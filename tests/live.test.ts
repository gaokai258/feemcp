import { describe, it, expect, beforeEach } from "vitest";
import {
  fetchFundingRatesLive,
  fetchExecutionCostLive,
  walkOrderBook,
  resolveSpotSymbol,
  resolveTradeSymbol,
  normalizeFundingPair,
  parseIntervalHours,
  resolveSwapSymbol,
  clearFundingCache,
  clearExecutionCache,
  type CcxtModule,
  type CcxtMarket,
  type CcxtExchange,
  type CcxtOrderBook,
} from "../src/live.js";
import {
  getFundingRates as getFundingRatesTool,
  getExecutionCost as getExecutionCostTool,
  calculateSavings,
  compareTotalCost,
  recommendExchange,
  calculateAnnualCost,
} from "../src/tools.js";
import { resetCachesForTest } from "../src/data.js";
import type { FundingOverrides, SpreadOverrides } from "../src/types.js";

// ---------- fake ccxt ----------

interface FakeConfig {
  markets: CcxtMarket[];
  rate?: number;
  interval?: string;
  fundingTs?: number;
  book?: CcxtOrderBook;
  bookBySymbol?: Record<string, CcxtOrderBook>;
  failAt?: "load" | "fetch" | "missing-rate" | "book";
  calls: number;
}

function makeFakeClass(config: FakeConfig): CcxtModule[string] {
  return class FakeExchange implements CcxtExchange {
    timeout = 30000;
    markets: Record<string, CcxtMarket> = {};

    constructor(settings?: Record<string, unknown>) {
      this.timeout = (settings?.timeout as number) ?? 30000;
      config.calls += 1;
    }

    async loadMarkets(): Promise<void> {
      if (config.failAt === "load") throw new Error("network down");
      for (const m of config.markets) this.markets[m.symbol] = m;
    }

    async fetchFundingRate(): Promise<{ fundingRate?: number; interval?: string; fundingTimestamp?: number }> {
      if (config.failAt === "fetch") throw new Error("rate fetch failed");
      if (config.failAt === "missing-rate") return { fundingRate: undefined, interval: config.interval };
      return {
        fundingRate: config.rate,
        interval: config.interval,
        ...(config.fundingTs !== undefined ? { fundingTimestamp: config.fundingTs } : {}),
      };
    }

    async fetchOrderBook(symbol: string): Promise<CcxtOrderBook> {
      if (config.failAt === "book") throw new Error("book fetch failed");
      const book = config.bookBySymbol?.[symbol] ?? config.book;
      if (!book) throw new Error(`no fake book for ${symbol}`);
      return book;
    }
  };
}

const BTC_USDT_PERP: CcxtMarket = {
  symbol: "BTC/USDT:USDT",
  base: "BTC",
  quote: "USDT",
  settle: "USDT",
  swap: true,
  linear: true,
};
const BTC_USD_PERP: CcxtMarket = {
  symbol: "BTC/USD:USD",
  base: "BTC",
  quote: "USD",
  settle: "USD",
  swap: true,
  linear: true,
};
const BTC_USDT_SPOT: CcxtMarket = {
  symbol: "BTC/USDT",
  base: "BTC",
  quote: "USDT",
  swap: false,
};

// Symmetric 1 bp half-spread around mid 100, huge top-level depth.
const TIGHT_BOOK: CcxtOrderBook = {
  asks: [[100.01, 1000]],
  bids: [[99.99, 1000]],
  timestamp: 1_700_000_000_000,
};
// Two ask levels of ~$50 each at 100.01 / 100.03; bids mirror at 99.99 / 99.97.
const TWO_LEVEL_BOOK: CcxtOrderBook = {
  asks: [
    [100.01, 0.5],
    [100.03, 0.5],
  ],
  bids: [
    [99.99, 0.5],
    [99.97, 0.5],
  ],
};
const SHALLOW_BOOK: CcxtOrderBook = {
  asks: [[100.01, 0.0001]],
  bids: [[99.99, 0.0001]],
};

function fakeCcxt(classes: Record<string, CcxtModule[string]>): { module: CcxtModule } {
  return { module: classes as CcxtModule };
}

beforeEach(() => {
  clearFundingCache();
  clearExecutionCache();
  resetCachesForTest();
});

// ---------- parsing helpers ----------

describe("normalizeFundingPair", () => {
  it("defaults to BTC/USDT", () => {
    expect(normalizeFundingPair(undefined)).toBe("BTC/USDT");
    expect(normalizeFundingPair("")).toBe("BTC/USDT");
  });
  it("normalizes free-form input", () => {
    expect(normalizeFundingPair("eth-usdt")).toBe("ETH/USDT");
    expect(normalizeFundingPair(" sol/usdt ")).toBe("SOL/USDT");
    expect(normalizeFundingPair("BTCUSD")).toBe("BTC/USD");
    expect(normalizeFundingPair("ETHUSDT")).toBe("ETH/USDT");
  });
});

