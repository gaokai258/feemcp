#!/usr/bin/env node
// Plan-B reachability probe (v0.49 prep): can the live spread/funding pipeline
// actually reach each venue's public API from THIS machine/runner?
//
// GitHub-hosted runners egress from US IPs and several venues geo-block them
// (HTTP 451/403). The continuous spread-observation pipeline (Plan B, deferred
// in the v0.48 plan) is only worth building on a GH runner for venues that are
// really reachable — this probe measures REAL coverage first by exercising the
// exact live code path: ccxt loadMarkets() -> resolveTradeSymbol() ->
// fetchOrderBook(symbol, 5).
//
// Requires `npm run build` first: venue->ccxt mappings and symbol resolution
// are imported from dist/live.js so the probe can never drift from the engine.
//
// Usage:
//   node scripts/probe-reachability.mjs [--pair BTC/USDT] [--timeout-ms 15000]
//        [--venues binance,okx,...] [--json path] [--help]
//
// Exit codes: 0 = report produced (blocked venues are expected data, not a
// failure), 1 = probe crashed (build missing, bad args, ccxt import failed).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CCXT_IDS, CCXT_SPOT_ID_OVERRIDES, resolveTradeSymbol } from "../dist/live.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------- args ----------

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

if (hasFlag("help") || hasFlag("h")) {
  console.log(`Plan-B reachability probe — exercises the live spread/funding code path
(ccxt loadMarkets -> resolveTradeSymbol -> fetchOrderBook) per venue x purpose.

Usage:
  node scripts/probe-reachability.mjs [--pair BTC/USDT] [--timeout-ms 15000]
      [--venues binance,okx,...] [--json <path>]

  --pair         Pair to resolve per venue (default BTC/USDT; USD fallbacks apply)
  --timeout-ms   Per-request ccxt timeout (default 15000)
  --venues       Comma-separated subset (default: every venue the live pipeline supports)
  --json         Write the machine-readable report to this path

Exit codes: 0 = report produced (blocked venues are expected data), 1 = crash.`);
  process.exit(0);
}

const pair = arg("pair", "BTC/USDT");
const timeoutMs = Math.max(1000, parseInt(arg("timeout-ms", "15000"), 10) || 15000);
const jsonPath = arg("json", null);
const venueFilter = arg("venues", null)
  ?.split(",")
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);

// ---------- probe targets: exactly what fetchExecutionCostLive supports ----------

// Futures lives in the dedicated classes of CCXT_IDS; spot uses the override
// for split venues. coinbase is spot-only (coinbaseexchange).
const FUTURES_VENUES = Object.keys(CCXT_IDS);
const SPOT_VENUES = [...new Set([...FUTURES_VENUES, "coinbase"])];

const targets = [];
for (const venue of SPOT_VENUES) {
  if (venueFilter && !venueFilter.includes(venue)) continue;
  const ccxtId = CCXT_SPOT_ID_OVERRIDES[venue] ?? CCXT_IDS[venue] ?? venue;
  targets.push({ exchange: venue, purpose: "spot", ccxtId });
}
for (const venue of FUTURES_VENUES) {
  if (venueFilter && !venueFilter.includes(venue)) continue;
  targets.push({ exchange: venue, purpose: "futures", ccxtId: CCXT_IDS[venue] ?? venue });
}

if (targets.length === 0) {
  console.error(`no probe targets for venues=${venueFilter?.join(",")}`);
  process.exit(1);
}

// ---------- error classification ----------

