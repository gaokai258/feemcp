export type TradingPurpose = "spot" | "futures";

// ---------- v0.36: markdown/CSV matrix rendering ----------
export type RenderFormat = "json" | "markdown" | "csv" | "both";
export interface RenderedTable {
  metric: string;
  markdown?: string;
  csv?: string;
}

// ---------- v0.6: data provenance ----------
export interface DataSource {
  name: string;
  url?: string;
  note?: string;
}

export interface DataProvenance {
  file: string;
  last_verified?: string;
  /** Whole months between last_verified and now; null when the date is unparseable. */
  months_behind?: number | null;
  /** True when missing/unparseable or older than the configured staleness threshold. */
  is_stale?: boolean;
  sources?: DataSource[];
}

export interface DataProvenanceReport {
  data_as_of: string;
  /** Staleness threshold in months applied to every per-file is_stale flag. */
  stale_after_months: number;
  /** Files whose is_stale is true (empty when the whole bundle is current). */
  stale_files: string[];
  files: DataProvenance[];
}

export interface ReferralLink {
  url: string;
  discount: string;
  my_rebate_rate: string;
  regions: string[];
  notes?: string;
}

export interface FeeTierSpot {
  tier: string;
  min_volume_usd: number;
  min_bnb?: number;
  min_gt?: number;
  min_kcs?: number;
  min_assets_usd?: number;
  maker: number;
  taker: number;
}

export interface FeeTierSpotSingle {
  tier: string;
  min_volume_usd: number;
  min_gt?: number;
  fee: number;
}

export interface FeeTierFutures {
  tier: string;
  min_volume_usd: number;
  min_gt?: number;
  min_kcs?: number;
  min_assets_usd?: number;
  maker: number;
  taker: number;
}

/** v0.13: KuCoin-style spot symbol classification (Class A ladder, B/C scale it). */
export interface SpotFeeClasses {
  primary: string;
  multipliers: { B: number; C: number };
  note: string;
}

/**
 * v0.44: how a venue actually prices execution.
 *  - "order_book": explicit maker/taker commission ON TOP of the bid-ask
 *    spread (every classic CEX; spread crossing is priced separately).
 *  - "flat": volume-independent single commission with no maker/taker split,
 *    quoted alongside an order-book/SOR execution (Finst 0.15%).
 *  - "spread": broker quote model — there is no separate commission; the
 *    venue's per-side premium IS the cost of execution (embedded in the
 *    quoted price). Spread crossing must NOT be added on top in all-in math.
 */
export type PricingModel = "order_book" | "flat" | "spread";

/**
 * v0.44: independent real-money evidence that advertised broker premiums
 * understate true execution cost. Spread-model brokerages quote a premium
 * (e.g. 1.49% per side) but peer-reviewed round-trip testing can show a much
 * wider realized markup. Surfaced verbatim (with sources) so agents can tell
 * users the difference between the published and measured price.
 */
export interface ExecutionQualityEvidence {
  /** Advertised full round-trip cost implied by the schedule (2× one-way premium). */
  advertised_roundtrip_pct?: number;
  /** Measured mean round-trip cost in percent (buy €X then immediately sell). */
  measured_roundtrip_pct: number;
  /** Measured cost minus the round-trip cost the published schedule predicts. */
  measured_hidden_markup_pct?: number;
  /** Sample/design summary (trades, notional, days). */
  trades: string;
  study: string;
  period: string;
  url?: string;
  /** Independent replication of the same finding (different team/methodology). */
  replication?: {
    study: string;
    period: string;
    trades?: string;
    url?: string;
  };
  note: string;
}

export interface ExchangeFeeRates {
  spot: FeeTierSpot[] | FeeTierSpotSingle[];
  futures: FeeTierFutures[];
  spot_fee_classes?: SpotFeeClasses;
  /** v0.44: execution-pricing model; absent = "order_book" (back-compat). */
  pricing_model?: PricingModel;
  /** v0.44: independent measured execution-quality evidence (spread brokers). */
  execution_quality?: ExecutionQualityEvidence;
  /** v0.14: free-form exchange-specific qualification/rate caveats surfaced to callers. */
  notes?: string[];
}

export interface FeeRatesData {
  last_verified: string;
  sources?: DataSource[];
  exchanges: {
    [exchange: string]: ExchangeFeeRates;
  };
}

export interface CountryRestriction {
  blocked: string[];
  allowed: string[];
  /**
   * v0.38: venue-level PRODUCT blocks that apply ONLY in this country even
   * though the venue itself can onboard residents here (e.g. Bitstamp serves
   * spot in the US but its MiCA/MiFID perpetuals are EU-eligible only).
   * Keys are venue ids; values list purposes ("spot"/"futures") unavailable.
   * Absence of a venue key means no extra product gating in this country.
   */
  product_blocked?: Record<string, TradingPurpose[]>;
}

/**
 * v0.40: named region allowlists (ISO-3166-1 alpha-2 members), e.g. EEA =
 * EU27 + Iceland/Liechtenstein/Norway (30 member states).
 */
export interface RegionMembership {
  [region: string]: string[];
}

/**
 * v0.40: positive region gates — the venue/purpose is available ONLY when the
 * user's country is a member of at least one listed region. A country that is
 * given but outside every listed region is blocked; this replaces the v0.38
 * negative-list default key that over-opened Bitstamp perps to AU/BR/etc.
 */
export type ProductRegionGates = Record<
  string,
  Partial<Record<TradingPurpose, string[]>>
>;

/**
 * v0.41: negative region blocks at VENUE level — the venue cannot onboard or
 * serve residents of ANY member of the listed regions (all products). Used for
 * the post-MiCA-cliff EEA sweep (2026-07-01): exchanges without a CASP
 * authorization (binance/mexc/bitget/blofin/phemex/bingx, plus kucoin whose
 * authorized EU entity remains under an FMA commencement prohibition) are
 * blocked across every EEA state without enumerating them per country.
 */
export type VenueRegionBlocks = Record<string, string[]>;

/**
 * v0.42: POSITIVE region allowlist at VENUE level — the venue may only onboard
 * residents of the listed regions; a country that is given but belongs to none
 * of them is blocked. Complements VenueRegionBlocks (negative list) for venues
 * whose service area is a small authorization footprint (e.g. Bitvavo: MiCA
 * CASP passporting across EEA30 plus separately licensed GB/CH access). Venues
 * absent from this table stay unrestricted (false-safe).
 */
export type VenueRegionAllows = Record<string, string[]>;

/**
 * v0.41: negative region blocks at PRODUCT level — the venue/purpose is
 * unavailable in every member of the listed regions while other products stay
 * open. Used for EEA perpetuals: crypto derivatives require a MiFID II
 * investment-firm licence on top of MiCA CASP, so bybit/gate (CASP-licensed
 * for spot, MiFID pending/unfiled) cannot offer futures to EEA residents.
 */
export type ProductRegionBlocks = Record<
  string,
  Partial<Record<TradingPurpose, string[]>>
>;

