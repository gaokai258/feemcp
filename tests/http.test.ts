import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, SERVER_NAME, SERVER_VERSION } from "../src/mcp-server.js";
import { startHttpServer, type RunningHttpServer, type AccessLogEntry } from "../src/http.js";

// v0.29: end-to-end tests for the stateless Streamable HTTP transport —
// real TCP listener + global fetch, exercising JSON-RPC over HTTP.
// Stateless semantics: each POST is served by a fresh isolated MCP server;
// no Mcp-Session-Id is ever issued and requests are concurrency-safe.

describe("v0.29 Streamable HTTP transport", () => {
  let running: RunningHttpServer;
  let base: string;
  let idCounter = 0;
  const nextId = () => ++idCounter;

  async function postMcp(body: unknown, headers?: Record<string, string>) {
    return fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  function rpc(method: string, params?: unknown) {
    return { jsonrpc: "2.0", id: nextId(), method, params };
  }

  async function callTool(name: string, args: Record<string, unknown> = {}) {
    const res = await postMcp(rpc("tools/call", { name, arguments: args }));
    expect(res.status).toBe(200);
    return (await res.json()) as {
      result?: { content?: { type: string; text: string }[]; isError?: boolean };
      error?: { code: number; message: string };
    };
  }

  beforeAll(async () => {
    running = await startHttpServer(createServer, {
      host: "127.0.0.1",
      port: 0,
    });
    base = `http://127.0.0.1:${running.port}`;
  }, 30000);

  afterAll(async () => {
    await running?.close();
  });

  it("GET /health returns service version and transport metadata", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      service: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "streamable-http",
      mode: "stateless",
      endpoint: "/mcp",
      auth_required: false,
      rate_limit_per_min: 0,
      uptime_s: expect.any(Number),
    });
  });

  it("initialize returns server info WITHOUT a session id (stateless)", async () => {
    const res = await postMcp(
      rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "http-test", version: "1.0" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe(SERVER_NAME);
    expect(body.result.serverInfo.version).toBe(SERVER_VERSION);
    expect(body.result.protocolVersion).toBe("2025-03-26");
  });

  it("accepts a JSON-RPC batch of two requests (tools/list + ping) in one POST", async () => {
    // Per spec, initialize cannot share a batch with other messages, so the
    // batch path is exercised with two ordinary requests instead.
    const res = await postMcp([rpc("tools/list", {}), rpc("ping", {})]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    const names = body[0].result.tools.map((t: { name: string }) => t.name);
    expect(names).toHaveLength(19);
    expect(names).toContain("compare_personas");
    expect(names).toContain("volume_what_if");
    expect(names).toContain("compare_countries");
    expect(body[1].result).toEqual({});
  });

  it("serves tools/list on a bare POST with no prior handshake (per-request isolation)", async () => {
    const res = await postMcp(rpc("tools/list", {}));
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toHaveLength(19);
    expect(names).toContain("analyze_persona");
    expect(names).toContain("compare_exchange_fees");
  });

  it("tools/call runs get_data_sources through the full HTTP stack", async () => {
    const body = await callTool("get_data_sources");
    expect(body.error).toBeUndefined();
    expect(body.result?.content?.[0]?.type).toBe("text");
    const payload = JSON.parse(body.result!.content![0].text);
    expect(payload.data_as_of).toBeTruthy();
    expect(Array.isArray(payload.files)).toBe(true);
    expect(payload.files.length).toBeGreaterThan(10);
  });

  it("tools/call runs a country-filtered fee comparison (US, 4 venues)", async () => {
    const body = await callTool("compare_exchange_fees", {
      purpose: "spot",
      country: "US",
      monthlyVolumeUsd: 10000,
    });
    expect(body.result?.isError).not.toBe(true);
    const text = body.result!.content![0].text;
    expect(text).toContain("okx");
    expect(text).toContain("kraken");
    expect(text).toContain("coinbase");
  });

  it("reports an unknown tool through the MCP isError envelope (-32602)", async () => {
    const res = await postMcp(rpc("tools/call", { name: "does_not_exist", arguments: {} }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result?.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/Tool does_not_exist not found/);
  });

  it("surfaces tool-level business errors via isError envelope over HTTP", async () => {
    // Kraken has no referral link configured → structured tool error, not a crash.
    const body = await callTool("get_referral_link", { exchange: "kraken", country: "US" });
    expect(body.result?.isError).toBe(true);
    const payload = JSON.parse(body.result!.content![0].text);
    expect(payload.code).toBe("NO_REFERRAL_LINK");
  });

  it("handles 5 concurrent POSTs with independent servers", async () => {
    const calls = Array.from({ length: 5 }, () =>
      callTool("compare_exchange_fees", { purpose: "spot", country: "US" }),
    );
    const results = await Promise.all(calls);
    for (const body of results) {
      expect(body.result?.isError).not.toBe(true);
      expect(body.result?.content?.[0]?.text).toContain("okx");
    }
  });

  it("rejects GET /mcp with 405 (stateless mode has no SSE session stream)", async () => {
    const res = await fetch(`${base}/mcp`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    const body = await res.json();
    expect(body.error.message).toMatch(/POST only/);
  });

  it("rejects DELETE /mcp with 405 (no sessions to terminate)", async () => {
    const res = await fetch(`${base}/mcp`, { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("returns 404 JSON-RPC-style error for unknown paths", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toMatch(/POST \/mcp/);
  });

  it("rejects a POST whose Accept header allows neither JSON nor SSE", async () => {
    const res = await postMcp(rpc("ping"), { accept: "text/html" });
    expect(res.status).toBe(406);
  });

  // v0.39: authenticated account fee tier — exercise only the branches that
  // never touch the network (static support / compliance gates).
  it("get_account_fee_tier is registered as the 17th tool", async () => {
    const res = await postMcp(rpc("tools/list", {}));
    const body = await res.json();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("get_account_fee_tier");
    const tool = body.result.tools.find((t: { name: string }) => t.name === "get_account_fee_tier");
    expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  // v0.46: MiCA stablecoin regional access (USDT EEA sweep).
  it("get_stablecoin_access is registered as the 18th tool", async () => {
    const res = await postMcp(rpc("tools/list", {}));
    const body = await res.json();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("get_stablecoin_access");
    const tool = body.result.tools.find((t: { name: string }) => t.name === "get_stablecoin_access");
    expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it("get_stablecoin_access: USDT restricted for DE, unrestricted for US; USDC authorized", async () => {
    const deBody = await callTool("get_stablecoin_access", { asset: "USDT", country: "DE" });
    expect(deBody.result?.isError).toBeFalsy();
    const de = JSON.parse(deBody.result!.content![0].text);
    expect(de.restriction).toMatchObject({ applies: true, region: "EEA", effective: "2026-07-01" });
    expect(de.venues).toHaveLength(18);

    const usBody = await callTool("get_stablecoin_access", { asset: "USDT", country: "US" });
    const us = JSON.parse(usBody.result!.content![0].text);
    expect(us.restriction.applies).toBe(false);

    const usdcBody = await callTool("get_stablecoin_access", { asset: "USDC", country: "DE" });
    const usdc = JSON.parse(usdcBody.result!.content![0].text);
    expect(usdc.mica_authorized).toBe(true);
    expect(usdc.restriction.applies).toBe(false);
  });

  // v0.47: consumer vs PRO interface costs (TUM hidden-spread study).
  it("compare_interface_costs is registered as the 19th tool", async () => {
    const res = await postMcp(rpc("tools/list", {}));
    const body = await res.json();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("compare_interface_costs");
    const tool = body.result.tools.find((t: { name: string }) => t.name === "compare_interface_costs");
    expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it("compare_interface_costs: six venues, TUM study, kraken/coinbase annualized excess at $1k/mo", async () => {
    const body = await callTool("compare_interface_costs", { monthly_volume_usd: 1000 });
    expect(body.result?.isError).toBeFalsy();
    const payload = JSON.parse(body.result!.content![0].text);
    expect(payload.venues.map((v: { exchange: string }) => v.exchange)).toEqual([
      "kraken",
      "coinbase",
      "bitstamp",
      "bitvavo",
      "bitpanda",
      "bison",
    ]);
    expect(payload.study_summary).toContain("TUM");
    const byId = Object.fromEntries(payload.venues.map((v: any) => [v.exchange, v]));
    expect(byId.kraken.consumer.measured_round_trip_pct).toBe(5.81);
    // (1.5 - 0.8)/100 * 1000 * 12 = 84
    expect(byId.kraken.consumer_vs_pro_annual_excess_usd).toBe(84);
    // (2.0 - 0.6)/100 * 1000 * 12 = 168
    expect(byId.coinbase.consumer_vs_pro_annual_excess_usd).toBe(168);
    expect(byId.bitvavo.consumer.fee_model).toBe("order_book_pass_through");
    expect(byId.bitpanda.pro).toBeUndefined();
  });

  it("get_account_fee_tier: unsupported venue fails with ACCOUNT_FEES_UNSUPPORTED before any network call", async () => {
    // v0.41: Phemex is EEA venue-blocked, so exercise the support gate from a
    // non-EEA market (AU resolves via the open default key).
    const body = await callTool("get_account_fee_tier", {
      exchange: "phemex",
      purpose: "spot",
      country: "AU",
      apiKey: "k",
      secret: "s",
    });
    expect(body.result?.isError).toBe(true);
    const payload = JSON.parse(body.result!.content![0].text);
    expect(payload.code).toBe("ACCOUNT_FEES_UNSUPPORTED");
  });

  it("get_account_fee_tier: unknown exchange → UNKNOWN_EXCHANGE", async () => {
    const body = await callTool("get_account_fee_tier", {
      exchange: "ftx",
      purpose: "spot",
      country: "DE",
      apiKey: "k",
      secret: "s",
    });
    expect(body.result?.isError).toBe(true);
    expect(JSON.parse(body.result!.content![0].text).code).toBe("UNKNOWN_EXCHANGE");
  });

  it("get_account_fee_tier: venue-level block (CN) and product gate (US bitstamp perps) fire before auth", async () => {
    const cn = await callTool("get_account_fee_tier", {
      exchange: "binance",
      purpose: "spot",
      country: "CN",
      apiKey: "k",
      secret: "s",
    });
    expect(cn.result?.isError).toBe(true);
    expect(JSON.parse(cn.result!.content![0].text).code).toBe("COUNTRY_BLOCKED");

    const gated = await callTool("get_account_fee_tier", {
      exchange: "bitstamp",
      purpose: "futures",
      country: "US",
      apiKey: "k",
      secret: "s",
    });
    expect(gated.result?.isError).toBe(true);
    expect(JSON.parse(gated.result!.content![0].text).code).toBe(
      "PRODUCT_BLOCKED_IN_COUNTRY",
    );
  });
});

// v0.32: bearer auth, per-IP fixed-window rate limiting, structured access log.
describe("v0.32 public-hosting middleware", () => {
  const TOKEN = "test-secret-token-032";

  let authSrv: RunningHttpServer;
  let limitSrv: RunningHttpServer;
  let noProxySrv: RunningHttpServer;
  let logSrv: RunningHttpServer;
  let logLimitSrv: RunningHttpServer;
  let authBase: string;
  let limitBase: string;
  let noProxyBase: string;
  let logBase: string;
  let logLimitBase: string;
  const logEntries: AccessLogEntry[] = [];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function initBody(id: number) {
    return {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    };
  }

  async function post(base: string, opts: RequestInit = {}) {
    return fetch(`${base}/mcp`, {
      ...opts,
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(opts.headers as Record<string, string>),
      },
      body: JSON.stringify(initBody(1)),
    });
  }

  beforeAll(async () => {
    authSrv = await startHttpServer(createServer, {
      host: "127.0.0.1", port: 0, bearerToken: TOKEN,
    });
    limitSrv = await startHttpServer(createServer, {
      host: "127.0.0.1", port: 0, rateLimitPerMin: 2, rateLimitWindowMs: 400,
    });
    noProxySrv = await startHttpServer(createServer, {
      host: "127.0.0.1", port: 0, rateLimitPerMin: 1, rateLimitWindowMs: 60_000, trustProxy: false,
    });
    logSrv = await startHttpServer(createServer, {
      host: "127.0.0.1", port: 0, bearerToken: TOKEN,
      accessLog: (e) => logEntries.push(e),
    });
    logLimitSrv = await startHttpServer(createServer, {
      host: "127.0.0.1", port: 0, rateLimitPerMin: 1, rateLimitWindowMs: 60_000,
      accessLog: (e) => logEntries.push(e),
    });
    authBase = `http://127.0.0.1:${authSrv.port}`;
    limitBase = `http://127.0.0.1:${limitSrv.port}`;
    noProxyBase = `http://127.0.0.1:${noProxySrv.port}`;
    logBase = `http://127.0.0.1:${logSrv.port}`;
    logLimitBase = `http://127.0.0.1:${logLimitSrv.port}`;
  }, 30000);

  afterAll(async () => {
    await Promise.all([
      authSrv.close(),
      limitSrv.close(),
      noProxySrv.close(),
      logSrv.close(),
      logLimitSrv.close(),
    ]);
  });

  it("bearer token: 401 + WWW-Authenticate without a token, 200 with the right one", async () => {
    const missing = await post(authBase);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    const missingBody = await missing.json();
    expect(missingBody.error.code).toBe(-32002);

    const wrong = await post(authBase, { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toContain("Bearer");

    const badScheme = await post(authBase, { headers: { authorization: "Basic dXNlcjpw" } });
    expect(badScheme.status).toBe(401);

    const ok = await post(authBase, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
  });

  it("bearer token: /health stays open and advertises auth_required", async () => {
    const res = await fetch(`${authBase}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auth_required).toBe(true);
  });

  it("rate limit: 3rd POST from one IP is 429 with Retry-After; health probes are exempt", async () => {
    const r1 = await post(limitBase);
    const r2 = await post(limitBase);
    expect([r1.status, r2.status]).toContain(200);
    const r3 = await post(limitBase);
    expect(r3.status).toBe(429);
    expect(Number(r3.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = await r3.json();
    expect(body.error.code).toBe(-32001);
    // Health is never counted toward the MCP POST budget.
    const health = await fetch(`${limitBase}/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).rate_limit_per_min).toBe(2);
  });

  it("rate limit: buckets are per X-Forwarded-For IP when trustProxy is on", async () => {
    const a1 = await post(limitBase, { headers: { "x-forwarded-for": "10.0.0.1" } });
    const a2 = await post(limitBase, { headers: { "x-forwarded-for": "10.0.0.1" } });
    const b1 = await post(limitBase, { headers: { "x-forwarded-for": "20.0.0.2" } });
    const a3 = await post(limitBase, { headers: { "x-forwarded-for": "10.0.0.1" } });
    expect(a1.status).toBe(200);
    expect(a2.status).toBe(200);
    // B has its own fresh bucket despite A already spending 2 hits.
    expect(b1.status).toBe(200);
    expect(a3.status).toBe(429);
  });

  it("rate limit: window resets after rateLimitWindowMs", async () => {
    await sleep(450);
    const again = await post(limitBase);
    expect(again.status).toBe(200);
  });

  it("trustProxy=false: X-Forwarded-For cannot buy a separate bucket", async () => {
    const x1 = await post(noProxyBase, { headers: { "x-forwarded-for": "9.9.9.9" } });
    const x2 = await post(noProxyBase, { headers: { "x-forwarded-for": "8.8.8.8" } });
    expect(x1.status).toBe(200);
    expect(x2.status).toBe(429);
  });

  it("access log: one structured entry per request with auth + rate-limit outcomes", async () => {
    // Auth-protected server: health (none), missing token (fail), valid token (ok).
    await fetch(`${logBase}/health`);
    await post(logBase);
    await post(logBase, { headers: { authorization: `Bearer ${TOKEN}` } });
    // Rate-limited server: 200 then 429 from the same IP.
    await post(logLimitBase);
    await post(logLimitBase);

    const healthEntry = logEntries.find((e) => e.path === "/health");
    expect(healthEntry).toMatchObject({ method: "GET", status: 200, auth: "none", rate_limited: false });

    const unauth = logEntries.filter((e) => e.path === "/mcp" && e.status === 401);
    expect(unauth.length).toBeGreaterThan(0);
    expect(unauth[0]).toMatchObject({ auth: "fail", rate_limited: false });

    const authed = logEntries.filter((e) => e.path === "/mcp" && e.status === 200 && e.auth === "ok");
    expect(authed.length).toBeGreaterThan(0);

    const limited = logEntries.filter((e) => e.rate_limited);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0].status).toBe(429);

    for (const e of logEntries) {
      expect(typeof e.duration_ms).toBe("number");
      expect(typeof e.ip).toBe("string");
      expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
    }
  });
});
