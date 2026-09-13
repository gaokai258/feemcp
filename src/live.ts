// v0.15: real-time funding-rate adapter.
//
// Bundled funding_rates.json only carries a long-run neutral average (0.01%/8h).
// This module fetches the CURRENT funding rate per venue via ccxt so callers can
// price the actual market they trade in right now.
//
// Design constraints:
// - ccxt is imported dynamically so bundled-only users pay no startup cost.
// - Every exchange is fetched independently; a failure (timeout, geo-block,
//   unsupported pair) degrades THAT venue to its bundled average and is recorded
//   in `failures`. The function never throws for per-exchange problems.
// - Results are TTL-cached in memory (funding only settles every few hours).
// - Negative rates pass through untouched (longs get paid).

import { getFundingRate, getSpreadEstimate } from "./data.js";
import type {
  FundingOverrides,
  FundingRateFailure,
  SpreadOverrides,
  SpreadOverride,
  ExecutionCostFailure,
  ExecutionCostWarning,
  TradingPurpose,
} from "./types.js";

// Our internal exchange id -> ccxt exchange id.
// ccxt 4.5 renamed Gate.io to "gate"; KuCoin/Kraken futures live in dedicated
// classes (the spot classes cannot fetch funding rates).
const CCXT_IDS: Record<string, string> = {
  binance: "binance",
  okx: "okx",
  gate: "gate",
  bybit: "bybit",
  mexc: "mexc",
  bitget: "bitget",
  kucoin: "kucoinfutures",
  kraken: "krakenfutures",
  hyperliquid: "hyperliquid",
  bingx: "bingx",
};

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// ---------- minimal structural view of the ccxt surface we use ----------

export interface CcxtMarket {
  symbol: string;
  base?: string;
  quote?: string;
  settle?: string;
  swap?: boolean;
  linear?: boolean;
}

export interface CcxtFundingRate {
  fundingRate?: number;
  interval?: string;
  fundingTimestamp?: number;
}

/** ccxt order book: levels are [price, base-amount] pairs (asks ascending, bids descending). */
export interface CcxtOrderBook {
  asks: [number, number][];
  bids: [number, number][];
  timestamp?: number;
}

export interface CcxtExchange {
  timeout: number;
  markets: Record<string, CcxtMarket>;
  loadMarkets(): Promise<unknown>;
  fetchFundingRate(symbol: string): Promise<CcxtFundingRate>;
  fetchOrderBook(symbol: string, limit?: number): Promise<CcxtOrderBook>;
}

export type CcxtModule = Record<
  string,
  new (settings?: Record<string, unknown>) => CcxtExchange
>;

export interface LiveDeps {
  /** Test seam: return a fake ccxt module instead of the real dynamic import. */
  createCcxt?: () => Promise<CcxtModule>;
}

export interface FetchLiveOptions {
  /** Perpetual pair, e.g. "BTC/USDT" (default), "ETH-USDT", "ETHUSD". */
  pair?: string;
  timeoutMs?: number;
  ttlMs?: number;
  /** Bypass the in-memory TTL cache. */
  noCache?: boolean;
  /** Test seam / injection point for a fake ccxt module. */
  deps?: LiveDeps;
}

export interface LiveFundingResponse {
  pair: string;
  fetched_at: string;
  /** Every requested exchange is present — live values or bundled fallbacks. */
  rates: FundingOverrides;
  failures: FundingRateFailure[];
}

// ---------- pair / interval parsing ----------

const FUNDING_QUOTES = ["USDT", "USDC", "FDUSD", "TUSD", "BUSD", "USD"];

/** Normalize free-form pair input to "BASE/QUOTE"; defaults to BTC/USDT. */
export function normalizeFundingPair(pair?: string): string {
  if (!pair) return "BTC/USDT";
  const compact = pair
    .trim()
    .toUpperCase()
    .replace(/[/_\-\s:]+/g, "");
  if (!compact) return "BTC/USDT";
  for (const q of FUNDING_QUOTES) {
    if (compact.endsWith(q) && compact.length > q.length) {
      return `${compact.slice(0, -q.length)}/${q}`;
    }
  }
  return `${compact}/USDT`;
}

