import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./mcp-server.js";

// v0.29: Streamable HTTP transport (MCP 2025-03-26 spec) in stateless mode.
//
// The SDK mandates a FRESH transport per POST in stateless mode (a shared
// stateless transport throws "cannot be reused across requests" — message ids
// would collide between clients). We go one step further and create a fresh
// McpServer per POST too: every request is therefore fully isolated and safe
// under concurrent load (no shared server._transport that long-running live
// tool calls could steal). Tool registration is cheap and all fee data lives
// behind module-level caches in data.ts.
//
// Responses go out as plain application/json (enableJsonResponse), no
// Mcp-Session-Id is issued, and GET (SSE) / DELETE (session end) are 405 by
// spec — ideal for horizontally scaled hosting without sticky sessions.
//
// v0.32 adds public-hosting middleware, all opt-in and off by default:
//  - bearer-token auth (bearerToken option / FEE_MCP_BEARER_TOKEN): every
//    POST to the MCP endpoint requires `Authorization: Bearer <token>`;
//    /health stays open for load-balancer probes. Comparison is constant
//    time; failure returns 401 + WWW-Authenticate.
//  - fixed-window per-IP rate limiting (rateLimitPerMin option /
//    FEE_MCP_RATE_LIMIT_PER_MIN, requests per minute): excess returns
//    429 + Retry-After. Only MCP POSTs are counted.
//  - one structured JSON access-log line per request (accessLog option /
//    FEE_MCP_ACCESS_LOG): method/path/status/duration/ip/auth/rate_limited.
//  - client IP honors the first X-Forwarded-For hop when trustProxy is on
//    (default: on — containers expect a reverse proxy in front).

export interface AccessLogEntry {
  ts: string;
  ip: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  auth: "none" | "ok" | "fail";
  rate_limited: boolean;
  user_agent?: string;
}

export interface HttpServerOptions {
  host?: string;
  port?: number;
  endpoint?: string;
  /** When set, MCP POSTs must carry `Authorization: Bearer <token>`. /health stays open. */
  bearerToken?: string;
  /** Max MCP POSTs per client IP per window. 0/undefined = unlimited. */
  rateLimitPerMin?: number;
  /** Window length in ms; test-injectable, defaults to 60_000. */
  rateLimitWindowMs?: number;
  /** Emit a structured JSON line (true → stdout) or pass each entry to a sink. */
  accessLog?: boolean | ((entry: AccessLogEntry) => void);
  /** Honor X-Forwarded-For for the client IP (default true). */
  trustProxy?: boolean;
}

export interface RunningHttpServer {
  readonly httpServer: http.Server;
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

function jsonError(res: http.ServerResponse, status: number, message: string, code: number) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
  );
}

/** Constant-time string comparison (length mismatch short-circuits, which leaks only length). */
function constantTokenEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    const first = raw?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** Per-key fixed-window counter. Lazy-swept so the map cannot grow unbounded. */
class FixedWindowLimiter {
  private hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  get limitPerMin(): number {
    return this.limit;
  }

  /** Registers one hit; returns whether it is allowed and, if not, the retry delay. */
  check(key: string, now: number = Date.now()): { allowed: boolean; retryAfterMs: number } {
    if (this.hits.size > 1000) this.sweep(now);
    let rec = this.hits.get(key);
    if (!rec || now - rec.start >= this.windowMs) {
      rec = { start: now, count: 0 };
      this.hits.set(key, rec);
    }
    if (rec.count >= this.limit) {
      return { allowed: false, retryAfterMs: Math.max(this.windowMs - (now - rec.start), 0) };
    }
    rec.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  private sweep(now: number) {
    for (const [key, rec] of this.hits) {
      if (now - rec.start >= this.windowMs) this.hits.delete(key);
    }
  }
}

export async function startHttpServer(
  mcpServerFactory: () => McpServer = createServer,
  options: HttpServerOptions = {},
): Promise<RunningHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3333;
  const endpoint = options.endpoint ?? "/mcp";
  const bearerToken = options.bearerToken;
  const trustProxy = options.trustProxy ?? true;
  const limiter =
    options.rateLimitPerMin && options.rateLimitPerMin > 0
      ? new FixedWindowLimiter(Math.floor(options.rateLimitPerMin), options.rateLimitWindowMs ?? 60_000)
      : null;
  const emitAccessLog =
    options.accessLog === true
      ? (entry: AccessLogEntry) => console.log(JSON.stringify(entry))
      : typeof options.accessLog === "function"
        ? (options.accessLog as (entry: AccessLogEntry) => void)
        : null;

