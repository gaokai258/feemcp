import {
  getReferralLinks,
  isExchangeAllowed,
  isProductBlockedInCountry,
  isVenueUsableFor,
  resolveFeeRate,
  getTokenDiscount,
  getTokenDiscounts,
  getFundingRate,
  getFundingRates as getBundledFundingRatesData,
  getWithdrawalFees,
  getFxRate,
  getFxRates,
  getFeeRates,
  weightedRate,
  listDataProvenance,
  getDataFreshness,
  getNormalizedLadder,
  listSupportedExchanges,
  resolvePairFee,
  getSpotFeeClasses,
  getExchangeNotes,
  getSpreadEstimate,
  getSpreadBaseline,
  getFiatRoutes,
  getPersonas,
  getTokenPrices,
  getTokenPrice,
  normalizePair,
  getStablecoinAccess,
  getStablecoinAsset,
  getStablecoinRegionRestriction,
  getStablecoinVenueRule,
  getInterfaceCosts,
  getInterfaceVenue,
} from "./data.js";
import { makeError, isToolError } from "./errors.js";
import { t, pickLang, PERSONA_COST_LABELS, type Lang } from "./i18n.js";
import {
  fetchFundingRatesLive,
  fetchExecutionCostLive,
  bundledExecutionOverride,
  normalizeFundingPair,
} from "./live.js";
import type { LiveDeps } from "./live.js";
import type {
  TradingPurpose,
  ExchangeFeeInfo,
  SavingsResult,
  TotalCostResult,
  RecommendationResult,
  ExchangeRecommendation,
  DataProvenanceReport,
  ToolError,
  ResolvedFeeRate,
  AnnualCostResult,
  FundingMode,
  FundingOverrides,
  FundingRateEntry,
  FundingRatesToolResult,
  FundingSource,
  SpreadMode,
  SpreadOverrides,
  SpreadSource,
  ExecutionCostResult,
  ExecutionCostEntry,
  ExecutionCostFailure,
  ExecutionCostWarning,
  FiatDirection,
  FiatCurrency,
  FiatMethod,
  FiatRegion,
  FiatFeeShape,
  FiatRoute,
  FiatRouteQuote,
  FiatExchangeQuote,
  FiatCostResult,
  FiatBestPick,
  WithdrawalFee,
  WithdrawalNetworkQuote,
  WithdrawalExchangeQuote,
  WithdrawalFeesResult,
  WithdrawalBestPick,
  TraderPersona,
  PersonaAnalysisResult,
  PersonaCostRow,
  PersonaComponentLeader,
  PersonaTokenDiscountHint,
  PersonaComparisonResult,
  PersonaComparisonEntry,
  PersonaVenueWins,
  TokenDiscountAnalysisResult,
  TokenDiscountTierAnalysis,
  VolumeWhatIfResult,
  WhatIfExchange,
  WhatIfPoint,
  WhatIfSweepPoint,
  WhatIfNextTier,
  WhatIfTierCrossing,
  CompareCountriesResult,
  CountryComparisonRow,
  CountryVenueAvailability,
  CountryVenueStatus,
  CountryWinnerCount,
  RenderFormat,
  StablecoinWarning,
  StablecoinVenueAccess,
  StablecoinAccessResult,
  StablecoinAccessVenueRow,
  InterfaceWarning,
  InterfaceVenueHint,
  InterfaceCostsResult,
  InterfaceCostRow,
} from "./types.js";
import { renderTable } from "./render.js";

function parsePercent(s: string): number {
  const m = s.match(/([\d.]+)\s*%/);
  return m ? parseFloat(m[1]) / 100 : 0;
}

function round(n: number, dp = 4): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// v0.36: validate the shared format/tableMetric render options.
const RENDER_FORMATS: RenderFormat[] = ["json", "markdown", "csv", "both"];
function invalidRenderOpts(
  format: RenderFormat | undefined,
  tableMetric: string | undefined,
  allowedMetrics: string[],
): ToolError | null {
  if (format !== undefined && !RENDER_FORMATS.includes(format)) {
    return makeError(`Unknown format '${format}'.`, {
      code: "INVALID_INPUT",
      suggested_action: "Use one of: json, markdown, csv, both.",
    });
  }
  if (tableMetric !== undefined && !allowedMetrics.includes(tableMetric)) {
    return makeError(`Unknown tableMetric '${tableMetric}'.`, {
      code: "INVALID_INPUT",
      suggested_action: `Use one of: ${allowedMetrics.join(", ")}.`,
    });
  }
  return null;
}

function clampShare(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return 0;
  return Math.min(Math.max(ms, 0), 1);
}

// v0.9: referral/token discounts reduce fees the user PAYS. A negative maker
// rate is a rebate paid TO the user, so discounts pass it through unchanged
// (a "20% off" link cannot shrink the exchange's rebate).
function discountRate(rate: number, factor: number): number {
  return rate < 0 ? rate : rate * factor;
}

// Resolve display currency: returns [currency, fxRate] or a ToolError.
function resolveCurrency(
  currency?: string,
): [string, number] | ToolError {
  if (!currency || currency.toUpperCase() === "USD") return ["USD", 1];
  const upper = currency.toUpperCase();
  const rate = getFxRate(upper);
  if (rate === null) {
    return makeError(`Unsupported currency '${currency}'.`, {
      code: "UNKNOWN_CURRENCY",
      suggested_action: `Supported currencies: ${Object.keys(getFxRates().rates).join(", ")}.`,
    });
  }
  return [upper, rate];
}

function applyTokenDiscount(
  exchange: string,
  purpose: TradingPurpose,
  baseRate: number,
  isMaker: boolean,
  useToken: boolean,
  tokenBalance?: number,
): { rate: number; discountPct: number; applied: boolean } {
  if (!useToken) return { rate: baseRate, discountPct: 0, applied: false };
  const td = getTokenDiscount(exchange);
  if (!td) return { rate: baseRate, discountPct: 0, applied: false };

  // Negative maker = rebate from the exchange; token deductions do not apply.
  if (baseRate < 0) return { rate: baseRate, discountPct: 0, applied: false };

  // Maker-to-zero perk (Gate GT futures maker).
  if (purpose === "futures" && isMaker && td.futures_maker_to_zero) {
    return { rate: 0, discountPct: 100, applied: true };
  }

  // Base deduction discount (BNB 25%/10%, MX 20%, BGB 20% ...).
  let pct = purpose === "spot" ? (td.spot_discount_pct ?? 0) : (td.futures_discount_pct ?? 0);

  // Holding tiers (Gate GT, MEXC MX): a known balance may lift the discount.
  if (td.holding_tiers && tokenBalance !== undefined) {
    let tierPct = 0;
    for (const h of td.holding_tiers) {
      if (tokenBalance >= h.min_balance) tierPct = h.discount_pct;
    }
    pct = Math.max(pct, tierPct);
  }

  if (pct <= 0) return { rate: baseRate, discountPct: 0, applied: false };
  return { rate: baseRate * (1 - pct / 100), discountPct: pct, applied: true };
}

function formatUsd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

const EX_DISPLAY_NAMES: Record<string, string> = {
  binance: "Binance",
  okx: "OKX",
  gate: "Gate",
  bybit: "Bybit",
  mexc: "MEXC",
  bitget: "Bitget",
  kucoin: "KuCoin",
  kraken: "Kraken",
  coinbase: "Coinbase",
  hyperliquid: "Hyperliquid",
  bingx: "BingX",
  phemex: "Phemex",
  blofin: "BloFin",
  bitstamp: "Bitstamp",
};

export function exDisplayName(exchange: string): string {
  return EX_DISPLAY_NAMES[exchange.toLowerCase()] ?? exchange;
}

// v0.12: apply a pair-level fee override (e.g. MEXC 0-fee spot, Binance FDUSD
// zero-maker, Bitget USDC/USDT promo). Mutates `resolved` in place so all
// downstream fee math uses the pair rates; only sides the entry defines are
// overridden — the rest keep the account-tier rate.
function applyPairOverride(
  exchange: string,
  purpose: TradingPurpose,
  pair: string | undefined,
  resolved: ResolvedFeeRate,
): { pricingBasis: "pair" | "account_tier"; pairNote?: string } {
  const entry = pair ? resolvePairFee(exchange, purpose, pair) : null;
  if (!entry) return { pricingBasis: "account_tier" };
  if (entry.maker !== undefined) resolved.base_maker = entry.maker;
  if (entry.taker !== undefined) resolved.base_taker = entry.taker;
  return { pricingBasis: "pair", pairNote: entry.note };
}

// v0.13: KuCoin spot runs Class A/B/C symbol groups; the bundled ladder only
// quotes Class A (B = 2x, C = 3x). Warn callers comparing KuCoin spot.
function spotClassNote(exchange: string, purpose: TradingPurpose): string | undefined {
  if (purpose !== "spot") return undefined;
  const classes = getSpotFeeClasses(exchange);
  return classes ? classes.note : undefined;
}

// v0.14: Kraken unified-tier caveats ride along on every result for the exchange.
function exchangeNotes(exchange: string): string[] | undefined {
  return getExchangeNotes(exchange) ?? undefined;
}

// Explain VIP-tier qualification rules back to the caller.
// Binance spot gates tiers with BNB (AND); Gate lets GT holdings upgrade tiers (OR);
// OKX/Bybit/Bitget let account assets upgrade tiers (OR).
function buildTierWarning(
  exchange: string,
  resolved: ResolvedFeeRate,
  tokenBalance: number | undefined,
  accountAssetsUsd?: number,
  lang: Lang = "en",
): string | undefined {
  const name = exDisplayName(exchange);
  if (resolved.token_name === "BNB") {
    if (resolved.tier_held_back) {
      return t(lang, "tw_bnb_back", {
        volumeTier: resolved.volume_tier,
        min: resolved.min_token,
        balance: tokenBalance,
        tier: resolved.tier,
      });
    }
    if (tokenBalance === undefined && resolved.min_token && resolved.min_token > 0) {
      return t(lang, "tw_bnb_missing", { tier: resolved.tier, min: resolved.min_token });
    }
    return undefined;
  }

  if (resolved.token_name === "GT") {
    if (resolved.tier_upgraded) {
      return t(lang, "tw_gt_up", { volumeTier: resolved.volume_tier, tier: resolved.tier });
    }
    if (resolved.next_tier && resolved.next_min_token !== undefined) {
      return t(lang, "tw_gt_next", {
        tier: resolved.tier,
        andHolding: tokenBalance !== undefined ? t(lang, "s_and_gt") : "",
        min: resolved.next_min_token,
        nextTier: resolved.next_tier,
      });
    }
    return undefined;
  }

  if (resolved.token_name === "KCS") {
    if (resolved.tier_upgraded) {
      return t(lang, "tw_kcs_up", { volumeTier: resolved.volume_tier, tier: resolved.tier });
    }
    if (resolved.next_tier && resolved.next_min_token !== undefined) {
      return t(lang, "tw_kcs_next", {
        tier: resolved.tier,
        andHolding: tokenBalance !== undefined ? t(lang, "s_and_kcs") : "",
        min: resolved.next_min_token.toLocaleString("en-US"),
        nextTier: resolved.next_tier,
      });
    }
    return undefined;
  }

  if (resolved.asset_gate) {
    // Kraken calls them "fee tiers" (Tier/Pro); the other asset-ladder venues say "VIP levels".
    if (resolved.tier_upgraded) {
      return t(lang, "tw_asset_up", {
        volumeTier: resolved.volume_tier,
        assetNoun: t(lang, exchange === "kraken" ? "s_aop" : "s_assets"),
        tier: resolved.tier,
        name,
        tierNoun: exchange === "kraken" ? (lang === "zh" ? "费率档" : "fee tiers") : (lang === "zh" ? "VIP 档位" : "VIP levels"),
      });
    }
    if (resolved.next_tier && resolved.next_min_assets !== undefined) {
      return t(lang, "tw_asset_next", {
        tier: resolved.tier,
        andHolding: accountAssetsUsd !== undefined ? t(lang, "s_and_assets") : "",
        minAssets: formatUsd(resolved.next_min_assets),
        name,
        assetNoun: t(lang, exchange === "kraken" ? "s_aop" : "s_assets"),
        nextTier: resolved.next_tier,
        tierNoun: exchange === "kraken" ? (lang === "zh" ? "费率档" : "fee tiers") : (lang === "zh" ? "VIP 档位" : "VIP levels"),
      });
    }
    return undefined;
  }

  return undefined;
}

// v0.18: common user spellings mapped to the canonical network keys in withdrawal_fees.json.
const WITHDRAWAL_NETWORK_ALIASES: Record<string, string> = {
  tron: "TRC-20",
  trc20: "TRC-20",
  "trc-20": "TRC-20",
  ethereum: "ERC-20",
  erc20: "ERC-20",
  "erc-20": "ERC-20",
  eth: "ERC-20",
  bsc: "BEP20",
  bep20: "BEP20",
  "bnb smart chain": "BEP20",
  "binance smart chain": "BEP20",
  "arbitrum one": "Arbitrum",
  arbitrum: "Arbitrum",
  arb: "Arbitrum",
  optimism: "Optimism",
  op: "Optimism",
  base: "Base",
  polygon: "Polygon",
  "polygon pos": "Polygon",
  "polygon network": "Polygon",
  matic: "Polygon",
  avalanche: "Avalanche C",
  "avalanche c-chain": "Avalanche C",
  "c-chain": "Avalanche C",
  "x-chain": "Avalanche C",
  solana: "Solana",
  sol: "Solana",
  ton: "TON",
  toncoin: "TON",
  xrp: "XRP",
  ripple: "XRP",
  "xrp ledger": "XRP",
  dogecoin: "Dogecoin",
  litecoin: "Litecoin",
  cardano: "Cardano",
  polkadot: "Polkadot",
  "relay chain": "Polkadot",
  assethub: "AssetHub",
  "asset hub": "AssetHub",
  bitcoin: "Bitcoin",
  "bitcoin cash": "Bitcoin Cash",
};

function normalizeWithdrawalNetwork(network: string): string {
  const key = network.trim().toLowerCase().replace(/\s+/g, " ");
  return WITHDRAWAL_NETWORK_ALIASES[key] ?? network.trim();
}

function withdrawalAssetPriceUsd(asset: string): number {
  return getWithdrawalFees().asset_prices_usd?.[asset] ?? 1;
}

function withdrawalFeeToUsd(fee: number, asset: string): number {
  return round(fee * withdrawalAssetPriceUsd(asset), 4);
}

// All WithdrawalFee entries listed for an asset at an exchange (single-entry or network map).
function withdrawalEntries(
  exchange: string,
  asset: string,
): WithdrawalFee[] {
  const exWf = getWithdrawalFees().exchanges[exchange];
  const entry = exWf?.[asset] as WithdrawalFee | Record<string, WithdrawalFee> | undefined;
  if (!entry) return [];
  if ("network" in entry && typeof (entry as { fee?: unknown }).fee === "number") {
    return [entry as WithdrawalFee];
  }
  return Object.values(entry as Record<string, WithdrawalFee>);
}

// Per-occurrence withdrawal fee in USD for an asset/network; 0 when no data matches.
// Without a network, the cheapest *available* route for the asset is used.
function resolveWithdrawalFeeUsd(
  exchange: string,
  asset: string,
  network?: string,
): number {
  const entries = withdrawalEntries(exchange, asset).filter((e) => !e.suspended);
  if (entries.length === 0) return 0;
  if (network) {
    const canonical = normalizeWithdrawalNetwork(network);
    const match = entries.find((e) => e.network === canonical);
    return match ? withdrawalFeeToUsd(match.fee, asset) : 0;
  }
  return Math.min(...entries.map((e) => withdrawalFeeToUsd(e.fee, asset)));
}

// ---------- v0.46: MiCA stablecoin regional access (USDT EEA sweep) ----------

/** Quote asset of a normalized pair ("BTC/USDT" -> "USDT"); null when absent. */
function pairQuoteAsset(pair: string | undefined): string | null {
  if (!pair) return null;
  const parts = normalizePair(pair).split("/");
  return parts[1] ?? null;
}

/**
 * The pair's quote asset when it is a stablecoin the resident's region bars
 * from licensed venues (e.g. a BTC/USDT quote for an EEA resident); else null.
 */
function restrictedQuoteAsset(pair: string | undefined, country: string | undefined): string | null {
  const quote = pairQuoteAsset(pair);
  if (!quote) return null;
  return getStablecoinRegionRestriction(quote, country) ? quote : null;
}

function buildStablecoinWarning(
  asset: string,
  country: string | undefined,
  lang: Lang,
  context: StablecoinWarning["context"],
): StablecoinWarning | null {
  const hit = getStablecoinRegionRestriction(asset, country);
  if (!hit) return null;
  const alts = hit.rule.alternatives?.join(", ") ?? "USDC, EURC";
  const key =
    context === "withdrawal" ? "sc_warn_withdrawal"
    : context === "persona" ? "sc_warn_persona"
    : "sc_warn_trade";
  return {
    code: "STABLECOIN_UNAVAILABLE_IN_REGION",
    asset,
    region: hit.region,
    message: t(lang, key, { asset, effective: hit.rule.effective, alts }),
    ...(hit.rule.effective ? { effective: hit.rule.effective } : {}),
    ...(hit.rule.self_custody_allowed !== undefined
      ? { self_custody_allowed: hit.rule.self_custody_allowed }
      : {}),
    ...(hit.rule.alternatives ? { alternatives: hit.rule.alternatives } : {}),
    context,
  };
}

/** Per-venue stablecoin access annotation applicable to this resident (null = no modeled restriction). */
function venueStablecoinAccess(
  asset: string,
  exchange: string,
  country: string | undefined,
): StablecoinVenueAccess | null {
  const rule = getStablecoinVenueRule(exchange, asset, country);
  if (!rule) return null;
  return {
    asset,
    status: rule.status,
    scope: rule.scope,
    ...(rule.since ? { since: rule.since } : {}),
    ...(rule.note ? { note: rule.note } : {}),
  };
}

/**
 * v0.46: standalone stablecoin access report — answers "can I still hold/buy/
 * withdraw USDT here?" under MiCA and lists every modeled venue's status for
 * the resident, plus the authorized alternatives (USDC/EURC/EURI/EURCV/USDQ).
 */
export function getStablecoinAccessReport(
  opts: {
    asset?: string;
    country?: string;
    exchange?: string;
    language?: Lang;
  } = {},
): StablecoinAccessResult | ToolError {
  const lang = pickLang(opts.language);
  const asset = (opts.asset ?? "USDT").toUpperCase();
  const data = getStablecoinAccess();
  const info = getStablecoinAsset(asset);
  if (!info) {
    return makeError(`No stablecoin access data for asset '${asset}'.`, {
      code: "INVALID_ASSET",
      suggested_action: `Tracked stablecoins: ${Object.keys(data.assets).join(", ")}.`,
    });
  }

  let exchangeFilter: string | undefined;
  if (opts.exchange) {
    exchangeFilter = opts.exchange.toLowerCase();
    if (!listSupportedExchanges().includes(exchangeFilter)) {
      return makeError(`Exchange '${opts.exchange}' is not supported.`, {
        code: "UNKNOWN_EXCHANGE",
        suggested_action: `Supported exchanges: ${listSupportedExchanges().join(", ")}.`,
      });
    }
    if (opts.country && !isExchangeAllowed(exchangeFilter, opts.country)) {
      return makeError(
        `Exchange '${opts.exchange}' is not available in country ${opts.country.toUpperCase()}.`,
        { code: "COUNTRY_BLOCKED" },
      );
    }
  }

  const restriction = getStablecoinRegionRestriction(asset, opts.country);

  // EEA resident + restricted asset: every modeled venue rule applies (scope
  // eea + scope global). Anywhere else (CH/GB/US/…/no country): only global
  // venue policies (e.g. BISON never lists stablecoins) are relevant.
  const venueRows: StablecoinAccessVenueRow[] = [];
  for (const [exchangeId, assetBook] of Object.entries(data.venues)) {
    if (exchangeFilter && exchangeId !== exchangeFilter) continue;
    const rule = assetBook[asset];
    if (!rule) continue;
    const appliesHere =
      rule.scope === "global" || (restriction !== null && opts.country !== undefined);
    if (!appliesHere) continue;
    venueRows.push({
      exchange: exchangeId,
      status: rule.status,
      scope: rule.scope,
      ...(rule.since ? { since: rule.since } : {}),
      ...(rule.note ? { note: rule.note } : {}),
      venue_available_in_country: opts.country
        ? isExchangeAllowed(exchangeId, opts.country)
        : true,
    });
  }
  // Stable display order = supported-exchange order.
  const order = new Map(listSupportedExchanges().map((e, i) => [e, i]));
  venueRows.sort((a, b) => (order.get(a.exchange) ?? 99) - (order.get(b.exchange) ?? 99));

  const eeaRule = info.region_rules?.EEA;
  const alternatives = restriction?.rule.alternatives ?? eeaRule?.alternatives ?? [];

  let advice: string;
  if (info.mica_authorized) {
    advice = t(lang, "sc_advice_authorized", { asset });
  } else if (restriction) {
    advice = t(lang, "sc_advice_eea", {
      asset,
      effective: restriction.rule.effective,
      alts: alternatives.join(", "),
    });
  } else {
    advice = t(lang, "sc_advice_global", {
      asset,
      effective: eeaRule?.effective ?? "2026-07-01",
    });
  }

  return {
    asset,
    asset_name: info.name,
    issuer: info.issuer,
    mica_authorized: info.mica_authorized,
    ...(info.issuer_note ? { issuer_note: info.issuer_note } : {}),
    fetched_at: new Date().toISOString(),
    data_as_of: data.last_verified,
    restriction: restriction
      ? {
          applies: true,
          region: restriction.region,
          effective: restriction.rule.effective,
          venue_trading: restriction.rule.venue_trading,
          ...(restriction.rule.custody_withdrawal
            ? { custody_withdrawal: restriction.rule.custody_withdrawal }
            : {}),
          ...(restriction.rule.self_custody_allowed !== undefined
            ? { self_custody_allowed: restriction.rule.self_custody_allowed }
            : {}),
          ...(restriction.rule.note ? { note: restriction.rule.note } : {}),
        }
      : { applies: false },
    venues: venueRows,
    compliant_alternatives: alternatives,
    ...(data.regulation?.self_custody_note
      ? { regulation_note: data.regulation.self_custody_note }
      : {}),
    advice,
    ...(data.sources ? { data_sources: data.sources } : {}),
  };
}

// ---------- v0.47: consumer-vs-pro interface costs ----------

/**
 * The venue's consumer interface when it is TUM-measured and materially
 * pricier than its own PRO book (Kraken app, Coinbase Simple — bitvavo's
 * pass-through flow and unmeasured Bitstamp Basic are excluded on purpose).
 */
function consumerInterfaceHint(exchange: string): InterfaceVenueHint | null {
  const venue = getInterfaceVenue(exchange);
  if (
    !venue?.pro ||
    venue.consumer.measured_round_trip_pct === undefined ||
    venue.consumer.modeled_one_way_pct <= venue.pro.base_taker_pct
  ) {
    return null;
  }
  return {
    consumer_product: venue.consumer.product_name,
    consumer_one_way_pct: venue.consumer.modeled_one_way_pct,
    pro_taker_pct: venue.pro.base_taker_pct,
    measured_round_trip_pct: venue.consumer.measured_round_trip_pct,
  };
}

/** Top-level trading-context warning for savings/recommendation results. */
function buildInterfaceWarning(exchange: string, lang: Lang): InterfaceWarning | null {
  const hint = consumerInterfaceHint(exchange);
  const venue = getInterfaceVenue(exchange);
  if (!hint || !venue?.pro) return null;
  return {
    code: "CONSUMER_INTERFACE_MORE_EXPENSIVE",
    exchange,
    pro_product: venue.pro.product_name,
    consumer_product: hint.consumer_product,
    pro_taker_pct: hint.pro_taker_pct,
    consumer_one_way_pct: hint.consumer_one_way_pct,
    measured_round_trip_pct: hint.measured_round_trip_pct,
    message: t(lang, "iface_warn_trade", {
      exchange,
      pro_product: venue.pro.product_name,
      pro_taker: venue.pro.base_taker_pct,
      one_way: hint.consumer_one_way_pct,
      rt: hint.measured_round_trip_pct,
    }),
  };
}