function classify(err) {
  const msg = err instanceof Error ? err.message : String(err);
  const ctor = err?.constructor?.name ?? "";
  if (/no spot market|no linear perpetual|no futures market|symbol/i.test(msg)) {
    return "symbol_unresolved";
  }
  if (/\b451\b|geo-?block|not available in|unavailable for legal|restricted location|sanctioned/i.test(msg)) {
    return "geo_block";
  }
  if (/\b418\b/.test(msg)) return "http_418_ip_ban";
  if (/\b429\b|too many requests|ddosprotection|rate.?limit/i.test(msg)) return "rate_limited";
  if (/\b403\b|forbidden/i.test(msg)) return "http_403";
  if (/\b401\b|unauthorized|api key/i.test(msg)) return "http_401_auth";
  if (/getaddrinfo|eai_again|enotfound/i.test(msg)) return "dns";
  if (/etimedout|esockettimedout|timeout|requesttimeout/i.test(msg) || /timeout/i.test(ctor)) {
    return "timeout";
  }
  if (/econnreset|econnrefused|socket hang up|network error|exchange not available|notavailable/i.test(msg) || /notavailable|network/i.test(ctor)) {
    return "network";
  }
  if (/certificate|tls|ssl|self[- ]signed/i.test(msg)) return "tls";
  return "other";
}

const TRANSIENT = new Set(["dns", "timeout", "network"]);

/** Run fn up to `times` times; retry only transient network failures. */
async function attempt(fn, times = 2) {
  let lastErr;
  for (let i = 0; i < times; i++) {
    const started = Date.now();
    try {
      return { ok: true, ms: Date.now() - started, ...(await fn()) };
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT.has(classify(err))) break;
    }
  }
  return { ok: false, ms: null, error: errMessage(lastErr), classification: classify(lastErr) };
}

function errMessage(err) {
  const msg = err instanceof Error ? err.message : String(err);
  // Truncate URL-heavy ccxt messages; keep the host + status tail.
  return msg.length > 220 ? msg.slice(0, 180) + "…" + msg.slice(-40) : msg;
}

// ---------- probe core (mirrors fetchExecutionCostLive in src/live.ts) ----------

async function probeTarget(ccxtModule, target) {
  const { exchange, purpose, ccxtId } = target;
  const result = {
    exchange,
    purpose,
    ccxt_id: ccxtId,
    load_markets: { ok: false },
    order_book: { ok: false },
  };

  const Klass = ccxtModule[ccxtId];
  if (!Klass) {
    result.load_markets = { ok: false, error: `ccxt has no exchange '${ccxtId}'`, classification: "no_ccxt_class" };
    result.order_book = { ok: false, error: "skipped: load_markets failed", classification: "skipped" };
    return result;
  }

  const client = new Klass({ timeout: timeoutMs, enableRateLimit: true });

  result.load_markets = await attempt(async () => {
    await client.loadMarkets();
    return { markets_count: Object.keys(client.markets).length };
  });

  if (!result.load_markets.ok) {
    result.order_book = { ok: false, error: "skipped: load_markets failed", classification: "skipped" };
    return result;
  }

  const [base, quote] = pair.split("/");
  const symbol = resolveTradeSymbol(client.markets, base, quote, purpose);
  if (!symbol) {
    result.order_book = {
      ok: false,
      error: `no ${purpose} market for ${pair} on ${ccxtId}`,
      classification: "symbol_unresolved",
    };
    return result;
  }
  result.order_book.symbol = symbol;
  result.order_book = { ...result.order_book, ...(await attempt(() => client.fetchOrderBook(symbol, 5))) };
  return result;
}

// Small concurrency pool: keeps order per target, avoids rate-limit storms.
async function probeAll(ccxtModule, poolSize = 4) {
  const results = new Array(targets.length);
  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const idx = next++;
      process.stdout.write(`probing ${targets[idx].exchange}/${targets[idx].purpose} (${targets[idx].ccxtId})…\n`);
      results[idx] = await probeTarget(ccxtModule, targets[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(poolSize, targets.length) }, worker));
  return results;
}

// ---------- reporting ----------

function statusOf(r) {
  if (r.load_markets.ok && r.order_book.ok) return "reachable+booked";
  if (r.load_markets.ok && r.order_book.classification === "symbol_unresolved") return "reachable-no-symbol";
  if (r.load_markets.ok) return "reachable-book-failed";
  if (r.load_markets.classification === "no_ccxt_class") return "no_ccxt_class";
  return "unreachable";
}