export interface CountryRestrictionsData {
  last_verified?: string;
  sources?: DataSource[];
  regions?: RegionMembership;
  product_region_gates?: ProductRegionGates;
  region_blocked?: VenueRegionBlocks;
  region_allowed?: VenueRegionAllows;
  product_region_blocked?: ProductRegionBlocks;
  [country: string]:
    | CountryRestriction
    | string
    | DataSource[]
    | RegionMembership
    | ProductRegionGates
    | VenueRegionBlocks
    | VenueRegionAllows
    | ProductRegionBlocks
    | undefined;
}

export interface ReferralLinksData {
  last_verified?: string;
  sources?: DataSource[];
  exchanges: {
    [exchange: string]: ReferralLink;
  };
}

export interface TokenDiscount {
  token: string;
  spot_discount_pct: number;
  futures_discount_pct: number;
  futures_maker_to_zero?: boolean;
  holding_tiers?: { min_balance: number; discount_pct: number }[];
  description?: string;
}

export interface TokenDiscountsData {
  last_verified: string;
  sources?: DataSource[];
  exchanges: {
    [exchange: string]: TokenDiscount;
  };
}

export interface WithdrawalFee {
  network: string;
  fee: number;
  fee_usd?: number;
  fee_usd_approx?: number;
  suspended?: boolean;
  note?: string;
}

export interface WithdrawalFeesData {
  last_verified: string;
  sources?: DataSource[];
  asset_prices_usd?: { [asset: string]: number };
  exchanges: {
    [exchange: string]: {
      [asset: string]: WithdrawalFee | { [network: string]: WithdrawalFee };
    };
  };
}

// v0.18: standalone withdrawal-fee comparison.
export interface WithdrawalNetworkQuote {
  network: string;
  fee: number | null;
  fee_usd: number | null;
  available: boolean;
  note?: string;
}

export interface WithdrawalExchangeQuote {
  exchange: string;
  supported: boolean;
  networks: WithdrawalNetworkQuote[];
  cheapest_network?: string;
  cheapest_fee_usd?: number;
  /** v0.46: present for a stablecoin asset this venue may not let region residents trade (on-chain withdrawal rights themselves remain). */
  stablecoin_access?: StablecoinVenueAccess;
}

export interface WithdrawalBestPick {
  exchange: string;
  network: string;
  fee: number;
  fee_usd: number;
}

export interface WithdrawalFeesResult {
  asset: string;
  network?: string;
  asset_price_usd?: number;
  fetched_at: string;
  data_as_of: string;
  exchanges: WithdrawalExchangeQuote[];
  best: WithdrawalBestPick | null;
  saving_vs_worst_usd?: number;
  advice: string;
  warnings?: string[];
  /** v0.46: present when the asset is a stablecoin barred from the resident region's licensed venues (trading delisted; withdrawal rights may remain). */
  stablecoin_warning?: StablecoinWarning;
}

export interface FundingRateData {
  interval_hours: number;
  avg_rate_pct: number;
  description?: string;
}

export interface FundingRatesData {
  last_verified: string;
  sources?: DataSource[];
  exchanges: {
    [exchange: string]: FundingRateData;
  };
}

// ---------- v0.15: live funding rates ----------
export type FundingMode = "bundled" | "live";
export type FundingSource = "bundled" | "live";

/** A funding rate fed into the cost math: either the bundled average or a live fetched value. */
export interface FundingRateOverride {
  /** Rate in percent per interval (0.01 = 0.01%); negative values pass through untouched. */
  rate_pct: number;
  interval_hours: number;
  /** ISO timestamp of the funding rate the exchange reported. */
  timestamp?: string;
  source: FundingSource;
}

/** Per-exchange funding overrides keyed by our internal exchange id. */
export type FundingOverrides = { [exchange: string]: FundingRateOverride };

export interface FundingRateEntry {
  exchange: string;
  rate_pct: number;
  interval_hours: number;
  source: FundingSource;
  /** ISO timestamp of the exchange-reported rate (live only). */
  funding_timestamp?: string;
  pair?: string;
  note?: string;
}

export interface FundingRateFailure {
  exchange: string;
  error: string;
  fallback: "bundled";
}

export interface FundingRatesToolResult {
  pair: string;
  mode: FundingMode;
  fetched_at: string;
  data_as_of?: string;
  rates: FundingRateEntry[];
  failures: FundingRateFailure[];
}

// ---------- v0.16: bid-ask spread + order-book slippage ----------
export type SpreadMode = "bundled" | "live";
export type SpreadSource = "bundled" | "live";

export interface SpreadBaselineEntry {
  typical_spread_bps: number;
  note?: string;
}

export interface SpreadBaselineData {
  last_verified: string;
  sources?: DataSource[];
  methodology?: string;
  pair_class_multipliers: {
    majors: number;
    large_cap: number;
    mid_alt: number;
  };
  majors: string[];
  large_cap: string[];
  exchanges: {
    [exchange: string]: SpreadBaselineEntry;
  };
}

/** One-way taker execution cost fed into the cost math, in basis points. */
export interface SpreadOverride {
  /** Cost of crossing to the best touch: half the top-of-book spread (buy side shown). */
  crossing_bps: number;
  /** Size-conditional market impact beyond the best touch; 0 for bundled mode. */
  slippage_bps: number;
  /** crossing_bps + slippage_bps. */
  total_bps: number;
  /** ISO timestamp of the order-book snapshot (live only). */
  timestamp?: string;
  source: SpreadSource;
  /** False when the fetched book did not contain enough depth to fill tradeSizeUsd (live). */
  fully_filled?: boolean;
  levels_consumed?: number;
  available_depth_usd?: number;
  symbol?: string;
}

export type SpreadOverrides = { [exchange: string]: SpreadOverride };

export interface ExecutionCostFailure {
  exchange: string;
  error: string;
  fallback: "bundled";
}

export interface ExecutionCostEntry {
  exchange: string;
  /** Full top-of-book bid-ask spread, bps. */
  spread_bps: number;
  /** Half-spread crossing cost, bps. */
  crossing_bps: number;
  /** Market impact beyond the best touch for the requested size, bps. */
  slippage_bps: number;
  /** crossing + slippage, one-way, bps. */
  total_bps: number;
  /** USD cost of one taker execution of tradeSizeUsd at total_bps. */
  cost_usd: number;
  levels_consumed?: number;
  fully_filled?: boolean;
  source: SpreadSource;
  book_timestamp?: string;
  symbol?: string;
  pair_class?: string;
  note?: string;
}

export interface ExecutionCostWarning {
  exchange: string;
  message: string;
}

export interface ExecutionCostResult {
  pair: string;
  purpose: TradingPurpose;
  side: "buy" | "sell";
  trade_size_usd: number;
  mode: SpreadMode;
  fetched_at: string;
  data_as_of?: string;
  costs: ExecutionCostEntry[];
  failures: ExecutionCostFailure[];
  /** Live rows where the visible book depth could not fully absorb the requested size. */
  warnings?: ExecutionCostWarning[];
  /** v0.46: pair quote is a stablecoin the region bars from licensed venues. */
  stablecoin_warning?: StablecoinWarning;
}

// ---------- v0.17: fiat on/off-ramp ----------

