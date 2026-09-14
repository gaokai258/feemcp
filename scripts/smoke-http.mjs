#!/usr/bin/env node
// v0.29 end-to-end smoke test for the Streamable HTTP transport.
// Spawns the real CLI in HTTP mode (`node dist/index.js --transport http`),
// waits for the listening banner, then exercises JSON-RPC over real TCP:
//   GET  /health             -> service/version
//   POST initialize          -> serverInfo, no Mcp-Session-Id (stateless)
//   POST tools/list          -> 20 tools
//   POST tools/call (feed)   -> get_fee_changes works end-to-end
//   POST tools/call (matrix) -> compare_personas JP works end-to-end
//   POST tools/call (sweep)  -> volume_what_if US spot works end-to-end
//   POST tools/call (country)-> compare_countries works end-to-end
//   GET  /mcp                -> 405 (no SSE in stateless mode)
//   GET  /nope               -> 404
// Exits non-zero on the first failed assertion.

import { spawn } from "node:child_process";
import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PKG_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version;

const PORT = Number(process.env.SMOKE_HTTP_PORT ?? 3399);
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;
const MCP = `${BASE}/mcp`;

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}

const child = spawn(process.execPath, ["dist/index.js", "--transport", "http", "--port", String(PORT), "--host", HOST], {
  stdio: ["ignore", "pipe", "pipe"],
});

let banner = "";
child.stderr.on("data", (d) => {
  banner += d.toString();
});

const shutdown = async (code) => {
  child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
};

const waitForBanner = async () => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (/HTTP listening on/.test(banner)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

const HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
let id = 0;
const rpc = (method, params) => ({ jsonrpc: "2.0", id: ++id, method, params });
const post = (body) =>
  fetch(MCP, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });

