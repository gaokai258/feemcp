// v0.48: fee schedule change feed — the auditable data-moat layer.
//
// Two kinds of evidence live here:
//   1. CURATED records (data/fee_changes.json): human-verified changes with an
//      official source URL and "high"/"medium" confidence.
//   2. DETECTED records: derived by diffing consecutive monthly ladder
//      snapshots (snapshots/fee_ladders/*.json, repo-only — npm consumers do
//      not ship them). They are labeled "detected" and must never be presented
//      as confirmed: a snapshot delta can reflect a data correction rather than
//      a real venue-side change.
//
// Every function in this module is PURE and offline; callers (tools.ts and the
// scripts/fee-snapshot.mjs CLI) wire the data loaders. Tests use fixtures only.

import type {
  FeeChange,
  FeeChangeConfidence,
  FeeChangeProduct,
  FeeChangeReport,
  FeeChangeValue,
  FeeRatesData,
  LadderSnapshot,
  SnapshotTier,
} from "./types.js";

const PRODUCTS = ["spot", "futures"] as const;
const RATE_FIELDS = new Set(["maker", "taker", "fee"]);
const MONTH_RE = /^\d{4}-\d{2}$/;

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function tierName(tier: SnapshotTier): string {
  return typeof tier.tier === "string" ? tier.tier : "";
}

/** Canonicalize one fee rung: scalar keys only, sorted, original precision kept. */
export function normalizeTier(raw: Record<string, unknown>): SnapshotTier {
  const out: SnapshotTier = {};
  for (const key of Object.keys(raw).sort()) {
    const v = raw[key];
    if (typeof v === "number" || typeof v === "string") {
      out[key] = v;
    }
  }
  return out;
}

/** Deterministic per-venue/product ladder fingerprint of a fee_rates bundle. */
export function normalizeLadders(feeRates: FeeRatesData): LadderSnapshot["ladders"] {
  const ladders: LadderSnapshot["ladders"] = {};
  for (const exchange of Object.keys(feeRates.exchanges).sort()) {
    const cfg = feeRates.exchanges[exchange];
    const entry: LadderSnapshot["ladders"][string] = {};
    if (Array.isArray(cfg.spot) && cfg.spot.length > 0) {
      entry.spot = cfg.spot.map((t) => normalizeTier(t as unknown as Record<string, unknown>));
    }
    if (Array.isArray(cfg.futures) && cfg.futures.length > 0) {
      entry.futures = cfg.futures.map((t) =>
        normalizeTier(t as unknown as Record<string, unknown>),
      );
    }
    ladders[exchange] = entry;
  }
  return ladders;
}

export function makeSnapshot(id: string, feeRates: FeeRatesData, capturedAt: string): LadderSnapshot {
  if (!MONTH_RE.test(id)) throw new Error(`snapshot id must be YYYY-MM, got ${id}`);
  return { id, captured_at: capturedAt, ladders: normalizeLadders(feeRates) };
}

// ---------- detected-change summaries (English + Chinese) ----------

function rateSummary(
  exchange: string,
  product: "spot" | "futures",
  tier: string,
  zh: boolean,
): string {
  return zh
    ? `${exchange} ${product === "spot" ? "现货" : "合约"} ${tier} 档费率在月度快照间发生变化（自动检测，尚未核实，请以官方费率页为准）`
    : `${exchange} ${product} ${tier} rate changed between monthly snapshots (auto-detected, unverified — confirm against the official fee page)`;
}

function thresholdSummary(
  exchange: string,
  product: "spot" | "futures",
  tier: string,
  zh: boolean,
): string {
  return zh
    ? `${exchange} ${product === "spot" ? "现货" : "合约"} ${tier} 档门槛在月度快照间发生变化（自动检测，尚未核实）`
    : `${exchange} ${product} ${tier} qualification threshold changed between monthly snapshots (auto-detected, unverified)`;
}

function rungAddedSummary(exchange: string, product: "spot" | "futures", tier: string, zh: boolean): string {
  return zh
    ? `${exchange} ${product === "spot" ? "现货" : "合约"}阶梯新增 ${tier} 档（自动检测，尚未核实）`
    : `${exchange} ${product} ladder gained a ${tier} rung (auto-detected, unverified)`;
}

