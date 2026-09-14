import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeTier,
  normalizeLadders,
  makeSnapshot,
  diffSnapshots,
  sortSnapshots,
  detectAllChanges,
  detectCurrentDrift,
  buildFeeChangeReport,
} from "../src/fee-history.js";
import { getFeeChanges, getFeeLadderSnapshots, resetCachesForTest } from "../src/data.js";
import { getFeeChangesReport } from "../src/tools.js";
import type { FeeRatesData, FeeChange, LadderSnapshot } from "../src/types.js";

// ---------- fixtures ----------

function bundle(venues: Record<string, unknown>): FeeRatesData {
  return { last_verified: "2026-09", exchanges: venues } as unknown as FeeRatesData;
}

const regular = (maker: number, taker: number, minVolume = 0) => ({
  tier: "Regular",
  maker,
  taker,
  min_volume_usd: minVolume,
});

function alphaBundle(opts: {
  spotMaker?: number;
  spotTaker?: number;
  regularThreshold?: number;
  withElite?: boolean;
  betaFutures?: boolean;
} = {}): FeeRatesData {
  const spot = [
    regular(opts.spotMaker ?? 0.1, opts.spotTaker ?? 0.1, opts.regularThreshold ?? 0),
    { tier: "VIP1", maker: 0.08, taker: 0.1, min_volume_usd: 50_000 },
  ];
  if (opts.withElite) {
    spot.splice(1, 0, { tier: "Elite", maker: 0.05, taker: 0.08, min_volume_usd: 500_000 });
  }
  const venues: Record<string, unknown> = {
    alpha: {
      spot,
      futures: [regular(0.02, 0.05)],
    },
  };
  if (opts.betaFutures) {
    venues.beta = { futures: [regular(0.01, 0.03)] };
  }
  return bundle(venues);
}

function snap(id: string, feeRates: FeeRatesData): LadderSnapshot {
  return makeSnapshot(id, feeRates, `${id}-15T00:00:00.000Z`);
}

function byKind(changes: FeeChange[], kind: string, field?: string): FeeChange[] {
  return changes.filter((c) => c.kind === kind && (field === undefined || c.field === field));
}

// ---------- tests ----------

describe("normalizeTier / normalizeLadders (snapshot fingerprints)", () => {
  it("keeps only scalar values and sorts keys deterministically", () => {
    const t = normalizeTier({
      min_volume_usd: 0,
      tier: "Regular",
      maker: 0.1,
      meta: { nested: true },
      flag: [1, 2],
    });
    expect(Object.keys(t)).toEqual(["maker", "min_volume_usd", "tier"]);
  });

  it("produces an identical fingerprint regardless of input key order", () => {
    const a = normalizeTier({ tier: "Regular", maker: 0.1, taker: 0.1 });
    const b = normalizeTier({ taker: 0.1, maker: 0.1, tier: "Regular" });
    expect(a).toEqual(b);
  });

  it("normalizes whole bundles with sorted venue keys and skips empty arrays", () => {
    const ladders = normalizeLadders(
      bundle({
        zeta: { spot: [regular(0.1, 0.1)], futures: [] },
        alpha: { spot: [regular(0.2, 0.2)] },
      }),
    );
    expect(Object.keys(ladders)).toEqual(["alpha", "zeta"]);
    expect(ladders.zeta.futures).toBeUndefined();
    expect(ladders.zeta.spot?.[0]).toEqual({ maker: 0.1, min_volume_usd: 0, taker: 0.1, tier: "Regular" });
  });
});

describe("makeSnapshot", () => {
  it("rejects ids that are not YYYY-MM", () => {
    expect(() => snap("2026-09-01", alphaBundle())).toThrow(/YYYY-MM/);
    expect(() => snap("2026-9", alphaBundle())).toThrow(/YYYY-MM/);
  });

  it("captures id, timestamp and normalized ladders", () => {
    const s = snap("2026-09", alphaBundle());
    expect(s.id).toBe("2026-09");
    expect(s.captured_at).toBe("2026-09-15T00:00:00.000Z");
    expect(s.ladders.alpha.spot).toHaveLength(2);
  });
});

