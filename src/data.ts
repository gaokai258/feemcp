import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  ReferralLinksData,
  FeeRatesData,
  CountryRestrictionsData,
  CountryRestriction,
  RegionMembership,
  ProductRegionGates,
  VenueRegionBlocks,
  VenueRegionAllows,
  ProductRegionBlocks,
  TokenDiscountsData,
  TokenDiscount,
  WithdrawalFeesData,
  FundingRatesData,
  FundingRateData,
  ResolvedFeeRate,
  FxRatesData,
  PairFeesData,
  PairFeeEntry,
  DataProvenanceReport,
  DataProvenance,
  DataSource,
  DataFreshness,
  TradingPurpose,
  FeeTierSpot,
  FeeTierSpotSingle,
  FeeTierFutures,
  PricingModel,
  SpreadBaselineData,
  FiatRoutesData,
  PersonasData,
  TokenPricesData,
  StablecoinAccessData,
  StablecoinAssetInfo,
  StablecoinRegionRule,
  StablecoinVenueRule,
  InterfaceCostsData,
  InterfaceVenueCost,
  FeeChangesData,
  LadderSnapshot,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveDataPath(envVar: string, defaultName: string): string {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  return join(__dirname, "..", "data", defaultName);
}

function loadJson<T>(path: string): T {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load data file ${path}: ${message}`);
  }
}

let referralLinksCache: ReferralLinksData | null = null;
let feeRatesCache: FeeRatesData | null = null;
let countryRestrictionsCache: CountryRestrictionsData | null = null;
let tokenDiscountsCache: TokenDiscountsData | null = null;
let withdrawalFeesCache: WithdrawalFeesData | null = null;
let fundingRatesCache: FundingRatesData | null = null;
let fxRatesCache: FxRatesData | null = null;
let pairFeesCache: PairFeesData | null = null;
let spreadBaselineCache: SpreadBaselineData | null = null;
let fiatRoutesCache: FiatRoutesData | null = null;
let personasCache: PersonasData | null = null;
let tokenPricesCache: TokenPricesData | null = null;
let stablecoinAccessCache: StablecoinAccessData | null = null;
let interfaceCostsCache: InterfaceCostsData | null = null;
let feeChangesCache: FeeChangesData | null = null;
let ladderSnapshotsCache: LadderSnapshot[] | null = null;

export function getReferralLinks(): ReferralLinksData {
  if (!referralLinksCache) {
    referralLinksCache = loadJson<ReferralLinksData>(
      resolveDataPath("REFERRAL_LINKS_PATH", "referral_links.json"),
    );
  }
  return referralLinksCache;
}

export function getFeeRates(): FeeRatesData {
  if (!feeRatesCache) {
    feeRatesCache = loadJson<FeeRatesData>(
      resolveDataPath("FEE_RATES_PATH", "fee_rates.json"),
    );
  }
  return feeRatesCache;
}

export function getCountryRestrictions(): CountryRestrictionsData {
  if (!countryRestrictionsCache) {
    countryRestrictionsCache = loadJson<CountryRestrictionsData>(
      resolveDataPath("COUNTRY_RESTRICTIONS_PATH", "country_restrictions.json"),
    );
  }
  return countryRestrictionsCache;
}

export function getTokenDiscounts(): TokenDiscountsData {
  if (!tokenDiscountsCache) {
    tokenDiscountsCache = loadJson<TokenDiscountsData>(
      resolveDataPath("TOKEN_DISCOUNTS_PATH", "token_discounts.json"),
    );
  }
  return tokenDiscountsCache;
}

export function getWithdrawalFees(): WithdrawalFeesData {
  if (!withdrawalFeesCache) {
    withdrawalFeesCache = loadJson<WithdrawalFeesData>(
      resolveDataPath("WITHDRAWAL_FEES_PATH", "withdrawal_fees.json"),
    );
  }
  return withdrawalFeesCache;
}

export function getFundingRates(): FundingRatesData {
  if (!fundingRatesCache) {
    fundingRatesCache = loadJson<FundingRatesData>(
      resolveDataPath("FUNDING_RATES_PATH", "funding_rates.json"),
    );
  }
  return fundingRatesCache;
}

export function getPairFees(): PairFeesData {
  if (!pairFeesCache) {
    pairFeesCache = loadJson<PairFeesData>(resolveDataPath("PAIR_FEES_PATH", "pair_fees.json"));
  }
  return pairFeesCache;
}

export function getSpreadBaseline(): SpreadBaselineData {
  if (!spreadBaselineCache) {
    spreadBaselineCache = loadJson<SpreadBaselineData>(
      resolveDataPath("SPREAD_BASELINE_PATH", "spread_baseline.json"),
    );
  }
  return spreadBaselineCache;
}

export function getFiatRoutes(): FiatRoutesData {
  if (!fiatRoutesCache) {
    fiatRoutesCache = loadJson<FiatRoutesData>(
      resolveDataPath("FIAT_ROUTES_PATH", "fiat_routes.json"),
    );
  }
  return fiatRoutesCache;
}

// v0.22: trader persona presets for analyze_persona.
export function getPersonas(): PersonasData {
  if (!personasCache) {
    personasCache = loadJson<PersonasData>(
      resolveDataPath("PERSONAS_PATH", "personas.json"),
    );
  }
  return personasCache;
}

export function getRestrictionForCountry(country: string): CountryRestriction {
  const data = getCountryRestrictions();
  const upper = country.toUpperCase();
  return (
    (data[upper] as CountryRestriction | undefined) ??
    (data["default"] as CountryRestriction | undefined) ?? { blocked: [], allowed: [] }
  );
}

// v0.12: accept "BTC/USDT", "BTC-USDT", "btc usdt", "BTCUSDT" uniformly.
export function normalizePair(pair: string): string {
  const upper = pair.trim().toUpperCase();
  if (upper.includes("/")) return upper.replace(/\s+/g, "");
  if (upper.includes("-") || upper.includes("_")) return upper.replace(/[-_]/g, "/").replace(/\s+/g, "");
  return upper;
}

// v0.12: pair-level fee override (MEXC 0-fee, Binance FDUSD/USDC, Bitget USDC...).
// Returns the matching entry, or null when the exchange has no data for this pair.
export function resolvePairFee(
  exchange: string,
  purpose: TradingPurpose,
  pair: string,
): PairFeeEntry | null {
  const book = getPairFees().exchanges[exchange.toLowerCase()];
  if (!book) return null;
  const entries = purpose === "spot" ? book.spot : book.futures;
  if (!entries) return null;
  // Compare with the separator stripped so "BTCUSDT", "btc-usdt" and "BTC/USDT" all match.
  const compact = (s: string) => normalizePair(s).replace("/", "");
  const target = compact(pair);
  if (!target) return null;
  return entries.find((e) => e.pairs.some((p) => compact(p) === target)) ?? null;
}

export function isExchangeAllowed(exchange: string, country: string): boolean {
  const lower = exchange.toLowerCase();
  // v0.41: post-MiCA-cliff region-wide venue bans (e.g. EEA) take precedence
  // over every per-country allowlist, so all callers inherit the block.
  if (isVenueRegionBlocked(lower, country)) return false;
  const restriction = getRestrictionForCountry(country);
  if (restriction.blocked.includes(lower)) return false;
  // v0.42: a positive region allowlist hit (e.g. Bitvavo's EEA passport + GB/CH
  // licences) authorizes the venue even when a stale per-country `allowed`
  // enumeration omits it. An explicit country `blocked` entry above still wins.
  if (isVenueRegionAllowed(lower, country)) return true;
  // Conversely, a venue WITH an allowlist entry that the resident's country
  // belongs to none of is closed there, even under a default-key allowed:[].
  if (isVenueRegionRestricted(lower, country)) return false;
  if (restriction.allowed.length === 0) return true;
  return restriction.allowed.includes(lower);
}

// v0.38: per-venue PRODUCT gating inside an otherwise-served country
// (Bitstamp perpetuals are EU-eligible only while spot runs in 150+ countries).
// v0.40: also enforces POSITIVE region allowlists from product_region_gates
// (e.g. bitstamp futures => ["EEA"]): a supplied country outside every listed
// region is blocked, which closes the v0.38 default-key over-open for AU/BR/CH
// and other unmodeled non-EEA residents. Absent country stays false-safe and
// leaves the decision to venue-level filters.
export function isProductBlockedInCountry(
  exchange: string,
  purpose: TradingPurpose,
  country: string | undefined,
): boolean {
  if (!country) return false;
  const lower = exchange.toLowerCase();
  const upper = country.toUpperCase();
  const restriction = getRestrictionForCountry(country);
  if (restriction.product_blocked?.[lower]?.includes(purpose)) return true;
  // v0.41: negative region block at product level (e.g. bybit/gate futures in
  // the EEA — CASP covers spot; MiFID II is required for crypto derivatives).
  const blockedRegions = getProductRegionBlocks()[lower]?.[purpose];
  if (blockedRegions && blockedRegions.some((r) => isCountryInRegion(upper, r))) {
    return true;
  }
  const allowedRegions = getProductRegionGates()[lower]?.[purpose];
  if (allowedRegions && allowedRegions.length > 0) {
    const regions = getRegions();
    return !allowedRegions.some((region) =>
      (regions[region] ?? []).map((c) => c.toUpperCase()).includes(upper),
    );
  }
  return false;
}

// v0.40: raw region membership table (e.g. { EEA: ["AT", ..., "NO"] }).
export function getRegions(): RegionMembership {
  return getCountryRestrictions().regions ?? {};
}

// v0.40: venue/purpose => regions the product is restricted to.
export function getProductRegionGates(): ProductRegionGates {
  return getCountryRestrictions().product_region_gates ?? {};
}

// v0.41: venue => regions where the venue is fully blocked (all products).
export function getVenueRegionBlocks(): VenueRegionBlocks {
  return getCountryRestrictions().region_blocked ?? {};
}

// v0.42: venue => regions whose residents are the ONLY ones the venue may serve.
export function getVenueRegionAllows(): VenueRegionAllows {
  return getCountryRestrictions().region_allowed ?? {};
}

// v0.41: venue/purpose => regions where that specific product is blocked.
export function getProductRegionBlocks(): ProductRegionBlocks {
  return getCountryRestrictions().product_region_blocked ?? {};
}

// v0.40: true when the country code is a declared member of the named region.
export function isCountryInRegion(country: string, region: string): boolean {
  return (getRegions()[region] ?? [])
    .map((c) => c.toUpperCase())
    .includes(country.toUpperCase());
}

// v0.41: true when the venue is region-blocked for the resident (e.g. an
// exchange without MiCA CASP authorization serving an EEA country after the
// 2026-07-01 cliff). Region status is authoritative and overrides any stale
// per-country `allowed` entry; absent country stays false-safe.
export function isVenueRegionBlocked(exchange: string, country: string | undefined): boolean {
  if (!country) return false;
  const blockedRegions = getVenueRegionBlocks()[exchange.toLowerCase()];
  return !!blockedRegions?.some((region) => isCountryInRegion(country, region));
}

// v0.42: true when the venue declares a positive service-area allowlist and the
// resident belongs to at least one listed region (e.g. Bitvavo serving EEA/GB/CH).
export function isVenueRegionAllowed(exchange: string, country: string | undefined): boolean {
  if (!country) return false;
  const allowedRegions = getVenueRegionAllows()[exchange.toLowerCase()];
  return !!allowedRegions?.some((region) => isCountryInRegion(country, region));
}

// v0.42: true when the venue declares an allowlist that the resident is outside.
// Venues without an entry stay unrestricted; absent country stays false-safe.
export function isVenueRegionRestricted(exchange: string, country: string | undefined): boolean {
  if (!country) return false;
  const allowedRegions = getVenueRegionAllows()[exchange.toLowerCase()];
  if (!allowedRegions) return false;
  return !allowedRegions.some((region) => isCountryInRegion(country, region));
}

// Combined gate: venue onboarding + product availability in one call.
export function isVenueUsableFor(
  exchange: string,
  country: string | undefined,
  purpose?: TradingPurpose,
): boolean {
  // v0.41: region-wide blocks take precedence over per-country allowlists.
  if (isVenueRegionBlocked(exchange, country)) return false;
  if (country && !isExchangeAllowed(exchange, country)) return false;
  if (purpose && isProductBlockedInCountry(exchange, purpose, country)) return false;
  return true;
}

export function getTokenDiscount(exchange: string): TokenDiscount | null {
  const data = getTokenDiscounts();
  return data.exchanges[exchange.toLowerCase()] ?? null;
}

export function getFundingRate(exchange: string): FundingRateData | null {
  const data = getFundingRates();
  return data.exchanges[exchange.toLowerCase()] ?? null;
}

// v0.16: bundled execution-cost estimate (half-spread crossing, no impact model).
export type PairClass = "majors" | "large_cap" | "mid_alt";

export function classifyPairClass(base: string): PairClass {
  const data = getSpreadBaseline();
  const b = base.toUpperCase();
  if (data.majors.includes(b)) return "majors";
  if (data.large_cap.includes(b)) return "large_cap";
  return "mid_alt";
}

export interface SpreadEstimate {
  /** Full top-of-book bid-ask spread in bps for this pair class. */
  full_spread_bps: number;
  /** One-way taker crossing cost in bps (half the spread). */
  crossing_bps: number;
  pair_class: PairClass;
  note?: string;
}

export function getSpreadEstimate(exchange: string, base: string): SpreadEstimate | null {
  const data = getSpreadBaseline();
  const entry = data.exchanges[exchange.toLowerCase()];
  if (!entry) return null;
  // v0.44: spread-model brokerages (e.g. Bitpanda consumer app) embed the
  // bid-ask cost in the quoted price as a per-side premium already modeled as
  // the venue's trading fee. Returning an explicit ZERO estimate keeps their
  // rows comparable in the standalone execution-cost view while preventing
  // the persona/savings engines from adding crossing cost a second time.
  if (getPricingModel(exchange) === "spread") {
    return {
      full_spread_bps: 0,
      crossing_bps: 0,
      pair_class: classifyPairClass(base),
      note: entry.note ??
        "Spread-model brokerage: the all-in price premium is modeled as the trading fee (see get_spot_fee); there is no separate additive bid-ask spread.",
    };
  }
  const pairClass = classifyPairClass(base);
  const multiplier = data.pair_class_multipliers[pairClass];
  const fullSpreadBps = entry.typical_spread_bps * multiplier;
  return {
    full_spread_bps: round4(fullSpreadBps),
    crossing_bps: round4(fullSpreadBps / 2),
    pair_class: pairClass,
    ...(entry.note ? { note: entry.note } : {}),
  };
}

// v0.44: venue execution-pricing model (default "order_book" for legacy data).
export function getPricingModel(exchange: string): PricingModel {
  return getFeeRates().exchanges[exchange.toLowerCase()]?.pricing_model ?? "order_book";
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

// v0.11: exchanges with bundled fee-rate data (superset of referral-linked exchanges).
export function listSupportedExchanges(): string[] {
  return Object.keys(getFeeRates().exchanges);
}

export function getFxRates(): FxRatesData {
  if (!fxRatesCache) {
    fxRatesCache = loadJson<FxRatesData>(resolveDataPath("FX_RATES_PATH", "fx_rates.json"));
  }
  return fxRatesCache;
}

export function getTokenPrices(): TokenPricesData {
  if (!tokenPricesCache) {
    tokenPricesCache = loadJson<TokenPricesData>(
      resolveDataPath("TOKEN_PRICES_PATH", "token_prices.json"),
    );
  }
  return tokenPricesCache;
}

export function getTokenPrice(token: string): number | null {
  const p = getTokenPrices().prices[token.toUpperCase()];
  return typeof p === "number" && p > 0 ? p : null;
}

// v0.46: MiCA stablecoin regional-access bundle (USDT EEA sweep + compliant
// alternatives USDC/EURC/EURI/EURCV/USDQ/EURQ).
export function getStablecoinAccess(): StablecoinAccessData {
  if (!stablecoinAccessCache) {
    stablecoinAccessCache = loadJson<StablecoinAccessData>(
      resolveDataPath("STABLECOIN_ACCESS_PATH", "stablecoin_access.json"),
    );
  }
  return stablecoinAccessCache;
}

export function getStablecoinAsset(asset: string): StablecoinAssetInfo | null {
  return getStablecoinAccess().assets[asset.toUpperCase()] ?? null;
}

// v0.47: consumer-vs-pro interface cost model for dual-product venues
// (Kraken app vs Pro, Coinbase Simple vs Advanced, Bitvavo Basic vs PRO,
// Bitstamp Basic vs PRO, Bitpanda/BISON brokerage evidence).
export function getInterfaceCosts(): InterfaceCostsData {
  if (!interfaceCostsCache) {
    interfaceCostsCache = loadJson<InterfaceCostsData>(
      resolveDataPath("INTERFACE_COSTS_PATH", "interface_costs.json"),
    );
  }
  return interfaceCostsCache;
}

// v0.48: curated fee-schedule change feed (ships with the npm package).
export function getFeeChanges(): FeeChangesData {
  if (!feeChangesCache) {
    feeChangesCache = loadJson<FeeChangesData>(
      resolveDataPath("FEE_CHANGES_PATH", "fee_changes.json"),
    );
  }
  return feeChangesCache;
}

/**
 * v0.48: monthly fee-ladder snapshots used to auto-detect schedule changes.
 * The snapshot directory is REPO-ONLY (not shipped in the npm tarball), so a
 * missing/unreadable directory degrades to an empty list instead of throwing —
 * npm consumers still get the curated feed, just no detected deltas.
 * FEE_SNAPSHOTS_PATH points at the directory containing YYYY-MM.json files.
 */
export function getFeeLadderSnapshots(): LadderSnapshot[] {
  if (ladderSnapshotsCache) return ladderSnapshotsCache;
  const dir =
    process.env.FEE_SNAPSHOTS_PATH ??
    join(__dirname, "..", "snapshots", "fee_ladders");
  if (!existsSync(dir)) {
    ladderSnapshotsCache = [];
    return ladderSnapshotsCache;
  }
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    ladderSnapshotsCache = [];
    return ladderSnapshotsCache;
  }
  const snapshots: LadderSnapshot[] = [];
  for (const f of files) {
    try {
      snapshots.push(loadJson<LadderSnapshot>(join(dir, f)));
    } catch {
      // Skip an unparseable snapshot rather than failing the whole feed.
    }
  }
  ladderSnapshotsCache = snapshots;
  return ladderSnapshotsCache;
}

export function getInterfaceVenue(exchange: string): InterfaceVenueCost | null {
  return getInterfaceCosts().venues[exchange.toLowerCase()] ?? null;
}

/** Every tracked stablecoin symbol (USDT, USDC, EURC, ...). */
export function listTrackedStablecoins(): string[] {
  return Object.keys(getStablecoinAccess().assets);
}

/**
 * v0.46: region-level restriction for a stablecoin in a resident's country.
 * Returns the rule only when the asset explicitly carries a rule for a region
 * the country belongs to AND the asset is not authorized there (e.g. USDT/EEA).
 * CH/GB/US/etc. and authorized assets (USDC) return null.
 */
export function getStablecoinRegionRestriction(
  asset: string,
  country: string | undefined,
): { region: string; rule: StablecoinRegionRule } | null {
  if (!country) return null;
  const info = getStablecoinAsset(asset);
  if (!info || info.mica_authorized || !info.region_rules) return null;
  const upper = country.toUpperCase();
  for (const [region, rule] of Object.entries(info.region_rules)) {
    if (rule.venue_trading === "unavailable" && isCountryInRegion(upper, region)) {
      return { region, rule };
    }
  }
  return null;
}

/**
 * v0.46: per-venue rule for a stablecoin that applies to a resident's country.
 * scope "global" rules apply everywhere; region-scoped rules only inside that
 * region. Null when the venue has no modeled rule for this asset/country.
 */
export function getStablecoinVenueRule(
  exchange: string,
  asset: string,
  country: string | undefined,
): StablecoinVenueRule & { region?: string } | null {
  const rule = getStablecoinAccess().venues[exchange.toLowerCase()]?.[asset.toUpperCase()];
  if (!rule) return null;
  if (rule.scope === "global") return { ...rule };
  if (!country) return null;
  // The only region-scoped regime modeled so far is the EEA under MiCA.
  return isCountryInRegion(country.toUpperCase(), "EEA") ? { ...rule, region: "EEA" } : null;
}

export function getFxRate(currency: string): number | null {
  const data = getFxRates();
  const upper = currency.toUpperCase();
  const rate = data.rates[upper];
  return typeof rate === "number" && rate > 0 ? rate : null;
}

// Weighted blend of maker and taker rates by maker share (0 = pure taker, 1 = pure maker).
export function weightedRate(maker: number, taker: number, makerShare: number): number {
  const ms = Math.min(Math.max(makerShare, 0), 1);
  return maker * ms + taker * (1 - ms);
}

// v0.6: aggregate provenance (last_verified + sources) across all data files.
export function listDataProvenance(now: Date = new Date()): DataProvenanceReport {
  const rawFiles: DataProvenance[] = [
    { file: "fee_rates.json", last_verified: getFeeRates().last_verified, sources: getFeeRates().sources },
    {
      file: "referral_links.json",
      last_verified: getReferralLinks().last_verified,
      sources: getReferralLinks().sources,
    },
    { file: "token_discounts.json", last_verified: getTokenDiscounts().last_verified, sources: getTokenDiscounts().sources },
    { file: "funding_rates.json", last_verified: getFundingRates().last_verified, sources: getFundingRates().sources },
    { file: "withdrawal_fees.json", last_verified: getWithdrawalFees().last_verified, sources: getWithdrawalFees().sources },
    { file: "pair_fees.json", last_verified: getPairFees().last_verified, sources: getPairFees().sources },
    { file: "spread_baseline.json", last_verified: getSpreadBaseline().last_verified, sources: getSpreadBaseline().sources },
    { file: "fiat_routes.json", last_verified: getFiatRoutes().last_verified, sources: getFiatRoutes().sources },
    { file: "fx_rates.json", last_verified: getFxRates().last_verified, sources: getFxRates().sources },
    {
      file: "country_restrictions.json",
      last_verified: getCountryRestrictions().last_verified as string | undefined,
      sources: getCountryRestrictions().sources as DataSource[] | undefined,
    },
    { file: "personas.json", last_verified: getPersonas().last_verified, sources: getPersonas().sources },
    { file: "token_prices.json", last_verified: getTokenPrices().last_verified, sources: getTokenPrices().sources },
    {
      file: "stablecoin_access.json",
      last_verified: getStablecoinAccess().last_verified,
      sources: getStablecoinAccess().sources,
    },
    {
      file: "interface_costs.json",
      last_verified: getInterfaceCosts().last_verified,
      sources: getInterfaceCosts().sources,
    },
    {
      file: "fee_changes.json",
      last_verified: getFeeChanges().last_verified,
      sources: getFeeChanges().sources,
    },
  ];

  const files: DataProvenance[] = rawFiles.map((f) => {
    const monthsBehind = monthsBehindAsOf(f.last_verified, now);
    return {
      ...f,
      months_behind: monthsBehind,
      is_stale: monthsBehind === null || monthsBehind > STALE_AFTER_MONTHS,
    };
  });

  const staleFiles = files.filter((f) => f.is_stale).map((f) => f.file);
  const dates = files.map((f) => f.last_verified).filter((d): d is string => typeof d === "string");
  const data_as_of = dates.length > 0 ? dates.sort()[0] : "unknown";
  return { data_as_of, stale_after_months: STALE_AFTER_MONTHS, stale_files: staleFiles, files };
}

type AnyTier = FeeTierSpot | FeeTierSpotSingle | FeeTierFutures;

function isSingleFeeSpot(tier: FeeTierSpot | FeeTierSpotSingle): tier is FeeTierSpotSingle {
  return "fee" in tier;
}

function tierRates(tier: AnyTier): { maker: number; taker: number } {
  if (isSingleFeeSpot(tier as FeeTierSpot | FeeTierSpotSingle)) {
    return { maker: (tier as FeeTierSpotSingle).fee, taker: (tier as FeeTierSpotSingle).fee };
  }
  const t = tier as FeeTierSpot | FeeTierFutures;
  return { maker: t.maker, taker: t.taker };
}

function tierTokenRequirement(tier: AnyTier): number {
  const bnb = "min_bnb" in tier ? tier.min_bnb : undefined;
  const gt = "min_gt" in tier ? tier.min_gt : undefined;
  const kcs = "min_kcs" in tier ? tier.min_kcs : undefined;
  return bnb ?? gt ?? kcs ?? 0;
}

function tierMinBnb(tier: AnyTier): number | undefined {
  return "min_bnb" in tier ? tier.min_bnb : undefined;
}

function tierMinGt(tier: AnyTier): number | undefined {
  return "min_gt" in tier ? tier.min_gt : undefined;
}

function tierMinKcs(tier: AnyTier): number | undefined {
  return "min_kcs" in tier ? tier.min_kcs : undefined;
}

// v0.13: the OR dual-track ladder (volume OR native-token holdings) now
// covers Gate (GT) and KuCoin (KCS). Returns the holdings field per tier.
function tierMinHeldToken(tier: AnyTier): number | undefined {
  return tierMinGt(tier) ?? tierMinKcs(tier);
}

function tierMinAssets(tier: AnyTier): number | undefined {
  return "min_assets_usd" in tier ? tier.min_assets_usd : undefined;
}

// v0.8: warn once bundled fee data is more than STALE_AFTER_MONTHS past last_verified.
export const STALE_AFTER_MONTHS = 3;

/** Whole-month distance between a "YYYY-MM" stamp and now (never negative); null if unparseable. */
export function monthsBehindAsOf(asOf: string | undefined, now: Date = new Date()): number | null {
  if (typeof asOf !== "string") return null;
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(asOf);
  if (!m) return null;
  const months =
    (now.getUTCFullYear() - Number(m[1])) * 12 + (now.getUTCMonth() + 1 - Number(m[2]));
  return Math.max(months, 0);
}

export function getDataFreshness(
  now: Date = new Date(),
  staleAfterMonths: number = STALE_AFTER_MONTHS,
): DataFreshness {
  const asOf = getFeeRates().last_verified;
  const parsed = monthsBehindAsOf(asOf, now);
  if (parsed === null) {
    return {
      data_as_of: asOf,
      months_behind: Number.POSITIVE_INFINITY,
      is_stale: true,
      warning: `Fee data has an unparseable last_verified value '${asOf}'; treat rates as outdated.`,
    };
  }
  const behind = parsed;
  const isStale = behind > staleAfterMonths;
  return {
    data_as_of: asOf,
    months_behind: behind,
    is_stale: isStale,
    ...(isStale
      ? {
          warning: `Fee data was last verified ${asOf} (${behind} month${behind === 1 ? "" : "s"} ago); exchange schedules may have changed. Verify with get_data_sources before deciding.`,
        }
      : {}),
  };
}

/**
 * Resolve the effective fee tier.
 *
 * Ladders differ in how native-token holdings interact with volume:
 *  - Binance spot (AND): VIP1+ requires the volume threshold AND BNB holdings.
 *      tokenBalance undefined → volume tier quoted, flagged as needing BNB.
 *      tokenBalance provided  → highest rung meeting BOTH constraints (may downgrade).
 *  - Gate spot + futures (OR): qualification is 30-day volume OR average GT
 *    holdings, whichever is higher (official Gate dual-track ladder).
 *      tokenBalance undefined → volume tier quoted, with a hint that GT can upgrade it.
 *      tokenBalance provided  → max(volume rung, GT-holdings rung); GT can only upgrade.
 *  - KuCoin spot + futures (OR): same dual-track model with KCS holdings
 *    (per-product 30-day volume thresholds; VIP0-12).
 *  - OKX spot + futures (OR): qualification is 30-day volume OR account assets
 *    (per-product volume; account-level assets), whichever is higher.
 *      accountAssetsUsd undefined → volume tier quoted, with an asset upgrade hint.
 *  - Binance futures: no holding gate.
 */
export function resolveFeeRate(
  exchange: string,
  purpose: TradingPurpose,
  monthlyVolumeUsd: number,
  tokenBalance?: number,
  accountAssetsUsd?: number,
): ResolvedFeeRate | null {
  const data = getFeeRates();
  const lower = exchange.toLowerCase();
  const exData = data.exchanges[lower];
  if (!exData) return null;

  const tiers = (purpose === "spot" ? exData.spot : exData.futures) as AnyTier[];
  if (tiers.length === 0) return null;

  // Highest tier the user's 30-day volume alone qualifies for.
  let volumeIdx = 0;
  tiers.forEach((tier, i) => {
    if (monthlyVolumeUsd >= tier.min_volume_usd) volumeIdx = i;
  });

  const ladderUsesBnb = tiers.some((t) => tierMinBnb(t) !== undefined);
  // v0.13: any volume-OR-holdings ladder (Gate GT, KuCoin KCS).
  const heldTokenName: "GT" | "KCS" | undefined = tiers.some(
    (t) => (tierMinGt(t) ?? 0) > 0,
  )
    ? "GT"
    : tiers.some((t) => (tierMinKcs(t) ?? 0) > 0)
      ? "KCS"
      : undefined;

  // ---- Binance spot: volume AND BNB ----
  if (lower === "binance" && ladderUsesBnb) {
    let effectiveIdx = volumeIdx;
    if (tokenBalance !== undefined) {
      for (let i = volumeIdx; i >= 0; i--) {
        if ((tierMinBnb(tiers[i]) ?? 0) <= tokenBalance) {
          effectiveIdx = i;
          break;
        }
      }
    }
    return assembleResult(tiers, volumeIdx, effectiveIdx, "BNB", {
      heldBack: tokenBalance !== undefined && effectiveIdx < volumeIdx,
      quoteVolumeGate: tokenBalance === undefined,
    });
  }

  // ---- Gate / KuCoin spot + futures: volume OR native-token holdings (higher of the two) ----
  if (heldTokenName) {
    let heldIdx = 0;
    if (tokenBalance !== undefined) {
      tiers.forEach((tier, i) => {
        const minHeld = tierMinHeldToken(tier) ?? 0;
        if (tokenBalance >= minHeld) heldIdx = i;
      });
    }
    const effectiveIdx = tokenBalance !== undefined ? Math.max(volumeIdx, heldIdx) : volumeIdx;
    // Next rung above the effective one is always reachable via more holdings (unless at top).
    const upgradeHintIdx = effectiveIdx + 1 < tiers.length ? effectiveIdx + 1 : undefined;
    return assembleResult(tiers, volumeIdx, effectiveIdx, heldTokenName, {
      upgradeBasis: heldTokenName === "GT" ? "gt" : "kcs",
      upgraded: effectiveIdx > volumeIdx,
      ...(upgradeHintIdx !== undefined
        ? {
            nextTier: tiers[upgradeHintIdx].tier,
            nextMinToken: tierMinHeldToken(tiers[upgradeHintIdx]),
          }
        : {}),
    });
  }

  // ---- OKX / Bybit / Bitget spot + futures: volume OR account assets (higher of the two) ----
  if (tiers.some((t) => tierMinAssets(t) !== undefined)) {
    let assetsIdx = 0;
    if (accountAssetsUsd !== undefined) {
      tiers.forEach((tier, i) => {
        // Tiers without an asset requirement (e.g. volume-only Supreme rows)
        // do not qualify via the asset path.
        const minAssets = tierMinAssets(tier);
        if (minAssets !== undefined && accountAssetsUsd >= minAssets) assetsIdx = i;
      });
    }
    const effectiveIdx =
      accountAssetsUsd !== undefined ? Math.max(volumeIdx, assetsIdx) : volumeIdx;
    // Next rung is always reachable via more assets (unless already at top).
    const upgradeHintIdx = effectiveIdx + 1 < tiers.length ? effectiveIdx + 1 : undefined;
    return assembleResult(tiers, volumeIdx, effectiveIdx, undefined, {
      upgradeBasis: "assets",
      assetGate: true,
      upgraded: effectiveIdx > volumeIdx,
      minAssets: tierMinAssets(tiers[effectiveIdx]),
      ...(upgradeHintIdx !== undefined
        ? {
            nextTier: tiers[upgradeHintIdx].tier,
            nextMinAssets: tierMinAssets(tiers[upgradeHintIdx]),
          }
        : {}),
    });
  }

  // ---- No holding gate: Binance futures ----
  return assembleResult(tiers, volumeIdx, volumeIdx, undefined, {});
}

// Normalized fee ladder (Gate single-fee spot rows expanded to maker=taker=fee).
export interface NormalizedTier {
  tier: string;
  min_volume_usd: number;
  maker: number;
  taker: number;
  min_bnb?: number;
  min_gt?: number;
  min_kcs?: number;
  min_assets_usd?: number;
}

export function getNormalizedLadder(
  exchange: string,
  purpose: TradingPurpose,
): NormalizedTier[] | null {
  const data = getFeeRates();
  const exData = data.exchanges[exchange.toLowerCase()];
  if (!exData) return null;
  const tiers = (purpose === "spot" ? exData.spot : exData.futures) as AnyTier[];
  if (tiers.length === 0) return null;
  return tiers.map((t) => {
    const rates = tierRates(t);
    return {
      tier: t.tier,
      min_volume_usd: t.min_volume_usd,
      maker: rates.maker,
      taker: rates.taker,
      ...(tierMinBnb(t) !== undefined ? { min_bnb: tierMinBnb(t) } : {}),
      ...(tierMinGt(t) !== undefined ? { min_gt: tierMinGt(t) } : {}),
      ...(tierMinKcs(t) !== undefined ? { min_kcs: tierMinKcs(t) } : {}),
      ...(tierMinAssets(t) !== undefined ? { min_assets_usd: tierMinAssets(t) } : {}),
    };
  });
}

// v0.13: KuCoin spot Class A/B/C metadata (the bundled ladder quotes Class A).
export function getSpotFeeClasses(exchange: string) {
  return getFeeRates().exchanges[exchange.toLowerCase()]?.spot_fee_classes ?? null;
}

// v0.14: exchange-specific qualification/rate caveats (Kraken unified Tier/Pro).
// v0.44: appends the independent execution-quality finding for spread-model
// brokerages (advertised premium vs measured real-money round-trip cost).
export function getExchangeNotes(exchange: string): string[] | null {
  const cfg = getFeeRates().exchanges[exchange.toLowerCase()];
  if (!cfg) return null;
  const notes = cfg.notes ? [...cfg.notes] : [];
  const eq = cfg.execution_quality;
  if (eq) {
    const hidden =
      typeof eq.measured_hidden_markup_pct === "number"
        ? `, of which ${eq.measured_hidden_markup_pct.toFixed(2)} pp was an undisclosed hidden markup`
        : "";
    const replica = eq.replication
      ? ` Independently replicated by ${eq.replication.study} (${eq.replication.period}${eq.replication.trades ? `, ${eq.replication.trades}` : ""}).`
      : "";
    notes.push(
      `Independent real-money execution test (${eq.study}, ${eq.period}; ${eq.trades}): measured mean round-trip cost ${eq.measured_roundtrip_pct.toFixed(2)}%` +
        (typeof eq.advertised_roundtrip_pct === "number"
          ? ` vs ${eq.advertised_roundtrip_pct.toFixed(2)}% implied by the published premium`
          : "") +
        `${hidden}. The bundled ranking uses the advertised premium for apples-to-apples comparison; treat the measured figure as the realistic all-in cost.${replica}`,
    );
  }
  return notes.length > 0 ? notes : null;
}

interface ResultExtras {
  heldBack?: boolean;
  quoteVolumeGate?: boolean;
  upgraded?: boolean;
  nextTier?: string;
  nextMinToken?: number;
  upgradeBasis?: "gt" | "kcs" | "assets";
  nextMinAssets?: number;
  minAssets?: number;
  assetGate?: boolean;
}

function assembleResult(
  tiers: AnyTier[],
  volumeIdx: number,
  effectiveIdx: number,
  tokenName: "BNB" | "GT" | "KCS" | undefined,
  extras: ResultExtras,
): ResolvedFeeRate {
  const volumeTier = tiers[volumeIdx];
  const effectiveTier = tiers[effectiveIdx];
  const rates = tierRates(effectiveTier);
  const volumeReq = tokenName ? tierTokenRequirement(volumeTier) : 0;
  const effectiveReq = tokenName ? tierTokenRequirement(effectiveTier) : 0;

  return {
    base_maker: rates.maker,
    base_taker: rates.taker,
    tier: effectiveTier.tier,
    volume_tier: volumeTier.tier,
    ...(tierMinBnb(effectiveTier) !== undefined ? { min_bnb: tierMinBnb(effectiveTier) } : {}),
    ...(tierMinGt(effectiveTier) !== undefined ? { min_gt: tierMinGt(effectiveTier) } : {}),
    ...(tierMinKcs(effectiveTier) !== undefined ? { min_kcs: tierMinKcs(effectiveTier) } : {}),
    ...(tokenName ? { token_name: tokenName } : {}),
    ...(tokenName === "BNB" && (extras.quoteVolumeGate || extras.heldBack) && volumeReq > 0
      ? { min_token: volumeReq }
      : {}),
    ...(tokenName === "BNB" && effectiveReq > 0 ? { effective_min_token: effectiveReq } : {}),
    ...(extras.heldBack ? { tier_held_back: true } : {}),
    ...(extras.upgraded ? { tier_upgraded: true } : {}),
    ...(extras.upgradeBasis ? { upgrade_basis: extras.upgradeBasis } : {}),
    ...(extras.nextTier ? { next_tier: extras.nextTier } : {}),
    ...(extras.nextMinToken !== undefined ? { next_min_token: extras.nextMinToken } : {}),
    ...(extras.nextMinAssets !== undefined ? { next_min_assets: extras.nextMinAssets } : {}),
    ...(extras.minAssets !== undefined ? { min_assets_usd: extras.minAssets } : {}),
    ...(extras.assetGate ? { asset_gate: true } : {}),
  };
}

export function resetCachesForTest(): void {
  referralLinksCache = null;
  feeRatesCache = null;
  countryRestrictionsCache = null;
  tokenDiscountsCache = null;
  withdrawalFeesCache = null;
  fundingRatesCache = null;
  fxRatesCache = null;
  pairFeesCache = null;
  spreadBaselineCache = null;
  fiatRoutesCache = null;
  feeChangesCache = null;
  ladderSnapshotsCache = null;
}