export type FiatDirection = "deposit" | "withdraw";
export type FiatRegion = "EU" | "US" | "GB" | "BR";
export type FiatMethod = "card" | "ach" | "sepa" | "fps" | "wire" | "swift" | "pix";
export type FiatCurrency = "USD" | "EUR" | "GBP" | "BRL";

/** Fee on one leg: pct of amount plus a fixed fee, with optional floor/cap (route currency). */
export interface FiatFeeShape {
  pct?: number;
  fixed?: number;
  min?: number;
  max?: number;
}

export interface FiatRoute {
  method: FiatMethod;
  currencies: FiatCurrency[];
  /** Restricts the rail to a country group; absent = available globally. */
  region?: FiatRegion;
  deposit: FiatFeeShape | null;
  withdraw: FiatFeeShape | null;
  eta: string;
  note?: string;
}

export interface FiatExchangeRoutes {
  routes: FiatRoute[];
  notes?: string[];
}

export interface FiatRoutesData {
  last_verified: string;
  methodology?: string;
  sources: DataSource[];
  regions: Record<FiatRegion, string[]>;
  exchanges: Record<string, FiatExchangeRoutes>;
}

export interface FiatRouteQuote {
  method: FiatMethod;
  /** Region tag for region-locked rails (e.g. card EU vs non-EU variants). */
  region?: FiatRegion;
  fee: number;
  fee_usd: number;
  effective_pct: number;
  /** Amount that actually arrives (amount minus fee), in the route currency. */
  net: number;
  eta: string;
  note?: string;
}

export interface FiatExchangeQuote {
  exchange: string;
  available: boolean;
  routes: FiatRouteQuote[];
  cheapest_method?: FiatMethod;
  cheapest_fee_usd?: number;
  notes?: string[];
}

export interface FiatBestPick {
  exchange: string;
  method: FiatMethod;
  fee: number;
  fee_usd: number;
  effective_pct: number;
  net: number;
}

export interface FiatCostResult {
  direction: FiatDirection;
  currency: FiatCurrency;
  amount: number;
  amount_usd: number;
  fx_rate?: number;
  fetched_at: string;
  data_as_of: string;
  exchanges: FiatExchangeQuote[];
  best: FiatBestPick | null;
  saving_vs_worst_usd?: number;
  advice: string;
  warnings?: string[];
}

export interface ResolvedFeeRate {
  base_maker: number;
  base_taker: number;
  /** Effective fee tier after applying any known native-token holding constraint. */
  tier: string;
  /** Fee tier the user's trade volume alone qualifies for (ignoring holdings). */
  volume_tier: string;
  min_bnb?: number;
  min_gt?: number;
  min_kcs?: number;
  /** Native token whose holdings gate the volume tier: "BNB" (binance), "GT" (gate) or "KCS" (kucoin). */
  token_name?: "BNB" | "GT" | "KCS";
  /** Native-token holdings required for the volume tier (0/undefined = no gate). */
  min_token?: number;
  /** Native-token holdings required for the effective tier. */
  effective_min_token?: number;
  /** True when insufficient provided token holdings downgraded the effective tier (Binance AND gate). */
  tier_held_back?: boolean;
  /** True when holdings lifted the effective tier above the volume tier (Gate GT or OKX assets). */
  tier_upgraded?: boolean;
  /** What lifted the tier when tier_upgraded is set: Gate GT / KuCoin KCS holdings or OKX account assets. */
  upgrade_basis?: "gt" | "kcs" | "assets";
  /** Next higher tier reachable by more holdings/volume (upgrade hint). */
  next_tier?: string;
  /** Native-token holdings required to reach next_tier. */
  next_min_token?: number;
  /** Account assets (USD) required to reach next_tier via the OKX asset path. */
  next_min_assets?: number;
  /** Account-asset requirement of the effective tier (OKX, USD). */
  min_assets_usd?: number;
  /** Ladder qualifies via account assets OR volume (OKX). */
  asset_gate?: boolean;
}

// ---------- v0.8: data freshness ----------
export interface DataFreshness {
  data_as_of: string;
  months_behind: number;
  is_stale: boolean;
  warning?: string;
}

export interface EffectiveFeeResult {
  exchange: string;
  tier: string;
  base_maker: number;
  base_taker: number;
  effective_maker: number;
  effective_taker: number;
  referral_discount?: string;
  token_applied: boolean;
  token_discount_pct: number;
  referral_url?: string;
}

// ---------- v0.12: pair-level fees & promos ----------
export interface PairFeeEntry {
  pairs: string[];
  /** Override maker rate for the listed pairs; omitted = use the account-tier maker. */
  maker?: number;
  /** Override taker rate for the listed pairs; omitted = use the account-tier taker. */
  taker?: number;
  promo?: boolean;
  note?: string;
}

export interface PairFeesData {
  last_verified: string;
  sources?: DataSource[];
  exchanges: {
    [exchange: string]: {
      spot?: PairFeeEntry[];
      futures?: PairFeeEntry[];
    };
  };
}

export interface ExchangeFeeInfo {
  exchange: string;
  tier: string;
  volume_tier?: string;
  base_maker: number;
  base_taker: number;
  effective_maker: number;
  effective_taker: number;
  weighted_rate: number;
  referral_discount?: string;
  token_applied: boolean;
  tier_warning?: string;
  freshness_warning?: string;
  data_as_of?: string;
  referral_url?: string;
  /** v0.12: "pair" when a pair-level fee/promo applied, else "account_tier". */
  pricing_basis: "pair" | "account_tier";
  pair_note?: string;
  /** v0.13: set on KuCoin spot results — quoted ladder is Class A; B/C pairs cost 2x/3x. */
  spot_class_note?: string;
  /** v0.14: exchange-specific qualification/rate caveats (Kraken unified Tier/Pro). */
  exchange_notes?: string[];
  /** v0.46: present when the priced pair quote is a stablecoin unavailable at this venue for the resident's region (e.g. a BTC/USDT quote for an EEA resident). */
  stablecoin_access?: StablecoinVenueAccess;
  /** v0.47: present when this venue's consumer app is TUM-measured pricier than the PRO book the row prices (Kraken app, Coinbase Simple). */
  consumer_interface?: InterfaceVenueHint;
}

export interface SavingsResult {
  exchange: string;
  volume: number;
  type: TradingPurpose;
  tier: string;
  volume_tier?: string;
  original_fee: number;
  fee_after_referral: number;
  fee_after_token: number;
  final_fee: number;
  total_savings: number;
  referral_discount?: string;
  token_applied: boolean;
  maker_share?: number;
  currency?: string;
  data_as_of?: string;
  tier_warning?: string;
  freshness_warning?: string;
  funding_cost?: number;
  /** v0.15: "live" when a real-time funding rate was used, "bundled" for the static average. */
  funding_source?: FundingSource;
  funding_rate_ts?: string;
  funding_pair?: string;
  /** v0.16: one-way bid-ask crossing cost for tradeSizeUsd (present when tradeSizeUsd is set). */
  spread_cost?: number;
  /** v0.16: size-conditional market impact beyond the best touch (live books only). */
  slippage_cost?: number;
  spread_source?: SpreadSource;
  spread_ts?: string;
  spread_pair?: string;
  referral_url?: string;
  pricing_basis: "pair" | "account_tier";
  pair_note?: string;
  /** v0.13: set on KuCoin spot results — quoted ladder is Class A; B/C pairs cost 2x/3x. */
  spot_class_note?: string;
  /** v0.14: exchange-specific qualification/rate caveats (Kraken unified Tier/Pro). */
  exchange_notes?: string[];
  /** v0.46: pair quote is a stablecoin the region bars from licensed venues. */
  stablecoin_warning?: StablecoinWarning;
  /** v0.47: present when the queried venue's consumer app is TUM-measured pricier than its PRO book (Kraken app, Coinbase Simple). */
  interface_warning?: InterfaceWarning;
}