const INTERVAL_UNIT_HOURS: Record<string, number> = {
  s: 1 / 3600,
  m: 1 / 60,
  h: 1,
  d: 24,
  w: 168,
};

/** Parse ccxt interval strings ("8h", "4h", "1h", "1d") to hours. */
export function parseIntervalHours(interval: string | undefined): number | undefined {
  if (!interval) return undefined;
  const m = String(interval)
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*([smhdw])$/);
  if (!m) return undefined;
  const hours = parseFloat(m[1]) * INTERVAL_UNIT_HOURS[m[2]];
  return Number.isFinite(hours) && hours > 0 ? hours : undefined;
}

/**
 * Pick the exchange's linear perpetual symbol for base/quote. Prefers an exact
 * BASE/QUOTE:QUOTE match, then any linear same-base/same-quote market, and
 * finally a same-base linear swap in another quote (e.g. Kraken BTC/USD:USD when
 * BTC/USDT:USDT does not exist on the venue).
 */
export function resolveSwapSymbol(
  markets: Record<string, CcxtMarket>,
  base: string,
  quote: string,
): string | undefined {
  const all = Object.values(markets);
  const exact = `${base}/${quote}:${quote}`;
  if (markets[exact]?.swap) return exact;

  const sameBq = all.filter((m) => m.swap && m.base === base && m.quote === quote);
  const exactPair =
    sameBq.find((m) => m.linear && m.settle === quote) ??
    sameBq.find((m) => m.linear) ??
    sameBq[0];
  if (exactPair) return exactPair.symbol;

  const sameBase = all.filter((m) => m.swap && m.base === base);
  const fallback =
    sameBase.find((m) => m.linear && (m.quote === "USDT" || m.quote === "USD")) ??
    sameBase.find((m) => m.linear) ??
    sameBase[0];
  return fallback?.symbol;
}

// ---------- ccxt module cache + result TTL cache ----------

let ccxtModulePromise: Promise<CcxtModule> | null = null;

async function loadCcxt(deps?: LiveDeps): Promise<CcxtModule> {
  if (deps?.createCcxt) return deps.createCcxt();
  if (!ccxtModulePromise) {
    // Heavy dependency: only loaded on the first live request.
    ccxtModulePromise = import("ccxt") as unknown as Promise<CcxtModule>;
  }
  return ccxtModulePromise;
}

interface CacheEntry {
  at: number;
  response: LiveFundingResponse;
}

const resultCache = new Map<string, CacheEntry>();

export function clearFundingCache(): void {
  resultCache.clear();
}