function rungRemovedSummary(exchange: string, product: "spot" | "futures", tier: string, zh: boolean): string {
  return zh
    ? `${exchange} ${product === "spot" ? "现货" : "合约"}阶梯移除 ${tier} 档（自动检测，尚未核实）`
    : `${exchange} ${product} ladder lost its ${tier} rung (auto-detected, unverified)`;
}

function ladderAppearedSummary(exchange: string, product: "spot" | "futures", count: number, zh: boolean): string {
  return zh
    ? `${exchange} 新增${product === "spot" ? "现货" : "合约"}费率阶梯（${count} 档，自动检测，尚未核实）`
    : `${exchange} now publishes a ${product} fee ladder (${count} rungs; auto-detected, unverified)`;
}

function ladderDisappearedSummary(exchange: string, product: "spot" | "futures", count: number, zh: boolean): string {
  return zh
    ? `${exchange} ${product === "spot" ? "现货" : "合约"}费率阶梯消失（原 ${count} 档，自动检测，尚未核实）`
    : `${exchange} ${product} fee ladder removed (was ${count} rungs; auto-detected, unverified)`;
}

function detectedNote(zh: boolean): string {
  return zh
    ? "由相邻月度费率阶梯快照自动 diff 生成，可能是数据更正而非真实费率调整；引用前请核对交易所官方费率页。"
    : "Auto-generated from consecutive monthly ladder snapshots; may be a data correction rather than a venue-side change. Verify against the official fee page before relying on it.";
}

interface DiffContext {
  fromId: string;
  toId: string;
}

function pushFieldBagChange(args: {
  out: FeeChange[];
  exchange: string;
  product: "spot" | "futures";
  tier: string;
  kind: "rate" | "threshold";
  diffs: { field: string; before: number; after: number }[];
  ctx: DiffContext;
}): void {
  const { out, exchange, product, tier, kind, diffs, ctx } = args;
  if (diffs.length === 0) return;
  const beforeBag: Record<string, number | string> = {};
  const afterBag: Record<string, number | string> = {};
  for (const d of diffs) {
    beforeBag[d.field] = kind === "rate" ? round4(d.before) : d.before;
    afterBag[d.field] = kind === "rate" ? round4(d.after) : d.after;
  }
  out.push({
    id: `${ctx.toId}-${exchange}-${product}-${slug(tier)}-${kind}`,
    date: ctx.toId,
    exchange,
    product,
    kind,
    tier,
    field: `${product}.${tier}.${diffs.map((d) => d.field).join("+")}`,
    before: beforeBag,
    after: afterBag,
    confidence: "detected",
    summary_en:
      kind === "rate"
        ? rateSummary(exchange, product, tier, false)
        : thresholdSummary(exchange, product, tier, false),
    summary_zh:
      kind === "rate"
        ? rateSummary(exchange, product, tier, true)
        : thresholdSummary(exchange, product, tier, true),
    note: detectedNote(false),
    detected_from_snapshot: ctx.fromId,
    detected_to_snapshot: ctx.toId,
  });
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "rung";
}

function pushStructureChange(args: {
  out: FeeChange[];
  exchange: string;
  product: "spot" | "futures";
  tier: string;
  added: boolean;
  rung?: SnapshotTier;
  ctx: DiffContext;
}): void {
  const { out, exchange, product, tier, added, rung, ctx } = args;
  const value: FeeChangeValue | undefined = rung
    ? Object.fromEntries(Object.entries(rung).filter(([k]) => k !== "tier"))
    : undefined;
  out.push({
    id: `${ctx.toId}-${exchange}-${product}-${slug(tier)}-${added ? "added" : "removed"}`,
    date: ctx.toId,
    exchange,
    product,
    kind: "ladder_structure",
    tier,
    field: `${product}.${tier}`,
    ...(added ? { after: value } : { before: value }),
    confidence: "detected",
    summary_en: added
      ? rungAddedSummary(exchange, product, tier, false)
      : rungRemovedSummary(exchange, product, tier, false),
    summary_zh: added
      ? rungAddedSummary(exchange, product, tier, true)
      : rungRemovedSummary(exchange, product, tier, true),
    note: detectedNote(false),
    detected_from_snapshot: ctx.fromId,
    detected_to_snapshot: ctx.toId,
  });
}