describe("parseIntervalHours", () => {
  it("parses ccxt interval strings", () => {
    expect(parseIntervalHours("8h")).toBe(8);
    expect(parseIntervalHours("4h")).toBe(4);
    expect(parseIntervalHours("1d")).toBe(24);
    expect(parseIntervalHours("30m")).toBe(0.5);
  });
  it("returns undefined for missing/invalid input", () => {
    expect(parseIntervalHours(undefined)).toBeUndefined();
    expect(parseIntervalHours("soon")).toBeUndefined();
  });
});

describe("resolveSwapSymbol", () => {
  const markets: Record<string, CcxtMarket> = {
    [BTC_USDT_PERP.symbol]: BTC_USDT_PERP,
    "BTC/USDC:USDC": { symbol: "BTC/USDC:USDC", base: "BTC", quote: "USDC", settle: "USDC", swap: true, linear: true },
  };

  it("picks the exact linear perp", () => {
    expect(resolveSwapSymbol(markets, "BTC", "USDT")).toBe("BTC/USDT:USDT");
  });

  it("falls back to a same-base linear perp in another quote (Kraken USD)", () => {
    const usdOnly: Record<string, CcxtMarket> = { [BTC_USD_PERP.symbol]: BTC_USD_PERP };
    expect(resolveSwapSymbol(usdOnly, "BTC", "USDT")).toBe("BTC/USD:USD");
  });

  it("returns undefined when no swap exists for the base", () => {
    expect(resolveSwapSymbol(markets, "DOGE", "USDT")).toBeUndefined();
  });
});

// ---------- live fetching ----------

describe("fetchFundingRatesLive", () => {
  it("maps a live ccxt rate (decimal -> percent) with timestamp and interval", async () => {
    const binance = { calls: 0, markets: [BTC_USDT_PERP], rate: 0.0005, interval: "8h", fundingTs: 1_700_000_000_000 };
    const ccxt = fakeCcxt({ binance: makeFakeClass(binance) });
    const res = await fetchFundingRatesLive(["binance"], {
      deps: { createCcxt: async () => ccxt.module },
    });
    expect(res.pair).toBe("BTC/USDT");
    expect(res.rates.binance).toEqual({
      rate_pct: 0.05,
      interval_hours: 8,
      timestamp: new Date(1_700_000_000_000).toISOString(),
      source: "live",
    });
    expect(res.failures).toEqual([]);
  });

  it("passes negative funding rates through untouched", async () => {
    const okx = { calls: 0, markets: [BTC_USDT_PERP], rate: -0.0002, interval: "8h" };
    const ccxt = fakeCcxt({ okx: makeFakeClass(okx) });
    const res = await fetchFundingRatesLive(["okx"], {
      deps: { createCcxt: async () => ccxt.module },
    });
    expect(res.rates.okx?.rate_pct).toBe(-0.02);
    expect(res.rates.okx?.source).toBe("live");
  });

  it("falls back per-exchange to bundled values and records a failure", async () => {
    const binance = { calls: 0, markets: [BTC_USDT_PERP], rate: 0.0005, interval: "8h" };
    const gate = { calls: 0, markets: [BTC_USDT_PERP], failAt: "fetch" as const };
    const ccxt = fakeCcxt({
      binance: makeFakeClass(binance),
      gate: makeFakeClass(gate),
    });
    const res = await fetchFundingRatesLive(["binance", "gate"], {
      deps: { createCcxt: async () => ccxt.module },
    });
    expect(res.rates.binance?.source).toBe("live");
    expect(res.rates.gate).toEqual({ rate_pct: 0.01, interval_hours: 8, source: "bundled" });
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]).toMatchObject({ exchange: "gate", fallback: "bundled" });
  });

  it("uses the bundled interval when the exchange omits one", async () => {
    const binance = { calls: 0, markets: [BTC_USDT_PERP], rate: 0.0003, interval: undefined };
    const ccxt = fakeCcxt({ binance: makeFakeClass(binance) });
    const res = await fetchFundingRatesLive(["binance"], {
      deps: { createCcxt: async () => ccxt.module },
    });
    expect(res.rates.binance?.rate_pct).toBe(0.03);
    expect(res.rates.binance?.interval_hours).toBe(8);
  });

  it("caches responses within the TTL", async () => {
    const binance = { calls: 0, markets: [BTC_USDT_PERP], rate: 0.0001, interval: "8h" };
    const ccxt = fakeCcxt({ binance: makeFakeClass(binance) });
    const deps = { createCcxt: async () => ccxt.module };
    await fetchFundingRatesLive(["binance"], { deps });
    await fetchFundingRatesLive(["binance"], { deps });
    expect(binance.calls).toBe(1);
    clearFundingCache();
    await fetchFundingRatesLive(["binance"], { deps });
    expect(binance.calls).toBe(2);
  });

  it("maps our gate id to ccxt 'gate' and kraken to 'krakenfutures'", async () => {
    const gate = { calls: 0, markets: [BTC_USDT_PERP], rate: 0.0001, interval: "4h" };
    const krakenfutures = { calls: 0, markets: [BTC_USD_PERP], rate: 0.0002, interval: "8h" };
    const ccxt = fakeCcxt({
      gate: makeFakeClass(gate),
      krakenfutures: makeFakeClass(krakenfutures),
    });
    const deps = { createCcxt: async () => ccxt.module };
    const res = await fetchFundingRatesLive(["gate", "kraken"], { deps });
    // Gate settles the pair every 4h here; krakenfutures class only lists BTC/USD:USD,
    // so the same-base linear fallback must resolve it for a BTC/USDT request.
    expect(res.pair).toBe("BTC/USDT");
    expect(res.rates.gate?.interval_hours).toBe(4);
    expect(res.rates.kraken?.source).toBe("live");
    expect(res.failures).toEqual([]);
    expect(gate.calls).toBe(1);
    expect(krakenfutures.calls).toBe(1);
  });
});