const INTERFACE_VENUE_DISPLAY: Record<string, string> = {
  kraken: "Kraken",
  coinbase: "Coinbase",
  bitvavo: "Bitvavo",
  bitstamp: "Bitstamp",
  bitpanda: "Bitpanda",
  bison: "BISON",
};

/**
 * v0.47: standalone consumer-vs-pro interface cost report — the same venue
 * often runs a cheap order-book interface (PRO/Advanced, priced everywhere in
 * this server) and an expensive consumer app whose spread is embedded in the
 * quote. Evidence: TUM real-money study (2025-10..11) + Frankfurt School
 * replication (2026-03).
 */
export function compareInterfaceCosts(
  opts: {
    exchange?: string;
    country?: string;
    monthlyVolumeUsd?: number;
    language?: Lang;
  } = {},
): InterfaceCostsResult | ToolError {
  const lang = pickLang(opts.language);
  const data = getInterfaceCosts();

  let exchangeFilter: string | undefined;
  if (opts.exchange) {
    exchangeFilter = opts.exchange.toLowerCase();
    if (!data.venues[exchangeFilter]) {
      return makeError(`No interface cost model for exchange '${opts.exchange}'.`, {
        code: "UNKNOWN_EXCHANGE",
        suggested_action: `Modeled dual-interface venues: ${Object.keys(data.venues).join(", ")}.`,
      });
    }
    if (opts.country && !isExchangeAllowed(exchangeFilter, opts.country)) {
      return makeError(
        `Exchange '${opts.exchange}' is not available in country ${opts.country.toUpperCase()}.`,
        { code: "COUNTRY_BLOCKED" },
      );
    }
  }

  let monthlyVolumeUsd: number | undefined;
  if (opts.monthlyVolumeUsd !== undefined) {
    if (
      typeof opts.monthlyVolumeUsd !== "number" ||
      !Number.isFinite(opts.monthlyVolumeUsd) ||
      opts.monthlyVolumeUsd <= 0
    ) {
      return makeError("monthlyVolumeUsd must be a positive number.", { code: "INVALID_VOLUME" });
    }
    monthlyVolumeUsd = opts.monthlyVolumeUsd;
  }

  const rows: InterfaceCostRow[] = [];
  const order = new Map(listSupportedExchanges().map((e, i) => [e, i]));
  for (const [exchangeId, venue] of Object.entries(data.venues)) {
    if (exchangeFilter && exchangeId !== exchangeFilter) continue;
    const { consumer } = venue;
    const pro = venue.pro ?? undefined;

    let deltaRt: number | undefined;
    if (consumer.measured_round_trip_pct !== undefined && pro) {
      deltaRt = round(consumer.measured_round_trip_pct - pro.published_round_trip_pct);
    }
    let annual: number | undefined;
    if (monthlyVolumeUsd !== undefined && pro && consumer.modeled_one_way_pct > pro.base_taker_pct) {
      annual = round2(
        ((consumer.modeled_one_way_pct - pro.base_taker_pct) / 100) * monthlyVolumeUsd * 12,
      );
    }

    let advice: string;
    if (!pro) {
      advice = t(lang, "iface_advice_broker_only", {
        exchange: exchangeId,
        rt: consumer.measured_round_trip_pct ?? "?",
        hidden: consumer.measured_hidden_spread_pp ?? 0,
        fusion: exchangeId === "bitpanda" ? t(lang, "iface_fusion_note") : "",
      });
    } else if (
      consumer.measured_round_trip_pct !== undefined &&
      consumer.modeled_one_way_pct <= pro.base_taker_pct
    ) {
      advice = t(lang, "iface_advice_passthrough", {
        exchange: exchangeId,
        consumer_product: consumer.product_name,
        rt: consumer.measured_round_trip_pct,
        hidden: consumer.measured_hidden_spread_pp ?? 0,
      });
    } else if (consumer.measured_round_trip_pct === undefined) {
      advice = t(lang, "iface_advice_unmeasured", {
        exchange: exchangeId,
        consumer_product: consumer.product_name,
        one_way: consumer.modeled_one_way_pct,
        pro_product: pro.product_name,
        pro_taker: pro.base_taker_pct,
      });
    } else {
      const sub = consumer.subscription
        ? t(
            lang,
            consumer.subscription.waiver_monthly_usd !== undefined
              ? "iface_sub_note"
              : "iface_sub_note_nocap",
            {
              sub_name: consumer.subscription.name,
              fee: consumer.subscription.monthly_usd,
              ...(consumer.subscription.waiver_monthly_usd !== undefined
                ? { waiver: consumer.subscription.waiver_monthly_usd }
                : {}),
            },
          )
        : "";
      advice =
        t(lang, "iface_advice_switch", {
          exchange: exchangeId,
          consumer_product: consumer.product_name,
          one_way: consumer.modeled_one_way_pct,
          pro_product: pro.product_name,
          pro_taker: pro.base_taker_pct,
          maker: pro.base_maker_pct,
          rt: consumer.measured_round_trip_pct,
        }) +
        (annual !== undefined
          ? t(lang, "iface_savings_clause", {
              annual: `$${annual}`,
              vol: `$${monthlyVolumeUsd}`,
            })
          : "") +
        sub;
    }

    rows.push({
      exchange: exchangeId,
      venue_name: INTERFACE_VENUE_DISPLAY[exchangeId] ?? exchangeId,
      available_in_country: opts.country ? isExchangeAllowed(exchangeId, opts.country) : true,
      consumer,
      ...(pro ? { pro } : {}),
      ...(deltaRt !== undefined ? { consumer_vs_pro_round_trip_pp: deltaRt } : {}),
      ...(annual !== undefined ? { consumer_vs_pro_annual_excess_usd: annual } : {}),
      advice,
      ...(venue.notes ? { notes: venue.notes } : {}),
    });
  }
  rows.sort((a, b) => (order.get(a.exchange) ?? 99) - (order.get(b.exchange) ?? 99));

  return {
    generated_at: new Date().toISOString(),
    data_as_of: data.last_verified,
    study_summary: t(lang, "iface_study_summary"),
    venues: rows,
    advice: t(lang, "iface_tool_advice"),
    ...(data.sources ? { data_sources: data.sources } : {}),
  };
}

// v0.18: standalone withdrawal-fee comparison across exchanges/networks.
export function getWithdrawalCost(
  opts: {
    asset?: string;
    network?: string;
    country?: string;
    exchanges?: string[];
    /** v0.30: "en" (default) or "zh" — language of advice/warnings narrative. */
    language?: Lang;
  } = {},
): WithdrawalFeesResult | ToolError {
  const lang = pickLang(opts.language);
  const asset = (opts.asset ?? "USDT").toUpperCase();
  const data = getWithdrawalFees();

  const supported = listSupportedExchanges();
  const knownAssets = new Set<string>();
  for (const ex of supported) {
    const book = data.exchanges[ex];
    if (book) for (const a of Object.keys(book)) knownAssets.add(a);
  }
  if (!knownAssets.has(asset)) {
    return makeError(`No withdrawal data for asset '${asset}'.`, {
      code: "INVALID_ASSET",
      suggested_action: `Assets with data: ${[...knownAssets].sort().join(", ")}.`,
    });
  }

  let networkFilter: string | undefined;
  if (opts.network) {
    networkFilter = normalizeWithdrawalNetwork(opts.network);
    const networkExists = supported.some((ex) =>
      withdrawalEntries(ex, asset).some((e) => e.network === networkFilter),
    );
    if (!networkExists) {
      return makeError(`No venue lists ${asset} withdrawals on network '${opts.network}'.`, {
        code: "INVALID_NETWORK",
        suggested_action: "Call without a network to see every supported route.",
      });
    }
  }

  let exchanges = supported;
  if (opts.exchanges && opts.exchanges.length > 0) {
    const requested = opts.exchanges.map((e) => e.toLowerCase());
    const unknown = requested.filter((e) => !supported.includes(e));
    if (unknown.length > 0) {
      return makeError(`Exchange(s) not supported: ${unknown.join(", ")}`, {
        code: "UNKNOWN_EXCHANGE",
        suggested_action: `Supported exchanges: ${supported.join(", ")}.`,
      });
    }
    exchanges = requested;
  }
  const countryUpper = opts.country?.toUpperCase();
  if (countryUpper) {
    exchanges = exchanges.filter((e) => isExchangeAllowed(e, countryUpper));
  }

  const warnings: string[] = [];
  // v0.46: USDT + EEA resident — trading is delisted but on-chain withdrawal rights remain.
  const scWarning = buildStablecoinWarning(asset, countryUpper, lang, "withdrawal");
  const quotes: WithdrawalExchangeQuote[] = [];
  let suspendedSeen = 0;

  for (const exchange of exchanges) {
    let entries = withdrawalEntries(exchange, asset);
    if (networkFilter) entries = entries.filter((e) => e.network === networkFilter);
    if (entries.length === 0) {
      const scAccess = venueStablecoinAccess(asset, exchange, countryUpper);
      quotes.push({
        exchange,
        supported: false,
        networks: [],
        ...(scAccess ? { stablecoin_access: scAccess } : {}),
      });
      continue;
    }

    const networkQuotes: WithdrawalNetworkQuote[] = entries.map((e) => {
      if (e.suspended) {
        suspendedSeen += 1;
        return {
          network: e.network,
          fee: e.fee,
          fee_usd: withdrawalFeeToUsd(e.fee, asset),
          available: false,
          ...(e.note ? { note: e.note } : {}),
        };
      }
      return {
        network: e.network,
        fee: e.fee,
        fee_usd: withdrawalFeeToUsd(e.fee, asset),
        available: true,
        ...(e.note ? { note: e.note } : {}),
      };
    });
    networkQuotes.sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      return (a.fee_usd ?? Number.POSITIVE_INFINITY) - (b.fee_usd ?? Number.POSITIVE_INFINITY);
    });

    const cheapest = networkQuotes.find((q) => q.available);
    const scAccess = venueStablecoinAccess(asset, exchange, countryUpper);
    quotes.push({
      exchange,
      supported: true,
      networks: networkQuotes,
      ...(cheapest
        ? {
            cheapest_network: cheapest.network,
            cheapest_fee_usd: cheapest.fee_usd ?? undefined,
          }
        : {}),
      ...(scAccess ? { stablecoin_access: scAccess } : {}),
    });
  }

  const availableQuotes = quotes.filter((q) => q.cheapest_fee_usd !== undefined);
  const unsupportedCount = quotes.length - availableQuotes.length - quotes.filter((q) => q.supported && q.cheapest_fee_usd === undefined).length;
  quotes.sort((a, b) => {
    const aCost = a.cheapest_fee_usd;
    const bCost = b.cheapest_fee_usd;
    if (aCost === undefined && bCost === undefined) return a.supported === b.supported ? 0 : a.supported ? -1 : 1;
    if (aCost === undefined) return 1;
    if (bCost === undefined) return -1;
    return aCost - bCost;
  });

  let best: WithdrawalBestPick | null = null;
  let savingVsWorst: number | undefined;
  if (availableQuotes.length > 0) {
    const bestExchange = availableQuotes.reduce((m, q) =>
      (q.cheapest_fee_usd ?? Number.POSITIVE_INFINITY) < (m.cheapest_fee_usd ?? Number.POSITIVE_INFINITY)
        ? q
        : m,
    );
    const bestRoute = bestExchange.networks.find((n) => n.available)!;
    best = {
      exchange: bestExchange.exchange,
      network: bestRoute.network,
      fee: bestRoute.fee!,
      fee_usd: bestRoute.fee_usd!,
    };
    const worstFee = Math.max(...availableQuotes.map((q) => q.cheapest_fee_usd ?? 0));
    if (worstFee > best.fee_usd) savingVsWorst = round2(worstFee - best.fee_usd);
  }

  if (unsupportedCount > 0) {
    warnings.push(
      t(lang, "wd_unsupported", {
        n: unsupportedCount,
        asset,
        onNet: networkFilter ? t(lang, "s_wd_net", { net: networkFilter }) : "",
      }),
    );
  }
  const suspendedOnly = quotes.filter((q) => q.supported && q.cheapest_fee_usd === undefined).length;
  if (suspendedOnly > 0) {
    warnings.push(
      t(lang, "wd_suspended_only", {
        n: suspendedOnly,
        forNet: networkFilter
          ? t(lang, "s_wd_for_net", { asset, net: networkFilter })
          : t(lang, "s_wd_for_asset", { asset }),
      }),
    );
  }
  if (suspendedSeen > 0 && suspendedOnly === 0) {
    warnings.push(t(lang, "wd_suspended_routes", { n: suspendedSeen }));
  }

  const assetPrice = data.asset_prices_usd?.[asset];
  const advice = buildWithdrawalAdvice(asset, networkFilter, best, savingVsWorst, assetPrice, lang);

  return {
    asset,
    ...(networkFilter ? { network: networkFilter } : {}),
    ...(assetPrice !== undefined ? { asset_price_usd: assetPrice } : {}),
    fetched_at: new Date().toISOString(),
    data_as_of: data.last_verified,
    exchanges: quotes,
    best,
    ...(savingVsWorst !== undefined ? { saving_vs_worst_usd: savingVsWorst } : {}),
    advice,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(scWarning ? { stablecoin_warning: scWarning } : {}),
  };
}

function buildWithdrawalAdvice(
  asset: string,
  networkFilter: string | undefined,
  best: WithdrawalBestPick | null,
  savingVsWorst: number | undefined,
  assetPrice: number | undefined,
  lang: Lang = "en",
): string {
  const net = networkFilter ? t(lang, "s_wd_net", { net: networkFilter }) : "";
  if (!best) {
    return t(lang, "wd_adv_none", { asset, net });
  }
  const saving =
    savingVsWorst !== undefined
      ? t(lang, "wd_adv_saving", { usd: `$${savingVsWorst}` })
      : "";
  const priceNote =
    assetPrice !== undefined && assetPrice !== 1
      ? t(lang, "wd_adv_price", { price: `$${assetPrice}`, asset })
      : "";
  return t(lang, "wd_adv_best", {
    asset,
    net,
    ex: best.exchange,
    fee: best.fee,
    usd: `$${best.fee_usd}`,
    saving,
    priceNote,
  });
}

function freshnessWarning(lang: Lang = "en"): string | undefined {
  const f = getDataFreshness();
  if (!f.warning) return undefined;
  if (lang === "en") return f.warning;
  if (!Number.isFinite(f.months_behind)) {
    return t(lang, "fresh_unparseable", { asOf: f.data_as_of });
  }
  return t(lang, "fresh_stale", { asOf: f.data_as_of, months: f.months_behind });
}

// v0.6: fee-data freshness stamp attached to every result element.
function dataAsOf(): string {
  return getFeeRates().last_verified;
}

// v0.15: funding rate used by the cost math — a live-fetched override when the
// caller passed fundingMode:"live", otherwise the bundled long-run average.
function resolveFundingForCalc(
  exchange: string,
  overrides?: FundingOverrides,
): { ratePct: number; intervalHours: number; source: FundingSource; timestamp?: string } | null {
  const override = overrides?.[exchange];
  if (override) {
    return {
      ratePct: override.rate_pct,
      intervalHours: override.interval_hours,
      source: override.source,
      ...(override.timestamp ? { timestamp: override.timestamp } : {}),
    };
  }
  const bundled = getFundingRate(exchange);
  if (!bundled) return null;
  return {
    ratePct: bundled.avg_rate_pct,
    intervalHours: bundled.interval_hours,
    source: "bundled",
  };
}

// v0.16: one-way taker execution cost (half-spread crossing + size impact) —
// a live order-book override when tradeSizeUsd + spreadMode:"live" were passed,
// otherwise the bundled half-spread estimate with zero modeled impact.
function resolveExecutionForCalc(
  exchange: string,
  pair: string | undefined,
  tradeSizeUsd: number | undefined,
  overrides?: SpreadOverrides,
):
  | { crossingBps: number; slippageBps: number; totalBps: number; source: SpreadSource; timestamp?: string }
  | null {
  if (!tradeSizeUsd || tradeSizeUsd <= 0) return null;
  const base = normalizeFundingPair(pair).split("/")[0];
  const override = overrides?.[exchange.toLowerCase()];
  if (override) {
    return {
      crossingBps: override.crossing_bps,
      slippageBps: override.slippage_bps,
      totalBps: override.total_bps,
      source: override.source,
      ...(override.timestamp ? { timestamp: override.timestamp } : {}),
    };
  }
  const est = getSpreadEstimate(exchange, base);
  if (!est) return null;
  return {
    crossingBps: est.crossing_bps,
    slippageBps: 0,
    totalBps: est.crossing_bps,
    source: "bundled",
  };
}

export function listDataSources(): DataProvenanceReport {
  return listDataProvenance();
}

export function compareExchangeFees(
  purpose: TradingPurpose,
  country: string,
  opts: {
    monthlyVolumeUsd?: number;
    useToken?: boolean;
    makerShare?: number;
    tokenBalance?: number;
    accountAssetsUsd?: number;
    pair?: string;
    /** v0.30: "en" (default) or "zh" — language of tier_warning narrative. */
    language?: Lang;
  } = {},
): ExchangeFeeInfo[] | ToolError {
  const lang = pickLang(opts.language);
  const monthlyVolumeUsd = opts.monthlyVolumeUsd ?? 0;
  const useToken = opts.useToken ?? false;
  const ms = clampShare(opts.makerShare);
  const tokenBalance = opts.tokenBalance;
  const accountAssetsUsd = opts.accountAssetsUsd;
  const pair = opts.pair;

  try {
    const data = getFeeRates();
    void data;
  } catch (err) {
    return makeError(`Failed to load fee data: ${err instanceof Error ? err.message : String(err)}`, {
      code: "DATA_LOAD_FAILED",
      retryable: true,
      suggested_action: "Check data file paths and permissions.",
    });
  }

  const staleWarning = freshnessWarning(lang);
  // v0.46: a restricted quote (e.g. BTC/USDT for an EEA resident) annotates
  // every venue row with that venue's regional access status; fee math itself
  // stays the published-schedule comparison.
  const restrictedQuote = restrictedQuoteAsset(pair, country);
  const results: ExchangeFeeInfo[] = [];
  // v0.11: iterate every exchange with fee data; referral links are optional.
  for (const exchange of listSupportedExchanges()) {
    if (!isVenueUsableFor(exchange, country, purpose)) continue;
    const resolved = resolveFeeRate(exchange, purpose, monthlyVolumeUsd, tokenBalance, accountAssetsUsd);
    if (!resolved) continue;
    const { pricingBasis, pairNote } = applyPairOverride(exchange, purpose, pair, resolved);
    const referral = getReferralLinks().exchanges[exchange];
    const refPct = referral ? parsePercent(referral.discount) : 0;

    const tokenMaker = applyTokenDiscount(exchange, purpose, resolved.base_maker, true, useToken, tokenBalance);
    const tokenTaker = applyTokenDiscount(exchange, purpose, resolved.base_taker, false, useToken, tokenBalance);

    const effMaker = round(discountRate(tokenMaker.rate, 1 - refPct));
    const effTaker = round(discountRate(tokenTaker.rate, 1 - refPct));
    const weighted = round(weightedRate(effMaker, effTaker, ms));
    const tierWarning = buildTierWarning(exchange, resolved, tokenBalance, accountAssetsUsd, lang);
    const ifaceHint = consumerInterfaceHint(exchange);

    results.push({
      exchange,
      tier: resolved.tier,
      ...(resolved.volume_tier !== resolved.tier ? { volume_tier: resolved.volume_tier } : {}),
      base_maker: resolved.base_maker,
      base_taker: resolved.base_taker,
      effective_maker: effMaker,
      effective_taker: effTaker,
      weighted_rate: weighted,
      ...(referral ? { referral_discount: referral.discount } : {}),
      token_applied: tokenMaker.applied || tokenTaker.applied,
      ...(tierWarning ? { tier_warning: tierWarning } : {}),
      ...(staleWarning ? { freshness_warning: staleWarning } : {}),
      data_as_of: dataAsOf(),
      ...(referral ? { referral_url: referral.url } : {}),
      pricing_basis: pricingBasis,
      ...(pairNote ? { pair_note: pairNote } : {}),
      ...(spotClassNote(exchange, purpose) ? { spot_class_note: spotClassNote(exchange, purpose) } : {}),
      ...(exchangeNotes(exchange) ? { exchange_notes: exchangeNotes(exchange) } : {}),
      ...(restrictedQuote
        ? (() => {
            const scAccess = venueStablecoinAccess(restrictedQuote, exchange, country);
            return scAccess ? { stablecoin_access: scAccess } : {};
          })()
        : {}),
      ...(ifaceHint ? { consumer_interface: ifaceHint } : {}),
    });
  }

  if (results.length === 0) {
    return makeError(
      `No supported exchanges available for country ${country.toUpperCase()} and purpose ${purpose}.`,
      {
        code: "NO_RESULTS",
        suggested_action: "Check country code or supported exchange list in README.",
      },
    );
  }

  results.sort((a, b) => a.weighted_rate - b.weighted_rate || a.effective_taker - b.effective_taker);
  return results;
}

export function getReferralLink(
  exchange: string,
  country: string,
): { url: string; exchange: string; discount: string; notes?: string } | ToolError {
  const lower = exchange.toLowerCase();
  if (!listSupportedExchanges().includes(lower)) {
    return makeError(`Exchange '${exchange}' is not supported.`, {
      code: "UNKNOWN_EXCHANGE",
      suggested_action: `Supported exchanges: ${listSupportedExchanges().join(", ")}.`,
    });
  }

  if (!isExchangeAllowed(lower, country)) {
    return makeError(
      `Exchange '${exchange}' is not available in country ${country.toUpperCase()} due to compliance restrictions.`,
      {
        code: "COUNTRY_BLOCKED",
        suggested_action: "Try another supported exchange or check country restrictions.",
      },
    );
  }

  const referral = getReferralLinks().exchanges[lower];
  if (!referral) {
    return makeError(`No referral link configured yet for '${lower}'.`, {
      code: "NO_REFERRAL_LINK",
      suggested_action: "Fee data for this exchange is available; use it without a referral link.",
    });
  }
  return {
    url: referral.url,
    exchange: lower,
    discount: referral.discount,
    notes: referral.notes,
  };
}