/**
 * Diff two monthly snapshots. Output ordering is deterministic
 * (venue, product, then structural/rate/threshold). Empty array = identical.
 */
export function diffSnapshots(from: LadderSnapshot, to: LadderSnapshot): FeeChange[] {
  const out: FeeChange[] = [];
  const ctx: DiffContext = { fromId: from.id, toId: to.id };
  const venues = new Set([...Object.keys(from.ladders), ...Object.keys(to.ladders)]);

  for (const exchange of [...venues].sort()) {
    const aVenue = from.ladders[exchange];
    const bVenue = to.ladders[exchange];
    for (const product of PRODUCTS) {
      const a = aVenue?.[product] ?? [];
      const b = bVenue?.[product] ?? [];
      if (a.length === 0 && b.length === 0) continue;

      // Whole product line appeared/disappeared at this venue.
      if (a.length === 0 || b.length === 0) {
        const count = Math.max(a.length, b.length);
        const appeared = b.length > 0;
        out.push({
          id: `${to.id}-${exchange}-${product}-${appeared ? "appeared" : "disappeared"}`,
          date: to.id,
          exchange,
          product,
          kind: "ladder_structure",
          field: product,
          ...(appeared ? { after: { rungs: String(count) } } : { before: { rungs: String(count) } }),
          confidence: "detected",
          summary_en: appeared
            ? ladderAppearedSummary(exchange, product, count, false)
            : ladderDisappearedSummary(exchange, product, count, false),
          summary_zh: appeared
            ? ladderAppearedSummary(exchange, product, count, true)
            : ladderDisappearedSummary(exchange, product, count, true),
          note: detectedNote(false),
          detected_from_snapshot: from.id,
          detected_to_snapshot: to.id,
        });
        continue;
      }

      const aMap = new Map(a.map((t) => [tierName(t), t]));
      const bMap = new Map(b.map((t) => [tierName(t), t]));

      for (const name of [...bMap.keys()].sort()) {
        if (!aMap.has(name)) {
          pushStructureChange({
            out, exchange, product, tier: name, added: true, rung: bMap.get(name), ctx,
          });
        }
      }
      for (const name of [...aMap.keys()].sort()) {
        if (!bMap.has(name)) {
          pushStructureChange({
            out, exchange, product, tier: name, added: false, rung: aMap.get(name), ctx,
          });
        }
      }

      for (const name of [...aMap.keys()].sort()) {
        const aTier = aMap.get(name);
        const bTier = bMap.get(name);
        if (!aTier || !bTier) continue;
        const fields = new Set([...Object.keys(aTier), ...Object.keys(bTier)].filter((k) => k !== "tier"));
        const rateDiffs: { field: string; before: number; after: number }[] = [];
        const thresholdDiffs: { field: string; before: number; after: number }[] = [];
        for (const field of [...fields].sort()) {
          const av = aTier[field];
          const bv = bTier[field];
          if (typeof av !== "number" || typeof bv !== "number") continue; // non-numeric edits surface via structure work
          // Rate fields are percent values whose effective precision is round4:
          // compare the rounded values so sub-bp noise never emits a change
          // whose before/after bag would be identical.
          if (RATE_FIELDS.has(field)) {
            if (round4(av) === round4(bv)) continue;
            rateDiffs.push({ field, before: av, after: bv });
          } else {
            if (av === bv) continue;
            thresholdDiffs.push({ field, before: av, after: bv });
          }
        }
        pushFieldBagChange({ out, exchange, product, tier: name, kind: "rate", diffs: rateDiffs, ctx });
        pushFieldBagChange({ out, exchange, product, tier: name, kind: "threshold", diffs: thresholdDiffs, ctx });
      }
    }
  }
  return out;
}