function counts(results) {
  const c = { reachable_booked: 0, reachable_partial: 0, unreachable: 0 };
  for (const r of results) {
    const s = statusOf(r);
    if (s === "reachable+booked") c.reachable_booked++;
    else if (s.startsWith("reachable")) c.reachable_partial++;
    else c.unreachable++;
  }
  return c;
}

function printConsole(results) {
  const pad = (s, n) => String(s ?? "").padEnd(n);
  console.log(
    "\n" +
      pad("exchange", 12) + pad("purpose", 9) + pad("ccxt id", 18) +
      pad("markets", 16) + pad("book", 16) + pad("status", 22) + "classification",
  );
  console.log("-".repeat(110));
  for (const r of results) {
    const lm = r.load_markets.ok
      ? `ok ${r.load_markets.ms}ms/${r.load_markets.markets_count}`
      : `fail (${r.load_markets.classification})`;
    const ob = r.order_book.ok
      ? `ok ${r.order_book.ms}ms`
      : `fail (${r.order_book.classification ?? "?"})`;
    console.log(
      pad(r.exchange, 12) + pad(r.purpose, 9) + pad(r.ccxt_id, 18) +
        pad(lm, 16) + pad(ob, 16) + pad(statusOf(r), 22) +
        (r.load_markets.ok ? (r.order_book.classification ?? "") : r.load_markets.classification),
    );
  }
}

function renderMarkdown(results, meta) {
  const c = counts(results);
  const lines = [
    "### Venue reachability (live spread/funding code path)",
    "",
    `Pair: \`${meta.pair}\` · timeout: ${meta.timeout_ms}ms · ccxt: ${meta.ccxt_version} · Node: ${meta.node} · ${meta.generated_at}`,
    "",
    "| exchange | purpose | ccxt id | load_markets | fetch_order_book | status | classification |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    const lm = r.load_markets.ok
      ? `ok (${r.load_markets.ms}ms, ${r.load_markets.markets_count} markets)`
      : `fail — ${r.load_markets.classification}`;
    const ob = r.order_book.ok
      ? `ok (${r.order_book.ms}ms)`
      : r.order_book.classification === "symbol_unresolved"
        ? "no market for pair"
        : `fail — ${r.order_book.classification}`;
    lines.push(
      `| ${r.exchange} | ${r.purpose} | ${r.ccxt_id} | ${lm} | ${ob} | ${statusOf(r)} | ${r.load_markets.error ?? r.order_book.error ?? ""} |`,
    );
  }
  lines.push(
    "",
    `**Summary:** ${c.reachable_booked} fully reachable · ${c.reachable_partial} partial (markets OK, book failed) · ${c.unreachable} unreachable of ${results.length} venue×purpose rows.`,
    "",
    "Only `reachable+booked` rows are candidates for a scheduled GH-runner spread collector.",
    "A `reachable-no-symbol` row is still reachable — try a pair quoted in the venue's native currency (e.g. BTC/USD).",
  );
  return lines.join("\n") + "\n";
}

// ---------- main ----------

async function main() {
  let ccxtModule;
  try {
    ccxtModule = await import("ccxt");
  } catch (err) {
    console.error(`failed to import ccxt: ${errMessage(err)}`);
    process.exit(1);
  }

  const meta = {
    generated_at: new Date().toISOString(),
    pair,
    timeout_ms: timeoutMs,
    ccxt_version: ccxtModule.version ?? "unknown",
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
  };

  const results = await probeAll(ccxtModule);
  printConsole(results);

  const md = renderMarkdown(results, meta);
  console.log("\n" + md);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }

  if (jsonPath) {
    const report = { ...meta, targets_requested: targets.length, results, counts: counts(results) };
    fs.mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
    console.log(`json report written: ${jsonPath}`);
  }

  const c = counts(results);
  console.log(`\nreachability: ${c.reachable_booked}/${results.length} fully reachable, ${c.reachable_partial} partial, ${c.unreachable} unreachable.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`probe crashed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