export function calculateSavings(
  exchange: string,
  volume: number,
  type: TradingPurpose,
  country: string,
  opts: {
    useToken?: boolean;
    holdingHours?: number;
    makerShare?: number;
    currency?: string;
    tokenBalance?: number;
    accountAssetsUsd?: number;
    pair?: string;
    fundingRates?: FundingOverrides;
    fundingPair?: string;
    tradeSizeUsd?: number;
    spreadRates?: SpreadOverrides;
    spreadPair?: string;
    language?: Lang;
  } = {},
): SavingsResult | ToolError {
  if (!Number.isFinite(volume) || volume <= 0) {
    return makeError("Volume must be a positive number.", {
      code: "INVALID_INPUT",
      suggested_action: "Provide a positive monthly trade volume in USDT.",
    });
  }

  const cur = resolveCurrency(opts.currency);
  if (isToolError(cur)) return cur;
  const [currency, fxRate] = cur;
  const lang = pickLang(opts.language);

  const lower = exchange.toLowerCase();
  if (!listSupportedExchanges().includes(lower)) {
    return makeError(`Exchange '${exchange}' is not supported.`, {
      code: "UNKNOWN_EXCHANGE",
      suggested_action: `Supported exchanges: ${listSupportedExchanges().join(", ")}.`,
    });
  }

  if (!isExchangeAllowed(lower, country)) {
    return makeError(
      `Exchange '${exchange}' is not available in country ${country.toUpperCase()}.`,
      { code: "COUNTRY_BLOCKED" },
    );
  }

  if (isProductBlockedInCountry(lower, type, country)) {
    return makeError(
      `${EX_DISPLAY_NAMES[lower] ?? lower} does not offer ${type} trading to residents of ${country.toUpperCase()} (venue is available for other products).`,
      {
        code: "PRODUCT_BLOCKED_IN_COUNTRY",
        suggested_action: "Try another venue, or switch purpose to a product available in this country.",
      },
    );
  }

  const resolved = resolveFeeRate(lower, type, volume, opts.tokenBalance, opts.accountAssetsUsd);
  if (!resolved) {
    return makeError(`No fee data for exchange '${exchange}'.`, { code: "NO_FEE_DATA" });
  }
  const { pricingBasis, pairNote } = applyPairOverride(lower, type, opts.pair, resolved);

  const referral = getReferralLinks().exchanges[lower];
  const refPct = referral ? parsePercent(referral.discount) : 0;
  const useToken = opts.useToken ?? false;
  const ms = clampShare(opts.makerShare);

  const tokenMaker = applyTokenDiscount(lower, type, resolved.base_maker, true, useToken, opts.tokenBalance);
  const tokenTaker = applyTokenDiscount(lower, type, resolved.base_taker, false, useToken, opts.tokenBalance);

  const baseWeighted = weightedRate(resolved.base_maker, resolved.base_taker, ms);
  const referralWeighted = weightedRate(
    discountRate(resolved.base_maker, 1 - refPct),
    discountRate(resolved.base_taker, 1 - refPct),
    ms,
  );
  const tokenWeighted = weightedRate(tokenMaker.rate, tokenTaker.rate, ms);
  const finalWeighted = weightedRate(
    discountRate(tokenMaker.rate, 1 - refPct),
    discountRate(tokenTaker.rate, 1 - refPct),
    ms,
  );

  const originalFeeUsd = (volume * baseWeighted) / 100;
  const feeAfterReferralUsd = (volume * referralWeighted) / 100;
  const feeAfterTokenUsd = (volume * tokenWeighted) / 100;
  const finalFeeUsd = (volume * finalWeighted) / 100;

  let fundingCostUsd: number | undefined;
  let fundingSource: FundingSource | undefined;
  let fundingRateTs: string | undefined;
  if (opts.holdingHours && opts.holdingHours > 0) {
    const fr = resolveFundingForCalc(lower, opts.fundingRates);
    if (fr) {
      const intervals = opts.holdingHours / fr.intervalHours;
      fundingCostUsd = (volume * fr.ratePct) / 100 * intervals;
      fundingSource = fr.source;
      fundingRateTs = fr.timestamp;
    }
  }

  let spreadCostUsd: number | undefined;
  let slippageCostUsd: number | undefined;
  let spreadSource: SpreadSource | undefined;
  let spreadTs: string | undefined;
  const exec0 = resolveExecutionForCalc(lower, opts.spreadPair ?? opts.pair, opts.tradeSizeUsd, opts.spreadRates);
  if (exec0 && opts.tradeSizeUsd) {
    spreadCostUsd = (opts.tradeSizeUsd * exec0.crossingBps) / 1e4;
    slippageCostUsd = (opts.tradeSizeUsd * exec0.slippageBps) / 1e4;
    spreadSource = exec0.source;
    spreadTs = exec0.timestamp;
  }

  const tierWarning = buildTierWarning(lower, resolved, opts.tokenBalance, opts.accountAssetsUsd, lang);
  const staleWarning = freshnessWarning(lang);
  // v0.46: USDT-quoted pair for an EEA resident — schedule fee only, pair not accessible.
  const scWarning = buildStablecoinWarning(
    restrictedQuoteAsset(opts.pair, country) ?? "",
    country,
    lang,
    "trading",
  );
  // v0.47: the savings here are PRO-schedule savings — flag consumer-app gaps.
  const ifaceWarning = buildInterfaceWarning(lower, lang);

  return {
    exchange: lower,
    volume,
    type,
    tier: resolved.tier,
    ...(resolved.volume_tier !== resolved.tier ? { volume_tier: resolved.volume_tier } : {}),
    original_fee: round2(originalFeeUsd * fxRate),
    fee_after_referral: round2(feeAfterReferralUsd * fxRate),
    fee_after_token: round2(feeAfterTokenUsd * fxRate),
    final_fee: round2(finalFeeUsd * fxRate),
    total_savings: round2((originalFeeUsd - finalFeeUsd) * fxRate),
    ...(referral ? { referral_discount: referral.discount } : {}),
    token_applied: tokenMaker.applied || tokenTaker.applied,
    ...(ms > 0 ? { maker_share: ms } : {}),
    ...(currency !== "USD" ? { currency } : {}),
    ...(fundingCostUsd !== undefined ? { funding_cost: round2(fundingCostUsd * fxRate) } : {}),
    ...(fundingSource ? { funding_source: fundingSource } : {}),
    ...(fundingRateTs ? { funding_rate_ts: fundingRateTs } : {}),
    ...(fundingSource === "live" && opts.fundingPair
      ? { funding_pair: normalizeFundingPair(opts.fundingPair) }
      : {}),
    ...(spreadCostUsd !== undefined ? { spread_cost: round2(spreadCostUsd * fxRate) } : {}),
    ...(slippageCostUsd !== undefined && slippageCostUsd !== 0
      ? { slippage_cost: round2(slippageCostUsd * fxRate) }
      : {}),
    ...(spreadSource ? { spread_source: spreadSource } : {}),
    ...(spreadTs ? { spread_ts: spreadTs } : {}),
    ...(spreadSource === "live" && (opts.spreadPair ?? opts.pair)
      ? { spread_pair: normalizeFundingPair(opts.spreadPair ?? opts.pair) }
      : {}),
    ...(tierWarning ? { tier_warning: tierWarning } : {}),
    ...(staleWarning ? { freshness_warning: staleWarning } : {}),
    data_as_of: dataAsOf(),
    ...(referral ? { referral_url: referral.url } : {}),
    pricing_basis: pricingBasis,
    ...(pairNote ? { pair_note: pairNote } : {}),
    ...(spotClassNote(lower, type) ? { spot_class_note: spotClassNote(lower, type) } : {}),
    ...(exchangeNotes(lower) ? { exchange_notes: exchangeNotes(lower) } : {}),
    ...(scWarning ? { stablecoin_warning: scWarning } : {}),
    ...(ifaceWarning ? { interface_warning: ifaceWarning } : {}),
  };
}

export function compareTotalCost(
  purpose: TradingPurpose,
  country: string,
  volume: number,
  opts: {
    holdingHours?: number;
    useToken?: boolean;
    withdrawalAsset?: string;
    withdrawalNetwork?: string;
    makerShare?: number;
    currency?: string;
    tokenBalance?: number;
    accountAssetsUsd?: number;
    pair?: string;
    fundingRates?: FundingOverrides;
    fundingPair?: string;
    tradeSizeUsd?: number;
    spreadRates?: SpreadOverrides;
    spreadPair?: string;
    fiatCurrency?: string;
    fiatDepositAmountUsd?: number;
    fiatDepositsPerYear?: number;
    fiatCashoutAmountUsd?: number;
    fiatCashoutsPerYear?: number;
    fiatMethod?: FiatMethod;
    language?: Lang;
  } = {},
): TotalCostResult[] | ToolError {
  if (!Number.isFinite(volume) || volume <= 0) {
    return makeError("Volume must be a positive number.", {
      code: "INVALID_INPUT",
      suggested_action: "Provide a positive trade volume in USDT.",
    });
  }

  const cur = resolveCurrency(opts.currency);
  if (isToolError(cur)) return cur;
  const [currency, fxRate] = cur;
  const lang = pickLang(opts.language);

  const results: TotalCostResult[] = [];
  const holdingHours = opts.holdingHours ?? 0;
  const useToken = opts.useToken ?? false;
  const ms = clampShare(opts.makerShare);
  const tokenBalance = opts.tokenBalance;
  const accountAssetsUsd = opts.accountAssetsUsd;
  const pair = opts.pair;
  const wAsset = opts.withdrawalAsset;
  const wNetwork = opts.withdrawalNetwork;
  const staleWarning = freshnessWarning(lang);

  // v0.26: one fiat sweep per direction across all allowed exchanges, then
  // per-venue lookup inside the loop (mirrors analyzePersona).
  const fiatCurrency = (opts.fiatCurrency ?? "USD").toUpperCase() as FiatCurrency;
  const fiatDepositsPerYear =
    opts.fiatDepositsPerYear !== undefined && Number.isFinite(opts.fiatDepositsPerYear)
      ? Math.max(opts.fiatDepositsPerYear, 0)
      : 0;
  const fiatCashoutsPerYear =
    opts.fiatCashoutsPerYear !== undefined && Number.isFinite(opts.fiatCashoutsPerYear)
      ? Math.max(opts.fiatCashoutsPerYear, 0)
      : 0;
  const allowedExchanges = listSupportedExchanges().filter((e) => isExchangeAllowed(e, country));
  const fiatDepositMap =
    fiatDepositsPerYear > 0 && opts.fiatDepositAmountUsd && opts.fiatDepositAmountUsd > 0
      ? sweepFiatRails(
          "deposit",
          opts.fiatDepositAmountUsd,
          fiatCurrency,
          country,
          allowedExchanges,
          opts.fiatMethod,
        )
      : new Map<string, { feeUsd: number; method: FiatMethod }>();
  const fiatCashoutMap =
    fiatCashoutsPerYear > 0 && opts.fiatCashoutAmountUsd && opts.fiatCashoutAmountUsd > 0
      ? sweepFiatRails(
          "withdraw",
          opts.fiatCashoutAmountUsd,
          fiatCurrency,
          country,
          allowedExchanges,
          opts.fiatMethod,
        )
      : new Map<string, { feeUsd: number; method: FiatMethod }>();

  // v0.46: restricted quote pair for an EEA resident annotates every row.
  const scWarning = buildStablecoinWarning(
    restrictedQuoteAsset(pair, country) ?? "",
    country,
    lang,
    "trading",
  );

  for (const exchange of listSupportedExchanges()) {
    if (!isVenueUsableFor(exchange, country, purpose)) continue;
    const resolved = resolveFeeRate(exchange, purpose, volume, tokenBalance, accountAssetsUsd);
    if (!resolved) continue;
    const { pricingBasis, pairNote } = applyPairOverride(exchange, purpose, pair, resolved);
    const referral = getReferralLinks().exchanges[exchange];
    const refPct = referral ? parsePercent(referral.discount) : 0;

    const tokenMaker = applyTokenDiscount(exchange, purpose, resolved.base_maker, true, useToken, tokenBalance);
    const tokenTaker = applyTokenDiscount(exchange, purpose, resolved.base_taker, false, useToken, tokenBalance);
    const tokenWeighted = weightedRate(
      discountRate(tokenMaker.rate, 1 - refPct),
      discountRate(tokenTaker.rate, 1 - refPct),
      ms,
    );
    const tradingFeeUsd = (volume * tokenWeighted) / 100;

    let fundingCostUsd = 0;
    let fundingSource: FundingSource | undefined;
    let fundingRateTs: string | undefined;
    if (holdingHours > 0) {
      const fr = resolveFundingForCalc(exchange, opts.fundingRates);
      if (fr) {
        const intervals = holdingHours / fr.intervalHours;
        fundingCostUsd = (volume * fr.ratePct) / 100 * intervals;
        fundingSource = fr.source;
        fundingRateTs = fr.timestamp;
      }
    }

    const withdrawalCostUsd = wAsset
      ? resolveWithdrawalFeeUsd(exchange, wAsset, wNetwork)
      : 0;

    let spreadCostUsd = 0;
    let slippageCostUsd = 0;
    let spreadSource: SpreadSource | undefined;
    let spreadTs: string | undefined;
    const exec1 = resolveExecutionForCalc(exchange, opts.spreadPair ?? pair, opts.tradeSizeUsd, opts.spreadRates);
    if (exec1 && opts.tradeSizeUsd) {
      spreadCostUsd = (opts.tradeSizeUsd * exec1.crossingBps) / 1e4;
      slippageCostUsd = (opts.tradeSizeUsd * exec1.slippageBps) / 1e4;
      spreadSource = exec1.source;
      spreadTs = exec1.timestamp;
    }

    const tradingFee = round2(tradingFeeUsd * fxRate);
    const fundingCost = round2(fundingCostUsd * fxRate);
    const withdrawalCost = round2(withdrawalCostUsd * fxRate);
    const spreadCost = round2(spreadCostUsd * fxRate);
    const slippageCost = round2(slippageCostUsd * fxRate);
    const dep = fiatDepositMap.get(exchange);
    const co = fiatCashoutMap.get(exchange);
    const fiatDepositCost = dep ? round2(dep.feeUsd * fiatDepositsPerYear * fxRate) : 0;
    const fiatCashoutCost = co ? round2(co.feeUsd * fiatCashoutsPerYear * fxRate) : 0;

    const tierWarning = buildTierWarning(exchange, resolved, tokenBalance, accountAssetsUsd, lang);
    const ifaceHint = consumerInterfaceHint(exchange);

    results.push({
      exchange,
      tier: resolved.tier,
      ...(resolved.volume_tier !== resolved.tier ? { volume_tier: resolved.volume_tier } : {}),
      trading_fee: tradingFee,
      funding_cost: fundingCost,
      ...(fundingSource ? { funding_source: fundingSource } : {}),
      ...(fundingRateTs ? { funding_rate_ts: fundingRateTs } : {}),
      ...(fundingSource === "live" && opts.fundingPair
        ? { funding_pair: normalizeFundingPair(opts.fundingPair) }
        : {}),
      ...(opts.tradeSizeUsd ? { spread_cost: spreadCost } : {}),
      ...(opts.tradeSizeUsd && slippageCost !== 0 ? { slippage_cost: slippageCost } : {}),
      ...(spreadSource ? { spread_source: spreadSource } : {}),
      ...(spreadTs ? { spread_ts: spreadTs } : {}),
      ...(spreadSource === "live" && (opts.spreadPair ?? pair)
        ? { spread_pair: normalizeFundingPair(opts.spreadPair ?? pair) }
        : {}),
      withdrawal_cost: withdrawalCost,
      ...(fiatDepositsPerYear > 0
        ? {
            fiat_deposit_cost: fiatDepositCost,
            fiat_deposit_available: !!dep,
            ...(dep ? { fiat_deposit_method: dep.method } : {}),
          }
        : {}),
      ...(fiatCashoutsPerYear > 0
        ? {
            fiat_cashout_cost: fiatCashoutCost,
            fiat_cashout_available: !!co,
            ...(co ? { fiat_cashout_method: co.method } : {}),
          }
        : {}),
      total_cost: round2(
        tradingFee +
          fundingCost +
          withdrawalCost +
          spreadCost +
          slippageCost +
          fiatDepositCost +
          fiatCashoutCost,
      ),
      ...(ms > 0 ? { maker_share: ms } : {}),
      ...(currency !== "USD" ? { currency } : {}),
      ...(tierWarning ? { tier_warning: tierWarning } : {}),
      ...(staleWarning ? { freshness_warning: staleWarning } : {}),
      data_as_of: dataAsOf(),
      ...(referral ? { referral_url: referral.url } : {}),
      pricing_basis: pricingBasis,
      ...(pairNote ? { pair_note: pairNote } : {}),
      ...(spotClassNote(exchange, purpose) ? { spot_class_note: spotClassNote(exchange, purpose) } : {}),
      ...(exchangeNotes(exchange) ? { exchange_notes: exchangeNotes(exchange) } : {}),
      ...(scWarning ? { stablecoin_warning: scWarning } : {}),
      ...(ifaceHint ? { consumer_interface: ifaceHint } : {}),
    });
  }

  if (results.length === 0) {
    return makeError(
      `No supported exchanges for country ${country.toUpperCase()} and purpose ${purpose}.`,
      { code: "NO_RESULTS" },
    );
  }

  results.sort((a, b) => a.total_cost - b.total_cost);
  return results;
}

interface RecommendationCandidate {
  exchange: string;
  tier: string;
  volumeTier: string;
  effMaker: number;
  effTaker: number;
  weighted: number;
  estFeeUsd: number;
  fundingUsd: number | null;
  fundingRatePct: number | null;
  fundingInterval: number | null;
  fundingSource?: FundingSource;
  fundingRateTs?: string;
  spreadUsd: number | null;
  slippageUsd: number | null;
  spreadSource?: SpreadSource;
  spreadTs?: string;
  /** v0.27: annualized direct fiat legs (null = habit not requested for that direction). */
  fiatDepositUsd: number | null;
  fiatCashoutUsd: number | null;
  fiatDepositAvailable?: boolean;
  fiatCashoutAvailable?: boolean;
  fiatDepositMethod?: FiatMethod;
  fiatCashoutMethod?: FiatMethod;
  tokenApplied: boolean;
  tokenDiscountPct: number;
  tokenName: string | null;
  refDiscount?: string;
  refUrl?: string;
  minBnb: number;
  minGt: number;
  tierWarning?: string;
  pricingBasis: "pair" | "account_tier";
  pairNote?: string;
  spotClassNote?: string;
  exchangeNotes?: string[];
}

function fmtRate(r: number): string {
  return `${r}%`;
}