/** Sort snapshots by YYYY-MM id (missing/invalid ids sort first but are skipped upstream). */
export function sortSnapshots(snapshots: LadderSnapshot[]): LadderSnapshot[] {
  return [...snapshots].filter((s) => MONTH_RE.test(s.id)).sort((a, b) => a.id.localeCompare(b.id));
}

/** Diff every adjacent snapshot pair, collecting all detected changes. */
export function detectAllChanges(snapshots: LadderSnapshot[]): FeeChange[] {
  const sorted = sortSnapshots(snapshots);
  const out: FeeChange[] = [];
  for (let i = 1; i < sorted.length; i++) {
    out.push(...diffSnapshots(sorted[i - 1], sorted[i]));
  }
  return out;
}

/** Diff the current (live-in-repo) ladders against the most recent snapshot. */
export function detectCurrentDrift(
  feeRates: FeeRatesData,
  snapshots: LadderSnapshot[],
  now: Date = new Date(),
): { latest: LadderSnapshot | null; changes: FeeChange[] } {
  const sorted = sortSnapshots(snapshots);
  const latest = sorted[sorted.length - 1] ?? null;
  if (!latest) return { latest: null, changes: [] };
  const current: LadderSnapshot = {
    id: now.toISOString().slice(0, 7),
    captured_at: now.toISOString(),
    ladders: normalizeLadders(feeRates),
  };
  return { latest, changes: diffSnapshots(latest, current) };
}

// ---------- report assembly ----------

export interface BuildFeeChangeReportOptions {
  /** Curated feed. */
  curated: FeeChange[];
  /** Monthly ladder snapshots (any order; invalid ids ignored). */
  snapshots: LadderSnapshot[];
  exchange?: string;
  product?: FeeChangeProduct;
  /** YYYY-MM or YYYY-MM-DD: only changes on/after this month. */
  sinceMonth?: string;
  limit?: number;
  language?: "en" | "zh";
  now?: Date;
}

const CONFIDENCE_RANK: Record<FeeChangeConfidence, number> = {
  high: 0,
  medium: 1,
  detected: 2,
};

export function buildFeeChangeReport(opts: BuildFeeChangeReportOptions): FeeChangeReport {
  const lang = opts.language === "zh" ? "zh" : "en";
  const exchange = opts.exchange?.toLowerCase();
  const since = (opts.sinceMonth ?? "").slice(0, 7);

  const detected = detectAllChanges(opts.snapshots);
  const merged = [...opts.curated, ...detected].filter((c) => {
    if (exchange && c.exchange.toLowerCase() !== exchange) return false;
    if (opts.product && opts.product !== "all" && c.product !== "all" && c.product !== opts.product) {
      return false;
    }
    if (since && c.date.slice(0, 7) < since) return false;
    return true;
  });

  merged.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    const rank = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    if (rank !== 0) return rank;
    return a.id.localeCompare(b.id);
  });

  const limited =
    opts.limit && opts.limit > 0 ? merged.slice(0, Math.floor(opts.limit)) : merged;

  const sorted = sortSnapshots(opts.snapshots);
  const dataAsOf =
    sorted[sorted.length - 1]?.id ??
    (opts.curated.reduce((max, c) => (c.date.slice(0, 7) > max ? c.date.slice(0, 7) : max), "") ||
      "unknown");

  const advice =
    lang === "zh"
      ? "high/medium 记录已对照交易所官方公告核实并附来源链接；detected 记录由月度费率快照自动 diff 生成，可能是数据更正而非真实调整，行动前请以官方费率页核实。"
      : "Records marked high/medium are verified against official venue announcements and carry a source link; records marked detected are auto-generated from monthly ladder snapshots and may reflect data corrections rather than real fee changes — confirm against the official fee page before acting.";

  return {
    generated_at: (opts.now ?? new Date()).toISOString(),
    data_as_of: dataAsOf,
    snapshot_coverage: {
      months: sorted.length,
      ...(sorted.length > 0
        ? { first: sorted[0].id, last: sorted[sorted.length - 1].id }
        : {}),
      available: sorted.length > 0,
    },
    changes: limited,
    advice,
  };
}
