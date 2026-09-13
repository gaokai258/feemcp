#!/usr/bin/env node
import "./polyfills.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./mcp-server.js";
import { startHttpServer, type RunningHttpServer } from "./http.js";

// v0.29: dual-transport entry point.
//   stdio (default):  node dist/index.js [--transport stdio]
//   streamable HTTP:  node dist/index.js --transport http [--host 0.0.0.0] [--port 3333] [--endpoint /mcp]
// Env overrides: FEE_MCP_TRANSPORT, FEE_MCP_HTTP_HOST, FEE_MCP_HTTP_PORT (HOST/PORT also accepted).
// v0.32 public-hosting env (HTTP mode only, all opt-in):
//   FEE_MCP_BEARER_TOKEN=<secret>       require Authorization: Bearer <secret> on MCP POSTs
//   FEE_MCP_RATE_LIMIT_PER_MIN=<n>      per-client-IP request cap per minute (0 = unlimited)
//   FEE_MCP_ACCESS_LOG=1                one structured JSON access-log line per request (stdout)
//   FEE_MCP_TRUST_PROXY=0               ignore X-Forwarded-For when not behind a reverse proxy

type TransportKind = "stdio" | "http";

interface CliOptions {
  transport: TransportKind;
  host: string;
  port: number;
  endpoint: string;
}

function parseArgs(argv: string[]): CliOptions {
  let transport: TransportKind =
    (process.env.FEE_MCP_TRANSPORT as TransportKind | undefined) ?? "stdio";
  let host = process.env.FEE_MCP_HTTP_HOST ?? process.env.HOST ?? "127.0.0.1";
  let port = Number(process.env.FEE_MCP_HTTP_PORT ?? process.env.PORT ?? 3333);
  let endpoint = process.env.FEE_MCP_HTTP_ENDPOINT ?? "/mcp";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--transport":
        transport = next() as TransportKind;
        break;
      case "--host":
        host = next();
        break;
      case "--port":
        port = Number(next());
        break;
      case "--endpoint":
        endpoint = next();
        break;
      case "--version":
      case "-v":
        process.stdout.write(`${SERVER_NAME} v${SERVER_VERSION}\n`);
        process.exit(0);
      case "--help":
      case "-h":
        process.stdout.write(
          [
            `${SERVER_NAME} v${SERVER_VERSION}`,
            "",
            "Usage: fee-optimizer-mcp [options]",
            "",
            "Options:",
            "  --transport <stdio|http>  MCP transport (default: stdio; env FEE_MCP_TRANSPORT)",
            "  --host <address>          HTTP bind host (default: 127.0.0.1; env FEE_MCP_HTTP_HOST/HOST)",
            "  --port <number>           HTTP port (default: 3333; env FEE_MCP_HTTP_PORT/PORT)",
            "  --endpoint <path>         HTTP MCP path (default: /mcp; env FEE_MCP_HTTP_ENDPOINT)",
            "  --version, -v             Print version and exit",
            "  --help, -h                Show this help",
            "",
            "HTTP mode exposes POST <endpoint> (stateless Streamable HTTP, JSON responses)",
            "and GET /health for load-balancer health checks.",
            "",
            "HTTP hosting env (all opt-in): FEE_MCP_BEARER_TOKEN, FEE_MCP_RATE_LIMIT_PER_MIN,",
            "FEE_MCP_ACCESS_LOG=1, FEE_MCP_TRUST_PROXY=0.",
            "",
          ].join("\n"),
        );
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg} (see --help)`);
    }
  }

  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`Invalid transport "${transport}" (expected stdio or http)`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port "${port}" (expected integer 0-65535)`);
  }
  if (!endpoint.startsWith("/")) {
    throw new Error(`Invalid endpoint "${endpoint}" (must start with /)`);
  }
  return { transport, host, port, endpoint };
}

async function runStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME} v${SERVER_VERSION}] listening on stdio`);
}

async function runHttp(opts: CliOptions) {
  // v0.32: opt-in public-hosting protections (env-driven).
  const bearerToken = process.env.FEE_MCP_BEARER_TOKEN?.trim() || undefined;
  const rateLimitRaw = Number(process.env.FEE_MCP_RATE_LIMIT_PER_MIN ?? 0);
  const rateLimitPerMin = Number.isFinite(rateLimitRaw) && rateLimitRaw > 0
    ? Math.floor(rateLimitRaw)
    : 0;
  const accessLog =
    process.env.FEE_MCP_ACCESS_LOG === "1" ||
    process.env.FEE_MCP_ACCESS_LOG?.toLowerCase() === "true";
  const trustProxy = process.env.FEE_MCP_TRUST_PROXY !== "0";

  // Factory, not an instance: stateless HTTP builds a fresh isolated MCP
  // server per POST (see http.ts), so concurrent requests never share state.
  const running: RunningHttpServer = await startHttpServer(createServer, {
    host: opts.host,
    port: opts.port,
    endpoint: opts.endpoint,
    ...(bearerToken ? { bearerToken } : {}),
    ...(rateLimitPerMin > 0 ? { rateLimitPerMin } : {}),
    ...(accessLog ? { accessLog: true } : {}),
    trustProxy,
  });
  console.error(
    `[${SERVER_NAME} v${SERVER_VERSION}] HTTP listening on ${running.url} (stateless, health: http://${opts.host}:${running.port}/health)` +
      ` [auth: ${bearerToken ? "bearer" : "off"}, rate-limit: ${rateLimitPerMin > 0 ? `${rateLimitPerMin}/min/ip` : "off"}, access-log: ${accessLog ? "on" : "off"}, trust-proxy: ${trustProxy ? "on" : "off"}]`,
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`[${SERVER_NAME}] received ${signal}, shutting down HTTP server...`);
    try {
      await running.close();
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.transport === "http") {
    await runHttp(opts);
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