describe("diffSnapshots", () => {
  it("returns no changes for identical snapshots", () => {
    const changes = diffSnapshots(snap("2026-08", alphaBundle()), snap("2026-09", alphaBundle()));
    expect(changes).toEqual([]);
  });

  it("detects a maker/taker rate change with round4-normalized before/after", () => {
    const changes = diffSnapshots(
      snap("2026-08", alphaBundle({ spotMaker: 0.1, spotTaker: 0.1 })),
      snap("2026-09", alphaBundle({ spotMaker: 0.09, spotTaker: 0.1 })),
    );
    const rate = byKind(changes, "rate", "spot.Regular.maker");
    expect(rate).toHaveLength(1);
    expect(rate[0].before).toEqual({ maker: 0.1 });
    expect(rate[0].after).toEqual({ maker: 0.09 });
    expect(rate[0].confidence).toBe("detected");
    expect(rate[0].detected_from_snapshot).toBe("2026-08");
    expect(rate[0].detected_to_snapshot).toBe("2026-09");
    expect(rate[0].summary_zh).toContain("自动检测");
  });

  it("ignores rate deltas below round4 granularity (0.1 vs 0.10004)", () => {
    const changes = diffSnapshots(
      snap("2026-08", alphaBundle({ spotMaker: 0.1 })),
      snap("2026-09", alphaBundle({ spotMaker: 0.10004 })),
    );
    expect(byKind(changes, "rate")).toEqual([]);
  });

  it("classifies min_volume_usd movement as a threshold change (unrounded)", () => {
    const changes = diffSnapshots(
      snap("2026-08", alphaBundle({ regularThreshold: 0 })),
      snap("2026-09", alphaBundle({ regularThreshold: 100 })),
    );
    const threshold = byKind(changes, "threshold", "spot.Regular.min_volume_usd");
    expect(threshold).toHaveLength(1);
    expect(threshold[0].before).toEqual({ min_volume_usd: 0 });
    expect(threshold[0].after).toEqual({ min_volume_usd: 100 });
  });

  it("detects rung insertion and removal matched by tier name", () => {
    const added = diffSnapshots(
      snap("2026-05", alphaBundle()),
      snap("2026-06", alphaBundle({ withElite: true })),
    );
    const add = byKind(added, "ladder_structure", "spot.Elite");
    expect(add).toHaveLength(1);
    expect(add[0].after).toEqual({ maker: 0.05, taker: 0.08, min_volume_usd: 500_000 });
    expect(add[0].before).toBeUndefined();

    const removed = diffSnapshots(
      snap("2026-06", alphaBundle({ withElite: true })),
      snap("2026-07", alphaBundle()),
    );
    const remove = byKind(removed, "ladder_structure", "spot.Elite");
    expect(remove).toHaveLength(1);
    expect(remove[0].before).toEqual({ maker: 0.05, taker: 0.08, min_volume_usd: 500_000 });
    expect(remove[0].after).toBeUndefined();
  });

  it("detects a whole product line appearing", () => {
    const changes = diffSnapshots(
      snap("2026-08", alphaBundle()),
      snap("2026-09", alphaBundle({ betaFutures: true })),
    );
    const appeared = changes.find((c) => c.exchange === "beta" && c.field === "futures");
    expect(appeared).toBeDefined();
    expect(appeared!.kind).toBe("ladder_structure");
    expect(appeared!.after).toEqual({ rungs: "1" });
  });

  it("skips non-numeric field edits on a matched rung", () => {
    const from = snap("2026-08", alphaBundle());
    const to = snap("2026-09", alphaBundle());
    (to.ladders.alpha.spot![0] as Record<string, string>).note = "renamed note";
    const changes = diffSnapshots(from, to);
    expect(changes).toEqual([]);
  });
});

describe("sortSnapshots / detectAllChanges / detectCurrentDrift", () => {
  it("filters invalid ids and sorts by month", () => {
    const s = [
      snap("2026-09", alphaBundle()),
      { ...snap("2026-07", alphaBundle()), id: "garbage" },
      snap("2026-07", alphaBundle()),
    ];
    expect(sortSnapshots(s).map((x) => x.id)).toEqual(["2026-07", "2026-09"]);
  });

  it("diffs only adjacent pairs across an out-of-order series", () => {
    const changes = detectAllChanges([
      snap("2026-09", alphaBundle({ spotTaker: 0.1 })),
      snap("2026-07", alphaBundle({ spotTaker: 0.12 })),
      snap("2026-08", alphaBundle({ spotTaker: 0.11 })),
    ]);
    const pairs = changes.map((c) => `${c.detected_from_snapshot}->${c.detected_to_snapshot}`);
    expect(pairs).toContain("2026-07->2026-08");
    expect(pairs).toContain("2026-08->2026-09");
    expect(pairs).not.toContain("2026-07->2026-09");
    expect(changes.every((c) => c.date === c.detected_to_snapshot)).toBe(true);
  });

  it("reports no drift without snapshots and the current month diff with one", () => {
    const rates = alphaBundle({ spotTaker: 0.09 });
    expect(detectCurrentDrift(rates, [], new Date("2026-10-05T00:00:00Z"))).toEqual({
      latest: null,
      changes: [],
    });
    const drift = detectCurrentDrift(
      rates,
      [snap("2026-09", alphaBundle())],
      new Date("2026-10-05T00:00:00Z"),
    );
    expect(drift.latest!.id).toBe("2026-09");
    expect(byKind(drift.changes, "rate", "spot.Regular.taker")).toHaveLength(1);
    expect(drift.changes[0].date).toBe("2026-10");
  });
});