export interface TotalCostResult {
  exchange: string;
  tier: string;
  volume_tier?: string;
  trading_fee: number;
  funding_cost: number;
  /** v0.15: "live" when a real-time funding rate was used, "bundled" for the static average. */
  funding_source?: FundingSource;
  funding_rate_ts?: string;
  funding_pair?: string;
  /** v0.16: one-way bid-ask crossing cost (present when tradeSizeUsd is set). */
  spread_cost?: number;
  /** v0.16: order-book market impact for the requested size (live books only). */
  slippage_cost?: number;
  spread_source?: SpreadSource;
  spread_ts?: string;
  spread_pair?: string;
  withdrawal_cost: number;
  total_cost: number;
  maker_share?: number;
  currency?: string;
  data_as_of?: string;
  tier_warning?: string;
  freshness_warning?: string;
  referral_url?: string;
  pricing_basis: "pair" | "account_tier";
  pair_note?: string;
  /** v0.13: set on KuCoin spot results — quoted ladder is Class A; B/C pairs cost 2x/3x. */
  spot_class_note?: string;
  /** v0.14: exchange-specific qualification/rate caveats (Kraken unified Tier/Pro). */
  exchange_notes?: string[];
  /** v0.26: annual direct-fiat deposit cost (cheapest rail × deposits_per_year). */
  fiat_deposit_cost?: number;
  /** v0.26: annual direct-fiat cash-out cost (cheapest rail × cashouts_per_year). */
  fiat_cashout_cost?: number;
  fiat_deposit_available?: boolean;
  fiat_cashout_available?: boolean;
  fiat_deposit_method?: FiatMethod;
  fiat_cashout_method?: FiatMethod;
  /** v0.46: pair quote is a stablecoin the region bars from licensed venues. */
  stablecoin_warning?: StablecoinWarning;
  /** v0.47: present when this venue's consumer app is TUM-measured pricier than the PRO book the row prices (Kraken app, Coinbase Simple). */
  consumer_interface?: InterfaceVenueHint;
}

export interface ToolError {
  error: string;
  code?: string;
  retryable?: boolean;
  suggested_action?: string;
}

// ---------- v0.10: annualized total cost ----------
export interface AnnualCostUpgrade {
  next_tier: string;
  /** 30-day volume required for the next tier (USD). */
  requires_volume_usd?: number;
  /** OKX account assets that also qualify for the next tier (USD). */
  requires_assets_usd?: number;
  /** Gate GT holdings that also qualify for the next tier. */
  requires_gt?: number;
  /** KuCoin KCS holdings that alternatively qualify for the next tier. */
  requires_kcs?: number;
  /** Binance spot BNB additionally required for the next tier. */
  requires_bnb?: number;
  /** Annualized trading fee at the current effective tier. */
  annual_fee_current: number;
  /** Annualized trading fee after reaching the next tier. */
  annual_fee_next_tier: number;
  /** Annualized trading-fee saving unlocked by the upgrade. */
  annual_savings: number;
  hint: string;
}

export interface AnnualCostResult {
  exchange: string;
  purpose: TradingPurpose;
  tier: string;
  volume_tier?: string;
  monthly_volume_usd: number;
  annual_trading_fee: number;
  annual_funding_cost: number;
  /** v0.15: "live" when a real-time funding rate was used, "bundled" for the static average. */
  funding_source?: FundingSource;
  funding_rate_ts?: string;
  funding_pair?: string;
  /** v0.16: annualized one-way spread crossing over the full traded notional. */
  annual_spread_cost?: number;
  /** v0.16: annualized order-book impact (live books only). */
  annual_slippage_cost?: number;
  spread_source?: SpreadSource;
  spread_ts?: string;
  spread_pair?: string;
  annual_withdrawal_cost: number;
  annual_total_cost: number;
  withdrawals_per_year?: number;
  /** v0.26: annual direct-fiat deposit cost (cheapest rail × fiat_deposits_per_year). */
  annual_fiat_deposit_cost?: number;
  /** v0.26: annual direct-fiat cash-out cost (cheapest rail × fiat_cashouts_per_year). */
  annual_fiat_cashout_cost?: number;
  fiat_deposit_available?: boolean;
  fiat_cashout_available?: boolean;
  fiat_deposit_method?: FiatMethod;
  fiat_cashout_method?: FiatMethod;
  maker_share?: number;
  currency?: string;
  data_as_of?: string;
  tier_warning?: string;
    freshness_warning?: string;
    upgrade?: AnnualCostUpgrade;
    referral_url?: string;
  pricing_basis: "pair" | "account_tier";
  pair_note?: string;
  /** v0.13: set on KuCoin spot results — quoted ladder is Class A; B/C pairs cost 2x/3x. */
  spot_class_note?: string;
  /** v0.14: exchange-specific qualification/rate caveats (Kraken unified Tier/Pro). */
  exchange_notes?: string[];
  /** v0.46: pair quote is a stablecoin the region bars from licensed venues. */
  stablecoin_warning?: StablecoinWarning;
  /** v0.47: present when the queried venue's consumer app is TUM-measured pricier than its PRO book. */
  interface_warning?: InterfaceWarning;
}

// ---------- v0.5: FX rates ----------
export interface FxRatesData {
  last_verified: string;
  base: string;
  note?: string;
  sources?: DataSource[];
  rates: { [currency: string]: number };
}

// ---------- v0.5: weighted fee ----------
export interface WeightedFee {
  weighted_rate: number;
  maker_component: number;
  taker_component: number;
}