export function recommendExchange(
  purpose: TradingPurpose,
  country: string,
  volume: number,
  opts: {
    makerShare?: number;
    useToken?: boolean;
    holdingHours?: number;
    currency?: string;
    tokenBalance?: number;
    accountAssetsUsd?: number;
    pair?: string;
    fundingRates?: FundingOverrides;
    fundingPair?: string;
    tradeSizeUsd?: number;
    spreadRates?: SpreadOverrides;
    spreadPair?: string;
    fiatCurrency?: string;
    fiatDepositAmountUsd?: number;
    fiatDepositsPerYear?: number;
    fiatCashoutAmountUsd?: number;
    fiatCashoutsPerYear?: number;
    fiatMethod?: FiatMethod;
    /** v0.30: "en" (default) or "zh" — language of advice/tradeoffs narrative. */
    language?: Lang;
  } = {},
): RecommendationResult | ToolError {
  if (!Number.isFinite(volume) || volume <= 0) {
    return makeError("Volume must be a positive number.", {
      code: "INVALID_INPUT",
      suggested_action: "Provide a positive monthly trade volume in USDT.",
    });
  }

  const cur = resolveCurrency(opts.currency);
  if (isToolError(cur)) return cur;
  const [currency, fxRate] = cur;

  const lang = pickLang(opts.language);
  const useToken = opts.useToken ?? false;
  const ms = clampShare(opts.makerShare);
  const holdingHours = opts.holdingHours ?? 0;
  const tokenBalance = opts.tokenBalance;
  const accountAssetsUsd = opts.accountAssetsUsd;
  const pair = opts.pair;

  // v0.27: fiat on/off-ramp habit joins the recommendation score. One sweep per
  // direction up front; a venue without a direct rail is absent from the map.
  const fiatCurrency = (opts.fiatCurrency ?? "USD").toUpperCase() as FiatCurrency;
  const fiatDepositsPerYear =
    opts.fiatDepositsPerYear !== undefined && Number.isFinite(opts.fiatDepositsPerYear)
      ? Math.max(opts.fiatDepositsPerYear, 0)
      : 0;
  const fiatCashoutsPerYear =
    opts.fiatCashoutsPerYear !== undefined && Number.isFinite(opts.fiatCashoutsPerYear)
      ? Math.max(opts.fiatCashoutsPerYear, 0)
      : 0;
  const needFiatDeposit = fiatDepositsPerYear > 0 && !!opts.fiatDepositAmountUsd && opts.fiatDepositAmountUsd > 0;
  const needFiatCashout = fiatCashoutsPerYear > 0 && !!opts.fiatCashoutAmountUsd && opts.fiatCashoutAmountUsd > 0;
  const hasFiatHabit = needFiatDeposit || needFiatCashout;
  const allowedForFiat = listSupportedExchanges().filter((e) => isExchangeAllowed(e, country));
  const fiatDepositMap = needFiatDeposit
    ? sweepFiatRails("deposit", opts.fiatDepositAmountUsd as number, fiatCurrency, country, allowedForFiat, opts.fiatMethod)
    : new Map<string, { feeUsd: number; method: FiatMethod }>();
  const fiatCashoutMap = needFiatCashout
    ? sweepFiatRails("withdraw", opts.fiatCashoutAmountUsd as number, fiatCurrency, country, allowedForFiat, opts.fiatMethod)
    : new Map<string, { feeUsd: number; method: FiatMethod }>();

  const candidates: RecommendationCandidate[] = [];
  for (const exchange of listSupportedExchanges()) {
    if (!isVenueUsableFor(exchange, country, purpose)) continue;
    const resolved: ResolvedFeeRate | null = resolveFeeRate(
      exchange,
      purpose,
      volume,
      tokenBalance,
      accountAssetsUsd,
    );
    if (!resolved) continue;
    const { pricingBasis, pairNote } = applyPairOverride(exchange, purpose, pair, resolved);
    const referral = getReferralLinks().exchanges[exchange];
    const refPct = referral ? parsePercent(referral.discount) : 0;

    const tokenMaker = applyTokenDiscount(exchange, purpose, resolved.base_maker, true, useToken, tokenBalance);
    const tokenTaker = applyTokenDiscount(exchange, purpose, resolved.base_taker, false, useToken, tokenBalance);
    const effMaker = round(discountRate(tokenMaker.rate, 1 - refPct));
    const effTaker = round(discountRate(tokenTaker.rate, 1 - refPct));
    const weighted = round(weightedRate(effMaker, effTaker, ms));

    let fundingUsd: number | null = null;
    let fundingRatePct: number | null = null;
    let fundingInterval: number | null = null;
    let fundingSource: FundingSource | undefined;
    let fundingRateTs: string | undefined;
    if (purpose === "futures" && holdingHours > 0) {
      const fr = resolveFundingForCalc(exchange, opts.fundingRates);
      if (fr) {
        const intervals = holdingHours / fr.intervalHours;
        fundingUsd = (volume * fr.ratePct) / 100 * intervals;
        fundingRatePct = fr.ratePct;
        fundingInterval = fr.intervalHours;
        fundingSource = fr.source;
        fundingRateTs = fr.timestamp;
      }
    }

    let spreadUsd: number | null = null;
    let slippageUsd: number | null = null;
    let spreadSource: SpreadSource | undefined;
    let spreadTs: string | undefined;
    const exec2 = resolveExecutionForCalc(exchange, opts.spreadPair ?? pair, opts.tradeSizeUsd, opts.spreadRates);
    if (exec2 && opts.tradeSizeUsd) {
      spreadUsd = (opts.tradeSizeUsd * exec2.crossingBps) / 1e4;
      slippageUsd = (opts.tradeSizeUsd * exec2.slippageBps) / 1e4;
      spreadSource = exec2.source;
      spreadTs = exec2.timestamp;
    }

    const td = getTokenDiscount(exchange);
    // Holding-tier venues (Gate GT, MEXC MX): a known balance pins the reached tier,
    // unknown balance advertises the top tier; otherwise use the flat deduction pct.
    let potentialPct: number;
    if (td?.holding_tiers) {
      const bestTierPct =
        tokenBalance !== undefined
          ? td.holding_tiers.reduce((acc, h) => (tokenBalance >= h.min_balance ? h.discount_pct : acc), 0)
          : Math.max(...td.holding_tiers.map((h) => h.discount_pct));
      potentialPct = Math.max(
        purpose === "spot" ? (td.spot_discount_pct ?? 0) : (td.futures_discount_pct ?? 0),
        bestTierPct,
      );
    } else {
      potentialPct =
        purpose === "spot" ? (td?.spot_discount_pct ?? 0) : (td?.futures_discount_pct ?? 0);
    }

    const tierWarning = buildTierWarning(exchange, resolved, tokenBalance, accountAssetsUsd, lang);

    const fDep = needFiatDeposit ? fiatDepositMap.get(exchange) : undefined;
    const fCo = needFiatCashout ? fiatCashoutMap.get(exchange) : undefined;
    const fiatDepositUsd = needFiatDeposit ? (fDep ? fDep.feeUsd * fiatDepositsPerYear : 0) : null;
    const fiatCashoutUsd = needFiatCashout ? (fCo ? fCo.feeUsd * fiatCashoutsPerYear : 0) : null;

    candidates.push({
      exchange,
      tier: resolved.tier,
      volumeTier: resolved.volume_tier,
      effMaker,
      effTaker,
      weighted,
      estFeeUsd: (volume * weighted) / 100,
      fundingUsd,
      fundingRatePct,
      fundingInterval,
      ...(fundingSource ? { fundingSource } : {}),
      ...(fundingRateTs ? { fundingRateTs } : {}),
      spreadUsd,
      slippageUsd,
      ...(spreadSource ? { spreadSource } : {}),
      ...(spreadTs ? { spreadTs } : {}),
      fiatDepositUsd,
      fiatCashoutUsd,
      ...(needFiatDeposit
        ? {
            fiatDepositAvailable: !!fDep,
            ...(fDep ? { fiatDepositMethod: fDep.method } : {}),
          }
        : {}),
      ...(needFiatCashout
        ? {
            fiatCashoutAvailable: !!fCo,
            ...(fCo ? { fiatCashoutMethod: fCo.method } : {}),
          }
        : {}),
      tokenApplied: tokenMaker.applied || tokenTaker.applied,
      tokenDiscountPct: potentialPct,
      tokenName: td?.token ?? null,
      ...(referral ? { refDiscount: referral.discount, refUrl: referral.url } : {}),
      minBnb: resolved.token_name === "BNB" ? (resolved.min_token ?? 0) : 0,
      minGt: resolved.token_name === "GT" ? (resolved.min_token ?? 0) : 0,
      ...(tierWarning ? { tierWarning } : {}),
      pricingBasis,
      pairNote,
      ...(spotClassNote(exchange, purpose) ? { spotClassNote: spotClassNote(exchange, purpose) } : {}),
      ...(exchangeNotes(exchange) ? { exchangeNotes: exchangeNotes(exchange) } : {}),
    });
  }

  if (candidates.length === 0) {
    return makeError(
      `No supported exchanges for country ${country.toUpperCase()} and purpose ${purpose}.`,
      { code: "NO_RESULTS", suggested_action: "Check country code or supported exchange list." },
    );
  }

  // Scoring: fee component (cheapest = 100), funding component for futures holding.
  // Negative estimates mean the venue pays maker rebates; scores must stay 0-100.
  const minFee = Math.min(...candidates.map((c) => c.estFeeUsd));
  const feeScore = (est: number): number => {
    if (minFee < 0) {
      // Most-negative (largest rebate) = 100; other zero/rebate venues scale 60-100;
      // fee-charging venues score 0.
      if (est <= 0) return Math.max(60, Math.min(100, 60 + 40 * (est / minFee)));
      return 0;
    }
    if (minFee === 0) return est <= 0 ? 100 : 0;
    return (minFee / est) * 100;
  };

  const allHaveFunding =
    purpose === "futures" &&
    holdingHours > 0 &&
    candidates.every((c) => c.fundingUsd !== null);
  const minFunding = allHaveFunding
    ? Math.min(...candidates.map((c) => c.fundingUsd as number))
    : 0;
  const fundingScore = (est: number): number => {
    if (!allHaveFunding) return 0;
    if (minFunding > 0) return (minFunding / est) * 100;
    return est <= minFunding ? 100 : 0;
  };

  // v0.16: spread+impact joins the score when an order size is provided. Weights
  // normalize over the components actually present (fee is always there).
  const hasSpread =
    opts.tradeSizeUsd !== undefined &&
    opts.tradeSizeUsd > 0 &&
    candidates.every((c) => c.spreadUsd !== null);
  const minSpread = hasSpread
    ? Math.min(...candidates.map((c) => (c.spreadUsd ?? 0) + (c.slippageUsd ?? 0)))
    : 0;
  const spreadScore = (est: number): number => {
    if (!hasSpread) return 0;
    if (minSpread > 0) return Math.min(100, (minSpread / est) * 100);
    return est <= minSpread ? 100 : 0;
  };
  // v0.27: fiat on/off-ramping joins the score when a habit is passed. The
  // component is only active when at least one venue actually has a qualifying
  // rail; a venue missing the rail scores 0 for that direction (a free-but-real
  // rail scores 100), so rail-less DEX/third-party-only venues never win a
  // card-funded retail user by virtue of an unpriced leg.
  const depPresent = candidates.filter((c) => c.fiatDepositUsd !== null && c.fiatDepositAvailable);
  const coPresent = candidates.filter((c) => c.fiatCashoutUsd !== null && c.fiatCashoutAvailable);
  const hasFiatScore =
    hasFiatHabit && (depPresent.length > 0 || coPresent.length > 0);
  const minFiatDep = depPresent.length
    ? Math.min(...depPresent.map((c) => c.fiatDepositUsd as number))
    : 0;
  const minFiatCo = coPresent.length
    ? Math.min(...coPresent.map((c) => c.fiatCashoutUsd as number))
    : 0;
  const dirScore = (est: number, min: number): number => {
    if (min > 0) return (min / est) * 100;
    return est <= min ? 100 : 0;
  };
  const fiatScore = (c: RecommendationCandidate): number => {
    if (!hasFiatScore) return 0;
    const parts: number[] = [];
    if (needFiatDeposit && depPresent.length > 0) {
      parts.push(c.fiatDepositAvailable ? dirScore(c.fiatDepositUsd as number, minFiatDep) : 0);
    }
    if (needFiatCashout && coPresent.length > 0) {
      parts.push(c.fiatCashoutAvailable ? dirScore(c.fiatCashoutUsd as number, minFiatCo) : 0);
    }
    return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  };
  const annualFiatOf = (c: RecommendationCandidate): number =>
    (c.fiatDepositUsd ?? 0) + (c.fiatCashoutUsd ?? 0);

  // Weights normalize over the components actually present (fee is always there).
  // Base weights match the pre-v0.27 table; when fiat is scored, its weight is
  // data-driven by COST DISPERSION: for a small monthly on-ramper the difference
  // between venues' card/SEPA fees can dwarf the whole year's trading-fee
  // difference, so fiat's weight rises 0.2→0.5 as its dispersion share grows,
  // and the remaining weight is re-split over fee/funding/spread in their base
  // proportions (fee floor stays 0.35-0.5). Without fiat, weights are identical
  // to the historical table.
  const baseFeeW = allHaveFunding && hasSpread ? 0.7 : allHaveFunding || hasSpread ? 0.8 : 1;
  const baseFundW = allHaveFunding ? (hasSpread ? 0.15 : 0.2) : 0;
  const baseSpreadW = hasSpread ? (allHaveFunding ? 0.15 : 0.2) : 0;
  let feeW = baseFeeW;
  let fundW = baseFundW;
  let spreadW = baseSpreadW;
  let fiatW = 0;
  if (hasFiatScore) {
    const dispFee = (Math.max(...candidates.map((c) => c.estFeeUsd)) - minFee) * 12;
    const fullRail = candidates.filter(
      (c) =>
        (!needFiatDeposit || c.fiatDepositAvailable) &&
        (!needFiatCashout || c.fiatCashoutAvailable),
    );
    const fiatAnnuals = fullRail.map(annualFiatOf);
    const dispFiat = fiatAnnuals.length > 1 ? Math.max(...fiatAnnuals) - Math.min(...fiatAnnuals) : 0;
    const claim = dispFee + dispFiat > 0 ? dispFiat / (dispFee + dispFiat) : 0;
    fiatW = 0.2 + 0.3 * Math.max(0, Math.min(1, claim));
    const baseSum = baseFeeW + baseFundW + baseSpreadW;
    const remaining = 1 - fiatW;
    feeW = (remaining * baseFeeW) / baseSum;
    fundW = (remaining * baseFundW) / baseSum;
    spreadW = (remaining * baseSpreadW) / baseSum;
  }

  const scored = candidates.map((c) => {
    const fs = feeScore(c.estFeeUsd);
    const fds = fundingScore(c.fundingUsd ?? 0);
    const xds = spreadScore((c.spreadUsd ?? 0) + (c.slippageUsd ?? 0));
    const fxs = fiatScore(c);
    const score = feeW * fs + fundW * fds + spreadW * xds + fiatW * fxs;
    return { ...c, score: round(Math.min(score, 100), 1) };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.estFeeUsd + (a.fundingUsd ?? 0) + (a.spreadUsd ?? 0) + (a.slippageUsd ?? 0) + annualFiatOf(a) -
        (b.estFeeUsd + (b.fundingUsd ?? 0) + (b.spreadUsd ?? 0) + (b.slippageUsd ?? 0) + annualFiatOf(b)),
  );

  const best = scored[0];
  const bestFunding = best.fundingUsd;
  const bestExec =
    best.spreadUsd !== null ? best.spreadUsd + (best.slippageUsd ?? 0) : null;
  const bestFiat = hasFiatScore ? annualFiatOf(best) : null;

  // v0.46: restricted quote (USDT pair for an EEA resident).
  const restrictedQuote = restrictedQuoteAsset(pair, country);
  const scWarning = buildStablecoinWarning(
    restrictedQuote ?? "",
    country,
    lang,
    "trading",
  );

  const recommendations: ExchangeRecommendation[] = scored.map((c) => {
    const isBest = c.exchange === best.exchange;
    const ifaceHint = consumerInterfaceHint(c.exchange);
    // en: "A, B and C" / zh: "A、B、C"
    const listJoin = (arr: string[]): string =>
      lang === "zh"
        ? arr.join("、")
        : arr.length > 1
          ? `${arr.slice(0, -1).join(", ")} and ${arr[arr.length - 1]}`
          : (arr[0] ?? "");
    const reasons: string[] = [];
    if (isBest) {
      const parts = [t(lang, "re_label_fees")];
      if (allHaveFunding) parts.push(t(lang, "re_label_funding"));
      if (hasSpread) parts.push(t(lang, "re_label_spread"));
      if (hasFiatScore) parts.push(t(lang, "re_label_fiat"));
      reasons.push(
        parts.length > 1
          ? t(lang, "re_reason_best", { parts: listJoin(parts) })
          : t(lang, "re_reason_best_single"),
      );
    }
    reasons.push(
      t(lang, "re_reason_weighted", {
        rate: fmtRate(c.weighted),
        maker: fmtRate(c.effMaker),
        taker: fmtRate(c.effTaker),
        tier: c.tier,
      }),
    );
    if (c.tokenApplied && c.tokenName) {
      reasons.push(t(lang, "re_reason_token", { token: c.tokenName }));
    }
    if (c.refDiscount) {
      reasons.push(t(lang, "re_reason_ref", { disc: c.refDiscount }));
    }
    if (c.fundingUsd !== null && c.fundingRatePct !== null && c.fundingInterval !== null) {
      reasons.push(
        t(lang, "re_reason_funding", { rate: fmtRate(c.fundingRatePct), interval: c.fundingInterval }),
      );
    }
    if (c.spreadUsd !== null) {
      reasons.push(
        c.spreadSource === "live"
          ? t(lang, "re_reason_spread_live", {
              usd: `$${round2((c.spreadUsd ?? 0) + (c.slippageUsd ?? 0))}`,
              size: `$${opts.tradeSizeUsd}`,
            })
          : t(lang, "re_reason_spread_est", {
              usd: `$${round2(c.spreadUsd)}`,
              size: `$${opts.tradeSizeUsd}`,
            }),
      );
    }
    if (hasFiatHabit) {
      const fiatLegs: string[] = [];
      if (needFiatDeposit) {
        if (c.fiatDepositAvailable) {
          fiatLegs.push(
            t(lang, "re_reason_fiat_dep", {
              n: fiatDepositsPerYear,
              cur: fiatCurrency,
              method: c.fiatDepositMethod ?? "bank",
              usd: `$${round2((c.fiatDepositUsd ?? 0) * fxRate)}`,
            }),
          );
        } else {
          fiatLegs.push(t(lang, "re_reason_no_dep"));
        }
      }
      if (needFiatCashout) {
        if (c.fiatCashoutAvailable) {
          fiatLegs.push(
            t(lang, "re_reason_fiat_cash", {
              n: fiatCashoutsPerYear,
              method: c.fiatCashoutMethod ?? "bank",
              x: fiatCashoutsPerYear > 1 ? "s" : "",
              usd: `$${round2((c.fiatCashoutUsd ?? 0) * fxRate)}`,
            }),
          );
        } else {
          fiatLegs.push(t(lang, "re_reason_no_cash"));
        }
      }
      reasons.push(t(lang, "re_reason_fiat_head", { legs: fiatLegs.join("; ") }));
    }

    const tradeoffs: string[] = [];
    if (c.minBnb > 0) tradeoffs.push(t(lang, "to_min_bnb", { n: c.minBnb }));
    if (c.minGt > 0) tradeoffs.push(t(lang, "to_min_gt", { n: c.minGt }));
    if (!isBest && c.estFeeUsd > minFee) {
      tradeoffs.push(t(lang, "to_fee_above", { usd: `$${round2(c.estFeeUsd - minFee)}` }));
    }
    if (!isBest && bestFunding !== null && c.fundingUsd !== null && c.fundingUsd > bestFunding) {
      tradeoffs.push(
        t(lang, "to_funding_above", { ex: best.exchange, usd: `$${round2(c.fundingUsd - bestFunding)}` }),
      );
    }
    const cExec = c.spreadUsd !== null ? c.spreadUsd + (c.slippageUsd ?? 0) : null;
    if (!isBest && bestExec !== null && cExec !== null && cExec > bestExec) {
      tradeoffs.push(
        t(lang, "to_exec_above", { ex: best.exchange, usd: `$${round2(cExec - bestExec)}` }),
      );
    }
    if (needFiatDeposit && c.fiatDepositAvailable === false) {
      tradeoffs.push(t(lang, "to_no_deposit", { cur: fiatCurrency }));
    }
    if (needFiatCashout && c.fiatCashoutAvailable === false) {
      tradeoffs.push(t(lang, "to_no_cashout", { cur: fiatCurrency }));
    }
    const cFiatAllRails =
      (!needFiatDeposit || c.fiatDepositAvailable) && (!needFiatCashout || c.fiatCashoutAvailable);
    if (
      hasFiatScore &&
      !isBest &&
      bestFiat !== null &&
      cFiatAllRails &&
      annualFiatOf(c) > bestFiat
    ) {
      tradeoffs.push(
        t(lang, "to_fiat_above", {
          ex: best.exchange,
          usd: `$${round2((annualFiatOf(c) - bestFiat) * fxRate)}`,
        }),
      );
    }

    return {
      exchange: c.exchange,
      tier: c.tier,
      ...(c.volumeTier !== c.tier ? { volume_tier: c.volumeTier } : {}),
      weighted_fee_rate: c.weighted,
      effective_maker: c.effMaker,
      effective_taker: c.effTaker,
      estimated_fee: round2(c.estFeeUsd * fxRate),
      ...(c.fundingUsd !== null ? { funding_cost: round2(c.fundingUsd * fxRate) } : {}),
      ...(c.fundingSource ? { funding_source: c.fundingSource } : {}),
      ...(c.fundingRateTs ? { funding_rate_ts: c.fundingRateTs } : {}),
      ...(c.fundingSource === "live" && opts.fundingPair
        ? { funding_pair: normalizeFundingPair(opts.fundingPair) }
        : {}),
      ...(c.spreadUsd !== null ? { spread_cost: round2(c.spreadUsd * fxRate) } : {}),
      ...(c.slippageUsd !== null && c.slippageUsd !== 0
        ? { slippage_cost: round2(c.slippageUsd * fxRate) }
        : {}),
      ...(c.spreadSource ? { spread_source: c.spreadSource } : {}),
      ...(c.spreadTs ? { spread_ts: c.spreadTs } : {}),
      ...(c.spreadSource === "live" && (opts.spreadPair ?? opts.pair)
        ? { spread_pair: normalizeFundingPair(opts.spreadPair ?? opts.pair) }
        : {}),
      ...(needFiatDeposit
        ? {
            fiat_deposit_cost: round2((c.fiatDepositUsd ?? 0) * fxRate),
            fiat_deposit_available: !!c.fiatDepositAvailable,
            ...(c.fiatDepositMethod ? { fiat_deposit_method: c.fiatDepositMethod } : {}),
          }
        : {}),
      ...(needFiatCashout
        ? {
            fiat_cashout_cost: round2((c.fiatCashoutUsd ?? 0) * fxRate),
            fiat_cashout_available: !!c.fiatCashoutAvailable,
            ...(c.fiatCashoutMethod ? { fiat_cashout_method: c.fiatCashoutMethod } : {}),
          }
        : {}),
      score: c.score,
      reasons,
      tradeoffs,
      ...(c.tierWarning ? { tier_warning: c.tierWarning } : {}),
      ...(c.refDiscount ? { referral_discount: c.refDiscount } : {}),
      ...(c.refUrl ? { referral_url: c.refUrl } : {}),
      pricing_basis: c.pricingBasis,
      ...(c.pairNote ? { pair_note: c.pairNote } : {}),
      ...(c.spotClassNote ? { spot_class_note: c.spotClassNote } : {}),
      ...(c.exchangeNotes ? { exchange_notes: c.exchangeNotes } : {}),
      ...(restrictedQuote
        ? (() => {
            const scAccess = venueStablecoinAccess(restrictedQuote, c.exchange, country);
            return scAccess ? { stablecoin_access: scAccess } : {};
          })()
        : {}),
      ...(ifaceHint ? { consumer_interface: ifaceHint } : {}),
    };
  });

  const adviceParts: string[] = [];
  if (best.pairNote && best.pricingBasis === "pair") {
    adviceParts.push(t(lang, "re_pair_pricing", { ex: best.exchange, note: best.pairNote }));
  }
  if (best.refDiscount) {
    adviceParts.push(t(lang, "re_referral", { ex: best.exchange, disc: best.refDiscount }));
  }
  if (!useToken && best.tokenName && best.tokenDiscountPct > 0) {
    adviceParts.push(
      best.exchange === "gate"
        ? t(lang, "re_token_gate", { token: best.tokenName, pct: best.tokenDiscountPct })
        : t(lang, "re_token_other", { token: best.tokenName, pct: best.tokenDiscountPct }),
    );
  }
  if (best.tierWarning) {
    adviceParts.push(best.tierWarning);
  }
  if (hasFiatScore) {
    const bestMissingDeposit = needFiatDeposit && best.fiatDepositAvailable === false;
    const bestMissingCashout = needFiatCashout && best.fiatCashoutAvailable === false;
    if (bestMissingDeposit || bestMissingCashout) {
      const legs = [
        ...(bestMissingDeposit ? [t(lang, "s_leg_deposit")] : []),
        ...(bestMissingCashout ? [t(lang, "s_leg_cashout")] : []),
      ].join("/");
      adviceParts.push(t(lang, "re_no_fiat_rail", { cur: fiatCurrency, legs }));
    }
    const cheapestFiat = scored
      .filter(
        (c) =>
          (!needFiatDeposit || c.fiatDepositAvailable) &&
          (!needFiatCashout || c.fiatCashoutAvailable),
      )
      .sort((a, b) => annualFiatOf(a) - annualFiatOf(b))[0];
    if (cheapestFiat && cheapestFiat.exchange !== best.exchange && annualFiatOf(cheapestFiat) < annualFiatOf(best)) {
      adviceParts.push(
        t(lang, "re_fiat_cheaper", {
          ex: EX_DISPLAY_NAMES[cheapestFiat.exchange] ?? cheapestFiat.exchange,
          usd: `$${round2((annualFiatOf(best) - annualFiatOf(cheapestFiat)) * fxRate)}`,
        }),
      );
    }
  }
  if (currency !== "USD") {
    adviceParts.push(t(lang, "re_fx_note", { cur: currency }));
  }
  if (scWarning) {
    adviceParts.push(scWarning.message);
  }
  // v0.47: rows price the PRO book — flag consumer-app cost gaps.
  const ifaceWarning = buildInterfaceWarning(best.exchange, lang);
  if (ifaceWarning) {
    adviceParts.push(ifaceWarning.message);
  }

  const asOf = dataAsOf();
  const staleWarning = freshnessWarning(lang);
  const sources = listDataProvenance();
  const relevantFiles = new Set(["fee_rates.json", "funding_rates.json", "referral_links.json"]);
  if (hasFiatScore) relevantFiles.add("fiat_routes.json");
  const dataSources = sources.files
    .filter((f) => relevantFiles.has(f.file) || (currency !== "USD" && f.file === "fx_rates.json"))
    .flatMap((f) => f.sources ?? []);

  return {
    purpose,
    country: country.toUpperCase(),
    volume,
    currency,
    data_as_of: asOf,
    data_sources: dataSources,
    ...(staleWarning ? { freshness_warning: staleWarning } : {}),
    best: recommendations[0],
    alternatives: recommendations.slice(1),
    advice: adviceParts.join(" "),
    ...(scWarning ? { stablecoin_warning: scWarning } : {}),
    ...(ifaceWarning ? { interface_warning: ifaceWarning } : {}),
  };
}

// v0.10: annualized all-in cost for one exchange — 12x monthly trading fees,
// 12x monthly funding exposure, per-event withdrawal fee x yearly count,
// plus a next-VIP-tier upgrade quote (annual saving + qualification path).
export function calculateAnnualCost(
  exchange: string,
  purpose: TradingPurpose,
  country: string,
  monthlyVolumeUsd: number,
  opts: {
    makerShare?: number;
    useToken?: boolean;
    tokenBalance?: number;
    accountAssetsUsd?: number;
    holdingHours?: number;
    withdrawalAsset?: string;
    withdrawalNetwork?: string;
    withdrawalsPerYear?: number;
    currency?: string;
    pair?: string;
    fundingRates?: FundingOverrides;
    fundingPair?: string;
    tradeSizeUsd?: number;
    spreadRates?: SpreadOverrides;
    spreadPair?: string;
    fiatCurrency?: string;
    fiatDepositAmountUsd?: number;
    fiatDepositsPerYear?: number;
    fiatCashoutAmountUsd?: number;
    fiatCashoutsPerYear?: number;
    fiatMethod?: FiatMethod;
    /** v0.30: "en" (default) or "zh" — language of tier_warning/upgrade-hint narrative. */
    language?: Lang;
  } = {},
): AnnualCostResult | ToolError {
  const lang = pickLang(opts.language);
  if (!Number.isFinite(monthlyVolumeUsd) || monthlyVolumeUsd <= 0) {
    return makeError("Monthly volume must be a positive number.", {
      code: "INVALID_INPUT",
      suggested_action: "Provide a positive monthly trade volume in USD.",
    });
  }

  const cur = resolveCurrency(opts.currency);
  if (isToolError(cur)) return cur;
  const [currency, fxRate] = cur;

  const lower = exchange.toLowerCase();
  if (!listSupportedExchanges().includes(lower)) {
    return makeError(`Exchange '${exchange}' is not supported.`, {
      code: "UNKNOWN_EXCHANGE",
      suggested_action: `Supported exchanges: ${listSupportedExchanges().join(", ")}.`,
    });
  }

  if (!isExchangeAllowed(lower, country)) {
    return makeError(
      `Exchange '${exchange}' is not available in country ${country.toUpperCase()}.`,
      { code: "COUNTRY_BLOCKED" },
    );
  }

  if (isProductBlockedInCountry(lower, purpose, country)) {
    return makeError(
      `${EX_DISPLAY_NAMES[lower] ?? lower} does not offer ${purpose} trading to residents of ${country.toUpperCase()} (venue is available for other products).`,
      { code: "PRODUCT_BLOCKED_IN_COUNTRY" },
    );
  }

  const useToken = opts.useToken ?? false;
  const ms = clampShare(opts.makerShare);
  const holdingHours = opts.holdingHours ?? 0;
  const withdrawalsPerYear =
    opts.withdrawalsPerYear !== undefined && Number.isFinite(opts.withdrawalsPerYear)
      ? Math.max(opts.withdrawalsPerYear, 0)
      : 0;

  const resolved = resolveFeeRate(
    lower,
    purpose,
    monthlyVolumeUsd,
    opts.tokenBalance,
    opts.accountAssetsUsd,
  );
  if (!resolved) {
    return makeError(`No fee data for exchange '${exchange}'.`, { code: "NO_FEE_DATA" });
  }
  const { pricingBasis, pairNote } = applyPairOverride(lower, purpose, opts.pair, resolved);

  const referral = getReferralLinks().exchanges[lower];
  const refPct = referral ? parsePercent(referral.discount) : 0;

  const tokenMaker = applyTokenDiscount(
    lower,
    purpose,
    resolved.base_maker,
    true,
    useToken,
    opts.tokenBalance,
  );
  const tokenTaker = applyTokenDiscount(
    lower,
    purpose,
    resolved.base_taker,
    false,
    useToken,
    opts.tokenBalance,
  );
  const finalWeighted = weightedRate(
    discountRate(tokenMaker.rate, 1 - refPct),
    discountRate(tokenTaker.rate, 1 - refPct),
    ms,
  );
  const annualTradingFeeUsd = ((monthlyVolumeUsd * finalWeighted) / 100) * 12;

  let annualFundingUsd = 0;
  let fundingSource: FundingSource | undefined;
  let fundingRateTs: string | undefined;
  if (purpose === "futures" && holdingHours > 0) {
    const fr = resolveFundingForCalc(lower, opts.fundingRates);
    if (fr) {
      const intervals = holdingHours / fr.intervalHours;
      annualFundingUsd = ((monthlyVolumeUsd * fr.ratePct) / 100) * intervals * 12;
      fundingSource = fr.source;
      fundingRateTs = fr.timestamp;
    }
  }

  // v0.16: spread crossing/impact is paid on every taker-traded notional, exactly
  // like the trading fee, so it scales with annual traded volume (the live bps
  // assume the flow is sliced into tradeSizeUsd-sized market orders).
  let annualSpreadUsd = 0;
  let annualSlippageUsd = 0;
  let spreadSource: SpreadSource | undefined;
  let spreadTs: string | undefined;
  const exec3 = resolveExecutionForCalc(lower, opts.spreadPair ?? opts.pair, opts.tradeSizeUsd, opts.spreadRates);
  if (exec3) {
    const annualNotional = monthlyVolumeUsd * 12;
    annualSpreadUsd = (annualNotional * exec3.crossingBps) / 1e4;
    annualSlippageUsd = (annualNotional * exec3.slippageBps) / 1e4;
    spreadSource = exec3.source;
    spreadTs = exec3.timestamp;
  }

  let annualWithdrawalUsd = 0;
  if (withdrawalsPerYear > 0 && opts.withdrawalAsset) {
    annualWithdrawalUsd =
      resolveWithdrawalFeeUsd(lower, opts.withdrawalAsset, opts.withdrawalNetwork) *
      withdrawalsPerYear;
  }

  // v0.26: direct fiat on/off-ramp annual legs (one single-exchange sweep each).
  let annualFiatDepositUsd = 0;
  let annualFiatCashoutUsd = 0;
  let depositMethod: FiatMethod | undefined;
  let cashoutMethod: FiatMethod | undefined;
  let depositAvailable = false;
  let cashoutAvailable = false;
  const fiatCurrency = (opts.fiatCurrency ?? "USD").toUpperCase() as FiatCurrency;
  const fiatDepositsPerYear =
    opts.fiatDepositsPerYear !== undefined && Number.isFinite(opts.fiatDepositsPerYear)
      ? Math.max(opts.fiatDepositsPerYear, 0)
      : 0;
  const fiatCashoutsPerYear =
    opts.fiatCashoutsPerYear !== undefined && Number.isFinite(opts.fiatCashoutsPerYear)
      ? Math.max(opts.fiatCashoutsPerYear, 0)
      : 0;
  if (fiatDepositsPerYear > 0 && opts.fiatDepositAmountUsd && opts.fiatDepositAmountUsd > 0) {
    const dep = sweepFiatRails(
      "deposit",
      opts.fiatDepositAmountUsd,
      fiatCurrency,
      country,
      [lower],
      opts.fiatMethod,
    ).get(lower);
    if (dep) {
      annualFiatDepositUsd = dep.feeUsd * fiatDepositsPerYear;
      depositMethod = dep.method;
      depositAvailable = true;
    }
  }
  if (fiatCashoutsPerYear > 0 && opts.fiatCashoutAmountUsd && opts.fiatCashoutAmountUsd > 0) {
    const co = sweepFiatRails(
      "withdraw",
      opts.fiatCashoutAmountUsd,
      fiatCurrency,
      country,
      [lower],
      opts.fiatMethod,
    ).get(lower);
    if (co) {
      annualFiatCashoutUsd = co.feeUsd * fiatCashoutsPerYear;
      cashoutMethod = co.method;
      cashoutAvailable = true;
    }
  }

  // Next-tier upgrade quote on the same discount assumptions.
  let upgrade: AnnualCostResult["upgrade"];
  const ladder = getNormalizedLadder(lower, purpose);
  if (ladder) {
    const idx = ladder.findIndex((t) => t.tier === resolved.tier);
    const next = idx >= 0 ? ladder[idx + 1] : undefined;
    if (next) {
      const nextMaker = applyTokenDiscount(
        lower,
        purpose,
        next.maker,
        true,
        useToken,
        opts.tokenBalance,
      );
      const nextTaker = applyTokenDiscount(
        lower,
        purpose,
        next.taker,
        false,
        useToken,
        opts.tokenBalance,
      );
      const nextWeighted = weightedRate(
        discountRate(nextMaker.rate, 1 - refPct),
        discountRate(nextTaker.rate, 1 - refPct),
        ms,
      );
      const annualFeeNextUsd = ((monthlyVolumeUsd * nextWeighted) / 100) * 12;
      const savingsUsd = annualTradingFeeUsd - annualFeeNextUsd;
      if (savingsUsd > 0) {
        const paths: string[] = [t(lang, "ac_path_volume", { usd: formatUsd(next.min_volume_usd) })];
        if (next.min_assets_usd !== undefined) {
          // v0.14: Kraken calls the holdings track "assets on platform (AOP)".
          const assetLabel = t(lang, lower === "kraken" ? "s_aop" : "s_assets");
          paths.push(t(lang, "ac_path_assets", { usd: formatUsd(next.min_assets_usd), assetLabel }));
        }
        if (next.min_gt !== undefined) paths.push(t(lang, "ac_path_gt", { n: next.min_gt }));
        if (next.min_kcs !== undefined)
          paths.push(t(lang, "ac_path_kcs", { n: next.min_kcs.toLocaleString("en-US") }));
        const requirement =
          lower === "binance" && next.min_bnb !== undefined
            ? t(lang, "ac_up_bnb", { tier: next.tier, usd: paths[0], bnb: next.min_bnb })
            : t(lang, "ac_up_or", { tier: next.tier, paths: paths.join(lang === "zh" ? "、" : " OR ") });
        const hint = t(lang, "ac_hint", {
          req: requirement,
          save: formatUsd(savingsUsd * fxRate),
          cur: currency !== "USD" ? ` ${currency}` : "",
        });
        upgrade = {
          next_tier: next.tier,
          ...(next.min_volume_usd > 0 ? { requires_volume_usd: next.min_volume_usd } : {}),
          ...(next.min_assets_usd !== undefined
            ? { requires_assets_usd: next.min_assets_usd }
            : {}),
          ...(next.min_gt !== undefined ? { requires_gt: next.min_gt } : {}),
          ...(next.min_kcs !== undefined ? { requires_kcs: next.min_kcs } : {}),
          ...(next.min_bnb !== undefined ? { requires_bnb: next.min_bnb } : {}),
          annual_fee_current: round2(annualTradingFeeUsd * fxRate),
          annual_fee_next_tier: round2(annualFeeNextUsd * fxRate),
          annual_savings: round2(savingsUsd * fxRate),
          hint,
        };
      }
    }
  }

  const tierWarning = buildTierWarning(lower, resolved, opts.tokenBalance, opts.accountAssetsUsd, lang);
  const staleWarning = freshnessWarning(lang);
  // v0.46: USDT-quoted pair for an EEA resident — schedule cost only.
  const scWarning = buildStablecoinWarning(
    restrictedQuoteAsset(opts.pair, country) ?? "",
    country,
    lang,
    "trading",
  );

  const annualTradingFee = round2(annualTradingFeeUsd * fxRate);
  const annualFunding = round2(annualFundingUsd * fxRate);
  const annualWithdrawal = round2(annualWithdrawalUsd * fxRate);
  const annualSpread = round2(annualSpreadUsd * fxRate);
  const annualSlippage = round2(annualSlippageUsd * fxRate);
  const annualFiatDeposit = round2(annualFiatDepositUsd * fxRate);
  const annualFiatCashout = round2(annualFiatCashoutUsd * fxRate);

  return {
    exchange: lower,
    purpose,
    tier: resolved.tier,
    ...(resolved.volume_tier !== resolved.tier ? { volume_tier: resolved.volume_tier } : {}),
    monthly_volume_usd: monthlyVolumeUsd,
    annual_trading_fee: annualTradingFee,
    annual_funding_cost: annualFunding,
    ...(fundingSource ? { funding_source: fundingSource } : {}),
    ...(fundingRateTs ? { funding_rate_ts: fundingRateTs } : {}),
    ...(fundingSource === "live" && opts.fundingPair
      ? { funding_pair: normalizeFundingPair(opts.fundingPair) }
      : {}),
    ...(opts.tradeSizeUsd ? { annual_spread_cost: annualSpread } : {}),
    ...(opts.tradeSizeUsd && annualSlippage !== 0 ? { annual_slippage_cost: annualSlippage } : {}),
    ...(spreadSource ? { spread_source: spreadSource } : {}),
    ...(spreadTs ? { spread_ts: spreadTs } : {}),
    ...(spreadSource === "live" && (opts.spreadPair ?? opts.pair)
      ? { spread_pair: normalizeFundingPair(opts.spreadPair ?? opts.pair) }
      : {}),
    annual_withdrawal_cost: annualWithdrawal,
    ...(fiatDepositsPerYear > 0
      ? {
          annual_fiat_deposit_cost: annualFiatDeposit,
          fiat_deposit_available: depositAvailable,
          ...(depositMethod ? { fiat_deposit_method: depositMethod } : {}),
        }
      : {}),
    ...(fiatCashoutsPerYear > 0
      ? {
          annual_fiat_cashout_cost: annualFiatCashout,
          fiat_cashout_available: cashoutAvailable,
          ...(cashoutMethod ? { fiat_cashout_method: cashoutMethod } : {}),
        }
      : {}),
    annual_total_cost: round2(
      annualTradingFee +
        annualFunding +
        annualWithdrawal +
        annualSpread +
        annualSlippage +
        annualFiatDeposit +
        annualFiatCashout,
    ),
    ...(withdrawalsPerYear > 0 ? { withdrawals_per_year: withdrawalsPerYear } : {}),
    ...(fiatDepositsPerYear > 0 ? { fiat_deposits_per_year: fiatDepositsPerYear } : {}),
    ...(fiatCashoutsPerYear > 0 ? { fiat_cashouts_per_year: fiatCashoutsPerYear } : {}),
    ...(ms > 0 ? { maker_share: ms } : {}),
    ...(currency !== "USD" ? { currency } : {}),
    ...(tierWarning ? { tier_warning: tierWarning } : {}),
    ...(staleWarning ? { freshness_warning: staleWarning } : {}),
    data_as_of: dataAsOf(),
    ...(upgrade ? { upgrade } : {}),
    ...(referral ? { referral_url: referral.url } : {}),
    pricing_basis: pricingBasis,
    ...(pairNote ? { pair_note: pairNote } : {}),
    ...(spotClassNote(lower, purpose) ? { spot_class_note: spotClassNote(lower, purpose) } : {}),
    ...(exchangeNotes(lower) ? { exchange_notes: exchangeNotes(lower) } : {}),
    ...(scWarning ? { stablecoin_warning: scWarning } : {}),
  };
}

// v0.15: inspect funding rates — bundled long-run averages or real-time rates
// fetched venue-by-venue (each failure degrades to bundled and is reported).
export async function getFundingRates(
  opts: {
    fundingMode?: FundingMode;
    fundingPair?: string;
    exchanges?: string[];
    country?: string;
  } = {},
  deps?: LiveDeps,
): Promise<FundingRatesToolResult | ToolError> {
  const mode: FundingMode = opts.fundingMode === "live" ? "live" : "bundled";
  const pair = normalizeFundingPair(opts.fundingPair);
  const supported = listSupportedExchanges();

  let exchanges = supported;
  if (opts.exchanges && opts.exchanges.length > 0) {
    const requested = opts.exchanges.map((e) => e.toLowerCase());
    const unknown = requested.filter((e) => !supported.includes(e));
    if (unknown.length > 0) {
      return makeError(`Exchange(s) not supported: ${unknown.join(", ")}`, {
        code: "UNKNOWN_EXCHANGE",
        suggested_action: `Supported exchanges: ${supported.join(", ")}.`,
      });
    }
    exchanges = requested;
  }
  if (opts.country) {
    // Funding rates are a perp/futures-only data point, so country-level
    // product gating applies on the futures purpose (v0.38 Bitstamp perps).
    exchanges = exchanges.filter((e) => isVenueUsableFor(e, opts.country as string, "futures"));
  }

  const dataAsOfFunding = getBundledFundingRatesData().last_verified;

  if (mode === "bundled") {
    const rates: FundingRateEntry[] = [];
    for (const exchange of exchanges) {
      const bundled = getFundingRate(exchange);
      if (!bundled) continue;
      rates.push({
        exchange,
        rate_pct: bundled.avg_rate_pct,
        interval_hours: bundled.interval_hours,
        source: "bundled",
        note: bundled.description,
      });
    }
    return {
      pair,
      mode,
      fetched_at: new Date().toISOString(),
      data_as_of: dataAsOfFunding,
      rates,
      failures: [],
    };
  }

  // Only fetch venues with bundled funding data: spot-only venues (e.g. no perps)
  // would otherwise surface a pointless failures[] entry with no bundled fallback.
  const fetchable = exchanges.filter((e) => getFundingRate(e));
  const live = await fetchFundingRatesLive(fetchable, { pair, deps });
  const rates: FundingRateEntry[] = [];
  for (const exchange of exchanges) {
    const ov = live.rates[exchange];
    if (!ov) continue;
    rates.push({
      exchange,
      rate_pct: ov.rate_pct,
      interval_hours: ov.interval_hours,
      source: ov.source,
      ...(ov.timestamp ? { funding_timestamp: ov.timestamp } : {}),
      pair: live.pair,
      ...(ov.source === "bundled" ? { note: getFundingRate(exchange)?.description } : {}),
    });
  }
  return {
    pair: live.pair,
    mode,
    fetched_at: live.fetched_at,
    data_as_of: dataAsOfFunding,
    rates,
    failures: live.failures,
  };
}

// v0.16: inspect one-way execution cost (bid-ask crossing + order-book slippage)
// for a specific order size — bundled half-spread estimates or live book walks.
export async function getExecutionCost(
  opts: {
    spreadMode?: SpreadMode;
    pair?: string;
    purpose?: TradingPurpose;
    side?: "buy" | "sell";
    tradeSizeUsd?: number;
    exchanges?: string[];
    country?: string;
    /** v0.46: language of the stablecoin regional warning. */
    language?: Lang;
  } = {},
  deps?: LiveDeps,
): Promise<ExecutionCostResult | ToolError> {
  const mode: SpreadMode = opts.spreadMode === "live" ? "live" : "bundled";
  const pair = normalizeFundingPair(opts.pair);
  const lang = pickLang(opts.language);
  // v0.46: USDT-quoted execution estimate for an EEA resident is schedule-only.
  const scWarning = buildStablecoinWarning(
    restrictedQuoteAsset(pair, opts.country) ?? "",
    opts.country?.toUpperCase(),
    lang,
    "trading",
  );
  const purpose: TradingPurpose = opts.purpose ?? "futures";
  const side: "buy" | "sell" = opts.side ?? "buy";
  const tradeSizeUsd =
    opts.tradeSizeUsd && opts.tradeSizeUsd > 0 ? opts.tradeSizeUsd : 10000;
  const supported = listSupportedExchanges();
  const base = pair.split("/")[0];

  let exchanges = supported;
  if (opts.exchanges && opts.exchanges.length > 0) {
    const requested = opts.exchanges.map((e) => e.toLowerCase());
    const unknown = requested.filter((e) => !supported.includes(e));
    if (unknown.length > 0) {
      return makeError(`Exchange(s) not supported: ${unknown.join(", ")}`, {
        code: "UNKNOWN_EXCHANGE",
        suggested_action: `Supported exchanges: ${supported.join(", ")}.`,
      });
    }
    exchanges = requested;
  }
  if (opts.country) {
    exchanges = exchanges.filter((e) => isVenueUsableFor(e, opts.country as string, purpose));
  }
  // Spot-only venues (e.g. Coinbase) must not appear in futures execution-cost
  // comparisons (and vice versa, if a futures-only venue ever appears).
  exchanges = exchanges.filter((e) => resolveFeeRate(e, purpose, 0) !== null);

  const dataAsOfSpread = getSpreadBaseline().last_verified;

  const entryFromOverride = (exchange: string, ov: NonNullable<ReturnType<typeof bundledExecutionOverride>>): ExecutionCostEntry => {
    const est = getSpreadEstimate(exchange, base);
    return {
      exchange,
      spread_bps: ov.source === "live" ? round(ov.crossing_bps * 2, 4) : (est?.full_spread_bps ?? ov.crossing_bps * 2),
      crossing_bps: ov.crossing_bps,
      slippage_bps: ov.slippage_bps,
      total_bps: ov.total_bps,
      cost_usd: round2((tradeSizeUsd * ov.total_bps) / 1e4),
      ...(ov.levels_consumed !== undefined ? { levels_consumed: ov.levels_consumed } : {}),
      ...(ov.fully_filled !== undefined ? { fully_filled: ov.fully_filled } : {}),
      source: ov.source,
      ...(ov.timestamp ? { book_timestamp: ov.timestamp } : {}),
      ...(ov.symbol ? { symbol: ov.symbol } : {}),
      ...(est ? { pair_class: est.pair_class } : {}),
      ...(ov.source === "bundled" && est?.note ? { note: est.note } : {}),
    };
  };

  if (mode === "bundled") {
    const costs: ExecutionCostEntry[] = [];
    for (const exchange of exchanges) {
      const ov = bundledExecutionOverride(exchange, base);
      if (ov) costs.push(entryFromOverride(exchange, ov));
    }
    return {
      pair,
      purpose,
      side,
      trade_size_usd: tradeSizeUsd,
      mode,
      fetched_at: new Date().toISOString(),
      data_as_of: dataAsOfSpread,
      costs,
      failures: [],
      ...(scWarning ? { stablecoin_warning: scWarning } : {}),
    };
  }

  const live = await fetchExecutionCostLive(exchanges, { pair, purpose, side, tradeSizeUsd, deps });
  const costs: ExecutionCostEntry[] = [];
  for (const exchange of exchanges) {
    const ov = live.costs[exchange];
    if (ov) costs.push(entryFromOverride(exchange, ov));
  }
  return {
    pair: live.pair,
    purpose: live.purpose,
    side: live.side,
    trade_size_usd: live.trade_size_usd,
    mode,
    fetched_at: live.fetched_at,
    data_as_of: dataAsOfSpread,
    costs,
    failures: live.failures,
    ...(live.warnings.length > 0 ? { warnings: live.warnings } : {}),
    ...(scWarning ? { stablecoin_warning: scWarning } : {}),
  };
}

// =====================================================================
// v0.17: fiat on/off-ramp cost (direct exchange-operated bank/card rails)
// =====================================================================

const FIAT_CURRENCIES: FiatCurrency[] = ["USD", "EUR", "GBP", "BRL"];

function calcFiatFee(shape: FiatFeeShape, amount: number): number {
  let fee = ((shape.pct ?? 0) / 100) * amount + (shape.fixed ?? 0);
  if (shape.min !== undefined) fee = Math.max(fee, shape.min);
  if (shape.max !== undefined) fee = Math.min(fee, shape.max);
  return round2(fee);
}

export function getFiatCost(
  opts: {
    direction?: FiatDirection;
    amount?: number;
    amountUsd?: number;
    currency?: string;
    country?: string;
    exchanges?: string[];
    method?: FiatMethod;
    /** v0.30: "en" (default) or "zh" — language of advice/warnings narrative. */
    language?: Lang;
  } = {},
): FiatCostResult | ToolError {
  const lang = pickLang(opts.language);
  const direction: FiatDirection = opts.direction === "withdraw" ? "withdraw" : "deposit";
  const currency = (opts.currency ?? "USD").toUpperCase() as FiatCurrency;
  if (!FIAT_CURRENCIES.includes(currency)) {
    return makeError(`Unsupported fiat currency '${opts.currency}'.`, {
      code: "INVALID_CURRENCY",
      suggested_action: `Supported currencies: ${FIAT_CURRENCIES.join(", ")}.`,
    });
  }
  if (opts.amount !== undefined && opts.amountUsd !== undefined) {
    return makeError("Provide either amount (in fiat) or amountUsd, not both.", {
      code: "INVALID_AMOUNT",
    });
  }
  if (
    (opts.amount !== undefined && opts.amount <= 0) ||
    (opts.amountUsd !== undefined && opts.amountUsd <= 0)
  ) {
    return makeError("Amount must be positive.", { code: "INVALID_AMOUNT" });
  }

  const fx = getFxRate(currency);
  if (!fx) {
    return makeError(`No display FX rate configured for ${currency}.`, { code: "MISSING_FX_RATE" });
  }
  const amount =
    opts.amountUsd !== undefined ? round2(opts.amountUsd * fx) : (opts.amount ?? 1000);
  const amountUsd = round2(amount / fx);

  const data = getFiatRoutes();
  const countryUpper = opts.country?.toUpperCase();
  const regionOf = (cc: string): FiatRegion | undefined =>
    (Object.keys(data.regions) as FiatRegion[]).find((r) => data.regions[r].includes(cc));
  const countryRegion = countryUpper ? regionOf(countryUpper) : undefined;

  const supported = listSupportedExchanges();
  let exchanges = supported;
  if (opts.exchanges && opts.exchanges.length > 0) {
    const requested = opts.exchanges.map((e) => e.toLowerCase());
    const unknown = requested.filter((e) => !supported.includes(e));
    if (unknown.length > 0) {
      return makeError(`Exchange(s) not supported: ${unknown.join(", ")}`, {
        code: "UNKNOWN_EXCHANGE",
        suggested_action: `Supported exchanges: ${supported.join(", ")}.`,
      });
    }
    exchanges = requested;
  }
  if (countryUpper) {
    exchanges = exchanges.filter((e) => isExchangeAllowed(e, countryUpper));
  }

  const warnings: string[] = [];
  const quotes: FiatExchangeQuote[] = [];

  for (const exchange of exchanges) {
    const book = data.exchanges[exchange];
    if (!book || book.routes.length === 0) {
      quotes.push({ exchange, available: false, routes: [] });
      continue;
    }

    const routeQuotes: FiatRouteQuote[] = [];
    for (const route of book.routes as FiatRoute[]) {
      if (!route.currencies.includes(currency)) continue;
      if (opts.method && route.method !== opts.method) continue;
      // With a country, drop rails locked to other regions. Without one, keep
      // region-tagged variants (e.g. Bybit EU vs non-EU cards) and label them.
      if (countryUpper && route.region && route.region !== countryRegion) continue;
      const shape = direction === "deposit" ? route.deposit : route.withdraw;
      if (!shape) continue;
      const fee = calcFiatFee(shape, amount);
      routeQuotes.push({
        method: route.method,
        ...(route.region ? { region: route.region } : {}),
        fee,
        fee_usd: round2(fee / fx),
        effective_pct: round((fee / amount) * 100, 3),
        net: round2(amount - fee),
        eta: route.eta,
        ...(route.note ? { note: route.note } : {}),
      });
    }

    if (routeQuotes.length === 0) {
      quotes.push({ exchange, available: false, routes: [], ...(book.notes ? { notes: book.notes } : {}) });
      continue;
    }
    routeQuotes.sort((a, b) => a.fee_usd - b.fee_usd);
    const cheapest = routeQuotes[0];
    quotes.push({
      exchange,
      available: true,
      routes: routeQuotes,
      cheapest_method: cheapest.method,
      cheapest_fee_usd: cheapest.fee_usd,
      ...(book.notes ? { notes: book.notes } : {}),
    });
  }

  const availableQuotes = quotes.filter((q) => q.available);
  const unavailableCount = quotes.length - availableQuotes.length;
  quotes.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return (a.cheapest_fee_usd ?? Number.POSITIVE_INFINITY) - (b.cheapest_fee_usd ?? Number.POSITIVE_INFINITY);
  });

  let best: FiatBestPick | null = null;
  let savingVsWorst: number | undefined;
  if (availableQuotes.length > 0) {
    const bestExchange = availableQuotes.reduce((m, q) =>
      (q.cheapest_fee_usd ?? Number.POSITIVE_INFINITY) < (m.cheapest_fee_usd ?? Number.POSITIVE_INFINITY) ? q : m,
    );
    const bestRoute = bestExchange.routes[0];
    best = {
      exchange: bestExchange.exchange,
      method: bestRoute.method,
      fee: bestRoute.fee,
      fee_usd: bestRoute.fee_usd,
      effective_pct: bestRoute.effective_pct,
      net: bestRoute.net,
    };
    const worstFee = Math.max(...availableQuotes.map((q) => q.cheapest_fee_usd ?? 0));
    if (worstFee > best.fee_usd) savingVsWorst = round2(worstFee - best.fee_usd);
  }

  if (unavailableCount > 0) {
    warnings.push(
      t(lang, "ft_unavailable", {
        n: unavailableCount,
        direction: t(lang, direction === "deposit" ? "s_ft_dir_deposit" : "s_ft_dir_withdraw"),
        currency,
        via: opts.method ? t(lang, "s_ft_via", { method: opts.method }) : "",
      }),
    );
  }
  if (!countryUpper && currency !== "USD") {
    warnings.push(t(lang, "ft_no_country"));
  }
  if (countryRegion && currency !== regionCurrency(countryRegion)) {
    warnings.push(
      t(lang, "ft_region_mismatch", {
        country: countryUpper,
        regionCur: regionCurrency(countryRegion),
        currency,
      }),
    );
  }

  const advice = buildFiatAdvice(direction, currency, amount, amountUsd, best, savingVsWorst, lang);

  return {
    direction,
    currency,
    amount,
    amount_usd: amountUsd,
    fx_rate: fx,
    fetched_at: new Date().toISOString(),
    data_as_of: data.last_verified,
    exchanges: quotes,
    best,
    ...(savingVsWorst !== undefined ? { saving_vs_worst_usd: savingVsWorst } : {}),
    advice,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function regionCurrency(region: FiatRegion): string {
  return { EU: "EUR", US: "USD", GB: "GBP", BR: "BRL" }[region];
}

// v0.26: sweep the cheapest direct-fiat rail for every exchange in one call
// (same shape analyzePersona uses) so compare/calc can fold fiat legs in.
function sweepFiatRails(
  direction: FiatDirection,
  amountUsd: number,
  currency: FiatCurrency,
  country: string,
  exchanges: string[],
  method?: FiatMethod,
): Map<string, { feeUsd: number; method: FiatMethod }> {
  const sink = new Map<string, { feeUsd: number; method: FiatMethod }>();
  const res = getFiatCost({
    direction,
    amountUsd,
    currency,
    country,
    exchanges,
    method,
  });
  if (isToolError(res)) return sink;
  for (const q of res.exchanges) {
    if (q.available && q.cheapest_fee_usd !== undefined && q.cheapest_method) {
      sink.set(q.exchange, { feeUsd: q.cheapest_fee_usd, method: q.cheapest_method });
    }
  }
  return sink;
}

function buildFiatAdvice(
  direction: FiatDirection,
  currency: string,
  amount: number,
  amountUsd: number,
  best: FiatBestPick | null,
  savingVsWorst: number | undefined,
  lang: Lang = "en",
): string {
  const dirNoun = t(lang, direction === "deposit" ? "s_ft_dir_deposit" : "s_ft_dir_withdraw");
  if (!best) {
    return t(lang, "ft_adv_none", { direction: dirNoun });
  }
  const leg = t(lang, direction === "deposit" ? "s_ft_leg_deposit" : "s_ft_leg_withdraw");
  const free = best.fee === 0;
  const saving =
    savingVsWorst !== undefined
      ? t(lang, "ft_adv_saving", { usd: `$${savingVsWorst}` })
      : "";
  if (free) {
    return t(lang, "ft_adv_free", {
      ex: best.exchange,
      method: best.method,
      direction: dirNoun,
      currency,
      amount,
      usd: `$${amountUsd}`,
      saving,
    });
  }
  return t(lang, "ft_adv_paid", {
    leg,
    ex: best.exchange,
    method: best.method,
    fee: best.fee,
    currency,
    usd: `$${best.fee_usd}`,
    pct: best.effective_pct,
    amount,
    net: best.net,
    saving,
  });
}

// ---------- v0.22: trader persona analysis ----------

export function listPersonas(): TraderPersona[] {
  return getPersonas().personas;
}

/**
 * v0.25: Compute a concise native-token discount payback hint for a venue.
 * Returns null when the venue has no native-token discount on this purpose.
 * Reuses analyzeTokenDiscount's proven tier/payback math.
 */
function buildTokenDiscountHint(
  exchange: string,
  country: string,
  purpose: TradingPurpose,
  monthlyVolumeUsd: number,
  makerShare: number,
  accountAssetsUsd?: number,
): PersonaTokenDiscountHint | null {
  const td = getTokenDiscount(exchange);
  if (!td) return null;
  const hasNativeDiscount =
    (purpose === "spot" ? (td.spot_discount_pct ?? 0) : (td.futures_discount_pct ?? 0)) > 0 ||
    !!td.futures_maker_to_zero ||
    (!!td.holding_tiers && td.holding_tiers.length > 0);
  if (!hasNativeDiscount) return null;

  const result = analyzeTokenDiscount(exchange, country, purpose, monthlyVolumeUsd, {
    makerShare,
    accountAssetsUsd,
  });
  if (isToolError(result) || !result.has_native_discount) return null;

  const tiers = result.tiers_analysis;
  const recIdx = result.recommended_tier_index;
  if (!tiers || recIdx === null || recIdx === undefined || recIdx >= tiers.length) return null;

  const tier = tiers[recIdx];
  if (tier.annual_saving_usd <= 0) return null;

  const isFlat = tier.min_balance === 0 && !(td.holding_tiers && td.holding_tiers.length > 0);

  return {
    token: result.token,
    discount_pct: tier.discount_pct,
    annual_saving_usd: tier.annual_saving_usd,
    payback_months: tier.payback_months,
    holding_cost_usd: tier.holding_cost_usd,
    is_flat: isFlat,
  };
}

export function analyzePersona(
  personaId: string,
  country: string,
  opts: {
    monthlyVolumeUsd?: number;
    makerShare?: number;
    useToken?: boolean;
    tokenBalance?: number;
    accountAssetsUsd?: number;
    holdingHours?: number;
    tradeSizeUsd?: number;
    pair?: string;
    currency?: string;
    fundingRates?: FundingOverrides;
    fundingPair?: string;
    spreadRates?: SpreadOverrides;
    spreadPair?: string;
    /** v0.30: "en" (default) or "zh" — language of warnings/reasons/advice narrative. */
    language?: Lang;
  } = {},
): PersonaAnalysisResult | ToolError {
  let persona: TraderPersona | undefined;
  try {
    persona = getPersonas().personas.find((p) => p.id === personaId.toLowerCase());
  } catch (err) {
    return makeError(`Failed to load persona data: ${err instanceof Error ? err.message : String(err)}`, {
      code: "DATA_LOAD_FAILED",
      retryable: true,
      suggested_action: "Check the personas.json file path and permissions.",
    });
  }
  if (!persona) {
    let available: string[] = [];
    try {
      available = getPersonas().personas.map((p) => p.id);
    } catch {
      // fall through with an empty list
    }
    return makeError(`Unknown persona '${personaId}'.`, {
      code: "INVALID_INPUT",
      suggested_action: `Available personas: ${available.join(", ")}.`,
    });
  }

  const cur = resolveCurrency(opts.currency);
  if (isToolError(cur)) return cur;
  const [currency, fxRate] = cur;
  const cc = country.toUpperCase();
  const lang = pickLang(opts.language);

  // Persona presets are defaults; explicit caller inputs always win.
  const monthlyVolumeUsd = opts.monthlyVolumeUsd ?? persona.monthly_volume_usd;
  const makerShare = opts.makerShare ?? persona.maker_share;
  const useToken = opts.useToken ?? persona.use_token ?? false;
  const tokenBalance = opts.tokenBalance;
  const accountAssetsUsd = opts.accountAssetsUsd ?? persona.account_assets_usd;
  const holdingHours = opts.holdingHours ?? persona.holding_hours;
  const tradeSizeUsd = opts.tradeSizeUsd ?? persona.trade_size_usd;
  const pair = opts.pair ?? persona.pair;
  const withdrawalAsset = persona.withdrawal_asset;
  const withdrawalsPerYear = persona.withdrawals_per_year ?? 0;
  const depositsPerYear = persona.fiat?.deposits_per_year ?? 0;
  const depositAmountUsd = persona.fiat?.deposit_amount_usd;
  const cashoutsPerYear = persona.fiat?.cashouts_per_year ?? 0;
  const cashoutAmountUsd = persona.fiat?.cashout_amount_usd;
  const fiatCurrency = persona.fiat?.currency ?? "USD";

  const warnings: string[] = [];
  const advice: string[] = [];

  // v0.46: a persona whose habitual withdrawal/quote asset is USDT run for an
  // EEA resident — every row carries the venue's regional access status.
  const scWarning = buildStablecoinWarning(
    withdrawalAsset && getStablecoinRegionRestriction(withdrawalAsset, cc)
      ? withdrawalAsset
      : (restrictedQuoteAsset(pair, cc) ?? ""),
    cc,
    lang,
    "persona",
  );

  // One offline withdrawal-fee sweep for every allowed venue (needed to detect
  // venues with NO open route for the persona's asset — calculateAnnualCost
  // prices a missing route as 0, which would be a false "free" signal).
  const allowed = listSupportedExchanges().filter((e) => isExchangeAllowed(e, cc));
  let withdrawalQuotes = new Map<string, { supported: boolean; cheapestFeeUsd?: number }>();
  if (withdrawalAsset && withdrawalsPerYear > 0) {
    const wd = getWithdrawalCost({ asset: withdrawalAsset, country: cc, exchanges: allowed });
    if (!isToolError(wd)) {
      withdrawalQuotes = new Map(
        wd.exchanges.map((q) => [
          q.exchange,
          { supported: q.supported, cheapestFeeUsd: q.cheapest_fee_usd },
        ]),
      );
    }
  }

  // One offline fiat sweep per direction; missing rails are flags, never zero costs.
  const fiatDeposit = new Map<string, { feeUsd: number; method: FiatMethod }>();
  const fiatCashout = new Map<string, { feeUsd: number; method: FiatMethod }>();
  const noDepositRail: string[] = [];
  const noCashoutRail: string[] = [];
  const sweepFiat = (
    direction: FiatDirection,
    amountUsd: number | undefined,
    perYear: number,
    sink: Map<string, { feeUsd: number; method: FiatMethod }>,
    missing: string[],
  ) => {
    if (perYear <= 0 || !amountUsd) return;
    const res = getFiatCost({
      direction,
      amountUsd,
      currency: fiatCurrency,
      country: cc,
      exchanges: allowed,
      method: persona?.fiat?.method,
    });
    if (isToolError(res)) return;
    for (const q of res.exchanges) {
      if (q.available && q.cheapest_fee_usd !== undefined && q.cheapest_method) {
        sink.set(q.exchange, { feeUsd: q.cheapest_fee_usd * perYear, method: q.cheapest_method });
      } else {
        missing.push(q.exchange);
      }
    }
  };
  sweepFiat("deposit", depositAmountUsd, depositsPerYear, fiatDeposit, noDepositRail);
  sweepFiat("withdraw", cashoutAmountUsd, cashoutsPerYear, fiatCashout, noCashoutRail);

  const rawAnnual = new Map<string, AnnualCostResult>();
  const rows: PersonaCostRow[] = [];

  for (const exchange of allowed) {
    const annual = calculateAnnualCost(exchange, persona.purpose, cc, monthlyVolumeUsd, {
      makerShare,
      useToken,
      tokenBalance,
      accountAssetsUsd,
      holdingHours,
      withdrawalAsset,
      withdrawalsPerYear,
      currency: opts.currency,
      pair,
      fundingRates: opts.fundingRates,
      fundingPair: opts.fundingPair,
      tradeSizeUsd,
      spreadRates: opts.spreadRates,
      spreadPair: opts.spreadPair,
      language: lang,
    });
    if (isToolError(annual)) continue; // e.g. Coinbase has no futures ladder
    rawAnnual.set(exchange, annual);

    const execution = (annual.annual_spread_cost ?? 0) + (annual.annual_slippage_cost ?? 0);

    // Withdrawal: use the sweep quote so unsupported routes are flagged, not free.
    let withdrawalCost = 0;
    let withdrawalSupported = true;
    const wq = withdrawalQuotes.get(exchange);
    if (withdrawalAsset && withdrawalsPerYear > 0) {
      if (wq && wq.supported && wq.cheapestFeeUsd !== undefined) {
        withdrawalCost = round2(wq.cheapestFeeUsd * withdrawalsPerYear * fxRate);
      } else {
        withdrawalSupported = false;
      }
    }

    const dep = fiatDeposit.get(exchange);
    const co = fiatCashout.get(exchange);
    const fiatCost = round2(((dep?.feeUsd ?? 0) + (co?.feeUsd ?? 0)) * fxRate);

    const allIn = round2(
      annual.annual_trading_fee +
        annual.annual_funding_cost +
        execution +
        withdrawalCost +
        fiatCost,
    );

    const mixBase = allIn > 0 ? allIn : 1;
    const costMix = {
      trading_fee: Math.round((annual.annual_trading_fee / mixBase) * 1000) / 10,
      funding: Math.round((annual.annual_funding_cost / mixBase) * 1000) / 10,
      execution: Math.round((execution / mixBase) * 1000) / 10,
      withdrawal: Math.round((withdrawalCost / mixBase) * 1000) / 10,
      fiat: Math.round((fiatCost / mixBase) * 1000) / 10,
    };

    rows.push({
      exchange,
      tier: annual.tier,
      ...(annual.volume_tier ? { volume_tier: annual.volume_tier } : {}),
      annual_trading_fee: annual.annual_trading_fee,
      annual_funding_cost: annual.annual_funding_cost,
      ...(tradeSizeUsd ? { annual_execution_cost: round2(execution) } : {}),
      annual_withdrawal_cost: withdrawalCost,
      ...(depositsPerYear > 0
        ? {
            annual_fiat_deposit_cost: round2((dep?.feeUsd ?? 0) * fxRate),
            fiat_deposit_available: !!dep,
            ...(dep ? { fiat_deposit_method: dep.method } : {}),
          }
        : {}),
      ...(cashoutsPerYear > 0
        ? {
            annual_fiat_cashout_cost: round2((co?.feeUsd ?? 0) * fxRate),
            fiat_cashout_available: !!co,
            ...(co ? { fiat_cashout_method: co.method } : {}),
          }
        : {}),
      annual_all_in: allIn,
      cost_mix_pct: costMix,
      ...(annual.referral_url ? { referral_url: annual.referral_url } : {}),
      pricing_basis: annual.pricing_basis,
      ...(annual.tier_warning ? { tier_warning: annual.tier_warning } : {}),
      ...(annual.freshness_warning ? { freshness_warning: annual.freshness_warning } : {}),
      ...(annual.exchange_notes ? { exchange_notes: annual.exchange_notes } : {}),
      ...(!withdrawalSupported ? { withdrawal_unsupported: true } : {}),
      ...(scWarning
        ? (() => {
            const scAccess = venueStablecoinAccess(scWarning.asset, exchange, cc);
            return scAccess ? { stablecoin_access: scAccess } : {};
          })()
        : {}),
    } as PersonaCostRow);
  }

  rows.sort((a, b) => a.annual_all_in - b.annual_all_in);

  // v0.25: token-discount payback hints. Only when the persona ran WITHOUT the
  // native-token toggle (useToken=false) — otherwise the discount is already
  // priced into the row. Limit to the top 3 ranked venues to keep output tight.
  const tokenDiscountHints: Array<{ exchange: string } & PersonaTokenDiscountHint> = [];
  if (!useToken) {
    for (const r of rows.slice(0, 3)) {
      const hint = buildTokenDiscountHint(
        r.exchange,
        cc,
        persona.purpose,
        monthlyVolumeUsd,
        makerShare,
        accountAssetsUsd,
      );
      if (hint) {
        r.token_discount_hint = hint;
        tokenDiscountHints.push({ exchange: r.exchange, ...hint });
      }
    }
  }

  if (rows.length === 0) {
    return makeError(`No exchanges with fee data are available in ${cc}.`, {
      code: "NO_RESULTS",
      suggested_action: "Try another country code.",
    });
  }

  // Component leaders across the ranked rows. Pickers return undefined for rows
  // where the component cannot be priced (missing rail / unsupported route),
  // so an unmodeled leg can never win a "cheapest" leadership.
  const leader = (pick: (r: PersonaCostRow) => number | undefined): PersonaComponentLeader | undefined => {
    let bestRow: PersonaCostRow | undefined;
    let bestVal = Number.POSITIVE_INFINITY;
    for (const r of rows) {
      const v = pick(r);
      if (v === undefined) continue;
      if (v < bestVal) {
        bestVal = v;
        bestRow = r;
      }
    }
    return bestRow ? { exchange: bestRow.exchange, annual_cost: round2(bestVal) } : undefined;
  };
  const componentLeaders: PersonaAnalysisResult["component_leaders"] = {
    trading_fee: leader((r) => r.annual_trading_fee),
    ...(persona.purpose === "futures" && (holdingHours ?? 0) > 0
      ? { funding: leader((r) => r.annual_funding_cost) }
      : {}),
    ...(tradeSizeUsd ? { execution: leader((r) => r.annual_execution_cost) } : {}),
    ...(withdrawalAsset && withdrawalsPerYear > 0
      ? {
          withdrawal: leader((r) => (r.withdrawal_unsupported ? undefined : r.annual_withdrawal_cost)),
        }
      : {}),
    ...(depositsPerYear + cashoutsPerYear > 0
      ? {
          fiat: leader((r) => {
            const hasRail =
              (depositsPerYear === 0 || r.fiat_deposit_available) &&
              (cashoutsPerYear === 0 || r.fiat_cashout_available);
            if (!hasRail) return undefined;
            return (r.annual_fiat_deposit_cost ?? 0) + (r.annual_fiat_cashout_cost ?? 0);
          }),
        }
      : {}),
  };

  // Warnings for unmodeled legs (missing data is never silently treated as free).
  if (noDepositRail.length > 0) {
    warnings.push(
      t(lang, "pe_warn_no_deposit", {
        names: noDepositRail.map((e) => EX_DISPLAY_NAMES[e] ?? e).join(", "),
        cur: fiatCurrency,
        cc,
      }),
    );
  }
  if (noCashoutRail.length > 0) {
    warnings.push(
      t(lang, "pe_warn_no_cashout", {
        names: noCashoutRail.map((e) => EX_DISPLAY_NAMES[e] ?? e).join(", "),
        cur: fiatCurrency,
        cc,
      }),
    );
  }
  const noWithdrawal = rows
    .filter((r) => r.withdrawal_unsupported)
    .map((r) => EX_DISPLAY_NAMES[r.exchange] ?? r.exchange);
  if (noWithdrawal.length > 0) {
    warnings.push(
      t(lang, "pe_warn_no_wd", { names: noWithdrawal.join(", "), asset: withdrawalAsset }),
    );
  }
  if (persona.purpose === "futures") {
    const skippedSpotOnly = allowed.filter((e) => !rawAnnual.has(e));
    if (skippedSpotOnly.length > 0) {
      warnings.push(
        t(lang, "pe_warn_spot_only", {
          names: skippedSpotOnly.map((e) => EX_DISPLAY_NAMES[e] ?? e).join(", "),
        }),
      );
    }
  }
  // v0.46: append-only (do not reorder the legacy warnings above — tests index them).
  if (scWarning) {
    warnings.push(scWarning.message);
  }

  const winner = rows[0];
  const runnerUp = rows[1];
  const winnerRaw = rawAnnual.get(winner.exchange);
  const money = (n: number) => (currency === "USD" ? formatUsd(n) : `${Math.round(n).toLocaleString("en-US")} ${currency}`);

  let best: PersonaAnalysisResult["best"] = null;
  if (runnerUp) {
    const reasons: string[] = [
      t(lang, "pe_reason_lowest", { amt: money(winner.annual_all_in), tier: winner.tier }),
    ];
    const tradeoffs: string[] = [];
    for (const key of persona.dominant_costs) {
      const l = componentLeaders[key as keyof typeof componentLeaders];
      const label = PERSONA_COST_LABELS[lang][key] ?? PERSONA_COST_LABELS.en[key] ?? key;
      // When the winner's leg for this component is unmodeled (no rail / no
      // route), the dedicated trade-off below already says so — skip a
      // misleading "$0/yr less" comparison here.
      const winnerLegMissing =
        (key === "withdrawal" && !!winner.withdrawal_unsupported) ||
        (key === "fiat" &&
          ((depositsPerYear > 0 && winner.fiat_deposit_available === false) ||
            (cashoutsPerYear > 0 && winner.fiat_cashout_available === false)));
      if (winnerLegMissing) continue;
      const winnerVal =
        key === "trading_fee"
          ? winner.annual_trading_fee
          : key === "funding"
            ? winner.annual_funding_cost
            : key === "execution"
              ? winner.annual_execution_cost
              : key === "withdrawal"
                ? winner.annual_withdrawal_cost
                : (winner.annual_fiat_deposit_cost ?? 0) + (winner.annual_fiat_cashout_cost ?? 0);
      if (l && l.exchange === winner.exchange) {
        reasons.push(t(lang, "pe_reason_dominant", { label, amt: money(l.annual_cost) }));
      } else if (l && winnerVal !== undefined && round2(winnerVal - l.annual_cost) > 0) {
        tradeoffs.push(
          t(lang, "pe_to_leg", {
            label,
            ex: EX_DISPLAY_NAMES[l.exchange] ?? l.exchange,
            amt: money(l.annual_cost),
            amt2: money(Math.max(winnerVal - l.annual_cost, 0)),
          }),
        );
      }
    }
    if (winner.referral_url) reasons.push(t(lang, "pe_reason_ref"));
    const winnerNoRail =
      (depositsPerYear > 0 && winner.fiat_deposit_available === false) ||
      (cashoutsPerYear > 0 && winner.fiat_cashout_available === false);
    if (winnerNoRail) {
      tradeoffs.push(t(lang, "pe_to_no_fiat", { cc }));
    }
    if (winner.withdrawal_unsupported) {
      tradeoffs.push(t(lang, "pe_to_no_wd", { asset: withdrawalAsset }));
    }
    best = {
      exchange: winner.exchange,
      tier: winner.tier,
      annual_all_in: winner.annual_all_in,
      runner_up_exchange: runnerUp.exchange,
      runner_up_annual_all_in: runnerUp.annual_all_in,
      saving_vs_runner_up: round2(runnerUp.annual_all_in - winner.annual_all_in),
      reasons,
      tradeoffs,
    };
  }

  // Cheapest venue with EVERY persona leg priced (open withdrawal route + direct
  // fiat rails where the persona needs them) — protects against a winner that
  // only wins because its missing legs were excluded.
  const needsWithdrawal = !!(withdrawalAsset && withdrawalsPerYear > 0);
  const needsFiat = depositsPerYear + cashoutsPerYear > 0;
  const fullyModeled = rows.filter(
    (r) =>
      (!needsWithdrawal || !r.withdrawal_unsupported) &&
      (!needsFiat ||
        (depositsPerYear === 0 || r.fiat_deposit_available === true) &&
          (cashoutsPerYear === 0 || r.fiat_cashout_available === true)),
  );
  const bestComplete: PersonaAnalysisResult["best_complete"] =
    fullyModeled.length > 0
      ? {
          exchange: fullyModeled[0].exchange,
          annual_all_in: fullyModeled[0].annual_all_in,
          extra_vs_winner: round2(fullyModeled[0].annual_all_in - winner.annual_all_in),
        }
      : null;

  // Tailored advice layer.
  const [nameA, nameB] =
    lang === "zh" ? [persona.name_zh, persona.name_en] : [persona.name_en, persona.name_zh];
  advice.push(
    t(lang, "pe_adv_head", {
      nameA,
      nameB,
      tagline: persona.tagline_zh,
      assumptions: persona.assumptions.join("；"),
    }),
  );
  if (best) {
    advice.push(
      t(lang, "pe_adv_best", {
        cc,
        ex: EX_DISPLAY_NAMES[best.exchange] ?? best.exchange,
        amt: money(best.annual_all_in),
        amt2: money(best.saving_vs_runner_up),
        ex2: EX_DISPLAY_NAMES[best.runner_up_exchange] ?? best.runner_up_exchange,
      }),
    );
    for (const to of best.tradeoffs) advice.push(t(lang, "pe_adv_to", { t: to }));
  }
  if (bestComplete && bestComplete.exchange !== winner.exchange) {
    advice.push(
      t(lang, "pe_adv_complete", {
        ex: EX_DISPLAY_NAMES[bestComplete.exchange] ?? bestComplete.exchange,
        amt: money(bestComplete.annual_all_in),
        amt2: money(bestComplete.extra_vs_winner),
      }),
    );
  }
  if (winnerRaw?.upgrade) {
    advice.push(
      t(lang, "pe_adv_upgrade", {
        ex: EX_DISPLAY_NAMES[winner.exchange] ?? winner.exchange,
        hint: winnerRaw.upgrade.hint,
      }),
    );
  }
  if (!useToken) {
    if (tokenDiscountHints.length > 0) {
      // Concrete, ranked token-discount opportunities for the top venues.
      const lines = tokenDiscountHints.map((h) => {
        const name = EX_DISPLAY_NAMES[h.exchange] ?? h.exchange;
        if (h.is_flat) {
          return t(lang, "pe_tok_flat", {
            ex: name,
            token: h.token,
            pct: h.discount_pct,
            amt: formatUsd(h.annual_saving_usd),
          });
        }
        const payback =
          h.payback_months !== null
            ? t(lang, "pe_tok_payback", { n: h.payback_months })
            : t(lang, "pe_tok_marginal");
        return t(lang, "pe_tok_tier", {
          ex: name,
          amt: formatUsd(h.holding_cost_usd),
          token: h.token,
          pct: h.discount_pct,
          amt2: formatUsd(h.annual_saving_usd),
          payback,
        });
      });
      advice.push(t(lang, "pe_tok_intro", { lines: lines.join("; ") }));
      advice.push(t(lang, "pe_tok_risk"));
    } else {
      advice.push(t(lang, "pe_tok_none"));
    }
  }
  if (persona.purpose === "futures" && (holdingHours ?? 0) > 0) {
    advice.push(t(lang, "pe_funding"));
  }
  if ((tradeSizeUsd ?? 0) >= 50000) {
    advice.push(t(lang, "pe_depth", { amt: money(tradeSizeUsd ?? 0) }));
  }
  advice.push(t(lang, "pe_presets"));

  const stale = freshnessWarning(lang);

  return {
    persona: {
      id: persona.id,
      name_en: persona.name_en,
      name_zh: persona.name_zh,
      tagline_zh: persona.tagline_zh,
      description_zh: persona.description_zh,
      assumptions: persona.assumptions,
      research_basis: persona.research_basis,
      dominant_costs: persona.dominant_costs,
    },
    country: cc,
    purpose: persona.purpose,
    inputs: {
      monthly_volume_usd: monthlyVolumeUsd,
      maker_share: clampShare(makerShare),
      use_token: useToken,
      ...(holdingHours !== undefined ? { holding_hours: holdingHours } : {}),
      ...(tradeSizeUsd !== undefined ? { trade_size_usd: tradeSizeUsd } : {}),
      ...(accountAssetsUsd !== undefined ? { account_assets_usd: accountAssetsUsd } : {}),
      ...(withdrawalAsset ? { withdrawal_asset: withdrawalAsset } : {}),
      ...(withdrawalsPerYear ? { withdrawals_per_year: withdrawalsPerYear } : {}),
      ...(depositsPerYear ? { fiat_deposits_per_year: depositsPerYear } : {}),
      ...(cashoutsPerYear ? { fiat_cashouts_per_year: cashoutsPerYear } : {}),
    },
    currency,
    ranking: rows,
    best,
    best_complete: bestComplete,
    component_leaders: componentLeaders,
    warnings,
    advice,
    data_as_of: dataAsOf(),
    data_sources: getPersonas().sources,
    ...(stale ? { freshness_warning: stale } : {}),
    ...(tokenDiscountHints.length > 0 ? { token_discount_hints: tokenDiscountHints } : {}),
    ...(scWarning ? { stablecoin_warning: scWarning } : {}),
  };
}

// ---------- v0.28: multi-persona batch comparison / decision matrix ----------

/**
 * Runs EVERY persona (or a requested subset) through analyzePersona for one
 * country and compacts the results into a "which venue for which trader" matrix:
 * per-persona winner + realistic all-legs pick + full venue row, plus cross-
 * persona venue win counts and the most versatile venue.
 */
export function comparePersonas(
  country: string,
  opts: {
    personas?: string[];
    useToken?: boolean;
    currency?: string;
    fundingRates?: FundingOverrides;
    fundingPair?: string;
    /** Pre-resolved spread overrides keyed by persona id (live books depend on each persona's purpose/clip). */
    spreadRatesByPersona?: Record<string, SpreadOverrides>;
    spreadPair?: string;
    /** v0.30: "en" (default) or "zh" — language of the inherited persona narrative. */
    language?: Lang;
    /** v0.36: attach a rendered matrix table (markdown/csv/both) to the JSON result. */
    format?: RenderFormat;
  } = {},
): PersonaComparisonResult | ToolError {
  const cc = country.toUpperCase();
  const badRender = invalidRenderOpts(opts.format, undefined, ["annual_all_in"]);
  if (badRender) return badRender;
  const allPersonas = getPersonas().personas;
  let selected: TraderPersona[] = allPersonas;
  if (opts.personas && opts.personas.length > 0) {
    const unknown = opts.personas
      .map((id) => id.toLowerCase())
      .filter((id) => !allPersonas.some((x) => x.id === id));
    if (unknown.length > 0) {
      return makeError(`Unknown persona(s): ${unknown.join(", ")}.`, {
        code: "INVALID_INPUT",
        suggested_action: `Available personas: ${allPersonas.map((x) => x.id).join(", ")}.`,
      });
    }
    // Preserve the caller's ordering and dedupe.
    selected = [...new Set(opts.personas.map((id) => id.toLowerCase()))]
      .map((id) => allPersonas.find((x) => x.id === id))
      .filter((p): p is TraderPersona => p !== undefined);
  }

  const errors: NonNullable<PersonaComparisonResult["errors"]> = [];
  const entries: PersonaComparisonEntry[] = [];
  const venueUnion = new Set<string>();

  for (const persona of selected) {
    const r = analyzePersona(persona.id, cc, {
      ...(opts.useToken !== undefined ? { useToken: opts.useToken } : {}),
      currency: opts.currency,
      fundingRates: opts.fundingRates,
      fundingPair: opts.fundingPair,
      spreadRates: opts.spreadRatesByPersona?.[persona.id],
      spreadPair: opts.spreadPair,
      language: opts.language,
    });
    if (isToolError(r)) {
      errors.push({
        persona: persona.id,
        ...((r as ToolError).code ? { code: (r as ToolError).code } : {}),
        error: (r as ToolError).error,
      });
      continue;
    }

    const winnerRow = r.ranking[0];
    const matrix = r.ranking.map((row) => {
      venueUnion.add(row.exchange);
      return {
        exchange: row.exchange,
        annual_all_in: row.annual_all_in,
        ...(row.withdrawal_unsupported ? { withdrawal_unsupported: true } : {}),
        ...(row.fiat_deposit_available !== undefined
          ? { fiat_deposit_available: row.fiat_deposit_available }
          : {}),
        ...(row.fiat_cashout_available !== undefined
          ? { fiat_cashout_available: row.fiat_cashout_available }
          : {}),
      };
    });

    entries.push({
      persona: {
        id: persona.id,
        name_en: persona.name_en,
        name_zh: persona.name_zh,
        tagline_zh: persona.tagline_zh,
      },
      purpose: persona.purpose,
      monthly_volume_usd: r.inputs.monthly_volume_usd,
      best:
        r.best && winnerRow
          ? {
              exchange: r.best.exchange,
              tier: r.best.tier,
              annual_all_in: r.best.annual_all_in,
              runner_up_exchange: r.best.runner_up_exchange,
              saving_vs_runner_up: r.best.saving_vs_runner_up,
              cost_mix_pct: winnerRow.cost_mix_pct,
              tradeoffs: r.best.tradeoffs,
            }
          : null,
      best_complete: r.best_complete ?? null,
      matrix,
    });
  }

  if (entries.length === 0) {
    return makeError(`No personas could be ranked in ${cc}.`, {
      code: "NO_RESULTS",
      suggested_action: "Check the country code or requested persona ids.",
    });
  }

  // Cross-persona win counts.
  const winMap = new Map<string, PersonaVenueWins>();
  for (const venue of venueUnion) {
    winMap.set(venue, {
      exchange: venue,
      headline_persona_ids: [],
      complete_persona_ids: [],
    });
  }
  for (const e of entries) {
    if (e.best) winMap.get(e.best.exchange)?.headline_persona_ids.push(e.persona.id);
    if (e.best_complete) winMap.get(e.best_complete.exchange)?.complete_persona_ids.push(e.persona.id);
  }
  const venueWins = [...winMap.values()]
    .filter(
      (w) => w.headline_persona_ids.length > 0 || w.complete_persona_ids.length > 0,
    )
    .sort(
      (a, b) =>
        b.complete_persona_ids.length - a.complete_persona_ids.length ||
        b.headline_persona_ids.length - a.headline_persona_ids.length ||
        a.exchange.localeCompare(b.exchange),
    );
  const mostVersatile =
    venueWins.length > 0 && venueWins[0].complete_persona_ids.length > 0
      ? venueWins[0].exchange
      : null;

  const result: PersonaComparisonResult = {
    country: cc,
    currency: opts.currency?.toUpperCase() ?? "USD",
    personas: entries,
    venues: [...venueUnion],
    venue_wins: venueWins,
    most_versatile: mostVersatile,
    data_as_of: dataAsOf(),
    data_sources: getPersonas().sources,
    ...(freshnessWarning(pickLang(opts.language))
      ? { freshness_warning: freshnessWarning(pickLang(opts.language)) }
      : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
  if (opts.format && opts.format !== "json") {
    result.rendered = renderTable("personas", result, opts.format, pickLang(opts.language));
  }
  return result;
}

export { isToolError };

// ---------- v0.23: native-token fee-discount payback analysis ----------

export function analyzeTokenDiscount(
  exchange: string,
  country: string,
  purpose: TradingPurpose,
  monthlyVolumeUsd: number,
  opts?: {
    makerShare?: number;
    tokenBalance?: number;
    accountAssetsUsd?: number;
    tokenPriceUsd?: number;
    currency?: string;
    /** v0.30: "en" (default) or "zh" — language of warnings/advice narrative. */
    language?: Lang;
  },
): TokenDiscountAnalysisResult | ToolError {
  const lang = pickLang(opts?.language);
  const lower = exchange.toLowerCase();
  if (!listSupportedExchanges().includes(lower)) {
    return makeError(`Unknown exchange: ${exchange}`, { code: "UNKNOWN_EXCHANGE", retryable: false });
  }
  if (!isExchangeAllowed(lower, country)) {
    return makeError(
      `${EX_DISPLAY_NAMES[lower] ?? lower} is not available to residents of ${country}.`,
      { code: "COUNTRY_BLOCKED", retryable: false },
    );
  }
  if (isProductBlockedInCountry(lower, purpose, country)) {
    return makeError(
      `${EX_DISPLAY_NAMES[lower] ?? lower} does not offer ${purpose} trading to residents of ${country}.`,
      { code: "PRODUCT_BLOCKED_IN_COUNTRY", retryable: false },
    );
  }
  if (monthlyVolumeUsd <= 0) {
    return makeError("monthlyVolumeUsd must be positive.", { code: "INVALID_INPUT", retryable: false });
  }

  const makerShare = Math.min(Math.max(opts?.makerShare ?? 0, 0), 1);
  const accountAssetsUsd = opts?.accountAssetsUsd;
  const currency = opts?.currency ?? "USD";

  const td = getTokenDiscount(lower);
  const token = td?.token ?? "N/A";
  const hasNativeDiscount =
    !!td &&
    ((purpose === "spot" ? (td.spot_discount_pct ?? 0) : (td.futures_discount_pct ?? 0)) > 0 ||
      !!td.futures_maker_to_zero ||
      (!!td.holding_tiers && td.holding_tiers.length > 0));

  const tokenPrice = opts?.tokenPriceUsd ?? getTokenPrice(token) ?? 0;

  // ---- BASE: zero native-token balance (no tier lift, no fee-deduction discount) ----
  const baseResolved = resolveFeeRate(lower, purpose, monthlyVolumeUsd, 0, accountAssetsUsd);
  if (!baseResolved) {
    return makeError(
      `${EX_DISPLAY_NAMES[lower] ?? lower} has no ${purpose} fee schedule.`,
      { code: "NO_RESULTS", retryable: false },
    );
  }
  const baseMaker = baseResolved.base_maker;
  const baseTaker = baseResolved.base_taker;
  const baseTier = baseResolved.tier;
  const baseBlended = weightedRate(baseMaker, baseTaker, makerShare);
  const annualBase = round2(((monthlyVolumeUsd * baseBlended) / 100) * 12);

  const warnings: string[] = [];
  const advice: string[] = [];

  // Build the list of candidate token balances to evaluate.
  // Tiered venues: each holding threshold (plus the 0-balance "no extra discount" level).
  // Flat-discount venues: a single synthetic level (min_balance 0, discount = flat rate).
  const candidateBalances: number[] = [];
  if (td?.holding_tiers && td.holding_tiers.length > 0) {
    candidateBalances.push(0);
    for (const h of td.holding_tiers) candidateBalances.push(h.min_balance);
  } else if (hasNativeDiscount) {
    candidateBalances.push(0);
  }

  // Compute effective blended rate + annual fee for a given token balance.
  function computeAtBalance(balance: number): {
    tier: string;
    makerRate: number;
    takerRate: number;
    blended: number;
    annualFee: number;
    discountPct: number;
  } {
    const res = resolveFeeRate(lower, purpose, monthlyVolumeUsd, balance, accountAssetsUsd);
    const m = res?.base_maker ?? baseMaker;
    const t = res?.base_taker ?? baseTaker;
    const dm = applyTokenDiscount(lower, purpose, m, true, true, balance).rate;
    const dt = applyTokenDiscount(lower, purpose, t, false, true, balance).rate;
    const blended = weightedRate(dm, dt, makerShare);
    const annualFee = round2(((monthlyVolumeUsd * blended) / 100) * 12);
    const discountPct = baseBlended > 0 ? (1 - blended / baseBlended) * 100 : 0;
    return { tier: res?.tier ?? baseTier, makerRate: dm, takerRate: dt, blended, annualFee, discountPct };
  }

  const tiersAnalysis: TokenDiscountTierAnalysis[] = [];
  for (const bal of candidateBalances) {
    const c = computeAtBalance(bal);
    const annualSaving = round2(annualBase - c.annualFee);
    // For flat-discount tiers (min_balance 0) the qualifying balance is the
    // token units needed to self-fund ~1 year of discounted fees, since any
    // positive balance unlocks the discount. Tiered venues use the real threshold.
    const qualifyingBalance =
      bal > 0 ? bal : tokenPrice > 0 ? Math.ceil((c.annualFee / tokenPrice) * 100) / 100 : 0;
    const holdingCost = round2(qualifyingBalance * tokenPrice);
    const paybackMonths = annualSaving > 0 ? round2((holdingCost / annualSaving) * 12) : null;
    const breakevenDrop =
      holdingCost > 0 ? round2((annualSaving / holdingCost) * 100) : null;
    tiersAnalysis.push({
      min_balance: bal,
      discount_pct: round(c.discountPct, 2),
      effective_rate: c.blended,
      annual_fee_usd: c.annualFee,
      annual_saving_usd: annualSaving,
      holding_cost_usd: holdingCost,
      payback_months: paybackMonths,
      breakeven_price_drop_pct: breakevenDrop,
    });
  }

  // Recommended tier: positive saving with the shortest payback; tie → lower holding cost.
  let recommendedIndex: number | null = null;
  {
    let bestPayback = Infinity;
    let bestCost = Infinity;
    tiersAnalysis.forEach((t, idx) => {
      if (t.annual_saving_usd > 0 && t.payback_months !== null) {
        if (t.payback_months < bestPayback || (t.payback_months === bestPayback && t.holding_cost_usd < bestCost)) {
          bestPayback = t.payback_months;
          bestCost = t.holding_cost_usd;
          recommendedIndex = idx;
        }
      }
    });
    if (recommendedIndex === null) recommendedIndex = null;
  }

  let discounted: TokenDiscountAnalysisResult["discounted"] | undefined;
  if (opts?.tokenBalance !== undefined) {
    const bal = opts.tokenBalance;
    const c = computeAtBalance(bal);
    const annualSaving = round2(annualBase - c.annualFee);
    const holdingCost = round2(bal * tokenPrice);
    discounted = {
      tier: c.tier,
      maker_rate: c.makerRate,
      taker_rate: c.takerRate,
      blended_rate: c.blended,
      discount_pct: round(c.discountPct, 2),
      annual_fee_usd: c.annualFee,
      annual_saving_usd: annualSaving,
      holding_cost_usd: holdingCost,
      payback_months: annualSaving > 0 ? round2((holdingCost / annualSaving) * 12) : null,
      breakeven_price_drop_pct: holdingCost > 0 ? round2((annualSaving / holdingCost) * 100) : null,
    };
  }

  // ---- Warnings & advice ----
  if (!hasNativeDiscount) {
    warnings.push(
      t(lang, "td_no_discount", {
        ex: EX_DISPLAY_NAMES[lower] ?? lower,
        purpose: t(lang, purpose === "spot" ? "s_purpose_spot" : "s_purpose_futures"),
        token,
      }),
    );
    if (lower === "okx") {
      advice.push(t(lang, "td_okx"));
    }
  }
  if (tokenPrice === 0) {
    warnings.push(t(lang, "td_no_price", { token }));
  }
  if (discounted) {
    if (discounted.annual_saving_usd <= 0) {
      advice.push(t(lang, "td_zero"));
    } else if (discounted.payback_months !== null) {
      advice.push(
        t(lang, "td_payback", {
          months: discounted.payback_months,
          amt: formatUsd(discounted.holding_cost_usd),
          token,
          pct: discounted.breakeven_price_drop_pct,
        }),
      );
    }
  } else if (recommendedIndex !== null && tiersAnalysis[recommendedIndex]) {
    const r = tiersAnalysis[recommendedIndex];
    advice.push(
      t(lang, "td_best_tier", {
        pct: r.discount_pct,
        bal: r.min_balance > 0
          ? t(lang, "td_bal_tier", { min: r.min_balance, token })
          : t(lang, "td_bal_flat", { token }),
        amt: formatUsd(r.annual_saving_usd),
        months: r.payback_months,
        amt2: formatUsd(r.holding_cost_usd),
      }),
    );
  }
  advice.push(t(lang, "td_risk"));
  if (td?.description) advice.push(t(lang, "td_terms", { token, desc: td.description }));

  const dataSources = [
    ...(getTokenDiscounts().sources ?? []),
    ...(getTokenPrices().sources ?? []),
    ...(getFeeRates().sources ?? []),
  ];

  return {
    exchange: lower,
    purpose,
    country,
    token,
    has_native_discount: hasNativeDiscount,
    token_price_usd: tokenPrice,
    currency,
    inputs: {
      monthly_volume_usd: monthlyVolumeUsd,
      maker_share: makerShare,
      ...(opts?.tokenBalance !== undefined ? { token_balance: opts.tokenBalance } : {}),
      ...(accountAssetsUsd !== undefined ? { account_assets_usd: accountAssetsUsd } : {}),
    },
    base: {
      tier: baseResolved.tier,
      maker_rate: baseMaker,
      taker_rate: baseTaker,
      blended_rate: baseBlended,
      annual_fee_usd: annualBase,
    },
    ...(discounted ? { discounted } : {}),
    ...(tiersAnalysis.length > 0 && opts?.tokenBalance === undefined
      ? { tiers_analysis: tiersAnalysis, recommended_tier_index: recommendedIndex }
      : {}),
    warnings,
    advice,
    data_as_of: dataAsOf(),
    data_sources: dataSources,
  };
}


// ---------------------------------------------------------------------------
// v0.34: volume what-if sweep — annual trading-fee cost across monthly-volume
// levels, VIP tier crossings, and "how much more volume unlocks the next rung".
// ---------------------------------------------------------------------------
const WHATIF_MAX_POINTS = 16;
const WHATIF_MAX_EXPLICIT_POINTS = 24;

interface WhatIfSnapInternal {
  tier: string;
  volume_tier?: string;
  maker: number;
  taker: number;
  weighted: number;
}

export function volumeWhatIf(
  purpose: TradingPurpose,
  country: string,
  opts: {
    volumes?: number[];
    baseVolume?: number;
    makerShare?: number;
    useToken?: boolean;
    tokenBalance?: number;
    accountAssetsUsd?: number;
    pair?: string;
    currency?: string;
    language?: Lang;
    maxPoints?: number;
    /** v0.36: attach a rendered sweep table (markdown/csv/both). */
    format?: RenderFormat;
    /** v0.36: table metric — weighted_fee_pct (default) | annual_fee_usd | tier. */
    tableMetric?: "weighted_fee_pct" | "annual_fee_usd" | "tier";
  } = {},
): VolumeWhatIfResult | ToolError {
  const lang = pickLang(opts.language);
  const cur = resolveCurrency(opts.currency);
  if (isToolError(cur)) return cur;
  const [currency] = cur;
  const badRender = invalidRenderOpts(opts.format, opts.tableMetric, [
    "weighted_fee_pct",
    "annual_fee_usd",
    "tier",
  ]);
  if (badRender) return badRender;
  const ms = opts.makerShare ?? 0.4;
  const useToken = opts.useToken ?? false;
  const maxPoints = Math.max(2, opts.maxPoints ?? WHATIF_MAX_POINTS);
  const baseVolume =
    opts.baseVolume !== undefined && Number.isFinite(opts.baseVolume) && opts.baseVolume > 0
      ? Math.round(opts.baseVolume)
      : undefined;

  if (opts.baseVolume !== undefined && baseVolume === undefined) {
    return makeError("baseVolume must be a finite positive number.", {
      code: "BAD_VOLUME",
      suggested_action: "Pass monthly volume in USD, e.g. 100000.",
    });
  }

  const allowed = listSupportedExchanges()
    .filter((e) => isVenueUsableFor(e, country, purpose))
    .filter((e) => resolveFeeRate(e, purpose, 0, opts.tokenBalance, opts.accountAssetsUsd) !== null);
  if (allowed.length === 0) {
    return makeError(
      `No supported exchanges available for country ${country.toUpperCase()} and purpose ${purpose}.`,
      {
        code: "NO_RESULTS",
        suggested_action: "Check country code or supported exchange list in README.",
      },
    );
  }

  const snapshotAt = (ex: string, vol: number): WhatIfSnapInternal => {
    const resolved = resolveFeeRate(ex, purpose, vol, opts.tokenBalance, opts.accountAssetsUsd);
    if (!resolved) throw new Error(`No fee tier for ${ex} at ${vol}`);
    applyPairOverride(ex, purpose, opts.pair, resolved);
    const referral = getReferralLinks().exchanges[ex];
    const refPct = referral ? parsePercent(referral.discount) : 0;
    const mRaw = applyTokenDiscount(
      ex,
      purpose,
      resolved.base_maker,
      true,
      useToken,
      opts.tokenBalance,
    ).rate;
    const tRaw = applyTokenDiscount(
      ex,
      purpose,
      resolved.base_taker,
      false,
      useToken,
      opts.tokenBalance,
    ).rate;
    const effMaker = round(discountRate(mRaw, 1 - refPct));
    const effTaker = round(discountRate(tRaw, 1 - refPct));
    return {
      tier: resolved.tier,
      ...(resolved.volume_tier !== resolved.tier ? { volume_tier: resolved.volume_tier } : {}),
      maker: effMaker,
      taker: effTaker,
      weighted: round(weightedRate(effMaker, effTaker, ms)),
    };
  };

  // ---- choose sweep points ----
  let capped = false;
  let volumes: number[];
  if (opts.volumes && opts.volumes.length > 0) {
    const bad = opts.volumes.find((v) => !Number.isFinite(v) || v < 0);
    if (bad !== undefined) {
      return makeError("Each volume must be a finite non-negative number of USD/month.", {
        code: "BAD_VOLUME",
        suggested_action: "Example: [10000, 100000, 1000000].",
      });
    }
    volumes = [...new Set(opts.volumes.map((v) => Math.round(v)))].sort((a, b) => a - b);
    if (volumes.length > WHATIF_MAX_EXPLICIT_POINTS) {
      volumes = volumes.slice(0, WHATIF_MAX_EXPLICIT_POINTS);
      capped = true;
    }
  } else {
    const set = new Set<number>([0]);
    if (baseVolume !== undefined) set.add(baseVolume);
    for (const ex of allowed) {
      const ladder = getNormalizedLadder(ex, purpose);
      if (!ladder) continue;
      for (const tr of ladder) set.add(tr.min_volume_usd);
    }
    let all = [...set].sort((a, b) => a - b);
    if (all.length > maxPoints) {
      capped = true;
      const keep = new Set<number>([0, all[all.length - 1]]);
      if (baseVolume !== undefined && all.includes(baseVolume)) keep.add(baseVolume);
      const interior = all.filter((v) => !keep.has(v));
      const slots = maxPoints - keep.size;
      for (let k = 0; k < slots && interior.length > 0; k++) {
        const idx = Math.round((k * (interior.length - 1)) / Math.max(1, slots - 1));
        keep.add(interior[idx]);
      }
      all = all.filter((v) => keep.has(v));
    }
    volumes = all;
  }

  // ---- run the sweep per venue, collecting crossings ----
  const points: WhatIfPoint[] = [];
  const perEx = new Map<string, WhatIfSweepPoint[]>();
  for (const ex of allowed) perEx.set(ex, []);
  const crossings: WhatIfTierCrossing[] = [];

  for (const vol of volumes) {
    const ranking = allowed.map((ex) => {
      const prev = perEx.get(ex)![perEx.get(ex)!.length - 1];
      const s = snapshotAt(ex, vol);
      const tierCrossed = prev !== undefined && prev.tier !== s.tier;
      const annualFee = round2((s.weighted / 100) * vol * 12);
      const cell: WhatIfSweepPoint = {
        monthly_volume_usd: vol,
        tier: s.tier,
        ...(s.volume_tier ? { volume_tier: s.volume_tier } : {}),
        effective_maker_pct: s.maker,
        effective_taker_pct: s.taker,
        weighted_fee_pct: s.weighted,
        annual_fee_usd: annualFee,
        ...(tierCrossed ? { tier_crossed: true } : {}),
      };
      perEx.get(ex)!.push(cell);
      if (tierCrossed && prev) {
        crossings.push({
          at_monthly_volume_usd: vol,
          exchange: ex,
          from_tier: prev.tier,
          to_tier: s.tier,
        });
      }
      return {
        exchange: ex,
        tier: s.tier,
        ...(s.volume_tier ? { volume_tier: s.volume_tier } : {}),
        weighted_fee_pct: s.weighted,
        annual_fee_usd: annualFee,
        ...(tierCrossed ? { tier_crossed: true } : {}),
      };
    });
    ranking.sort(
      (a, b) =>
        a.weighted_fee_pct - b.weighted_fee_pct ||
        a.annual_fee_usd - b.annual_fee_usd ||
        a.exchange.localeCompare(b.exchange),
    );
    const cheapest = ranking[0];
    points.push({
      monthly_volume_usd: vol,
      annual_traded_notional_usd: vol * 12,
      cheapest: {
        exchange: cheapest.exchange,
        tier: cheapest.tier,
        weighted_fee_pct: cheapest.weighted_fee_pct,
        annual_fee_usd: cheapest.annual_fee_usd,
      },
      ranking,
    });
  }
  crossings.sort(
    (a, b) =>
      a.at_monthly_volume_usd - b.at_monthly_volume_usd || a.exchange.localeCompare(b.exchange),
  );

  // ---- per-venue curves + exact next-rung analysis at the user's base volume ----
  const exchanges: WhatIfExchange[] = allowed.map((ex) => {
    const sweep = perEx.get(ex)!;
    let current: WhatIfExchange["current"] = null;
    let nextTier: WhatIfNextTier | null | undefined;
    if (baseVolume !== undefined) {
      const nowSnap = snapshotAt(ex, baseVolume);
      current = {
        monthly_volume_usd: baseVolume,
        tier: nowSnap.tier,
        weighted_fee_pct: nowSnap.weighted,
        annual_fee_usd: round2((nowSnap.weighted / 100) * baseVolume * 12),
      };
      const ladder = getNormalizedLadder(ex, purpose);
      if (ladder) {
        let volIdx = 0;
        ladder.forEach((tr, i) => {
          if (baseVolume >= tr.min_volume_usd) volIdx = i;
        });
        if (volIdx + 1 < ladder.length) {
          const target = ladder[volIdx + 1];
          const nextSnap = snapshotAt(ex, target.min_volume_usd);
          const blocked = nextSnap.tier !== target.tier;
          nextTier = {
            from_tier: nowSnap.volume_tier ?? nowSnap.tier,
            to_tier: target.tier,
            at_monthly_volume_usd: target.min_volume_usd,
            additional_monthly_volume_usd: Math.max(0, target.min_volume_usd - baseVolume),
            weighted_fee_pct_now: nowSnap.weighted,
            weighted_fee_pct_next: nextSnap.weighted,
            saving_per_year_usd_at_current_volume: round2(
              Math.max(0, ((nowSnap.weighted - nextSnap.weighted) / 100) * baseVolume * 12),
            ),
            ...(blocked ? { blocked_by_holding_gate: true } : {}),
          };
        } else {
          nextTier = null;
        }
      }
    }
    const out: WhatIfExchange = { exchange: ex, current, sweep };
    if (nextTier !== undefined) out.next_tier = nextTier;
    return out;
  });

  // ---- advice ----
  const advice: string[] = [];
  const warnings: string[] = [];
  if (baseVolume !== undefined) {
    const currents = exchanges
      .filter((e) => e.current)
      .map((e) => ({ ex: e.exchange, current: e.current!, next: e.next_tier ?? null }))
      .sort((a, b) => a.current.annual_fee_usd - b.current.annual_fee_usd);
    const win = currents[0];
    advice.push(
      t(lang, "wi_cheapest", {
        volume: formatUsd(baseVolume),
        exchange: EX_DISPLAY_NAMES[win.ex] ?? win.ex,
        tier: win.current.tier,
        usd: formatUsd(win.current.annual_fee_usd),
      }),
    );
    const opportunities = currents
      .filter((c) => c.next && !c.next.blocked_by_holding_gate && c.next.saving_per_year_usd_at_current_volume > 0)
      .sort(
        (a, b) =>
          (b.next?.saving_per_year_usd_at_current_volume ?? 0) -
          (a.next?.saving_per_year_usd_at_current_volume ?? 0),
      )
      .slice(0, 3);
    for (const o of opportunities) {
      advice.push(
        t(lang, "wi_upgrade", {
          exchange: EX_DISPLAY_NAMES[o.ex] ?? o.ex,
          add: formatUsd(o.next!.additional_monthly_volume_usd),
          tier: o.next!.to_tier,
          usd: formatUsd(o.next!.saving_per_year_usd_at_current_volume),
        }),
      );
    }
    const gated = currents.filter((c) => c.next?.blocked_by_holding_gate).slice(0, 3);
    for (const g of gated) {
      advice.push(
        t(lang, "wi_upgrade_gate", {
          exchange: EX_DISPLAY_NAMES[g.ex] ?? g.ex,
          tier: g.next!.to_tier,
          volume: formatUsd(g.next!.at_monthly_volume_usd),
        }),
      );
    }
    if (opportunities.length === 0 && gated.length === 0) advice.push(t(lang, "wi_no_upgrade"));
  }
  if (capped) warnings.push(t(lang, "wi_points_capped", { max: maxPoints }));
  const fw = freshnessWarning(lang);
  if (fw) warnings.push(fw);

  const whatIfResult: VolumeWhatIfResult = {
    purpose,
    country: country.toUpperCase(),
    currency,
    maker_share: ms,
    use_token: useToken,
    ...(baseVolume !== undefined ? { base_monthly_volume_usd: baseVolume } : {}),
    volumes,
    data_as_of: dataAsOf(),
    points,
    tier_crossings: crossings,
    exchanges,
    advice,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  if (opts.format && opts.format !== "json") {
    whatIfResult.rendered = renderTable(
      "whatif",
      whatIfResult,
      opts.format,
      lang,
      opts.tableMetric ?? "weighted_fee_pct",
    );
  }
  return whatIfResult;
}

// ---------------------------------------------------------------------------
// v0.35: country diff matrix — one trader profile priced across countries.
// Compliance filtering changes BOTH the venue set and (via local rails) the
// all-in cost, so the same persona can cost materially different amounts by
// residency. Runs the existing analyzePersona engine once per country.
// ---------------------------------------------------------------------------
const DEFAULT_COUNTRY_SET = ["US", "GB", "DE", "JP", "SG", "BR", "CN"];
export const COMPARE_COUNTRIES_DEFAULT_SET = DEFAULT_COUNTRY_SET;
const MAX_COMPARE_COUNTRIES = 12;

export function compareCountries(
  personaId: string = "active_spot_trader",
  opts: {
    countries?: string[];
    monthlyVolumeUsd?: number;
    makerShare?: number;
    useToken?: boolean;
    tokenBalance?: number;
    accountAssetsUsd?: number;
    holdingHours?: number;
    tradeSizeUsd?: number;
    pair?: string;
    currency?: string;
    fundingPair?: string;
    spreadPair?: string;
    /** Pre-resolved live funding overrides keyed by ISO country code. */
    fundingRatesByCountry?: Record<string, FundingOverrides>;
    /** Pre-resolved live spread overrides keyed by ISO country code. */
    spreadRatesByCountry?: Record<string, SpreadOverrides>;
    language?: Lang;
    /** v0.36: attach a rendered matrix table (markdown/csv/both). */
    format?: RenderFormat;
    /** v0.36: table metric — availability (default) | cost. */
    tableMetric?: "availability" | "cost";
  } = {},
): CompareCountriesResult | ToolError {
  const lang = pickLang(opts.language);
  const id = personaId.toLowerCase();
  const persona = getPersonas().personas.find((p) => p.id === id);
  if (!persona) {
    return makeError(`Unknown persona '${personaId}'.`, {
      code: "INVALID_INPUT",
      suggested_action: `Available personas: ${getPersonas().personas.map((p) => p.id).join(", ")}.`,
    });
  }
  const cur = resolveCurrency(opts.currency);
  if (isToolError(cur)) return cur;
  const [currency] = cur;
  const badRender = invalidRenderOpts(opts.format, opts.tableMetric, [
    "availability",
    "cost",
  ]);
  if (badRender) return badRender;

  let countries =
    opts.countries && opts.countries.length > 0
      ? [...new Set(opts.countries.map((c) => c.toUpperCase()))]
      : [...DEFAULT_COUNTRY_SET];
  if (countries.length > MAX_COMPARE_COUNTRIES) countries = countries.slice(0, MAX_COMPARE_COUNTRIES);

  const allVenues = listSupportedExchanges();
  const rows: CountryComparisonRow[] = [];
  let dataAsOfStamp = dataAsOf();

  for (const cc of countries) {
    const r = analyzePersona(persona.id, cc, {
      ...(opts.monthlyVolumeUsd !== undefined ? { monthlyVolumeUsd: opts.monthlyVolumeUsd } : {}),
      ...(opts.makerShare !== undefined ? { makerShare: opts.makerShare } : {}),
      ...(opts.useToken !== undefined ? { useToken: opts.useToken } : {}),
      ...(opts.tokenBalance !== undefined ? { tokenBalance: opts.tokenBalance } : {}),
      ...(opts.accountAssetsUsd !== undefined ? { accountAssetsUsd: opts.accountAssetsUsd } : {}),
      ...(opts.holdingHours !== undefined ? { holdingHours: opts.holdingHours } : {}),
      ...(opts.tradeSizeUsd !== undefined ? { tradeSizeUsd: opts.tradeSizeUsd } : {}),
      ...(opts.pair !== undefined ? { pair: opts.pair } : {}),
      currency: opts.currency,
      ...(opts.fundingPair !== undefined ? { fundingPair: opts.fundingPair } : {}),
      ...(opts.spreadPair !== undefined ? { spreadPair: opts.spreadPair } : {}),
      fundingRates: opts.fundingRatesByCountry?.[cc],
      spreadRates: opts.spreadRatesByCountry?.[cc],
      language: opts.language,
    });

    const pricedExchanges = isToolError(r)
      ? new Set<string>()
      : new Set(r.ranking.map((row) => row.exchange));

    const blocked: string[] = [];
    const unsupported: string[] = [];
    for (const ex of allVenues) {
      // Venue-level gating first: explicit country lists and v0.41 region
      // blocks (post-MiCA-cliff EEA venue bans), regardless of persona purpose.
      if (!isVenueUsableFor(ex, cc)) blocked.push(ex);
      // Product-level: explicit and region product gates (e.g. Bybit/Gate
      // perps unavailable in EEA pending MiFID authorization).
      else if (isProductBlockedInCountry(ex, persona.purpose, cc)) unsupported.push(ex);
      else if (!pricedExchanges.has(ex)) unsupported.push(ex);
    }

    if (isToolError(r)) {
      rows.push({
        country: cc,
        available_venues: allVenues.length - blocked.length,
        winner: null,
        best_complete: null,
        comparison_basis: "winner",
        comparison_annual_all_in: null,
        extra_vs_cheapest_country_usd: null,
        extra_vs_cheapest_country_pct: null,
        blocked_venues: blocked,
        unsupported_product_venues: unsupported,
        ranking: [],
        error: r.error,
        ...(r.code ? { error_code: r.code } : {}),
      });
      continue;
    }
    dataAsOfStamp = r.data_as_of ?? dataAsOfStamp;
    const basis: "winner" | "best_complete" =
      r.best_complete && r.best_complete.extra_vs_winner > 0 ? "best_complete" : "winner";
    const comparisonCost =
      basis === "best_complete" && r.best_complete
        ? r.best_complete.annual_all_in
        : (r.best?.annual_all_in ?? null);

    rows.push({
      country: cc,
      available_venues: allVenues.length - blocked.length,
      winner: r.best
        ? {
            exchange: r.best.exchange,
            tier: r.ranking[0]?.tier ?? "",
            annual_all_in: r.best.annual_all_in,
          }
        : null,
      best_complete: r.best_complete
        ? {
            exchange: r.best_complete.exchange,
            annual_all_in: r.best_complete.annual_all_in,
            extra_vs_winner: r.best_complete.extra_vs_winner,
          }
        : null,
      comparison_basis: basis,
      comparison_annual_all_in: comparisonCost,
      extra_vs_cheapest_country_usd: null,
      extra_vs_cheapest_country_pct: null,
      blocked_venues: blocked,
      unsupported_product_venues: unsupported,
      ranking: r.ranking,
    });
  }

  // ---- cross-country deltas (on a COMPARABLE basis: all-legs pick when the
  // headline winner misses rails, so a rail-less venue cannot fake a country) ----
  const priced = rows.filter((row) => row.comparison_annual_all_in !== null);
  const cheapest = priced.length
    ? priced.reduce((a, b) =>
        (a.comparison_annual_all_in! <= b.comparison_annual_all_in! ? a : b),
      )
    : null;
  const costliest = priced.length
    ? priced.reduce((a, b) =>
        (a.comparison_annual_all_in! >= b.comparison_annual_all_in! ? a : b),
      )
    : null;
  const basisPick = (row: CountryComparisonRow) => {
    const ex =
      row.comparison_basis === "best_complete"
        ? (row.best_complete?.exchange ?? row.winner!.exchange)
        : row.winner!.exchange;
    const tier = row.ranking.find((x) => x.exchange === ex)?.tier;
    return {
      country: row.country,
      exchange: ex,
      annual_all_in: row.comparison_annual_all_in!,
      basis: row.comparison_basis,
      ...(tier ? { tier } : {}),
    };
  };
  for (const row of priced) {
    const delta = round2(row.comparison_annual_all_in! - cheapest!.comparison_annual_all_in!);
    row.extra_vs_cheapest_country_usd = delta;
    row.extra_vs_cheapest_country_pct =
      cheapest!.comparison_annual_all_in! > 0
        ? Math.round((delta / cheapest!.comparison_annual_all_in!) * 1000) / 10
        : 0;
  }

  // ---- winner venue counts across countries ----
  const winMap = new Map<string, string[]>();
  for (const row of priced) {
    const ex = row.winner!.exchange;
    if (!winMap.has(ex)) winMap.set(ex, []);
    winMap.get(ex)!.push(row.country);
  }
  const winnerVenueCounts: CountryWinnerCount[] = [...winMap.entries()]
    .map(([exchange, cs]) => ({ exchange, count: cs.length, countries: cs }))
    .sort((a, b) => b.count - a.count || a.exchange.localeCompare(b.exchange));

  // ---- venue × country availability matrix ----
  const venueAvailability: CountryVenueAvailability[] = allVenues.map((ex) => {
    const perCountry: Record<string, CountryVenueStatus> = {};
    const blockedIn: string[] = [];
    for (const row of rows) {
      if (row.blocked_venues.includes(ex)) {
        perCountry[row.country] = "blocked";
        blockedIn.push(row.country);
      } else if (row.unsupported_product_venues.includes(ex)) {
        perCountry[row.country] = "unsupported_product";
      } else {
        perCountry[row.country] = "available";
      }
    }
    return { exchange: ex, per_country: perCountry, blocked_in: blockedIn };
  });

  // ---- narrative advice ----
  const advice: string[] = [];
  const warnings: string[] = [];
  for (const row of rows) {
    if (!row.winner) {
      advice.push(
        t(lang, "cc_row_error", { country: row.country, code: row.error_code ?? "NO_RESULTS" }),
      );
      continue;
    }
    advice.push(
      t(lang, "cc_row", {
        country: row.country,
        exchange: EX_DISPLAY_NAMES[row.winner.exchange] ?? row.winner.exchange,
        tier: row.winner.tier,
        usd: formatUsd(row.winner.annual_all_in),
        n: String(row.available_venues),
      }),
    );
    if (
      row.best_complete &&
      row.best_complete.exchange !== row.winner.exchange &&
      row.best_complete.extra_vs_winner > 0
    ) {
      advice.push(
        t(lang, "cc_complete", {
          country: row.country,
          winner: EX_DISPLAY_NAMES[row.winner.exchange] ?? row.winner.exchange,
          complete: EX_DISPLAY_NAMES[row.best_complete.exchange] ?? row.best_complete.exchange,
          extra: formatUsd(row.best_complete.extra_vs_winner),
        }),
      );
    }
  }
  if (cheapest && costliest && cheapest.country !== costliest.country) {
    advice.push(
      t(lang, "cc_gap", {
        lo: cheapest.country,
        hi: costliest.country,
        delta: formatUsd(
          costliest.comparison_annual_all_in! - cheapest.comparison_annual_all_in!,
        ),
        pct: String(
          cheapest.comparison_annual_all_in! > 0
            ? Math.round(
                ((costliest.comparison_annual_all_in! - cheapest.comparison_annual_all_in!) /
                  cheapest.comparison_annual_all_in!) *
                  1000,
              ) / 10
            : 0,
        ),
      }),
    );
  }
  if (winnerVenueCounts.length > 0) {
    const top = winnerVenueCounts[0];
    if (top.count >= 2) {
      advice.push(
        t(lang, "cc_wins", {
          exchange: EX_DISPLAY_NAMES[top.exchange] ?? top.exchange,
          n: String(top.count),
          total: String(priced.length),
          countries: top.countries.join(", "),
        }),
      );
    }
  }
  // Venues blocked in SOME but not all compared countries are the informative ones.
  for (const va of venueAvailability) {
    if (va.blocked_in.length > 0 && va.blocked_in.length < countries.length) {
      advice.push(
        t(lang, "cc_venue", {
          venue: EX_DISPLAY_NAMES[va.exchange] ?? va.exchange,
          countries: va.blocked_in.join(", "),
        }),
      );
    }
  }
  const fw = freshnessWarning(lang);
  if (fw) warnings.push(fw);

  const countryResult: CompareCountriesResult = {
    persona: { id: persona.id, name_en: persona.name_en, name_zh: persona.name_zh },
    purpose: persona.purpose,
    currency,
    countries,
    data_as_of: dataAsOfStamp,
    rows,
    cheapest_country: cheapest ? basisPick(cheapest) : null,
    costliest_country: costliest ? basisPick(costliest) : null,
    spread_usd:
      cheapest && costliest
        ? round2(
            costliest.comparison_annual_all_in! - cheapest.comparison_annual_all_in!,
          )
        : null,
    winner_venue_counts: winnerVenueCounts,
    venue_availability: venueAvailability,
    advice,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  if (opts.format && opts.format !== "json") {
    countryResult.rendered = renderTable(
      "countries",
      countryResult,
      opts.format,
      lang,
      opts.tableMetric ?? "availability",
    );
  }
  return countryResult;
}