  const handleMcpPost = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // One isolated server + transport per POST (SDK stateless requirement).
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcp = mcpServerFactory();
    let settled = false;
    const cleanup = async () => {
      if (settled) return;
      settled = true;
      await transport.close().catch(() => {});
      await mcp.close().catch(() => {});
    };
    // Client disconnect mid-response must still release the pair. Guard on
    // writableFinished: under keep-alive the response "close" event also fires
    // after every NORMAL completed response, and closing then would race the
    // in-flight handler (SDK then returns 404 "Session not found"). Normal
    // completion is cleaned up by the finally block below.
    res.on("close", () => {
      if (!res.writableFinished) void cleanup();
    });

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[http] MCP request error:", err);
      jsonError(res, 500, `Internal error: ${(err as Error)?.message ?? String(err)}`, -32603);
    } finally {
      await cleanup();
    }
  };

  const requestHandler: http.RequestListener = (req, res) => {
    const startedAt = Date.now();
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const ip = clientIp(req, trustProxy);
    const isMcpPath = pathname === endpoint || pathname === `${endpoint}/`;
    // "none" = no auth required or not evaluated (health/404/rate-limited before auth).
    let authStatus: AccessLogEntry["auth"] = "none";
    let rateLimited = false;

    if (emitAccessLog) {
      res.once("finish", () => {
        emitAccessLog({
          ts: new Date().toISOString(),
          ip,
          method: req.method ?? "?",
          path: pathname,
          status: res.statusCode,
          duration_ms: Date.now() - startedAt,
          auth: authStatus,
          rate_limited: rateLimited,
          ...(req.headers["user-agent"] ? { user_agent: req.headers["user-agent"] } : {}),
        });
      });
    }

    if (isMcpPath) {
      if (req.method === "POST") {
        // Rate limit first (per IP) so unauthenticated floods get 429 too.
        if (limiter) {
          const decision = limiter.check(ip);
          if (!decision.allowed) {
            rateLimited = true;
            res.setHeader("Retry-After", String(Math.ceil(decision.retryAfterMs / 1000)));
            jsonError(
              res,
              429,
              "Rate limit exceeded: too many requests from this client; retry after the Retry-After interval.",
              -32001,
            );
            return;
          }
        }
        if (bearerToken) {
          const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
          if (match && constantTokenEqual(match[1].trim(), bearerToken)) {
            authStatus = "ok";
          } else {
            authStatus = "fail";
            res.setHeader("WWW-Authenticate", 'Bearer realm="fee-optimizer-mcp"');
            jsonError(
              res,
              401,
              "Unauthorized: missing or invalid bearer token. Send 'Authorization: Bearer <token>'.",
              -32002,
            );
            return;
          }
        }
        void handleMcpPost(req, res);
        return;
      }
      // Stateless mode: no per-session SSE stream and no sessions to delete.
      res.setHeader("allow", "POST");
      jsonError(
        res,
        405,
        `Method ${req.method} not allowed: stateless HTTP transport accepts POST only (no SSE sessions)`,
        -32000,
      );
      return;
    }
    if (pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: SERVER_NAME,
          version: SERVER_VERSION,
          transport: "streamable-http",
          mode: "stateless",
          endpoint,
          auth_required: !!bearerToken,
          rate_limit_per_min: limiter ? limiter.limitPerMin : 0,
          uptime_s: Math.round(process.uptime()),
        }),
      );
      return;
    }
    if (pathname === "/health") {
      res.setHeader("allow", "GET");
      jsonError(res, 405, `Method ${req.method} not allowed: /health accepts GET only`, -32000);
      return;
    }
    jsonError(res, 404, `Not found: ${pathname} (MCP endpoint is POST ${endpoint})`, -32601);
  };

  const httpServer = http.createServer(requestHandler);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });

  const actualPort = (httpServer.address() as AddressInfo).port;
  const url = `http://${host}:${actualPort}${endpoint}`;

  return {
    httpServer,
    url,
    port: actualPort,
    async close() {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