// ---------- v0.5: recommendation ----------
export interface ExchangeRecommendation {
  exchange: string;
  tier: string;
  volume_tier?: string;
  weighted_fee_rate: number;
  effective_maker: number;
  effective_taker: number;
  estimated_fee: number;
  funding_cost?: number;
  /** v0.15: "live" when a real-time funding rate was used, "bundled" for the static average. */
  funding_source?: FundingSource;
  funding_rate_ts?: string;
  funding_pair?: string;
  /** v0.16: one-way spread crossing + impact for tradeSizeUsd. */
  spread_cost?: number;
  slippage_cost?: number;
  spread_source?: SpreadSource;
  spread_ts?: string;
  spread_pair?: string;
  /** v0.27: annualized direct fiat deposit/cash-out cost (cheapest rail × yearly count). */
  fiat_deposit_cost?: number;
  fiat_cashout_cost?: number;
  fiat_deposit_available?: boolean;
  fiat_cashout_available?: boolean;
  fiat_deposit_method?: FiatMethod;
  fiat_cashout_method?: FiatMethod;
  score: number;
  reasons: string[];
  tradeoffs: string[];
  tier_warning?: string;
  referral_discount?: string;
  referral_url?: string;
  pricing_basis: "pair" | "account_tier";
  pair_note?: string;
  /** v0.13: set on KuCoin spot results — quoted ladder is Class A; B/C pairs cost 2x/3x. */
  spot_class_note?: string;
  /** v0.14: exchange-specific qualification/rate caveats (Kraken unified Tier/Pro). */
  exchange_notes?: string[];
  /** v0.46: present when the priced pair quote is a stablecoin unavailable at this venue for the resident's region. */
  stablecoin_access?: StablecoinVenueAccess;
  /** v0.47: present when this venue's consumer app is TUM-measured pricier than the PRO book the row prices. */
  consumer_interface?: InterfaceVenueHint;
}

export interface RecommendationResult {
  purpose: TradingPurpose;
  country: string;
  volume: number;
  currency: string;
  data_as_of?: string;
  data_sources?: DataSource[];
  freshness_warning?: string;
  best: ExchangeRecommendation;
  alternatives: ExchangeRecommendation[];
  advice: string;
  /** v0.46: pair quote is a stablecoin the region bars from licensed venues. */
  stablecoin_warning?: StablecoinWarning;
  /** v0.47: present when the recommended venue's consumer app is TUM-measured pricier than its PRO book. */
  interface_warning?: InterfaceWarning;
}

// ---------- v0.22: trader personas ----------
export interface PersonaFiatHabit {
  deposits_per_year?: number;
  deposit_amount_usd?: number;
  currency?: FiatCurrency;
  method?: FiatMethod;
  cashouts_per_year?: number;
  cashout_amount_usd?: number;
}

export interface TraderPersona {
  id: string;
  name_en: string;
  name_zh: string;
  tagline_zh: string;
  description_zh: string;
  purpose: TradingPurpose;
  monthly_volume_usd: number;
  maker_share: number;
  use_token?: boolean;
  account_assets_usd?: number;
  holding_hours?: number;
  trade_size_usd?: number;
  pair?: string;
  withdrawal_asset?: string;
  withdrawals_per_year?: number;
  fiat?: PersonaFiatHabit;
  dominant_costs: string[];
  assumptions: string[];
  research_basis: string;
}

export interface PersonasData {
  last_verified: string;
  note?: string;
  sources?: DataSource[];
  personas: TraderPersona[];
}

/** Per-venue annualized cost row for a persona scenario. */
export interface PersonaCostRow {
  exchange: string;
  tier: string;
  volume_tier?: string;
  annual_trading_fee: number;
  annual_funding_cost: number;
  annual_execution_cost?: number;
  annual_withdrawal_cost: number;
  annual_fiat_deposit_cost?: number;
  annual_fiat_cashout_cost?: number;
  /** Modeled annual all-in: trading + funding + execution + withdrawal + priced fiat legs. */
  annual_all_in: number;
  /** Share of each priced component in annual_all_in (0-100, rounded). */
  cost_mix_pct: {
    trading_fee: number;
    funding: number;
    execution: number;
    withdrawal: number;
    fiat: number;
  };
  fiat_deposit_available?: boolean;
  fiat_cashout_available?: boolean;
  fiat_deposit_method?: FiatMethod;
  fiat_cashout_method?: FiatMethod;
  referral_url?: string;
  pricing_basis?: "pair" | "account_tier";
  tier_warning?: string;
  freshness_warning?: string;
  exchange_notes?: string[];
  /** Venue lists no OPEN route for the persona's withdrawal asset (cost excluded, not zero). */
  withdrawal_unsupported?: boolean;
  /** v0.25: best native-token discount payback for this venue (only when persona ran with useToken=false). */
  token_discount_hint?: PersonaTokenDiscountHint;
  /** v0.46: present when the persona withdraws in a stablecoin this venue may not let region residents trade. */
  stablecoin_access?: StablecoinVenueAccess;
}

/** v0.25: concise token-discount payback summary injected into persona rows. */
export interface PersonaTokenDiscountHint {
  token: string;
  /** Effective discount % of the best-payback tier. */
  discount_pct: number;
  /** Annual USD saving vs. the no-token base tier. */
  annual_saving_usd: number;
  /** Months to recoup the locked token capital (null if saving is non-positive). */
  payback_months: number | null;
  /** USD value of the token balance needed to unlock this tier. */
  holding_cost_usd: number;
  /** True for flat-deduction tokens (BNB/MX/BGB/KCS/PT) that work at any balance. */
  is_flat: boolean;
}

export interface PersonaComponentLeader {
  exchange: string;
  annual_cost: number;
}

export interface PersonaBestPick {
  exchange: string;
  tier: string;
  annual_all_in: number;
  runner_up_exchange: string;
  runner_up_annual_all_in: number;
  /** Positive number: runner-up all-in minus winner all-in. */
  saving_vs_runner_up: number;
  reasons: string[];
  tradeoffs: string[];
}

export interface PersonaCompletePick {
  exchange: string;
  annual_all_in: number;
  /** How much MORE this fully-modeled pick costs than the raw winner. */
  extra_vs_winner: number;
}

export interface PersonaAnalysisResult {
  persona: {
    id: string;
    name_en: string;
    name_zh: string;
    tagline_zh: string;
    description_zh: string;
    assumptions: string[];
    research_basis: string;
    dominant_costs: string[];
  };
  country: string;
  purpose: TradingPurpose;
  inputs: {
    monthly_volume_usd: number;
    maker_share: number;
    use_token: boolean;
    holding_hours?: number;
    trade_size_usd?: number;
    account_assets_usd?: number;
    withdrawal_asset?: string;
    withdrawals_per_year?: number;
    fiat_deposits_per_year?: number;
    fiat_cashouts_per_year?: number;
  };
  currency: string;
  ranking: PersonaCostRow[];
  best: PersonaBestPick | null;
  /**
   * Cheapest venue whose cost is FULLY modeled for this persona (open withdrawal
   * route when the persona withdraws; direct fiat rails when the persona
   * deposits/cashes out). Equals the winner unless the winner only wins by
   * excluding unmodeled legs (no rail / unsupported route).
   */
  best_complete?: PersonaCompletePick | null;
  component_leaders: {
    trading_fee?: PersonaComponentLeader;
    funding?: PersonaComponentLeader;
    execution?: PersonaComponentLeader;
    withdrawal?: PersonaComponentLeader;
    fiat?: PersonaComponentLeader;
  };
  warnings: string[];
  advice: string[];
  data_as_of?: string;
  data_sources?: DataSource[];
  freshness_warning?: string;
  /** v0.25: native-token discount payback hints for the top-ranked venues (only when useToken=false). */
  token_discount_hints?: Array<{ exchange: string } & PersonaTokenDiscountHint>;
  /** v0.46: present when the persona trades or withdraws in a stablecoin barred from the resident region's licensed venues. */
  stablecoin_warning?: StablecoinWarning;
  /** v0.47: present when the persona's best-ranked venue's consumer app is TUM-measured pricier than its PRO book. */
  interface_warning?: InterfaceWarning;
}