// ---------- getFundingRates tool ----------

describe("getFundingRates tool", () => {
  it("bundled mode returns all 13 offline rows with no failures", async () => {
    const res = await getFundingRatesTool({});
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.mode).toBe("bundled");
    expect(res.pair).toBe("BTC/USDT");
    expect(res.rates).toHaveLength(13);
    expect(res.rates.every((r) => r.source === "bundled")).toBe(true);
    expect(res.failures).toEqual([]);
    expect(res.data_as_of).toBeTruthy();

    // v0.20: Hyperliquid settles hourly; bundled 0.00125%/1h = CEX 0.01%/8h.
    const hl = res.rates.find((r) => r.exchange === "hyperliquid");
    expect(hl).toMatchObject({ interval_hours: 1, rate_pct: 0.00125, source: "bundled" });

    // v0.21: BingX settles 8h at the standard CEX neutral average.
    const bx = res.rates.find((r) => r.exchange === "bingx");
    expect(bx).toMatchObject({ interval_hours: 8, rate_pct: 0.01, source: "bundled" });

    // v0.37: BloFin likewise settles 8h at 0.01%.
    const bf = res.rates.find((r) => r.exchange === "blofin");
    expect(bf).toMatchObject({ interval_hours: 8, rate_pct: 0.01, source: "bundled" });

    // v0.38: Bitstamp regulated perps (EU/EEA-only) likewise settle 8h P2P at 0.01%.
    const bs = res.rates.find((r) => r.exchange === "bitstamp");
    expect(bs).toMatchObject({ interval_hours: 8, rate_pct: 0.01, source: "bundled" });
  });

  it("v0.38: US country filter drops Bitstamp perps (EU/EEA-eligible product gate)", async () => {
    const res = await getFundingRatesTool({ country: "US" });
    if ("error" in res) throw new Error(res.error);
    expect(res.rates.find((r) => r.exchange === "bitstamp")).toBeUndefined();
    const de = await getFundingRatesTool({ country: "DE" });
    if ("error" in de) throw new Error(de.error);
    expect(de.rates.find((r) => r.exchange === "bitstamp")).toBeDefined();
  });

  it("filters by country (US -> gate, kraken, okx)", async () => {
    const res = await getFundingRatesTool({ country: "US" });
    if ("error" in res) throw new Error(res.error);
    expect(res.rates.map((r) => r.exchange).sort()).toEqual(["gate", "kraken", "okx"]);
  });

  it("rejects unknown exchanges", async () => {
    const res = await getFundingRatesTool({ exchanges: ["binance", "ftx"] });
    expect("error" in res).toBe(true);
    if (!("error" in res)) return;
    expect(res.code).toBe("UNKNOWN_EXCHANGE");
  });

  it("live mode merges fetched rates with bundled fallbacks", async () => {
    const binance = { calls: 0, markets: [BTC_USDT_PERP], rate: 0.0004, interval: "8h", fundingTs: 1_700_000_000_000 };
    const bybit = { calls: 0, markets: [BTC_USDT_PERP], failAt: "load" as const };
    const ccxt = fakeCcxt({
      binance: makeFakeClass(binance),
      bybit: makeFakeClass(bybit),
    });
    const res = await getFundingRatesTool(
      { fundingMode: "live", exchanges: ["binance", "bybit"] },
      { createCcxt: async () => ccxt.module },
    );
    if ("error" in res) throw new Error(res.error);
    expect(res.mode).toBe("live");
    const bn = res.rates.find((r) => r.exchange === "binance");
    const bb = res.rates.find((r) => r.exchange === "bybit");
    expect(bn?.source).toBe("live");
    expect(bn?.rate_pct).toBe(0.04);
    expect(bn?.funding_timestamp).toBe(new Date(1_700_000_000_000).toISOString());
    expect(bb?.source).toBe("bundled");
    expect(res.failures.map((f) => f.exchange)).toEqual(["bybit"]);
  });
});