describe("buildFeeChangeReport", () => {
  const curatedHigh: FeeChange = {
    id: "2026-05-alpha-cut",
    date: "2026-05-01",
    exchange: "alpha",
    product: "all",
    kind: "rate",
    summary_en: "Alpha cut fees",
    confidence: "high",
  };
  const curatedMedium: FeeChange = {
    id: "2026-09-beta-promo",
    date: "2026-09-01",
    exchange: "beta",
    product: "futures",
    kind: "promo",
    summary_en: "Beta promo",
    confidence: "medium",
  };

  it("merges curated + detected and sorts by date desc then confidence rank", () => {
    const report = buildFeeChangeReport({
      curated: [curatedHigh, curatedMedium],
      snapshots: [
        snap("2026-07", alphaBundle({ spotTaker: 0.1 })),
        snap("2026-08", alphaBundle({ spotTaker: 0.09 })),
      ],
      now: new Date("2026-09-01T00:00:00Z"),
    });
    expect(report.changes.map((c) => c.id)).toEqual([
      "2026-09-beta-promo",
      "2026-08-alpha-spot-regular-rate",
      "2026-05-alpha-cut",
    ]);
    expect(report.data_as_of).toBe("2026-08");
  });

  it("filters by exchange, product (all matches both), since_month and limit", () => {
    const opts = {
      curated: [curatedHigh, curatedMedium],
      snapshots: [
        snap("2026-07", alphaBundle({ spotTaker: 0.1 })),
        snap("2026-08", alphaBundle({ spotTaker: 0.09 })),
      ],
    };
    expect(buildFeeChangeReport({ ...opts, exchange: "alpha" }).changes.map((c) => c.exchange)).toEqual([
      "alpha",
      "alpha",
    ]);
    // curatedHigh product=all must survive a spot filter; detected spot rate too.
    expect(
      buildFeeChangeReport({ ...opts, product: "spot" }).changes.map((c) => c.id).sort(),
    ).toEqual(["2026-05-alpha-cut", "2026-08-alpha-spot-regular-rate"]);
    // beta promo is futures-only and must be filtered out for spot.
    expect(
      buildFeeChangeReport({ ...opts, product: "futures" }).changes.map((c) => c.id),
    ).toEqual(["2026-09-beta-promo", "2026-05-alpha-cut"]);
    expect(
      buildFeeChangeReport({ ...opts, sinceMonth: "2026-06" }).changes.map((c) => c.date),
    ).toEqual(["2026-09-01", "2026-08"]);
    expect(buildFeeChangeReport({ ...opts, limit: 1 }).changes).toHaveLength(1);
  });

  it("reports unavailable coverage with no snapshots and derives data_as_of from curated", () => {
    const report = buildFeeChangeReport({ curated: [curatedHigh], snapshots: [] });
    expect(report.snapshot_coverage).toEqual({ months: 0, available: false });
    expect(report.data_as_of).toBe("2026-05");
  });

  it("localizes advice for zh", () => {
    const en = buildFeeChangeReport({ curated: [], snapshots: [], language: "en" });
    const zh = buildFeeChangeReport({ curated: [], snapshots: [], language: "zh" });
    expect(en.advice).toContain("official fee page");
    expect(zh.advice).toContain("官方费率页");
  });
});

describe("data loaders degrade safely", () => {
  let dir: string;

  beforeEach(() => {
    resetCachesForTest();
    dir = mkdtempSync(join(tmpdir(), "feemcp-snap-"));
  });

  afterEach(() => {
    delete process.env.FEE_SNAPSHOTS_PATH;
    delete process.env.FEE_CHANGES_PATH;
    resetCachesForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  it("getFeeLadderSnapshots returns [] for a missing directory", () => {
    process.env.FEE_SNAPSHOTS_PATH = join(dir, "does-not-exist");
    expect(getFeeLadderSnapshots()).toEqual([]);
  });

  it("skips an unparseable snapshot but keeps valid siblings", () => {
    process.env.FEE_SNAPSHOTS_PATH = dir;
    writeFileSync(join(dir, "2026-09.json"), JSON.stringify(snap("2026-09", alphaBundle())));
    writeFileSync(join(dir, "2026-10.json"), "{ broken json");
    const snapshots = getFeeLadderSnapshots();
    expect(snapshots.map((s) => s.id)).toEqual(["2026-09"]);
  });

  it("getFeeChangesReport wires loaders through the tool layer end to end", () => {
    process.env.FEE_CHANGES_PATH = join(dir, "fee_changes.json");
    process.env.FEE_SNAPSHOTS_PATH = join(dir, "no-snapshots");
    writeFileSync(
      process.env.FEE_CHANGES_PATH,
      JSON.stringify({
        last_verified: "2026-09",
        sources: [{ name: "Official fee page", url: "https://example.test/fees" }],
        changes: [
          {
            id: "2026-09-alpha-change",
            date: "2026-09-02",
            exchange: "alpha",
            product: "spot",
            kind: "rate",
            summary_en: "Alpha adjusted spot fees",
            confidence: "high",
          },
        ],
      }),
    );
    // Sanity: the loader reads the override file.
    expect(getFeeChanges().changes).toHaveLength(1);
    const report = getFeeChangesReport({ language: "zh" });
    expect("error" in report).toBe(false);
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0].exchange).toBe("alpha");
    expect(report.snapshot_coverage.available).toBe(false);
    expect(report.advice).toContain("官方费率页");
  });
});