// ---------- v0.28: multi-persona batch comparison / decision matrix ----------

/** One venue cell in a persona's annual-all-in row. */
export interface PersonaMatrixCell {
  exchange: string;
  annual_all_in: number;
  /** Venue lists no open route for the persona's withdrawal asset (leg excluded, not zero). */
  withdrawal_unsupported?: boolean;
  fiat_deposit_available?: boolean;
  fiat_cashout_available?: boolean;
}

/** Compact per-persona outcome inside a batch comparison. */
export interface PersonaComparisonEntry {
  persona: {
    id: string;
    name_en: string;
    name_zh: string;
    tagline_zh: string;
  };
  purpose: TradingPurpose;
  monthly_volume_usd: number;
  /** Lowest modeled all-in; null only when fewer than 2 venues could be ranked. */
  best: {
    exchange: string;
    tier: string;
    annual_all_in: number;
    runner_up_exchange: string;
    saving_vs_runner_up: number;
    cost_mix_pct: PersonaCostRow["cost_mix_pct"];
    /** Winner-specific caveats (no fiat rail / unsupported withdrawal route). */
    tradeoffs: string[];
  } | null;
  /** Cheapest venue with EVERY persona leg actually priced; null when no full pick. */
  best_complete: PersonaCompletePick | null;
  /** Venues ranked cheapest-first; a venue absent here is blocked in-country or spot-only. */
  matrix: PersonaMatrixCell[];
}

/** How many personas each venue wins. */
export interface PersonaVenueWins {
  exchange: string;
  headline_persona_ids: string[];
  complete_persona_ids: string[];
}

export interface PersonaComparisonResult {
  country: string;
  currency: string;
  personas: PersonaComparisonEntry[];
  /** Union of venues that appear in at least one persona matrix (stable display order). */
  venues: string[];
  /** Venues sorted by complete-pick wins, then headline wins. */
  venue_wins: PersonaVenueWins[];
  /** Venue with the most best_complete wins (realistic all-legs pick) — the most versatile venue. */
  most_versatile: string | null;
  data_as_of?: string;
  data_sources?: DataSource[];
  freshness_warning?: string;
  errors?: Array<{ persona: string; code?: string; error: string }>;
  /** v0.36: present only when format=markdown|csv|both is requested. */
  rendered?: RenderedTable;
}

// ---------- v0.23: native-token fee-discount payback analysis ----------

export interface TokenPricesData {
  last_verified: string;
  note?: string;
  sources?: DataSource[];
  prices: {
    [token: string]: number;
  };
}

export interface TokenDiscountTierAnalysis {
  /** Minimum token balance required for this discount level. */
  min_balance: number;
  /** Effective fee discount at this level (percentage points). */
  discount_pct: number;
  /** Effective blended rate (decimal, e.g. 0.00075) after tier + discount. */
  effective_rate: number;
  annual_fee_usd: number;
  annual_saving_usd: number;
  /** Cost of locking up min_balance tokens at the snapshot price. */
  holding_cost_usd: number;
  /** Months of fee savings to recoup the holding cost; null if saving is 0. */
  payback_months: number | null;
  /** Maximum one-year token price drop (in %) the saving can absorb before net negative. */
  breakeven_price_drop_pct: number | null;
}

export interface TokenDiscountAnalysisResult {
  exchange: string;
  purpose: TradingPurpose;
  country: string;
  token: string;
  has_native_discount: boolean;
  /** Snapshot USD price used (override or bundled). */
  token_price_usd: number;
  currency: string;
  inputs: {
    monthly_volume_usd: number;
    maker_share: number;
    token_balance?: number;
    account_assets_usd?: number;
  };
  base: {
    tier: string;
    maker_rate: number;
    taker_rate: number;
    blended_rate: number;
    annual_fee_usd: number;
  };
  /** Discounted result when a specific token_balance was provided. */
  discounted?: {
    tier: string;
    maker_rate: number;
    taker_rate: number;
    blended_rate: number;
    discount_pct: number;
    annual_fee_usd: number;
    annual_saving_usd: number;
    holding_cost_usd: number;
    payback_months: number | null;
    breakeven_price_drop_pct: number | null;
  };
  /** All achievable discount levels (returned when token_balance is omitted). */
  tiers_analysis?: TokenDiscountTierAnalysis[];
  recommended_tier_index?: number | null;
  warnings: string[];
  advice: string[];
  data_as_of?: string;
  data_sources?: DataSource[];
}

// v0.34: volume what-if sweep — cost curve across monthly-volume levels.
export interface WhatIfRankingCell {
  exchange: string;
  tier: string;
  /** Present when the effective tier differs from the volume-only tier (holding gate). */
  volume_tier?: string;
  weighted_fee_pct: number;
  annual_fee_usd: number;
  /** True at the first sweep point where this venue's effective tier changes vs the previous point. */
  tier_crossed?: boolean;
}

export interface WhatIfPoint {
  monthly_volume_usd: number;
  annual_traded_notional_usd: number;
  cheapest: {
    exchange: string;
    tier: string;
    weighted_fee_pct: number;
    annual_fee_usd: number;
  };
  ranking: WhatIfRankingCell[];
}

export interface WhatIfSweepPoint {
  monthly_volume_usd: number;
  tier: string;
  volume_tier?: string;
  effective_maker_pct: number;
  effective_taker_pct: number;
  weighted_fee_pct: number;
  annual_fee_usd: number;
  tier_crossed?: boolean;
}

export interface WhatIfNextTier {
  from_tier: string;
  to_tier: string;
  /** 30-day volume at which the next volume tier unlocks. */
  at_monthly_volume_usd: number;
  /** Extra monthly volume needed from the user's current level. */
  additional_monthly_volume_usd: number;
  weighted_fee_pct_now: number;
  weighted_fee_pct_next: number;
  /** Annual fee delta at the CURRENT volume if the next tier applied today. */
  saving_per_year_usd_at_current_volume: number;
  /** Volume alone does not move the effective tier (e.g. Binance spot also requires BNB). */
  blocked_by_holding_gate?: boolean;
}

export interface WhatIfExchange {
  exchange: string;
  current: {
    monthly_volume_usd: number;
    tier: string;
    weighted_fee_pct: number;
    annual_fee_usd: number;
  } | null;
  /** Null when already at the top volume tier; omitted when no base volume was given. */
  next_tier?: WhatIfNextTier | null;
  sweep: WhatIfSweepPoint[];
}

export interface WhatIfTierCrossing {
  at_monthly_volume_usd: number;
  exchange: string;
  from_tier: string;
  to_tier: string;
}