// ---------- cost tools consume overrides ----------

describe("live funding overrides in cost tools", () => {
  const liveMap: FundingOverrides = {
    binance: {
      rate_pct: 0.05,
      interval_hours: 8,
      timestamp: "2026-09-12T00:00:00.000Z",
      source: "live",
    },
  };

  it("calculateSavings prices funding from the live override with provenance", () => {
    const res = calculateSavings("binance", 100_000, "futures", "JP", {
      holdingHours: 16,
      fundingRates: liveMap,
      fundingPair: "ETH/USDT",
    });
    if ("error" in res) throw new Error(res.error);
    expect(res.funding_cost).toBe(100);
    expect(res.funding_source).toBe("live");
    expect(res.funding_rate_ts).toBe("2026-09-12T00:00:00.000Z");
    expect(res.funding_pair).toBe("ETH/USDT");
  });

  it("calculateSavings without overrides keeps the bundled 0.01% average", () => {
    const res = calculateSavings("binance", 100_000, "futures", "JP", { holdingHours: 16 });
    if ("error" in res) throw new Error(res.error);
    expect(res.funding_cost).toBe(20);
    expect(res.funding_source).toBe("bundled");
    expect(res.funding_pair).toBeUndefined();
  });

  it("compareTotalCost tags each row with the funding source", () => {
    const res = compareTotalCost("futures", "JP", 100_000, {
      holdingHours: 16,
      fundingRates: liveMap,
    });
    if ("error" in res) throw new Error(res.error);
    const bn = res.find((r) => r.exchange === "binance");
    expect(bn?.funding_cost).toBe(100);
    expect(bn?.funding_source).toBe("live");
    const ok = res.find((r) => r.exchange === "okx");
    expect(ok?.funding_source).toBe("bundled");
  });

  it("calculateAnnualCost annualizes the live rate (12x monthly exposure)", () => {
    const res = calculateAnnualCost("binance", "futures", "JP", 100_000, {
      holdingHours: 720,
      fundingRates: liveMap,
    });
    if ("error" in res) throw new Error(res.error);
    // 100k * 0.05% * (720/8) * 12 = 54,000
    expect(res.annual_funding_cost).toBe(54000);
    expect(res.funding_source).toBe("live");
  });

  it("recommendExchange carries live provenance into every candidate", () => {
    const res = recommendExchange("futures", "JP", 100_000, {
      holdingHours: 16,
      fundingRates: liveMap,
    });
    if ("error" in res) throw new Error(res.error);
    const all = [res.best, ...res.alternatives];
    const bn = all.find((r) => r.exchange === "binance");
    expect(bn?.funding_source).toBe("live");
    expect(bn?.funding_cost).toBe(100);
    expect(all.filter((r) => r.funding_source === "bundled").length).toBeGreaterThan(0);
  });
});

// =====================================================================
// v0.16: order-book walk + execution cost
// =====================================================================

describe("walkOrderBook pure math", () => {
  it("charges half the spread to cross, with no impact inside top depth", () => {
    const buy = walkOrderBook(TIGHT_BOOK, 10_000, "buy");
    expect(buy.mid).toBe(100);
    expect(buy.spread_bps).toBe(2);
    expect(buy.crossing_bps).toBe(1);
    expect(buy.slippage_bps).toBe(0);
    expect(buy.total_bps).toBe(1);
    expect(buy.levels_consumed).toBe(1);
    expect(buy.fully_filled).toBe(true);

    const sell = walkOrderBook(TIGHT_BOOK, 10_000, "sell");
    expect(sell.crossing_bps).toBe(1);
    expect(sell.slippage_bps).toBe(0);
    expect(sell.total_bps).toBe(1);
  });

  it("walks multiple levels and measures VWAP impact beyond the touch", () => {
    // Full two-level consumption: notional 100.02, base 1.0 -> VWAP exactly 100.02.
    const buy = walkOrderBook(TWO_LEVEL_BOOK, 100.02, "buy");
    expect(buy.levels_consumed).toBe(2);
    expect(buy.crossing_bps).toBe(1);
    expect(buy.slippage_bps).toBe(1);
    expect(buy.total_bps).toBe(2);
    expect(buy.fully_filled).toBe(true);

    const sell = walkOrderBook(TWO_LEVEL_BOOK, 99.98, "sell");
    expect(sell.levels_consumed).toBe(2);
    expect(sell.crossing_bps).toBe(1);
    expect(sell.slippage_bps).toBe(1);
    expect(sell.total_bps).toBe(2);
  });

  it("reports partial fill against visible depth", () => {
    const walk = walkOrderBook(SHALLOW_BOOK, 10_000, "buy");
    expect(walk.fully_filled).toBe(false);
    expect(walk.levels_consumed).toBe(1);
    expect(walk.available_depth_usd).toBe(0.01);
    // Impact cannot be measured beyond visible depth; crossing still counts.
    expect(walk.slippage_bps).toBe(0);
    expect(walk.total_bps).toBe(1);
  });

  it("throws on an empty or one-sided book", () => {
    expect(() => walkOrderBook({ asks: [], bids: [] }, 1000, "buy")).toThrow();
    expect(() => walkOrderBook({ asks: TIGHT_BOOK.asks, bids: [] }, 1000, "sell")).toThrow();
  });
});

