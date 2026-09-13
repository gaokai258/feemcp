#!/usr/bin/env node
// Data quality gate for the fee optimizer bundles (v0.33).
//
// Deterministic, offline, no network: validates internal consistency of every
// JSON file in data/ so a bad edit cannot ship a broken fee comparison.
//   node scripts/audit-data.mjs        # exit 0 = clean, exit 1 = issues found
//
// Checks:
//   1. every data file has a parseable last_verified (YYYY-MM[-DD]) and >=1
//      source with a name AND either an http(s) url or an explanatory note
//      (methodology/compliance/operator sources legitimately carry a note
//      instead of a single link — but a source must never be untraceable)
//   2. cross-file venue coverage: fee_rates venues exist in spread_baseline
//      and withdrawal_fees; any venue with futures tiers has a funding entry
//   3. fee ladders are volume-sorted and maker/taker never increase with tier
//   4. every token-discount symbol has a token_prices snapshot
//   5. every withdrawal asset across venues has an asset_prices_usd entry
//      (otherwise native fees cannot be converted to USD)
//   6. referral links are well-formed http(s) URLs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const load = (f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));

const issues = [];
const warn = (m) => issues.push(m);

// ---------- 1. per-file metadata ----------
const files = fs.readdirSync(dataDir).filter((f) => f.endsWith(".json"));
const dateRe = /^\d{4}-\d{2}(-\d{2})?$/;
for (const f of files) {
  const d = load(f);
  const lv = d.last_verified ?? d.last_verified_at;
  if (typeof lv !== "string" || !dateRe.test(lv)) {
    warn(`${f}: missing/unparseable last_verified (got ${JSON.stringify(lv)})`);
  }
  const src = d.sources;
  if (!Array.isArray(src) || src.length === 0) {
    warn(`${f}: sources must be a non-empty array`);
  } else {
    src.forEach((s, i) => {
      if (!s?.name || typeof s.name !== "string") warn(`${f}: sources[${i}] missing name`);
      const hasNote = typeof s?.note === "string" && s.note.trim().length > 0;
      let u = null;
      try {
        u = s.url ? new URL(s.url) : null;
      } catch {
        /* invalid URL string — fall through */
      }
      const hasValidUrl = u !== null && /^https?:$/.test(u.protocol);
      if (!hasValidUrl && !hasNote) {
        warn(`${f}: sources[${i}] "${s?.name ?? "?"}" needs a valid url OR an explanatory note`);
      } else if (s.url && !hasValidUrl) {
        warn(`${f}: sources[${i}] "${s?.name ?? "?"}" has malformed url (${JSON.stringify(s.url)})`);
      }
    });
  }
}

const fees = load("fee_rates.json");
const spread = load("spread_baseline.json");
const wd = load("withdrawal_fees.json");
const fund = load("funding_rates.json");
const disc = load("token_discounts.json");
const prices = load("token_prices.json");
const referrals = load("referral_links.json");

const exchanges = Object.keys(fees.exchanges);
const spreadV = new Set(Object.keys(spread.exchanges));
const wdV = new Set(Object.keys(wd.exchanges));
const fundV = new Set(Object.keys(fund.exchanges));
const priceKeys = new Set(Object.keys(prices.prices));
const assetPrices = new Set(Object.keys(wd.asset_prices_usd ?? {}));

// ---------- 2. cross-file venue coverage ----------
for (const e of exchanges) {
  if (!spreadV.has(e)) warn(`spread_baseline missing venue: ${e}`);
  if (!wdV.has(e)) warn(`withdrawal_fees missing venue: ${e}`);
  const hasFutures = Array.isArray(fees.exchanges[e].futures) && fees.exchanges[e].futures.length > 0;
  if (hasFutures && !fundV.has(e)) warn(`${e}: futures tiers present but no funding_rates entry`);
}

// ---------- 3. ladder monotonicity (percent; maker may be negative = rebate) ----------
function checkLadder(e, kind, ladder) {
  let prevVol = -1;
  let prevMaker = Infinity;
  let prevTaker = Infinity;
  for (const t of ladder) {
    const vol = Number(t.min_volume_usd ?? 0);
    if (vol < prevVol) warn(`${e} ${kind}: tiers not volume-sorted at ${t.tier}`);
    prevVol = vol;
    const mk = Number(t.maker ?? t.fee);
    const tk = Number(t.taker ?? t.fee);
    if (!Number.isFinite(mk) || !Number.isFinite(tk)) {
      warn(`${e} ${kind}: non-finite fee at ${t.tier}`);
      continue;
    }
    if (mk - prevMaker > 1e-9) warn(`${e} ${kind}: maker increases at ${t.tier} (${prevMaker} -> ${mk})`);
    if (tk - prevTaker > 1e-9) warn(`${e} ${kind}: taker increases at ${t.tier} (${prevTaker} -> ${tk})`);
    if (mk < -0.1 || tk < -0.1) warn(`${e} ${kind}: implausibly negative fee at ${t.tier} (${mk}/${tk})`);
    prevMaker = mk;
    prevTaker = tk;
  }
}
for (const [e, cfg] of Object.entries(fees.exchanges)) {
  if (Array.isArray(cfg.spot)) checkLadder(e, "spot", cfg.spot);
  else warn(`${e}: missing spot tier array`);
  if (Array.isArray(cfg.futures) && cfg.futures.length) checkLadder(e, "fut", cfg.futures);
}

// ---------- 4. discount token price coverage ----------
for (const [e, cfg] of Object.entries(disc.exchanges ?? {})) {
  const token = cfg.token ?? cfg.token_symbol;
  if (token && !priceKeys.has(token)) warn(`${e}: discount token '${token}' missing from token_prices`);
}

// ---------- 5. withdrawal asset price coverage ----------
const referencedAssets = new Set();
for (const cfg of Object.values(wd.exchanges)) {
  for (const asset of Object.keys(cfg)) referencedAssets.add(asset);
  // sanity: every open route carries a positive native fee
  for (const [asset, entry] of Object.entries(cfg)) {
    const routes = entry && typeof entry === "object" && "network" in entry
      ? [entry]
      : Object.values(entry ?? {});
    for (const net of routes) {
      if (net.available === false) continue;
      const fee = Number(net.fee);
      if (!Number.isFinite(fee) || fee < 0) warn(`withdrawal ${asset} ${net.network ?? "?"}: bad native fee ${net.fee}`);
    }
  }
}
for (const asset of referencedAssets) {
  if (!assetPrices.has(asset)) warn(`withdrawal asset '${asset}' has no asset_prices_usd entry (USD conversion impossible)`);
}

// ---------- 6. referral URLs ----------
for (const [e, cfg] of Object.entries(referrals.exchanges ?? {})) {
  if (cfg.url == null) continue; // venue intentionally without a link
  try {
    const u = new URL(cfg.url);
    if (!/^https?:$/.test(u.protocol)) throw new Error("bad protocol");
  } catch {
    warn(`${e}: invalid referral url (${JSON.stringify(cfg.url)})`);
  }
}

// ---------- report ----------
if (issues.length) {
  console.error(`\nDATA AUDIT FAILED — ${issues.length} issue(s):`);
  for (const i of issues) console.error("  - " + i);
  process.exit(1);
}
console.log(`DATA AUDIT OK — ${files.length} files, ${exchanges.length} venues, ladders/prices/routes/links consistent.`);