/** Visible for tests. */
export function _resetCcxtModuleCache(): void {
  ccxtModulePromise = null;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Fetch current funding rates for the given exchanges.
 * Never throws: per-exchange failures fall back to bundled averages.
 */
export async function fetchFundingRatesLive(
  exchanges: string[],
  opts: FetchLiveOptions = {},
): Promise<LiveFundingResponse> {
  const pair = normalizeFundingPair(opts.pair);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cacheKey = `${pair}|${exchanges.map((e) => e.toLowerCase()).join(",")}`;

  if (!opts.noCache) {
    const cached = resultCache.get(cacheKey);
    if (cached && Date.now() - cached.at < ttlMs) {
      return cached.response;
    }
  }

  const [base, quote] = pair.split("/");
  const rates: FundingOverrides = {};
  const failures: FundingRateFailure[] = [];

  let ccxtModule: CcxtModule | null = null;
  let moduleError: string | null = null;
  try {
    ccxtModule = await loadCcxt(opts.deps);
  } catch (err) {
    moduleError = err instanceof Error ? err.message : String(err);
  }

  await Promise.all(
    exchanges.map(async (rawExchange): Promise<void> => {
      const exchange = rawExchange.toLowerCase();
      const bundled = getFundingRate(exchange);
      const failWithBundled = (error: string): void => {
        failures.push({ exchange, error, fallback: "bundled" });
        if (bundled) {
          rates[exchange] = {
            rate_pct: bundled.avg_rate_pct,
            interval_hours: bundled.interval_hours,
            source: "bundled",
          };
        }
      };

      if (!ccxtModule) {
        failWithBundled(moduleError ?? "ccxt module unavailable");
        return;
      }

      try {
        const ccxtId = CCXT_IDS[exchange] ?? exchange;
        const Klass = ccxtModule[ccxtId];
        if (!Klass) throw new Error(`ccxt has no exchange '${ccxtId}'`);
        const client = new Klass({ timeout: timeoutMs, enableRateLimit: true });
        await client.loadMarkets();
        const symbol = resolveSwapSymbol(client.markets, base, quote);
        if (!symbol) {
          throw new Error(`no linear perpetual for ${pair} on ${ccxtId}`);
        }
        const fr = await client.fetchFundingRate(symbol);
        if (fr.fundingRate === undefined || !Number.isFinite(fr.fundingRate)) {
          throw new Error(`exchange returned no funding rate for ${symbol}`);
        }
        const intervalHours =
          parseIntervalHours(fr.interval) ?? bundled?.interval_hours ?? 8;
        rates[exchange] = {
          rate_pct: round6(fr.fundingRate * 100),
          interval_hours: intervalHours,
          ...(fr.fundingTimestamp && Number.isFinite(fr.fundingTimestamp)
            ? { timestamp: new Date(fr.fundingTimestamp).toISOString() }
            : {}),
          source: "live",
        };
      } catch (err) {
        failWithBundled(err instanceof Error ? err.message : String(err));
      }
    }),
  );

  const response: LiveFundingResponse = {
    pair,
    fetched_at: new Date().toISOString(),
    rates,
    failures,
  };
  resultCache.set(cacheKey, { at: Date.now(), response });
  return response;
}

// =====================================================================
// v0.16: order-book spread + size-conditional slippage
// =====================================================================

// Spot execution must use the spot class for the two split venues.
const CCXT_SPOT_ID_OVERRIDES: Record<string, string> = {
  kucoin: "kucoin",
  kraken: "kraken",
  coinbase: "coinbaseexchange",
};

function ccxtIdFor(exchange: string, purpose: TradingPurpose): string {
  if (purpose === "spot") return CCXT_SPOT_ID_OVERRIDES[exchange] ?? CCXT_IDS[exchange] ?? exchange;
  return CCXT_IDS[exchange] ?? exchange;
}

/** Resolve the spot symbol BASE/QUOTE, with a same-base USDT/USD fallback. */
export function resolveSpotSymbol(
  markets: Record<string, CcxtMarket>,
  base: string,
  quote: string,
): string | undefined {
  const all = Object.values(markets);
  const exact = `${base}/${quote}`;
  if (markets[exact] && markets[exact].swap !== true) return exact;

  const sameBq = all.filter((m) => m.swap !== true && m.base === base && m.quote === quote);
  if (sameBq.length > 0) return sameBq[0].symbol;

  const sameBase = all.filter((m) => m.swap !== true && m.base === base);
  const fallback =
    sameBase.find((m) => m.quote === "USDT" || m.quote === "USD") ?? sameBase[0];
  return fallback?.symbol;
}

export function resolveTradeSymbol(
  markets: Record<string, CcxtMarket>,
  base: string,
  quote: string,
  purpose: TradingPurpose,
): string | undefined {
  return purpose === "spot"
    ? resolveSpotSymbol(markets, base, quote)
    : resolveSwapSymbol(markets, base, quote);
}

export interface BookWalkResult {
  mid: number;
  /** Full top-of-book spread in bps. */
  spread_bps: number;
  /** Cost of crossing to the best touch for the requested side, bps. */
  crossing_bps: number;
  /** VWAP impact beyond the best touch across the consumed depth, bps. */
  slippage_bps: number;
  /** crossing + slippage, one-way, bps. */
  total_bps: number;
  levels_consumed: number;
  /** USD notional actually available on the walked side. */
  available_depth_usd: number;
  fully_filled: boolean;
}

/**
 * Walk an L2 book to simulate a marketable order of `sizeUsd`:
 * crossing the half-spread plus size-conditional impact vs mid.
 * Pure function — deterministic, no I/O, unit-tested directly.
 */
export function walkOrderBook(
  book: CcxtOrderBook,
  sizeUsd: number,
  side: "buy" | "sell",
): BookWalkResult {
  const bestAsk = book.asks[0]?.[0];
  const bestBid = book.bids[0]?.[0];
  if (bestAsk === undefined || bestBid === undefined || bestAsk <= 0 || bestBid <= 0) {
    throw new Error("order book missing bid/ask");
  }
  const mid = (bestAsk + bestBid) / 2;
  const levels = side === "buy" ? book.asks : book.bids;
  if (levels.length === 0) throw new Error(`order book has no ${side} side`);

  const spreadBps = ((bestAsk - bestBid) / mid) * 1e4;
  const crossingBps =
    side === "buy" ? ((bestAsk - mid) / mid) * 1e4 : ((mid - bestBid) / mid) * 1e4;

  let remainingUsd = sizeUsd;
  let filledNotional = 0;
  let filledBase = 0;
  let levelsConsumed = 0;
  for (const [price, amount] of levels) {
    if (remainingUsd <= 0) break;
    const levelNotional = price * amount;
    const takeNotional = Math.min(remainingUsd, levelNotional);
    if (takeNotional <= 0) continue;
    filledNotional += takeNotional;
    filledBase += takeNotional / price;
    remainingUsd -= takeNotional;
    levelsConsumed += 1;
  }

  const fullyFilled = remainingUsd <= 0.0001;
  const vwap = filledBase > 0 ? filledNotional / filledBase : side === "buy" ? bestAsk : bestBid;
  const impactBps =
    side === "buy"
      ? Math.max(0, ((vwap - bestAsk) / mid) * 1e4)
      : Math.max(0, ((bestBid - vwap) / mid) * 1e4);

  return {
    mid,
    spread_bps: round6(spreadBps),
    crossing_bps: round6(crossingBps),
    slippage_bps: round6(impactBps),
    total_bps: round6(crossingBps + impactBps),
    levels_consumed: levelsConsumed,
    available_depth_usd: round2(
      levels.reduce((sum, [price, amount]) => sum + price * amount, 0),
    ),
    fully_filled: fullyFilled,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const BOOK_DEFAULT_TTL_MS = 30 * 1000;

export interface FetchExecutionOptions {
  pair?: string;
  purpose?: TradingPurpose;
  side?: "buy" | "sell";
  tradeSizeUsd?: number;
  timeoutMs?: number;
  ttlMs?: number;
  noCache?: boolean;
  deps?: LiveDeps;
}

export interface LiveExecutionResponse {
  pair: string;
  purpose: TradingPurpose;
  side: "buy" | "sell";
  trade_size_usd: number;
  fetched_at: string;
  costs: SpreadOverrides;
  failures: ExecutionCostFailure[];
  warnings: ExecutionCostWarning[];
}

interface ExecutionCacheEntry {
  at: number;
  response: LiveExecutionResponse;
}

const executionCache = new Map<string, ExecutionCacheEntry>();

export function clearExecutionCache(): void {
  executionCache.clear();
}

/** Bundled one-way execution estimate (half-spread crossing; impact not modeled offline). */
export function bundledExecutionOverride(
  exchange: string,
  base: string,
  symbol?: string,
): SpreadOverride | null {
  const est = getSpreadEstimate(exchange, base);
  if (!est) return null;
  return {
    crossing_bps: est.crossing_bps,
    slippage_bps: 0,
    total_bps: est.crossing_bps,
    source: "bundled",
    fully_filled: undefined,
    ...(symbol ? { symbol } : {}),
  };
}

/**
 * Fetch live order books and compute one-way spread+impact for the given size.
 * Never throws: per-exchange failures degrade to bundled half-spread estimates.
 */
export async function fetchExecutionCostLive(
  exchanges: string[],
  opts: FetchExecutionOptions = {},
): Promise<LiveExecutionResponse> {
  const pair = normalizeFundingPair(opts.pair);
  const purpose: TradingPurpose = opts.purpose ?? "futures";
  const side: "buy" | "sell" = opts.side ?? "buy";
  const tradeSizeUsd = opts.tradeSizeUsd && opts.tradeSizeUsd > 0 ? opts.tradeSizeUsd : 10000;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = opts.ttlMs ?? BOOK_DEFAULT_TTL_MS;
  const cacheKey = `${purpose}|${side}|${tradeSizeUsd}|${pair}|${exchanges
    .map((e) => e.toLowerCase())
    .join(",")}`;

  if (!opts.noCache) {
    const cached = executionCache.get(cacheKey);
    if (cached && Date.now() - cached.at < ttlMs) return cached.response;
  }

  const [base, quote] = pair.split("/");
  const costs: SpreadOverrides = {};
  const failures: ExecutionCostFailure[] = [];
  const warnings: ExecutionCostWarning[] = [];

  let ccxtModule: CcxtModule | null = null;
  let moduleError: string | null = null;
  try {
    ccxtModule = await loadCcxt(opts.deps);
  } catch (err) {
    moduleError = err instanceof Error ? err.message : String(err);
  }

  await Promise.all(
    exchanges.map(async (rawExchange): Promise<void> => {
      const exchange = rawExchange.toLowerCase();
      const failWithBundled = (error: string, symbol?: string): void => {
        const fallback = bundledExecutionOverride(exchange, base, symbol);
        if (fallback) {
          failures.push({ exchange, error, fallback: "bundled" });
          costs[exchange] = fallback;
        }
      };

      if (!ccxtModule) {
        failWithBundled(moduleError ?? "ccxt module unavailable");
        return;
      }

      try {
        const ccxtId = ccxtIdFor(exchange, purpose);
        const Klass = ccxtModule[ccxtId];
        if (!Klass) throw new Error(`ccxt has no exchange '${ccxtId}'`);
        const client = new Klass({ timeout: timeoutMs, enableRateLimit: true });
        await client.loadMarkets();
        const symbol = resolveTradeSymbol(client.markets, base, quote, purpose);
        if (!symbol) {
          throw new Error(`no ${purpose} market for ${pair} on ${ccxtId}`);
        }
        const book = await client.fetchOrderBook(symbol, 100);
        const walk = walkOrderBook(book, tradeSizeUsd, side);
        const override: SpreadOverride = {
          crossing_bps: walk.crossing_bps,
          slippage_bps: walk.slippage_bps,
          total_bps: walk.total_bps,
          source: "live",
          fully_filled: walk.fully_filled,
          levels_consumed: walk.levels_consumed,
          available_depth_usd: walk.available_depth_usd,
          symbol,
        };
        if (book.timestamp && Number.isFinite(book.timestamp)) {
          override.timestamp = new Date(book.timestamp).toISOString();
        }
        if (!walk.fully_filled) {
          warnings.push({
            exchange,
            message: `only $${walk.available_depth_usd} of $${tradeSizeUsd} visible in top ${walk.levels_consumed} levels; impact beyond visible depth is not counted`,
          });
        }
        costs[exchange] = override;
      } catch (err) {
        failWithBundled(err instanceof Error ? err.message : String(err));
      }
    }),
  );

  const response: LiveExecutionResponse = {
    pair,
    purpose,
    side,
    trade_size_usd: tradeSizeUsd,
    fetched_at: new Date().toISOString(),
    costs,
    failures,
    warnings,
  };
  executionCache.set(cacheKey, { at: Date.now(), response });
  return response;
}