try {
  if (!(await waitForBanner())) {
    console.error("FAIL  server did not print listening banner. stderr:\n" + banner);
    process.exit(1);
  }
  console.log(`-- CLI HTTP banner: ${banner.trim().split("\n").at(-1)}`);

  // 1. health
  {
    const res = await fetch(`${BASE}/health`);
    const body = await res.json();
    check(`GET /health -> 200 ok + v${PKG_VERSION}`, res.status === 200 && body.status === "ok" && body.version === PKG_VERSION, JSON.stringify(body));
  }

  // 2. initialize (stateless: no session id)
  {
    const res = await post(
      rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "smoke-http", version: "1.0" },
      }),
    );
    const body = await res.json();
    check(
      "initialize -> fee-optimizer-mcp, no session id",
      res.status === 200 &&
        body.result?.serverInfo?.name === "fee-optimizer-mcp" &&
        res.headers.get("mcp-session-id") === null,
    );
  }

  // 3. tools/list = 20
  {
    const res = await post(rpc("tools/list", {}));
    const body = await res.json();
    const names = body.result?.tools?.map((t) => t.name) ?? [];
    check(
      "tools/list -> 20 tools incl. get_fee_changes",
      res.status === 200 && names.length === 20 && names.includes("get_fee_changes"),
      `got ${names.length}`
    );
  }

  // 3b. v0.48 fee change feed: curated records come through the HTTP stack
  {
    const res = await post(rpc("tools/call", {
      name: "get_fee_changes",
      arguments: { exchange: "bingx", language: "zh" },
    }));
    const body = await res.json();
    const text = body.result?.content?.[0]?.text ?? "";
    check(
      "tools/call get_fee_changes bingx -> curated changes, no error",
      res.status === 200 &&
        body.result?.isError !== true &&
        /"exchange": "bingx"/.test(text) &&
        /"confidence": "high"/.test(text),
      text.slice(0, 200)
    );
  }

  // 4. full tool pipeline over HTTP: v0.28 decision matrix for JP
  {
    const res = await post(rpc("tools/call", { name: "compare_personas", arguments: { country: "JP" } }));
    const body = await res.json();
    const text = body.result?.content?.[0]?.text ?? "";
    check(
      "tools/call compare_personas JP -> okx most_versatile",
      res.status === 200 && body.result?.isError !== true && /"most_versatile": "okx"/.test(text),
      text.slice(0, 200)
    );
  }

  // 4b. v0.34 sweep pipeline: US spot with base volume + Chinese narrative
  {
    const res = await post(rpc("tools/call", {
      name: "volume_what_if",
      arguments: { purpose: "spot", country: "US", baseVolume: 80000, language: "zh" },
    }));
    const body = await res.json();
    const text = body.result?.content?.[0]?.text ?? "";
    check(
      "tools/call volume_what_if US spot -> crossings + 交易费最低 advice",
      res.status === 200 &&
        body.result?.isError !== true &&
        /"tier_crossings": \[/.test(text) &&
        /交易费最低/.test(text) &&
        /"exchange": "coinbase"/.test(text),
      text.slice(0, 200)
    );
  }

  // 4c. v0.35 country matrix pipeline: 7 countries, venue availability + gap
  {
    const res = await post(rpc("tools/call", {
      name: "compare_countries",
      arguments: { persona: "casual_buyer", language: "zh" },
    }));
    const body = await res.json();
    const text = body.result?.content?.[0]?.text ?? "";
    check(
      "tools/call compare_countries casual_buyer -> DE cheapest + 不可用 matrix lines",
      res.status === 200 &&
        body.result?.isError !== true &&
        /"cheapest_country": \{[^}]*"country": "DE"/.test(text) &&
        /"per_country"/.test(text) &&
        /不可用/.test(text),
      text.slice(0, 200)
    );
  }

  // 4d. v0.36 rendered table pipeline: format=both attaches markdown + CSV
  {
    const res = await post(rpc("tools/call", {
      name: "compare_countries",
      arguments: { persona: "casual_buyer", countries: ["DE", "JP"], format: "both", language: "zh" },
    }));
    const body = await res.json();
    const text = body.result?.content?.[0]?.text ?? "";
    check(
      "tools/call compare_countries format=both -> rendered markdown table + CRLF CSV",
      res.status === 200 &&
        body.result?.isError !== true &&
        /"rendered": \{/.test(text) &&
        /"markdown": "/.test(text) &&
        /\| --- \|/.test(text) &&
        /"csv": "[^"]*\\r\\n/.test(text) &&
        /✓/.test(text),
      text.slice(0, 200)
    );
  }

  // 4e. v0.39 account fee tier: unsupported venue returns typed error, no network
  {
    const res = await post(rpc("tools/call", {
      name: "get_account_fee_tier",
      arguments: { exchange: "phemex", purpose: "spot", country: "AU", apiKey: "redacted-smoke", secret: "redacted-smoke" },
    }));
    const body = await res.json();
    const text = body.result?.content?.[0]?.text ?? "";
    check(
      "tools/call get_account_fee_tier phemex -> ACCOUNT_FEES_UNSUPPORTED",
      res.status === 200 && body.result?.isError === true && /"code": "ACCOUNT_FEES_UNSUPPORTED"/.test(text),
      text.slice(0, 200)
    );
  }

  // 4f. v0.41 post-MiCA-cliff: CASP-less venue is venue-blocked for EEA
  // residency BEFORE any authenticated call is attempted.
  {
    const res = await post(rpc("tools/call", {
      name: "get_account_fee_tier",
      arguments: { exchange: "binance", purpose: "spot", country: "DE", apiKey: "redacted-smoke", secret: "redacted-smoke" },
    }));
    const body = await res.json();
    const text = body.result?.content?.[0]?.text ?? "";
    check(
      "tools/call get_account_fee_tier binance DE -> COUNTRY_BLOCKED (v0.41 EEA region gate, pre-auth)",
      res.status === 200 && body.result?.isError === true && /"code": "COUNTRY_BLOCKED"/.test(text),
      text.slice(0, 200)
    );
  }

  // 4g. v0.42 Bitvavo: EEA positive allowlist — priced for DE spot, excluded
  // for GB spot (separate UK entity not modeled).
  {
    const de = await post(rpc("tools/call", {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "DE" },
    }));
    const deBody = await de.json();
    const deText = deBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call compare_exchange_fees DE spot -> includes bitvavo at 0.15/0.25 (v0.42 EEA allowlist)",
      de.status === 200 &&
        deBody.result?.isError !== true &&
        /"exchange": "bitvavo"[^}]*"base_maker": 0\.15[^}]*"base_taker": 0\.25/.test(deText),
      deText.slice(0, 200)
    );

    const gb = await post(rpc("tools/call", {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "GB" },
    }));
    const gbBody = await gb.json();
    const gbText = gbBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call compare_exchange_fees GB spot -> bitvavo excluded (outside EEA whitelist)",
      gb.status === 200 && gbBody.result?.isError !== true && !/"exchange": "bitvavo"/.test(gbText),
      gbText.slice(0, 200)
    );
  }

  // 4h. v0.43 Finst: second EEA positive-allowlist brokerage — flat 0.15/0.15
  // priced for DE spot, excluded for GB spot, and no ccxt account-fee support.
  {
    const de = await post(rpc("tools/call", {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "DE" },
    }));
    const deBody = await de.json();
    const deText = deBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call compare_exchange_fees DE spot -> includes finst at flat 0.15/0.15 (v0.43 EEA broker)",
      de.status === 200 &&
        deBody.result?.isError !== true &&
        /"exchange": "finst"[^}]*"base_maker": 0\.15[^}]*"base_taker": 0\.15/.test(deText),
      deText.slice(0, 200)
    );

    const gb = await post(rpc("tools/call", {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "GB" },
    }));
    const gbBody = await gb.json();
    const gbText = gbBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call compare_exchange_fees GB spot -> finst excluded (outside EEA whitelist)",
      gb.status === 200 && gbBody.result?.isError !== true && !/"exchange": "finst"/.test(gbText),
      gbText.slice(0, 200)
    );

    const acct = await post(rpc("tools/call", {
      name: "get_account_fee_tier",
      arguments: { exchange: "finst", purpose: "spot", country: "DE", apiKey: "redacted-smoke", secret: "redacted-smoke" },
    }));
    const acctBody = await acct.json();
    const acctText = acctBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call get_account_fee_tier finst DE -> ACCOUNT_FEES_UNSUPPORTED (no ccxt connector)",
      acct.status === 200 && acctBody.result?.isError === true && /"code": "ACCOUNT_FEES_UNSUPPORTED"/.test(acctText),
      acctText.slice(0, 200)
    );
  }

  // 4i. v0.44 Bitpanda: first spread-model brokerage — 1.49% embedded premium
  // for DE spot, onboarded in BOTH EEA and GB (GB single-member region key),
  // blocked in the US, and no ccxt account-fee support.
  {
    const de = await post(rpc("tools/call", {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "DE" },
    }));
    const deBody = await de.json();
    const deText = deBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call compare_exchange_fees DE spot -> includes bitpanda at 1.49/1.49 (v0.44 spread broker)",
      de.status === 200 &&
        deBody.result?.isError !== true &&
        /"exchange": "bitpanda"[^}]*"base_maker": 1\.49[^}]*"base_taker": 1\.49/.test(deText),
      deText.slice(0, 200)
    );

    const gb = await post(rpc("tools/call", {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "GB" },
    }));
    const gbBody = await gb.json();
    const gbText = gbBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call compare_exchange_fees GB spot -> bitpanda INCLUDED (EEA+GB service area)",
      gb.status === 200 && gbBody.result?.isError !== true && /"exchange": "bitpanda"/.test(gbText),
      gbText.slice(0, 200)
    );

    const us = await post(rpc("tools/call", {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "US" },
    }));
    const usBody = await us.json();
    const usText = usBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call compare_exchange_fees US spot -> bitpanda excluded (outside EEA+GB service area)",
      us.status === 200 && usBody.result?.isError !== true && !/"exchange": "bitpanda"/.test(usText),
      usText.slice(0, 200)
    );

    const acct = await post(rpc("tools/call", {
      name: "get_account_fee_tier",
      arguments: { exchange: "bitpanda", purpose: "spot", country: "DE", apiKey: "redacted-smoke", secret: "redacted-smoke" },
    }));
    const acctBody = await acct.json();
    const acctText = acctBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call get_account_fee_tier bitpanda DE -> ACCOUNT_FEES_UNSUPPORTED (spread broker, no ccxt class)",
      acct.status === 200 && acctBody.result?.isError === true && /"code": "ACCOUNT_FEES_UNSUPPORTED"/.test(acctText),
      acctText.slice(0, 200)
    );
  }

  // 4j. v0.45 Bison: second spread-model brokerage (EUWAX principal) — 1.75%
  // headline for DE spot (no pair passed), onboarded in EEA+CH (CH single-member
  // region key), blocked in GB (complementary to Bitpanda) and the US, and no
  // ccxt account-fee support.
  {
    const de = await post(rpc("tools/call", {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "DE" },
    }));
    const deBody = await de.json();
    const deText = deBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call compare_exchange_fees DE spot -> includes bison at 1.75/1.75 (v0.45 spread broker, headline no-pair)",
      de.status === 200 &&
        deBody.result?.isError !== true &&
        /"exchange": "bison"[^}]*"base_maker": 1\.75[^}]*"base_taker": 1\.75/.test(deText),
      deText.slice(0, 200)
    );

    const ch = await post(rpc("tools/call", {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "CH" },
    }));
    const chBody = await ch.json();
    const chText = chBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call compare_exchange_fees CH spot -> bison INCLUDED (EEA+CH service area)",
      ch.status === 200 && chBody.result?.isError !== true && /"exchange": "bison"/.test(chText),
      chText.slice(0, 200)
    );

    const gb = await post(rpc("tools/call", {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "GB" },
    }));
    const gbBody = await gb.json();
    const gbText = gbBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call compare_exchange_fees GB spot -> bison excluded (GB outside EEA+CH, complementary to Bitpanda)",
      gb.status === 200 && gbBody.result?.isError !== true && !/"exchange": "bison"/.test(gbText),
      gbText.slice(0, 200)
    );

    const us = await post(rpc("tools/call", {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "US" },
    }));
    const usBody = await us.json();
    const usText = usBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call compare_exchange_fees US spot -> bison excluded (outside EEA+CH service area)",
      us.status === 200 && usBody.result?.isError !== true && !/"exchange": "bison"/.test(usText),
      usText.slice(0, 200)
    );

    const acct = await post(rpc("tools/call", {
      name: "get_account_fee_tier",
      arguments: { exchange: "bison", purpose: "spot", country: "DE", apiKey: "redacted-smoke", secret: "redacted-smoke" },
    }));
    const acctBody = await acct.json();
    const acctText = acctBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call get_account_fee_tier bison DE -> ACCOUNT_FEES_UNSUPPORTED (EUWAX principal broker, no ccxt class)",
      acct.status === 200 && acctBody.result?.isError === true && /"code": "ACCOUNT_FEES_UNSUPPORTED"/.test(acctText),
      acctText.slice(0, 200)
    );
  }

  // 4k. v0.46 MiCA stablecoin access: USDT EEA sweep + auto-injection.
  {
    const de = await post(rpc("tools/call", {
      name: "get_stablecoin_access",
      arguments: { asset: "USDT", country: "DE" },
    }));
    const deBody = await de.json();
    const deText = deBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call get_stablecoin_access USDT/DE -> restriction applies, effective 2026-07-01, 18 venue rows incl. bison never_offered",
      de.status === 200 &&
        deBody.result?.isError !== true &&
        /"applies": true/.test(deText) &&
        /"effective": "2026-07-01"/.test(deText) &&
        /"self_custody_allowed": true/.test(deText) &&
        /"exchange": "bison"[^}]*"status": "never_offered"/.test(deText) &&
        /"exchange": "coinbase"[^}]*"status": "delisted"/.test(deText),
      deText.slice(0, 300)
    );

    const us = await post(rpc("tools/call", {
      name: "get_stablecoin_access",
      arguments: { asset: "USDT", country: "US" },
    }));
    const usBody = await us.json();
    const usText = usBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call get_stablecoin_access USDT/US -> restriction does NOT apply (MiCA is EEA-only)",
      us.status === 200 && usBody.result?.isError !== true && /"applies": false/.test(usText),
      usText.slice(0, 300)
    );

    const usdc = await post(rpc("tools/call", {
      name: "get_stablecoin_access",
      arguments: { asset: "USDC", country: "DE" },
    }));
    const usdcBody = await usdc.json();
    const usdcText = usdcBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call get_stablecoin_access USDC/DE -> MiCA-authorized, no restriction",
      usdc.status === 200 &&
        usdcBody.result?.isError !== true &&
        /"mica_authorized": true/.test(usdcText) &&
        /"applies": false/.test(usdcText),
      usdcText.slice(0, 300)
    );

    const cmp = await post(rpc("tools/call", {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "DE", pair: "BTC/USDT" },
    }));
    const cmpBody = await cmp.json();
    const cmpText = cmpBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call compare_exchange_fees DE BTC/USDT -> rows carry stablecoin_access warning (STABLECOIN_UNAVAILABLE_IN_REGION)",
      cmp.status === 200 &&
        cmpBody.result?.isError !== true &&
        /"stablecoin_access": \{[^}]*"asset": "USDT"[^}]*"status": "(delisted|venue_blocked|never_offered)"/.test(cmpText),
      cmpText.slice(0, 300)
    );
  }

  // 4l. v0.47 consumer vs PRO interface costs: TUM hidden-spread study,
  // annualized excess at $1k/mo, broker-only rows without a PRO ladder.
  {
    const kraken = await post(rpc("tools/call", {
      name: "compare_interface_costs",
      arguments: { exchange: "kraken", country: "DE", monthly_volume_usd: 1000 },
    }));
    const krakenBody = await kraken.json();
    const krakenText = krakenBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call compare_interface_costs kraken DE $1k/mo -> TUM 5.81% round trip, 4.21pp gap, $84/yr excess",
      kraken.status === 200 &&
        krakenBody.result?.isError !== true &&
        /"measured_round_trip_pct": 5\.81/.test(krakenText) &&
        /"consumer_vs_pro_round_trip_pp": 4\.21/.test(krakenText) &&
        /"consumer_vs_pro_annual_excess_usd": 84/.test(krakenText) &&
        /"tier_credit": false/.test(krakenText),
      krakenText.slice(0, 300)
    );

    const all = await post(rpc("tools/call", {
      name: "compare_interface_costs",
      arguments: {},
    }));
    const allBody = await all.json();
    const allText = allBody.result?.content?.[0]?.text ?? "";
    check(
      "tools/call compare_interface_costs (all) -> six venues, Bitvavo 0.58% pass-through, Coinbase 7.49% worst, Bitpanda broker-only",
      all.status === 200 &&
        allBody.result?.isError !== true &&
        /TUM/.test(allText) &&
        /"exchange": "bitvavo"/.test(allText) &&
        /"measured_round_trip_pct": 0\.58/.test(allText) &&
        /"measured_round_trip_pct": 7\.49/.test(allText) &&
        /"exchange": "bitpanda"/.test(allText) &&
        !/"consumer_vs_pro_round_trip_pp": [0-9]/.test(allText.slice(allText.indexOf('"exchange": "bitpanda"'), allText.indexOf('"exchange": "bison"'))),
      allText.slice(0, 300)
    );
  }

  // 5. GET /mcp -> 405
  {
    const res = await fetch(MCP);
    check("GET /mcp -> 405 allow POST", res.status === 405 && res.headers.get("allow") === "POST", `got ${res.status}`);
  }

  // 6. unknown path -> 404
  {
    const res = await fetch(`${BASE}/nope`);
    check("GET /nope -> 404", res.status === 404, `got ${res.status}`);
  }

  console.log(failures === 0 ? "\nHTTP SMOKE ALL PASSED" : `\nHTTP SMOKE ${failures} FAILURE(S)`);
  await shutdown(failures === 0 ? 0 : 1);
} catch (err) {
  console.error("FAIL  smoke harness error:", err);
  await shutdown(1);
}