describe("resolveSpotSymbol", () => {
  it("picks the spot market when spot and swap share the BASE/QUOTE name", () => {
    const markets: Record<string, CcxtMarket> = {
      [BTC_USDT_SPOT.symbol]: BTC_USDT_SPOT,
      [BTC_USDT_PERP.symbol]: BTC_USDT_PERP,
    };
    expect(resolveSpotSymbol(markets, "BTC", "USDT")).toBe("BTC/USDT");
  });

  it("returns undefined when only a swap exists", () => {
    const markets: Record<string, CcxtMarket> = { [BTC_USDT_PERP.symbol]: BTC_USDT_PERP };
    expect(resolveSpotSymbol(markets, "BTC", "USDT")).toBeUndefined();
  });

  it("falls back to a same-base spot market (USDC when USDT requested)", () => {
    const btcUsdc: CcxtMarket = { symbol: "BTC/USDC", base: "BTC", quote: "USDC", swap: false };
    const markets: Record<string, CcxtMarket> = { [btcUsdc.symbol]: btcUsdc };
    expect(resolveSpotSymbol(markets, "BTC", "USDT")).toBe("BTC/USDC");
  });

  it("resolveTradeSymbol dispatches spot vs swap", () => {
    const markets: Record<string, CcxtMarket> = {
      [BTC_USDT_SPOT.symbol]: BTC_USDT_SPOT,
      [BTC_USDT_PERP.symbol]: BTC_USDT_PERP,
    };
    expect(resolveTradeSymbol(markets, "BTC", "USDT", "spot")).toBe("BTC/USDT");
    expect(resolveTradeSymbol(markets, "BTC", "USDT", "futures")).toBe("BTC/USDT:USDT");
  });
});

