#!/usr/bin/env node
// v0.48: monthly fee-ladder snapshot CLI (data moat).
//
// Thin wrapper over the compiled engine in dist/fee-history.js so the
// normalization/diff logic has exactly ONE implementation. Requires
// `npm run build` first.
//
// Usage:
//   node scripts/fee-snapshot.mjs snapshot [--month YYYY-MM] [--force]
//       Capture/refresh this month's deterministic ladder snapshot.
//       No-op (exit 0) when an identical snapshot already exists.
//   node scripts/fee-snapshot.mjs diff --from YYYY-MM --to YYYY-MM
//       Print changes between two months. Exit 0 = none, 2 = changes found.
//   node scripts/fee-snapshot.mjs latest
//       Diff current fee_rates.json against the newest snapshot.
//       Exit 0 = no drift, 2 = drift found, 3 = no snapshots yet.
//
// Paths follow the engine env overrides: FEE_RATES_PATH and
// FEE_SNAPSHOTS_PATH (directory of YYYY-MM.json files).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSnapshot, diffSnapshots, detectCurrentDrift } from "../dist/fee-history.js";
import { getFeeRates, getFeeLadderSnapshots } from "../dist/data.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshotDir =
  process.env.FEE_SNAPSHOTS_PATH ?? path.join(root, "snapshots", "fee_ladders");
const monthRe = /^\d{4}-\d{2}$/;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function snapshotPath(month) {
  return path.join(snapshotDir, `${month}.json`);
}

function writeSnapshot(snapshot) {
  fs.mkdirSync(snapshotDir, { recursive: true });
  const body = JSON.stringify(snapshot, null, 2) + "\n";
  const file = snapshotPath(snapshot.id);
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === body) {
    console.log(`snapshot ${snapshot.id}: already up to date (${file})`);
    return false;
  }
  fs.writeFileSync(file, body, "utf8");
  console.log(`snapshot ${snapshot.id}: written (${file})`);
  return true;
}

function formatValue(v) {
  if (v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function printChanges(changes) {
  if (changes.length === 0) {
    console.log("no changes detected.");
    return;
  }
  for (const c of changes) {
    const where = [c.exchange, c.product, c.tier].filter(Boolean).join(" ");
    const head = `- [${c.confidence}] ${c.date} ${where} ${c.kind}`;
    const body = `\n    ${c.summary_en}`;
    const detail =
      c.before !== undefined || c.after !== undefined
        ? `\n    ${c.field ?? ""}: ${formatValue(c.before)} -> ${formatValue(c.after)}`
        : "";
    console.log(head + body + detail);
  }
}

function loadSnapshotFile(month) {
  const file = snapshotPath(month);
  if (!fs.existsSync(file)) {
    console.error(`snapshot not found: ${file}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function cmdSnapshot() {
  const month = arg("month", currentMonth());
  const force = process.argv.includes("--force");
  if (!monthRe.test(month)) {
    console.error(`invalid --month ${month}, expected YYYY-MM`);
    process.exit(1);
  }
  const snapshot = makeSnapshot(month, getFeeRates(), new Date().toISOString());
  if (force) {
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(snapshotPath(month), JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    console.log(`snapshot ${month}: force-written`);
    return;
  }
  writeSnapshot(snapshot);
}

function cmdDiff() {
  const from = arg("from");
  const to = arg("to");
  if (!from || !to || !monthRe.test(from) || !monthRe.test(to)) {
    console.error("diff requires --from YYYY-MM --to YYYY-MM");
    process.exit(1);
  }
  const changes = diffSnapshots(loadSnapshotFile(from), loadSnapshotFile(to));
  console.log(`diff ${from} -> ${to}: ${changes.length} change(s)`);
  printChanges(changes);
  process.exit(changes.length > 0 ? 2 : 0);
}

function cmdLatest() {
  const feeRates = getFeeRates();
  const { latest, changes } = detectCurrentDrift(feeRates, getFeeLadderSnapshots());
  if (!latest) {
    console.error("no snapshots available — run `snapshot` first");
    process.exit(3);
  }
  console.log(`current fee_rates.json vs latest snapshot ${latest.id}: ${changes.length} change(s)`);
  printChanges(changes);
  process.exit(changes.length > 0 ? 2 : 0);
}

const command = process.argv[2] ?? "latest";
if (command === "snapshot") cmdSnapshot();
else if (command === "diff") cmdDiff();
else if (command === "latest") cmdLatest();
else {
  console.error(`unknown command '${command}' (snapshot|diff|latest)`);
  process.exit(1);
}