export interface VolumeWhatIfResult {
  purpose: TradingPurpose;
  country: string;
  currency: string;
  maker_share: number;
  use_token: boolean;
  base_monthly_volume_usd?: number;
  volumes: number[];
  data_as_of: string;
  points: WhatIfPoint[];
  tier_crossings: WhatIfTierCrossing[];
  exchanges: WhatIfExchange[];
  advice: string[];
  warnings?: string[];
  /** v0.36: present only when format=markdown|csv|both is requested. */
  rendered?: RenderedTable;
}

// v0.35: country diff matrix — the same trader profile run across countries.
export type CountryVenueStatus = "available" | "blocked" | "unsupported_product";

export interface CountryComparisonRow {
  country: string;
  available_venues: number;
  winner: {
    exchange: string;
    tier: string;
    annual_all_in: number;
  } | null;
  best_complete: {
    exchange: string;
    annual_all_in: number;
    extra_vs_winner: number;
  } | null;
  /**
   * The comparable annual cost for cross-country math: the realistic all-legs
   * pick (best_complete) when the headline winner misses rails, else the winner.
   */
  comparison_basis: "winner" | "best_complete";
  comparison_annual_all_in: number | null;
  /** Extra annual cost vs the cheapest compared country (null when no priced winner). */
  extra_vs_cheapest_country_usd: number | null;
  extra_vs_cheapest_country_pct: number | null;
  blocked_venues: string[];
  /** Allowed in-country but no product for this profile (e.g. Coinbase for futures). */
  unsupported_product_venues: string[];
  ranking: PersonaCostRow[];
  /** Present when the persona engine could not price anything in this country. */
  error?: string;
  error_code?: string;
}

export interface CountryVenueAvailability {
  exchange: string;
  per_country: Record<string, CountryVenueStatus>;
  blocked_in: string[];
}

export interface CountryWinnerCount {
  exchange: string;
  count: number;
  countries: string[];
}

// ---------- v0.46: MiCA stablecoin regional access (USDT EEA sweep) ----------

/**
 * Whether a tracked stablecoin can be offered by licensed venues in a region.
 * - "unavailable": no venue operating under the regional regime may offer it.
 */
export type StablecoinVenueTrading = "available" | "unavailable";

export interface StablecoinRegionRule {
  venue_trading: StablecoinVenueTrading;
  /** Date the regime's hard enforcement begins (e.g. MiCA CASP cliff 2026-07-01). */
  effective: string;
  wave_note?: string;
  custody_withdrawal?: string;
  self_custody_allowed?: boolean;
  alternatives?: string[];
  note?: string;
}

export interface StablecoinAssetInfo {
  name: string;
  issuer: string;
  /** False = no e-money-token (EMT) authorization under the region's regime. */
  mica_authorized: boolean;
  issuer_note?: string;
  authorized_note?: string;
  /** Keyed by region id from country_restrictions.json regions (e.g. "EEA"). */
  region_rules?: Record<string, StablecoinRegionRule>;
}

/**
 * Per-venue USDT (etc.) access.
 * scope "eea"  = rule applies only to residents of the named region;
 * scope "global" = venue policy everywhere (e.g. Bison never lists stablecoins).
 * Statuses:
 * - "delisted": pairs used to exist and were removed;
 * - "never_offered": venue entity never listed the asset;
 * - "venue_blocked": the venue itself cannot serve region residents.
 */
export type StablecoinVenueStatus = "delisted" | "never_offered" | "venue_blocked";

export interface StablecoinVenueRule {
  scope: "eea" | "global";
  status: StablecoinVenueStatus;
  since?: string;
  note?: string;
}

export interface StablecoinAccessData {
  last_verified: string;
  sources?: DataSource[];
  regulation?: {
    framework?: string;
    emt_rules_effective?: string;
    casp_transition_end?: string;
    region?: string;
    self_custody_allowed?: boolean;
    self_custody_note?: string;
  };
  assets: Record<string, StablecoinAssetInfo>;
  venues: Record<string, Record<string, StablecoinVenueRule>>;
}

/** Structured warning attached to fee/withdrawal/persona results. */
export interface StablecoinWarning {
  code: "STABLECOIN_UNAVAILABLE_IN_REGION";
  asset: string;
  region: string;
  /** Localized human message (follows the tool's `language` parameter). */
  message: string;
  effective?: string;
  self_custody_allowed?: boolean;
  alternatives?: string[];
  /** "trading" when a pair quote is affected; "withdrawal" for the withdrawal tool. */
  context: "trading" | "withdrawal" | "persona";
}

/** Per-row venue access annotation inside comparison/withdrawal results. */
export interface StablecoinVenueAccess {
  asset: string;
  status: StablecoinVenueStatus;
  scope: "eea" | "global";
  since?: string;
  note?: string;
}

export interface StablecoinAccessVenueRow {
  exchange: string;
  status: StablecoinVenueStatus;
  scope: "eea" | "global";
  since?: string;
  note?: string;
  /** False when the venue cannot onboard the queried resident at all. */
  venue_available_in_country: boolean;
}

export interface StablecoinAccessResult {
  asset: string;
  asset_name?: string;
  issuer?: string;
  mica_authorized: boolean;
  issuer_note?: string;
  fetched_at: string;
  data_as_of: string;
  /** Region-level rule applicable to the queried country (null outside every restricted region). */
  restriction: {
    applies: boolean;
    region?: string;
    effective?: string;
    venue_trading?: StablecoinVenueTrading;
    custody_withdrawal?: string;
    self_custody_allowed?: boolean;
    note?: string;
  };
  venues: StablecoinAccessVenueRow[];
  compliant_alternatives: string[];
  regulation_note?: string;
  advice: string;
  data_sources?: DataSource[];
}

// ---------- v0.47: consumer-vs-pro interface costs (dual-product venues) ----------

/**
 * How a venue's consumer (retail) interface charges:
 * - "fee_plus_embedded_spread": visible fee + undisclosed spread inside the quote
 *   (Kraken app Instant Buy, Coinbase Simple);
 * - "spread_embedded": all-in price, the spread IS the cost (Bitstamp Basic);
 * - "order_book_pass_through": consumer flow routes into the PRO book at
 *   published order-book fees (Bitvavo Basic — the transparency benchmark);
 * - "broker_premium": quoted per-side premium IS the trading fee (Bitpanda app,
 *   BISON — spread-model brokerages, already priced in fee_rates.json).
 */
export type ConsumerFeeModel =
  | "fee_plus_embedded_spread"
  | "spread_embedded"
  | "order_book_pass_through"
  | "broker_premium";

export interface InterfaceMeasurement {
  /** Study behind the measured numbers. */
  study: string;
  /** Real-money observation window (YYYY-MM..YYYY-MM). */
  period: string;
  /** Number of round-trips observed for this platform. */
  n: number;
  /** Notional per round-trip in EUR (the studies used €100). */
  notional_eur: number;
  /** Independent replication result, when one exists. */
  corroboration?: string;
}