describe("fetchExecutionCostLive", () => {
  it("maps a live book walk with provenance and symbol", async () => {
    const binance = { calls: 0, markets: [BTC_USDT_PERP], book: TIGHT_BOOK };
    const ccxt = fakeCcxt({ binance: makeFakeClass(binance) });
    const res = await fetchExecutionCostLive(["binance"], {
      purpose: "futures",
      side: "buy",
      tradeSizeUsd: 10_000,
      deps: { createCcxt: async () => ccxt.module },
    });
    expect(res.pair).toBe("BTC/USDT");
    expect(res.purpose).toBe("futures");
    expect(res.side).toBe("buy");
    expect(res.trade_size_usd).toBe(10_000);
    expect(res.costs.binance).toMatchObject({
      crossing_bps: 1,
      slippage_bps: 0,
      total_bps: 1,
      levels_consumed: 1,
      fully_filled: true,
      source: "live",
      symbol: "BTC/USDT:USDT",
    });
    expect(res.costs.binance?.timestamp).toBe(new Date(1_700_000_000_000).toISOString());
    expect(res.failures).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it("walks depth for a size that consumes multiple levels", async () => {
    const okx = { calls: 0, markets: [BTC_USDT_PERP], book: TWO_LEVEL_BOOK };
    const ccxt = fakeCcxt({ okx: makeFakeClass(okx) });
    const res = await fetchExecutionCostLive(["okx"], {
      tradeSizeUsd: 100.02,
      deps: { createCcxt: async () => ccxt.module },
    });
    expect(res.costs.okx?.slippage_bps).toBe(1);
    expect(res.costs.okx?.total_bps).toBe(2);
    expect(res.costs.okx?.levels_consumed).toBe(2);
  });

  it("keeps the measured cost with a warning when depth is insufficient", async () => {
    const binance = { calls: 0, markets: [BTC_USDT_PERP], book: SHALLOW_BOOK };
    const ccxt = fakeCcxt({ binance: makeFakeClass(binance) });
    const res = await fetchExecutionCostLive(["binance"], {
      tradeSizeUsd: 10_000,
      deps: { createCcxt: async () => ccxt.module },
    });
    expect(res.costs.binance?.source).toBe("live");
    expect(res.costs.binance?.fully_filled).toBe(false);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatchObject({ exchange: "binance" });
    expect(res.failures).toEqual([]);
  });

  it("falls back to the bundled baseline when the book fetch fails", async () => {
    const binance = { calls: 0, markets: [BTC_USDT_PERP], failAt: "book" as const };
    const ccxt = fakeCcxt({ binance: makeFakeClass(binance) });
    const res = await fetchExecutionCostLive(["binance"], {
      tradeSizeUsd: 10_000,
      deps: { createCcxt: async () => ccxt.module },
    });
    expect(res.costs.binance).toMatchObject({ crossing_bps: 0.5, source: "bundled" });
    expect(res.failures).toEqual([
      expect.objectContaining({ exchange: "binance", fallback: "bundled" }),
    ]);
    expect(res.warnings).toEqual([]);
  });

  it("routes spot requests to the spot ccxt class (kucoin, not kucoinfutures)", async () => {
    const kucoinSpot = {
      calls: 0,
      markets: [BTC_USDT_SPOT],
      bookBySymbol: { "BTC/USDT": TIGHT_BOOK },
    };
    const kucoinFuts = {
      calls: 0,
      markets: [BTC_USDT_PERP],
      book: TWO_LEVEL_BOOK,
    };
    const ccxt = fakeCcxt({
      kucoin: makeFakeClass(kucoinSpot),
      kucoinfutures: makeFakeClass(kucoinFuts),
    });
    const deps = { createCcxt: async () => ccxt.module };

    const spot = await fetchExecutionCostLive(["kucoin"], { purpose: "spot", tradeSizeUsd: 10_000, deps });
    expect(spot.costs.kucoin?.symbol).toBe("BTC/USDT");
    expect(spot.costs.kucoin?.source).toBe("live");
    expect(kucoinSpot.calls).toBe(1);
    expect(kucoinFuts.calls).toBe(0);

    const futs = await fetchExecutionCostLive(["kucoin"], { purpose: "futures", tradeSizeUsd: 10_000, deps });
    expect(futs.costs.kucoin?.symbol).toBe("BTC/USDT:USDT");
    expect(kucoinFuts.calls).toBe(1);
  });

  it("caches live walks within the 30s TTL per (purpose, side, size, pair, exchanges)", async () => {
    const binance = { calls: 0, markets: [BTC_USDT_PERP], book: TIGHT_BOOK };
    const ccxt = fakeCcxt({ binance: makeFakeClass(binance) });
    const opts = { tradeSizeUsd: 10_000, deps: { createCcxt: async () => ccxt.module } };
    await fetchExecutionCostLive(["binance"], opts);
    await fetchExecutionCostLive(["binance"], opts);
    expect(binance.calls).toBe(1);
    clearExecutionCache();
    await fetchExecutionCostLive(["binance"], { ...opts, noCache: false });
    expect(binance.calls).toBe(2);
  });
});

describe("getExecutionCost tool", () => {
  it("bundled mode returns all 13 rows from typical-spread baselines", async () => {
    const res = await getExecutionCostTool({});
    if ("error" in res) throw new Error(res.error);
    expect(res.mode).toBe("bundled");
    expect(res.purpose).toBe("futures");
    expect(res.side).toBe("buy");
    expect(res.trade_size_usd).toBe(10_000);
    expect(res.costs).toHaveLength(13);
    expect(res.failures).toEqual([]);

    const bn = res.costs.find((c) => c.exchange === "binance");
    expect(bn).toMatchObject({
      spread_bps: 1,
      crossing_bps: 0.5,
      slippage_bps: 0,
      total_bps: 0.5,
      cost_usd: 0.5,
      pair_class: "majors",
      source: "bundled",
    });
    expect(bn?.note).toBeTruthy();

    // Kraken's typical BTC spread is ~5 bps -> 2.5 bps crossing on $10k = $2.5.
    const kr = res.costs.find((c) => c.exchange === "kraken");
    expect(kr).toMatchObject({ spread_bps: 5, crossing_bps: 2.5, cost_usd: 2.5 });

    // v0.20: Hyperliquid BTC perp book measured 0.82 bps -> bundled 0.8.
    const hl = res.costs.find((c) => c.exchange === "hyperliquid");
    expect(hl).toMatchObject({ spread_bps: 0.8, crossing_bps: 0.4, cost_usd: 0.4, source: "bundled" });

    // v0.21: BingX typical BTC spread 4 bps -> 2 bps crossing on $10k = $2.
    const bx = res.costs.find((c) => c.exchange === "bingx");
    expect(bx).toMatchObject({ spread_bps: 4, crossing_bps: 2, slippage_bps: 0, total_bps: 2, cost_usd: 2, source: "bundled" });

    // v0.37: BloFin typical BTC perp spread 3 bps -> 1.5 bps crossing on $1k = $1.5.
    const bf = res.costs.find((c) => c.exchange === "blofin");
    expect(bf).toMatchObject({ spread_bps: 3, crossing_bps: 1.5, slippage_bps: 0, total_bps: 1.5, cost_usd: 1.5, source: "bundled" });

    // v0.38: Bitstamp regulated majors ~2 bps -> 1 bps crossing on $10k = $1.
    const bs = res.costs.find((c) => c.exchange === "bitstamp");
    expect(bs).toMatchObject({ spread_bps: 2, crossing_bps: 1, slippage_bps: 0, total_bps: 1, cost_usd: 1, source: "bundled" });
  });

  it("v0.19: spot mode includes Coinbase at its 2 bps baseline; futures mode excludes it", async () => {
    const spot = await getExecutionCostTool({ purpose: "spot", exchanges: ["coinbase"] });
    if ("error" in spot) throw new Error(spot.error);
    expect(spot.costs[0]).toMatchObject({
      exchange: "coinbase",
      spread_bps: 2,
      crossing_bps: 1,
      slippage_bps: 0,
      total_bps: 1,
      cost_usd: 1,
      pair_class: "majors",
      source: "bundled",
    });

    // Spot-only venue silently drops out of futures comparisons.
    const fut = await getExecutionCostTool({ exchanges: ["coinbase"] });
    if ("error" in fut) throw new Error(fut.error);
    expect(fut.costs).toHaveLength(0);
    expect(fut.failures).toEqual([]);
  });

  it("scales cost with order size", async () => {
    const res = await getExecutionCostTool({ tradeSizeUsd: 20_000, exchanges: ["binance"] });
    if ("error" in res) throw new Error(res.error);
    expect(res.costs[0].cost_usd).toBe(1);
  });

  it("classifies alt pairs into large-cap vs mid-alt spread tiers", async () => {
    // DOGE is on the large-cap list: 1.5x -> full 1.5 bps, crossing 0.75.
    const doge = await getExecutionCostTool({ pair: "DOGE/USDT", exchanges: ["binance"] });
    if ("error" in doge) throw new Error(doge.error);
    expect(doge.costs[0]).toMatchObject({ pair_class: "large_cap", spread_bps: 1.5, crossing_bps: 0.75 });

    const sol = await getExecutionCostTool({ pair: "SOL/USDT", exchanges: ["binance"] });
    if ("error" in sol) throw new Error(sol.error);
    expect(sol.costs[0].pair_class).toBe("large_cap");

    // PEPE is outside the majors/large-cap lists: mid_alt 3x -> full 3 bps.
    const pepe = await getExecutionCostTool({ pair: "PEPE/USDT", exchanges: ["binance"] });
    if ("error" in pepe) throw new Error(pepe.error);
    expect(pepe.costs[0]).toMatchObject({ pair_class: "mid_alt", spread_bps: 3, crossing_bps: 1.5 });
  });

  it("filters by country (US -> gate, kraken, okx)", async () => {
    const res = await getExecutionCostTool({ country: "US" });
    if ("error" in res) throw new Error(res.error);
    expect(res.costs.map((c) => c.exchange).sort()).toEqual(["gate", "kraken", "okx"]);
  });

  it("rejects unknown exchanges", async () => {
    const res = await getExecutionCostTool({ exchanges: ["binance", "ftx"] });
    expect("error" in res).toBe(true);
    if (!("error" in res)) return;
    expect(res.code).toBe("UNKNOWN_EXCHANGE");
  });

  it("live mode merges book walks with bundled fallbacks and surfaces warnings", async () => {
    const binance = { calls: 0, markets: [BTC_USDT_PERP], book: TIGHT_BOOK };
    const bybit = { calls: 0, markets: [BTC_USDT_PERP], failAt: "book" as const };
    const ccxt = fakeCcxt({
      binance: makeFakeClass(binance),
      bybit: makeFakeClass(bybit),
    });
    const res = await getExecutionCostTool(
      { spreadMode: "live", exchanges: ["binance", "bybit"], tradeSizeUsd: 10_000 },
      { createCcxt: async () => ccxt.module },
    );
    if ("error" in res) throw new Error(res.error);
    expect(res.mode).toBe("live");
    const bn = res.costs.find((c) => c.exchange === "binance");
    const bb = res.costs.find((c) => c.exchange === "bybit");
    expect(bn?.source).toBe("live");
    expect(bn?.spread_bps).toBe(2);
    expect(bn?.cost_usd).toBe(1);
    expect(bn?.book_timestamp).toBe(new Date(1_700_000_000_000).toISOString());
    expect(bb?.source).toBe("bundled");
    expect(bb?.spread_bps).toBe(1.2);
    expect(bb?.crossing_bps).toBe(0.6);
    expect(res.failures.map((f) => f.exchange)).toEqual(["bybit"]);
  });
});

// ---------- execution cost inside the four cost tools ----------

describe("execution cost in the cost tools", () => {
  const liveSpread: SpreadOverrides = {
    binance: {
      crossing_bps: 2,
      slippage_bps: 1,
      total_bps: 3,
      timestamp: "2026-09-12T00:00:00.000Z",
      source: "live",
      fully_filled: true,
    },
  };

  it("calculateSavings adds bundled half-spread crossing when tradeSizeUsd is given", () => {
    const res = calculateSavings("binance", 100_000, "futures", "JP", { tradeSizeUsd: 10_000 });
    if ("error" in res) throw new Error(res.error);
    expect(res.spread_cost).toBe(0.5);
    expect(res.slippage_cost).toBeUndefined();
    expect(res.spread_source).toBe("bundled");
    expect(res.spread_ts).toBeUndefined();
  });

  it("calculateSavings omits execution cost without an order size", () => {
    const res = calculateSavings("binance", 100_000, "futures", "JP");
    if ("error" in res) throw new Error(res.error);
    expect(res.spread_cost).toBeUndefined();
    expect(res.spread_source).toBeUndefined();
  });

  it("calculateSavings prices live crossing + slippage with provenance", () => {
    const res = calculateSavings("binance", 100_000, "futures", "JP", {
      tradeSizeUsd: 10_000,
      spreadRates: liveSpread,
      spreadPair: "ETH/USDT",
    });
    if ("error" in res) throw new Error(res.error);
    expect(res.spread_cost).toBe(2);
    expect(res.slippage_cost).toBe(1);
    expect(res.spread_source).toBe("live");
    expect(res.spread_ts).toBe("2026-09-12T00:00:00.000Z");
    expect(res.spread_pair).toBe("ETH/USDT");
  });

  it("compareTotalCost charges execution on every row and folds it into total", () => {
    const res = compareTotalCost("futures", "JP", 100_000, { tradeSizeUsd: 10_000 });
    if ("error" in res) throw new Error(res.error);
    const bn = res.find((r) => r.exchange === "binance");
    const kr = res.find((r) => r.exchange === "kraken");
    expect(bn?.spread_cost).toBe(0.5);
    expect(kr?.spread_cost).toBe(2.5);
    for (const row of res) {
      const exec = (row.spread_cost ?? 0) + (row.slippage_cost ?? 0);
      expect(row.total_cost).toBeGreaterThanOrEqual(
        (row.trading_fee ?? 0) + (row.funding_cost ?? 0) + (row.withdrawal_cost ?? 0) + exec - 0.01,
      );
    }

    const without = compareTotalCost("futures", "JP", 100_000);
    if ("error" in without) throw new Error(without.error);
    expect(without.every((r) => r.spread_cost === undefined)).toBe(true);
  });

  it("calculateAnnualCost annualizes spread crossing over 12x monthly volume", () => {
    const res = calculateAnnualCost("binance", "futures", "JP", 100_000, { tradeSizeUsd: 10_000 });
    if ("error" in res) throw new Error(res.error);
    // $1.2m annual notional * 0.5 bps = $60.
    expect(res.annual_spread_cost).toBe(60);
    expect(res.annual_slippage_cost).toBeUndefined();
    expect(res.spread_source).toBe("bundled");
    // binance futures at 100k/month resolves to 0.04% taker: 100k * 0.04% * 12 = 480.
    expect(res.annual_trading_fee).toBe(480);
    expect(res.annual_total_cost).toBe(540);

    const live = calculateAnnualCost("binance", "futures", "JP", 100_000, {
      tradeSizeUsd: 10_000,
      spreadRates: liveSpread,
      spreadPair: "ETH/USDT",
    });
    if ("error" in live) throw new Error(live.error);
    expect(live.annual_spread_cost).toBe(240);
    expect(live.annual_slippage_cost).toBe(120);
    expect(live.annual_total_cost).toBe(840);
    expect(live.spread_source).toBe("live");
    expect(live.spread_pair).toBe("ETH/USDT");
  });

  it("recommendExchange factors execution cost into the ranking with reasons", () => {
    const res = recommendExchange("futures", "JP", 100_000, { tradeSizeUsd: 10_000 });
    if ("error" in res) throw new Error(res.error);
    const all = [res.best, ...res.alternatives];
    expect(all.every((r) => r.spread_cost !== undefined)).toBe(true);
    const bn = all.find((r) => r.exchange === "binance");
    const kr = all.find((r) => r.exchange === "kraken");
    expect(bn?.spread_cost).toBe(0.5);
    expect(kr?.spread_cost).toBe(2.5);
    const text = [
      ...res.best.reasons,
      ...(res.best.tradeoffs ?? []),
      res.advice,
    ]
      .join(" ")
      .toLowerCase();
    expect(text).toContain("spread");
  });
});