export interface ConsumerInterfaceCost {
  product_name: string;
  fee_model: ConsumerFeeModel;
  /**
   * Representative one-way retail cost (pct of notional) used for the
   * annualized excess math: published fee + typical embedded spread.
   */
  modeled_one_way_pct: number;
  /** Published per-side fees where disclosed (pct), keyed by order flow. */
  published_one_way_pct?: Record<string, number>;
  /** Flat per-trade fee ladder in USD where applicable (Coinbase Simple). */
  flat_fees_usd?: Record<string, number>;
  /** Disclosed/estimated embedded spread range (pct). */
  embedded_spread_pct?: [number, number];
  /** TUM real-money round-trip result (positive = pct lost), where measured. */
  measured_round_trip_pct?: number;
  /** Cost predicted from published fees alone (2 x one-way). */
  predicted_round_trip_pct?: number;
  /** measured minus predicted — the undisclosed retail markup (pp). */
  measured_hidden_spread_pp?: number;
  measurement?: InterfaceMeasurement;
  subscription?: {
    name: string;
    monthly_usd: number;
    /** Monthly consumer volume whose fees the plan waives (USD). */
    waiver_monthly_usd?: number;
    note?: string;
  };
  /** Consumer volume counts toward PRO tier qualification (Kraken: false). */
  tier_credit?: boolean;
}

export interface ProInterfaceCost {
  product_name: string;
  /** Base-tier published maker/taker from the venue's order-book schedule (pct). */
  base_maker_pct: number;
  base_taker_pct: number;
  /** 2 x base taker — published-only round-trip proxy (pct). */
  published_round_trip_pct: number;
}

export interface InterfaceVenueCost {
  consumer: ConsumerInterfaceCost;
  /** Null for spread-model brokerages without a separate order-book product. */
  pro?: ProInterfaceCost | null;
  notes?: string[];
}

export interface InterfaceCostsData {
  last_verified: string;
  verified_date?: string;
  sources?: DataSource[];
  methodology?: string;
  venues: Record<string, InterfaceVenueCost>;
}

/** Structured warning attached to trading-context results for dual-interface venues. */
export interface InterfaceWarning {
  code: "CONSUMER_INTERFACE_MORE_EXPENSIVE";
  exchange: string;
  pro_product: string;
  consumer_product: string;
  /** PRO base taker the rows are priced at (pct). */
  pro_taker_pct: number;
  /** Consumer all-in one-way estimate (pct). */
  consumer_one_way_pct: number;
  /** TUM measured consumer round-trip on a €100 market order (pct), when measured. */
  measured_round_trip_pct?: number;
  /** Localized human message (follows the tool's `language` parameter). */
  message: string;
}

/** Per-row interface annotation inside comparison/persona results. */
export interface InterfaceVenueHint {
  consumer_product: string;
  consumer_one_way_pct: number;
  pro_taker_pct: number;
  measured_round_trip_pct?: number;
}

export interface InterfaceCostRow {
  exchange: string;
  venue_name: string;
  /** False when the venue cannot onboard the queried resident at all. */
  available_in_country: boolean;
  consumer: ConsumerInterfaceCost;
  pro?: ProInterfaceCost;
  /** measured round-trip minus PRO published round-trip (pp), when both exist. */
  consumer_vs_pro_round_trip_pp?: number;
  /** (consumer one-way − PRO taker) x monthly volume x 12, in USD. */
  consumer_vs_pro_annual_excess_usd?: number;
  advice: string;
  notes?: string[];
}

export interface InterfaceCostsResult {
  generated_at: string;
  data_as_of: string;
  /** TUM + Frankfurt School headline finding (localized). */
  study_summary: string;
  venues: InterfaceCostRow[];
  advice: string;
  data_sources?: DataSource[];
}

export interface CompareCountriesResult {
  persona: {
    id: string;
    name_en: string;
    name_zh: string;
  };
  purpose: TradingPurpose;
  currency: string;
  countries: string[];
  data_as_of: string;
  rows: CountryComparisonRow[];
  cheapest_country: {
    country: string;
    exchange: string;
    tier?: string;
    annual_all_in: number;
    basis: "winner" | "best_complete";
  } | null;
  costliest_country: {
    country: string;
    exchange: string;
    tier?: string;
    annual_all_in: number;
    basis: "winner" | "best_complete";
  } | null;
  /** Annual cost gap between the costliest and cheapest countries (USD). */
  spread_usd: number | null;
  winner_venue_counts: CountryWinnerCount[];
  venue_availability: CountryVenueAvailability[];
  advice: string[];
  warnings?: string[];
  /** v0.36: present only when format=markdown|csv|both is requested. */
  rendered?: RenderedTable;
}

// =====================================================================
// v0.48: fee schedule change feed (data moat — auditable change history)
// =====================================================================

/** Which product line a fee change applies to. */
export type FeeChangeProduct = "spot" | "futures" | "all";

/** Classification of what moved on a venue's fee schedule. */
export type FeeChangeKind =
  | "rate"
  | "threshold"
  | "ladder_structure"
  | "promo"
  | "token_discount"
  | "pricing_model";

/**
 * Provenance confidence:
 * - "high": curated record backed by an official venue announcement/fee page.
 * - "medium": curated record from a credible secondary reproduction.
 * - "detected": auto-derived from a monthly snapshot diff; NOT yet human-verified.
 */
export type FeeChangeConfidence = "high" | "medium" | "detected";

/** Before/after payload: a single number or a small structured field bag. */
export type FeeChangeValue = number | string | Record<string, number | string>;

/** A single auditable fee-schedule change. */
export interface FeeChange {
  /** Stable id, conventionally "YYYY-MM-venue-topic". */
  id: string;
  /** Discovery/announcement date: YYYY-MM-DD when known, YYYY-MM month precision otherwise. */
  date: string;
  exchange: string;
  product: FeeChangeProduct;
  kind: FeeChangeKind;
  summary_en: string;
  summary_zh?: string;
  /** When the venue says the new terms take effect (may differ from discovery date). */
  effective_date?: string;
  /** Tier label when the change is rung-specific. */
  tier?: string;
  /** Structured field path, e.g. "spot[2].taker" or "futures length". */
  field?: string;
  before?: FeeChangeValue;
  after?: FeeChangeValue;
  url?: string;
  confidence: FeeChangeConfidence;
  note?: string;
  /** Snapshot ids bounding a "detected" record (YYYY-MM). */
  detected_from_snapshot?: string;
  detected_to_snapshot?: string;
}

export interface FeeChangesData {
  last_verified: string;
  sources?: DataSource[];
  changes: FeeChange[];
}

/** Normalized tier persisted in a monthly ladder snapshot (keys sorted). */
export type SnapshotTier = Record<string, number | string>;

/** One month's deterministic fingerprint of every venue's fee ladders. */
export interface LadderSnapshot {
  /** "YYYY-MM". */
  id: string;
  /** ISO timestamp of capture. */
  captured_at: string;
  ladders: Record<
    string,
    {
      spot?: SnapshotTier[];
      futures?: SnapshotTier[];
    }
  >;
}

/** Result of the get_fee_changes tool. */
export interface FeeChangeReport {
  generated_at: string;
  data_as_of: string;
  snapshot_coverage: {
    /** Number of monthly snapshots available locally. */
    months: number;
    first?: string;
    last?: string;
    /** False for npm consumers (snapshots ship repo-only); curated feed still works. */
    available: boolean;
  };
  changes: FeeChange[];
  advice: string;
}
