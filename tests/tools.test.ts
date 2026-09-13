import { describe, it, expect, beforeEach } from "vitest";
import {
  compareExchangeFees,
  compareInterfaceCosts,
  getReferralLink,
  calculateSavings,
  compareTotalCost,
  recommendExchange,
  listDataSources,
  calculateAnnualCost,
  getFiatCost,
  getWithdrawalCost,
  analyzePersona,
  comparePersonas,
  listPersonas,
  analyzeTokenDiscount,
  volumeWhatIf,
  compareCountries,
  getStablecoinAccessReport,
  getExecutionCost,
} from "../src/tools.js";
import { renderTable } from "../src/render.js";
import { resolveFeeRate, getTokenDiscount, getWithdrawalFees, getFundingRate, getDataFreshness, getSpotFeeClasses, getExchangeNotes, getNormalizedLadder, getSpreadEstimate, getPricingModel, monthsBehindAsOf, listDataProvenance, isProductBlockedInCountry, isVenueUsableFor, isCountryInRegion, getRegions, getProductRegionGates, getVenueRegionBlocks, getProductRegionBlocks, isVenueRegionBlocked, getVenueRegionAllows, isVenueRegionAllowed, isVenueRegionRestricted } from "../src/data.js";
import { resetCachesForTest } from "../src/data.js";

describe("resolveFeeRate (VIP tier lookup)", () => {
  beforeEach(() => resetCachesForTest());

  it("returns Regular tier for zero volume binance spot", () => {
    const r = resolveFeeRate("binance", "spot", 0);
    expect(r).not.toBeNull();
    expect(r!.tier).toBe("Regular");
    expect(r!.base_maker).toBe(0.1);
    expect(r!.base_taker).toBe(0.1);
  });

  it("returns VIP1 for $1M binance spot", () => {
    const r = resolveFeeRate("binance", "spot", 1_000_000);
    expect(r!.tier).toBe("VIP1");
    expect(r!.base_maker).toBe(0.09);
  });

  it("returns VIP3 for $20M binance spot", () => {
    const r = resolveFeeRate("binance", "spot", 20_000_000);
    expect(r!.tier).toBe("VIP3");
    expect(r!.base_maker).toBe(0.04);
    expect(r!.base_taker).toBe(0.06);
  });

  it("returns VIP9 for $4B binance spot", () => {
    const r = resolveFeeRate("binance", "spot", 4_000_000_000);
    expect(r!.tier).toBe("VIP9");
    expect(r!.base_maker).toBe(0.011);
  });

  it("returns Regular for binance futures", () => {
    const r = resolveFeeRate("binance", "futures", 0);
    expect(r!.tier).toBe("Regular");
    expect(r!.base_maker).toBe(0.02);
    expect(r!.base_taker).toBe(0.05);
  });

  it("returns VIP1 futures at $15M volume (no BNB gate on futures)", () => {
    expect(resolveFeeRate("binance", "futures", 5_000_000)!.tier).toBe("Regular");
    const r = resolveFeeRate("binance", "futures", 15_000_000);
    expect(r!.tier).toBe("VIP1");
    expect(r!.base_maker).toBe(0.016);
    expect(r!.token_name).toBeUndefined();
  });

  it("gate.io spot uses single fee field", () => {
    const r = resolveFeeRate("gate", "spot", 0);
    expect(r!.tier).toBe("VIP0");
    expect(r!.base_maker).toBe(0.2);
    expect(r!.base_taker).toBe(0.2);
  });

  it("gate.io futures VIP5", () => {
    const r = resolveFeeRate("gate", "futures", 50_000_000);
    expect(r!.tier).toBe("VIP5");
    expect(r!.base_maker).toBe(0.01);
    expect(r!.base_taker).toBe(0.025);
  });

  it("returns null for unknown exchange", () => {
    expect(resolveFeeRate("nonexistent", "spot", 0)).toBeNull();
  });
});

describe("getTokenDiscount", () => {
  beforeEach(() => resetCachesForTest());

  it("binance has BNB 25% spot discount", () => {
    const td = getTokenDiscount("binance");
    expect(td!.token).toBe("BNB");
    expect(td!.spot_discount_pct).toBe(25);
    expect(td!.futures_discount_pct).toBe(10);
  });

  it("gate has futures_maker_to_zero", () => {
    const td = getTokenDiscount("gate");
    expect(td!.futures_maker_to_zero).toBe(true);
    expect(td!.holding_tiers!.length).toBeGreaterThan(0);
  });
});

describe("compareExchangeFees", () => {
  beforeEach(() => resetCachesForTest());

  it("returns 13 exchanges for JP spot (coinbase blocked, hyperliquid + bingx + phemex + blofin + bitstamp in)", () => {
    const r = compareExchangeFees("spot", "JP");
    expect(Array.isArray(r)).toBe(true);
    expect((r as any[]).length).toBe(13);
    // v0.11: bybit/mexc/bitget have fee data but no referral links yet — still listed.
    const mexc = (r as any[]).find((x) => x.exchange === "mexc");
    expect(mexc).toBeDefined();
    expect(mexc.referral_url).toBeUndefined();
    expect(mexc.referral_discount).toBeUndefined();
    expect(mexc.effective_taker).toBe(0.05);
  });

  it("CN blocks binance, kucoin and kraken, leaves the other seven (incl. phemex)", () => {
    const r = compareExchangeFees("futures", "CN") as any[];
    expect(r.length).toBe(7);
    expect(r.find((x) => x.exchange === "binance")).toBeUndefined();
    expect(r.find((x) => x.exchange === "kucoin")).toBeUndefined();
    expect(r.find((x) => x.exchange === "kraken")).toBeUndefined();
    // v0.20: Hyperliquid does not front-end block CN (local law still applies).
    expect(r.find((x) => x.exchange === "hyperliquid")).toBeDefined();
  });

  it("applies VIP tier when volume passed", () => {
    const r = compareExchangeFees("spot", "JP", { monthlyVolumeUsd: 1_000_000 }) as any[];
    const binance = r.find((x) => x.exchange === "binance");
    expect(binance.tier).toBe("VIP1");
    expect(binance.base_maker).toBe(0.09);
  });

  it("applies token discount when useToken=true (binance BNB)", () => {
    const r = compareExchangeFees("spot", "JP", { useToken: true }) as any[];
    const binance = r.find((x) => x.exchange === "binance");
    // base taker 0.1, BNB 25% off -> 0.075, then 20% referral -> 0.06
    expect(binance.token_applied).toBe(true);
    expect(binance.effective_taker).toBe(0.06);
  });

  it("gate futures maker to zero with GT", () => {
    const r = compareExchangeFees("futures", "JP", { useToken: true }) as any[];
    const gate = r.find((x) => x.exchange === "gate");
    expect(gate.token_applied).toBe(true);
    // base maker 0.02 -> GT makes 0 -> then 20% referral off 0 = 0
    expect(gate.effective_maker).toBe(0);
  });

  it("sorts by effective taker fee ascending", () => {
    const r = compareExchangeFees("spot", "JP") as any[];
    for (let i = 1; i < r.length; i++) {
      expect(r[i].effective_taker).toBeGreaterThanOrEqual(r[i - 1].effective_taker);
    }
  });
});

describe("getReferralLink", () => {
  beforeEach(() => resetCachesForTest());

  it("returns gate.io link", () => {
    const r = getReferralLink("gate", "JP") as any;
    expect(r.exchange).toBe("gate");
    expect(r.url).toContain("AVVHAFs");
  });

  it("returns error for unknown exchange", () => {
    const r = getReferralLink("fakeex", "JP");
    expect("error" in r).toBe(true);
    expect((r as any).code).toBe("UNKNOWN_EXCHANGE");
  });

  it("case-insensitive", () => {
    const r = getReferralLink("GATE", "JP") as any;
    expect(r.exchange).toBe("gate");
  });
});

describe("calculateSavings", () => {
  beforeEach(() => resetCachesForTest());

  it("binance futures 100k, Regular tier, no token", () => {
    const r = calculateSavings("binance", 100_000, "futures", "JP") as any;
    // base taker 0.05%, 20% referral off
    // original = 100000 * 0.0005 = 50
    // final = 100000 * 0.0005 * 0.8 = 40
    expect(r.tier).toBe("Regular");
    expect(r.original_fee).toBe(50);
    expect(r.final_fee).toBe(40);
    expect(r.total_savings).toBe(10);
    expect(r.referral_url).toContain("ref=13303906");
  });

  it("binance futures 100k with BNB token discount", () => {
    const r = calculateSavings("binance", 100_000, "futures", "JP", { useToken: true }) as any;
    // base taker 0.05, BNB 10% off futures -> 0.045, then 20% referral -> 0.036
    // original = 50, final = 100000 * 0.00036 = 36
    expect(r.token_applied).toBe(true);
    expect(r.final_fee).toBe(36);
    expect(r.total_savings).toBe(14);
  });

  it("binance futures 15M hits VIP1 tier", () => {
    const r = calculateSavings("binance", 15_000_000, "futures", "JP") as any;
    expect(r.tier).toBe("VIP1");
    // VIP1 taker 0.04%, original = 15000000 * 0.0004 = 6000
    expect(r.original_fee).toBe(6000);
  });

  it("funding cost calculated when holdingHours passed", () => {
    const r = calculateSavings("binance", 100_000, "futures", "JP", { holdingHours: 16 }) as any;
    // 16h / 8h interval = 2 intervals, 0.01% per interval
    // funding = 100000 * 0.0001 * 2 = 20
    expect(r.funding_cost).toBe(20);
  });

  it("rejects non-positive volume", () => {
    expect("error" in calculateSavings("binance", 0, "spot", "JP")).toBe(true);
    expect("error" in calculateSavings("binance", -1, "spot", "JP")).toBe(true);
  });
});

describe("compareTotalCost", () => {
  beforeEach(() => resetCachesForTest());

  it("returns total cost ranking for futures + 16h holding + USDT TRC-20", () => {
    const r = compareTotalCost("futures", "JP", 100_000, {
      holdingHours: 16,
      withdrawalAsset: "USDT",
      withdrawalNetwork: "TRC-20",
    }) as any[];
    // 13 venues - coinbase (blocked in JP and spot-only anyway) = 12 futures-capable rows.
    expect(r.length).toBe(12);
    // sorted by total_cost ascending
    for (let i = 1; i < r.length; i++) {
      expect(r[i].total_cost).toBeGreaterThanOrEqual(r[i - 1].total_cost);
    }
    // binance USDT TRC-20 withdrawal = $1.5 (2026-09 schedule)
    const binance = r.find((x) => x.exchange === "binance");
    expect(binance.withdrawal_cost).toBe(1.5);
    // funding 16h = 2 intervals * 0.01% * 100000 = 20
    expect(binance.funding_cost).toBe(20);
    // v0.20: Hyperliquid lacks USDT routes (withdrawal 0) but its hourly funding
    // prices 16 intervals * 0.00125% = the same $20 per $100k as 8h CEX venues.
    const hl = r.find((x) => x.exchange === "hyperliquid");
    expect(hl.funding_cost).toBe(20);
    expect(hl.withdrawal_cost).toBe(0);
  });

  it("no withdrawal fee when withdrawalAsset not passed", () => {
    const r = compareTotalCost("spot", "JP", 10_000) as any[];
    for (const item of r) {
      expect(item.withdrawal_cost).toBe(0);
      expect(item.funding_cost).toBe(0);
    }
  });

  it("CN blocks binance, kucoin and kraken in total cost", () => {
    const r = compareTotalCost("futures", "CN", 100_000) as any[];
    expect(r.find((x) => x.exchange === "binance")).toBeUndefined();
    expect(r.find((x) => x.exchange === "kucoin")).toBeUndefined();
    expect(r.find((x) => x.exchange === "kraken")).toBeUndefined();
    expect(r.length).toBe(7);
  });
});

describe("structured errors", () => {
  beforeEach(() => resetCachesForTest());

  it("errors have code field", () => {
    const r = getReferralLink("fakeex", "JP") as any;
    expect(r.code).toBe("UNKNOWN_EXCHANGE");
    expect(typeof r.suggested_action).toBe("string");
  });

  it("country blocked error has code", () => {
    const r = calculateSavings("binance", 1000, "spot", "CN") as any;
    expect(r.code).toBe("COUNTRY_BLOCKED");
  });
});

describe("v0.5: maker/taker weighted fees", () => {
  beforeEach(() => resetCachesForTest());

  it("weighted_rate equals effective_taker when makerShare omitted (backwards compat)", () => {
    const r = compareExchangeFees("spot", "JP") as any[];
    for (const item of r) {
      expect(item.weighted_rate).toBe(item.effective_taker);
    }
  });

  it("makerShare=1 ranks mexc first (zero spot maker), hyperliquid second, okx third", () => {
    const r = compareExchangeFees("spot", "JP", { makerShare: 1 }) as any[];
    // eff maker @VIP0: mexc 0 (no referral), hyperliquid 0.04 (14d-window Tier 0),
    // okx 0.08*0.8=0.064, binance 0.1*0.8=0.08, bybit 0.1 (no referral), bitget 0.1, gate 0.2*0.8=0.16
    expect(r[0].exchange).toBe("mexc");
    expect(r[0].weighted_rate).toBe(0);
    expect(r[1].exchange).toBe("hyperliquid");
    expect(r[1].weighted_rate).toBe(0.04);
    expect(r[2].exchange).toBe("okx");
    expect(r[2].weighted_rate).toBe(0.064);
    expect(r[3].exchange).toBe("binance");
  });

  it("makerShare=0.5 blends maker and taker", () => {
    const r = compareExchangeFees("spot", "JP", { makerShare: 0.5 }) as any[];
    const okx = r.find((x) => x.exchange === "okx");
    // maker 0.064, taker 0.08 -> (0.064+0.08)/2 = 0.072
    expect(okx.weighted_rate).toBe(0.072);
  });

  it("calculateSavings respects makerShare (binance futures 100k, 50% maker)", () => {
    const r = calculateSavings("binance", 100_000, "futures", "JP", { makerShare: 0.5 }) as any;
    // weighted base = (0.02+0.05)/2 = 0.035 -> original 35, final 28, savings 7
    expect(r.maker_share).toBe(0.5);
    expect(r.original_fee).toBe(35);
    expect(r.final_fee).toBe(28);
    expect(r.total_savings).toBe(7);
  });

  it("calculateSavings makerShare=1 (pure maker)", () => {
    const r = calculateSavings("binance", 100_000, "futures", "JP", { makerShare: 1 }) as any;
    // weighted base 0.02 -> original 20, final 16
    expect(r.original_fee).toBe(20);
    expect(r.final_fee).toBe(16);
  });

  it("compareTotalCost makerShare affects trading fee", () => {
    const r = compareTotalCost("futures", "JP", 100_000, { makerShare: 1 }) as any[];
    const binance = r.find((x) => x.exchange === "binance");
    // weighted 0.02, 20% referral -> 0.016 -> fee 16 (vs 40 taker-only), no funding/withdrawal
    expect(binance.trading_fee).toBe(16);
    expect(binance.maker_share).toBe(1);
  });
});

describe("v0.5: multi-currency display", () => {
  beforeEach(() => resetCachesForTest());

  it("calculateSavings converts amounts to JPY", () => {
    const r = calculateSavings("binance", 100_000, "futures", "JP", { currency: "JPY" }) as any;
    // USD: original 50, final 40, savings 10 -> JPY x150
    expect(r.currency).toBe("JPY");
    expect(r.original_fee).toBe(7500);
    expect(r.final_fee).toBe(6000);
    expect(r.total_savings).toBe(1500);
  });

  it("no currency field when USD", () => {
    const r = calculateSavings("binance", 100_000, "futures", "JP") as any;
    expect(r.currency).toBeUndefined();
  });

  it("funding cost also converted", () => {
    const r = calculateSavings("binance", 100_000, "futures", "JP", {
      holdingHours: 16,
      currency: "EUR",
    }) as any;
    // USD funding 20 -> EUR x0.92 = 18.4
    expect(r.currency).toBe("EUR");
    expect(r.funding_cost).toBe(18.4);
  });

  it("compareTotalCost converts to EUR", () => {
    const r = compareTotalCost("spot", "JP", 10_000, { currency: "EUR" }) as any[];
    const binance = r.find((x) => x.exchange === "binance");
    // USD fee = 10000*0.001*0.8 = 8 -> 7.36
    expect(binance.currency).toBe("EUR");
    expect(binance.trading_fee).toBe(7.36);
  });

  it("rejects unsupported currency", () => {
    const r = calculateSavings("binance", 100_000, "futures", "JP", { currency: "XYZ" }) as any;
    expect(r.code).toBe("UNKNOWN_CURRENCY");
  });
});

describe("v0.5: recommend_exchange", () => {
  beforeEach(() => resetCachesForTest());

  it("recommends mexc for taker-heavy spot with score 100", () => {
    const r = recommendExchange("spot", "JP", 100_000) as any;
    // mexc taker 0.05% is the cheapest; fee score 100, everyone else 0
    expect(r.best.exchange).toBe("mexc");
    expect(r.best.score).toBe(100);
    // 13 JP-eligible spot venues - the best = 12 alternatives.
    expect(r.alternatives.length).toBe(12);
    expect(r.best.reasons.length).toBeGreaterThan(0);
    expect(r.advice).toContain("useToken=true");
  });

  it("maker-heavy trader gets mexc recommended (0% spot maker)", () => {
    const r = recommendExchange("spot", "JP", 100_000, { makerShare: 1 }) as any;
    expect(r.best.exchange).toBe("mexc");
    expect(r.best.weighted_fee_rate).toBe(0);
  });

  it("futures with holding includes funding in reasons", () => {
    const r = recommendExchange("futures", "JP", 100_000, { holdingHours: 16 }) as any;
    expect(r.best.reasons.some((s: string) => s.includes("funding"))).toBe(true);
    // all funding equal -> combined score = fee score
    expect(r.best.score).toBe(100);
  });

  it("suggests token discount when not used", () => {
    const r = recommendExchange("spot", "JP", 100_000) as any;
    expect(r.advice).toContain("useToken=true");
  });

  it("respects country restrictions (CN blocks binance)", () => {
    const r = recommendExchange("spot", "CN", 100_000) as any;
    expect(r.best.exchange).not.toBe("binance");
  });

  it("converts estimated fee to requested currency", () => {
    const r = recommendExchange("spot", "JP", 100_000, { currency: "JPY" }) as any;
    expect(r.currency).toBe("JPY");
    // best = mexc: USD fee = 100000 * 0.0005 = 50 -> 50 * 150
    expect(r.best.estimated_fee).toBe(7_500);
  });

  it("rejects non-positive volume", () => {
    expect("error" in recommendExchange("spot", "JP", 0)).toBe(true);
  });

  it("rejects unsupported currency", () => {
    const r = recommendExchange("spot", "JP", 100_000, { currency: "ABC" }) as any;
    expect(r.code).toBe("UNKNOWN_CURRENCY");
  });
});

describe("v0.6: data provenance", () => {
  beforeEach(() => resetCachesForTest());

  it("listDataSources returns all 14 files with last_verified and sources", () => {
    const r = listDataSources();
    expect(r.files.length).toBe(14);
    expect(r.files.some((f) => f.file === "fiat_routes.json")).toBe(true);
    expect(r.files.some((f) => f.file === "personas.json")).toBe(true);
    expect(r.files.some((f) => f.file === "token_prices.json")).toBe(true);
    expect(r.files.some((f) => f.file === "interface_costs.json")).toBe(true);
    expect(r.data_as_of).toMatch(/^\d{4}-\d{2}$/);
    for (const f of r.files) {
      expect(f.last_verified).toMatch(/^\d{4}-\d{2}$/);
      expect(f.sources).toBeDefined();
      expect(f.sources!.length).toBeGreaterThan(0);
      for (const s of f.sources!) {
        expect(typeof s.name).toBe("string");
        expect(s.url !== undefined || s.note !== undefined).toBe(true);
      }
    }
  });

  it("fee_rates sources include official exchange fee pages", () => {
    const r = listDataSources();
    const fee = r.files.find((f) => f.file === "fee_rates.json")!;
    const urls = fee.sources!.map((s) => s.url ?? "").join(" ");
    expect(urls).toContain("binance.com");
    expect(urls).toContain("okx.com");
    expect(urls).toContain("gate.io");
  });

  it("results carry data_as_of freshness stamp", () => {
    const cmp = compareExchangeFees("spot", "JP") as any[];
    expect(cmp[0].data_as_of).toMatch(/^\d{4}-\d{2}$/);
    const sav = calculateSavings("binance", 100_000, "futures", "JP") as any;
    expect(sav.data_as_of).toMatch(/^\d{4}-\d{2}$/);
    const rec = recommendExchange("spot", "JP", 100_000) as any;
    expect(rec.data_as_of).toMatch(/^\d{4}-\d{2}$/);
    expect(rec.data_sources.length).toBeGreaterThan(0);
  });
});

describe("v0.8/v0.9: VIP tier native-token rules (Binance AND, Gate OR)", () => {
  beforeEach(() => resetCachesForTest());

  it("gate spot $10M with unknown holdings quotes VIP3 and hints VIP4 via 12000 GT", () => {
    const r = resolveFeeRate("gate", "spot", 10_000_000)!;
    expect(r.tier).toBe("VIP3");
    expect(r.volume_tier).toBe("VIP3");
    expect(r.token_name).toBe("GT");
    // OR semantics: GT is never a downgrade requirement...
    expect(r.min_token).toBeUndefined();
    expect(r.tier_held_back).toBeUndefined();
    // ...but an upgrade hint is surfaced.
    expect(r.next_tier).toBe("VIP4");
    expect(r.next_min_token).toBe(12000);
  });

  it("gate spot $10M with zero GT keeps VIP3 (volume OR GT, never downgraded)", () => {
    const r = resolveFeeRate("gate", "spot", 10_000_000, 0)!;
    expect(r.tier).toBe("VIP3");
    expect(r.volume_tier).toBe("VIP3");
    expect(r.tier_held_back).toBeUndefined();
    expect(r.tier_upgraded).toBeUndefined();
    expect(r.base_maker).toBe(0.14);
    expect(r.base_taker).toBe(0.14);
    expect(r.next_tier).toBe("VIP4");
  });

  it("gate GT holdings alone upgrade the tier at zero volume (exact thresholds)", () => {
    expect(resolveFeeRate("gate", "spot", 0, 999)!.tier).toBe("VIP0");
    expect(resolveFeeRate("gate", "spot", 0, 1000)!.tier).toBe("VIP1");
    expect(resolveFeeRate("gate", "spot", 0, 2999)!.tier).toBe("VIP1");
    expect(resolveFeeRate("gate", "spot", 0, 3000)!.tier).toBe("VIP2");
    expect(resolveFeeRate("gate", "spot", 0, 6000)!.tier).toBe("VIP3");
    const upgraded = resolveFeeRate("gate", "spot", 0, 6000)!;
    expect(upgraded.volume_tier).toBe("VIP0");
    expect(upgraded.tier_upgraded).toBe(true);
  });

  it("gate effective tier is the higher of volume rung and GT rung", () => {
    // $10M volume = VIP3; 3000 GT alone = VIP2 -> stays VIP3
    const lower = resolveFeeRate("gate", "spot", 10_000_000, 3000)!;
    expect(lower.tier).toBe("VIP3");
    expect(lower.tier_upgraded).toBeUndefined();
    // 12000 GT alone = VIP4 -> upgrades above volume VIP3
    const higher = resolveFeeRate("gate", "spot", 10_000_000, 12000)!;
    expect(higher.tier).toBe("VIP4");
    expect(higher.volume_tier).toBe("VIP3");
    expect(higher.tier_upgraded).toBe(true);
    expect(higher.base_maker).toBe(0.12);
  });

  it("gate futures also use the OR dual-track ladder", () => {
    const viaGt = resolveFeeRate("gate", "futures", 0, 200000)!;
    expect(viaGt.tier).toBe("VIP9");
    expect(viaGt.base_maker).toBe(0.002);
    expect(viaGt.base_taker).toBe(0.015);
    const zero = resolveFeeRate("gate", "futures", 50_000_000, 0)!;
    expect(zero.tier).toBe("VIP5");
    expect(zero.tier_held_back).toBeUndefined();
  });

  it("binance spot VIP1 requires 5 BNB; zero BNB falls back to Regular", () => {
    const unknown = resolveFeeRate("binance", "spot", 1_000_000)!;
    expect(unknown.tier).toBe("VIP1");
    expect(unknown.min_token).toBe(5);
    const none = resolveFeeRate("binance", "spot", 1_000_000, 0)!;
    expect(none.tier).toBe("Regular");
    expect(none.tier_held_back).toBe(true);
    expect(resolveFeeRate("binance", "spot", 1_000_000, 5)!.tier).toBe("VIP1");
  });

  it("binance futures and okx have no holding gates", () => {
    const bf = resolveFeeRate("binance", "futures", 15_000_000, 0)!;
    expect(bf.tier).toBe("VIP1");
    expect(bf.tier_held_back).toBeUndefined();
    expect(bf.token_name).toBeUndefined();
    const ok = resolveFeeRate("okx", "spot", 20_000_000, 0)!;
    expect(ok.tier).toBe("VIP4");
    expect(ok.token_name).toBeUndefined();
  });

  it("compare hints GT upgrade for gate and never downgrades it at zero GT", () => {
    const unknownRows = compareExchangeFees("spot", "JP", { monthlyVolumeUsd: 10_000_000 }) as any[];
    const gateUnknown = unknownRows.find((x) => x.exchange === "gate");
    expect(gateUnknown.tier).toBe("VIP3");
    expect(gateUnknown.tier_warning).toContain("12000 GT");
    expect(gateUnknown.tier_warning).toContain("VIP4");

    const zeroRows = compareExchangeFees("spot", "JP", {
      monthlyVolumeUsd: 10_000_000,
      tokenBalance: 0,
    }) as any[];
    const gateZero = zeroRows.find((x) => x.exchange === "gate");
    expect(gateZero.tier).toBe("VIP3");
    expect(gateZero.volume_tier).toBeUndefined();
    expect(gateZero.tier_warning).toContain("VIP4");

    const upgradedRows = compareExchangeFees("spot", "JP", {
      monthlyVolumeUsd: 10_000_000,
      tokenBalance: 12000,
    }) as any[];
    const gateUp = upgradedRows.find((x) => x.exchange === "gate");
    expect(gateUp.tier).toBe("VIP4");
    expect(gateUp.volume_tier).toBe("VIP3");
    expect(gateUp.tier_warning).toContain("lifts the effective fee tier to VIP4");
  });
});

describe("v0.8: Gate GT holding-tier discounts", () => {
  beforeEach(() => resetCachesForTest());

  it("2000 GT upgrades to VIP1 AND gives 35% spot discount; 100 GT stays VIP0 with 10%", () => {
    const r2000 = calculateSavings("gate", 100_000, "spot", "JP", {
      useToken: true,
      tokenBalance: 2000,
    }) as any;
    // OR ladder: 2000 GT >= 1000 -> VIP1 fee 0.18% -> 180 base;
    // 35% GT holding discount -> 117; then 20% referral -> 93.6
    expect(r2000.tier).toBe("VIP1");
    expect(r2000.volume_tier).toBe("VIP0");
    expect(r2000.original_fee).toBe(180);
    expect(r2000.fee_after_token).toBe(117);
    expect(r2000.final_fee).toBe(93.6);
    expect(r2000.token_applied).toBe(true);

    // 100 GT < 1000 -> no VIP upgrade (VIP0 0.2%); 10% holding discount -> 180
    const r100 = calculateSavings("gate", 100_000, "spot", "JP", {
      useToken: true,
      tokenBalance: 100,
    }) as any;
    expect(r100.tier).toBe("VIP0");
    expect(r100.fee_after_token).toBe(180);
  });

  it("unknown GT balance cannot apply holding-tier spot discount", () => {
    const r = calculateSavings("gate", 100_000, "spot", "JP", { useToken: true }) as any;
    expect(r.token_applied).toBe(false);
    expect(r.fee_after_token).toBe(200);
  });

  it("futures maker still drops to zero with GT deduction even without known balance", () => {
    const r = calculateSavings("gate", 100_000, "futures", "JP", {
      useToken: true,
      makerShare: 1,
    }) as any;
    expect(r.original_fee).toBe(20);
    expect(r.final_fee).toBe(0);
    expect(r.token_applied).toBe(true);
  });

  it("recommend reflects GT tier upgrade plus holding discount when balance known", () => {
    const r = recommendExchange("spot", "JP", 100_000, {
      useToken: true,
      tokenBalance: 2000,
    }) as any;
    const gate = [r.best, ...r.alternatives].find((x) => x.exchange === "gate");
    // VIP1 via OR: 0.18% * (1 - 0.35) * (1 - 0.2 referral) = 0.0936%
    expect(gate.tier).toBe("VIP1");
    expect(gate.weighted_fee_rate).toBe(0.0936);
  });
});

describe("v0.8: data freshness warnings", () => {
  beforeEach(() => resetCachesForTest());

  it("current data (2026-09 vs 2026-09) is not stale", () => {
    const f = getDataFreshness(new Date("2026-09-15T00:00:00Z"));
    expect(f.is_stale).toBe(false);
    expect(f.months_behind).toBe(0);
    expect(f.warning).toBeUndefined();
  });

  it("flags data older than 3 months", () => {
    const f = getDataFreshness(new Date("2027-02-01T00:00:00Z"));
    expect(f.is_stale).toBe(true);
    expect(f.months_behind).toBe(5);
    expect(f.warning).toContain("2026-09");
  });

  it("attaches freshness warnings to tool results only when stale", () => {
    const now = compareExchangeFees("spot", "JP") as any[];
    expect(now[0].freshness_warning).toBeUndefined();
  });
});

describe("v0.33: monthsBehindAsOf helper + per-file provenance freshness", () => {
  beforeEach(() => resetCachesForTest());

  it("monthsBehindAsOf parses month and day stamps, clamps the future, rejects garbage", () => {
    expect(monthsBehindAsOf("2026-09", new Date("2026-09-13T00:00:00Z"))).toBe(0);
    expect(monthsBehindAsOf("2026-09-12", new Date("2026-09-13T00:00:00Z"))).toBe(0);
    expect(monthsBehindAsOf("2026-05", new Date("2026-09-01T00:00:00Z"))).toBe(4);
    expect(monthsBehindAsOf("2027-01", new Date("2026-09-01T00:00:00Z"))).toBe(0); // future clamps
    expect(monthsBehindAsOf("not-a-date", new Date("2026-09-01T00:00:00Z"))).toBeNull();
    expect(monthsBehindAsOf(undefined)).toBeNull();
  });

  it("listDataProvenance annotates every file and reports an empty stale list while current", () => {
    const r = listDataProvenance(new Date("2026-09-13T00:00:00Z"));
    expect(r.files).toHaveLength(14);
    expect(r.stale_after_months).toBe(3);
    expect(r.stale_files).toEqual([]);
    for (const f of r.files) {
      expect(typeof f.months_behind).toBe("number");
      expect(f.months_behind).toBe(0);
      expect(f.is_stale).toBe(false);
    }
  });

  it("listDataProvenance flags files once they cross the 3-month threshold and names them", () => {
    const r = listDataProvenance(new Date("2027-02-01T00:00:00Z"));
    expect(r.stale_files).toContain("fee_rates.json");
    expect(r.stale_files.length).toBe(14);
    const fee = r.files.find((f) => f.file === "fee_rates.json")!;
    expect(fee.months_behind).toBe(5);
    expect(fee.is_stale).toBe(true);
    // Oldest stamp still drives the aggregate data_as_of.
    expect(r.data_as_of).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe("v0.9: official 2026-09 rate tables", () => {
  beforeEach(() => resetCachesForTest());

  it("binance spot corrected upper tiers", () => {
    const v4 = resolveFeeRate("binance", "spot", 75_000_000, 500)!;
    expect(v4.tier).toBe("VIP4");
    expect(v4.base_maker).toBe(0.04);
    expect(v4.base_taker).toBe(0.052);
    const v5 = resolveFeeRate("binance", "spot", 150_000_000, 1000)!;
    expect(v5.tier).toBe("VIP5");
    expect(v5.base_maker).toBe(0.025);
    expect(v5.base_taker).toBe(0.031);
    const v7 = resolveFeeRate("binance", "spot", 800_000_000, 3000)!;
    expect(v7.tier).toBe("VIP7");
    expect(v7.base_maker).toBe(0.019);
    expect(v7.base_taker).toBe(0.028);
  });

  it("binance futures corrected thresholds and top tier", () => {
    expect(resolveFeeRate("binance", "futures", 250_000_000)!.tier).toBe("VIP3");
    expect(resolveFeeRate("binance", "futures", 12_500_000_000)!.base_maker).toBe(0.004);
    const v9 = resolveFeeRate("binance", "futures", 50_000_000_000)!;
    expect(v9.tier).toBe("VIP9");
    expect(v9.base_maker).toBe(0);
    expect(v9.base_taker).toBe(0.017);
  });

  it("okx expanded 10-rung ladder", () => {
    expect(resolveFeeRate("okx", "spot", 1_000_000)!.base_maker).toBe(0.0675);
    const v6 = resolveFeeRate("okx", "spot", 200_000_000)!;
    expect(v6.tier).toBe("VIP6");
    expect(v6.base_maker).toBe(0);
    expect(v6.base_taker).toBe(0.03);
    expect(resolveFeeRate("okx", "futures", 5_000_000)!.tier).toBe("VIP1");
    expect(resolveFeeRate("okx", "futures", 20_000_000_000)!.base_taker).toBe(0.015);
  });
});

describe("v0.9: negative maker rates (maker rebates)", () => {
  beforeEach(() => resetCachesForTest());

  it("resolves OKX VIP7+ negative maker rates on spot and futures", () => {
    const spot = resolveFeeRate("okx", "spot", 500_000_000)!;
    expect(spot.tier).toBe("VIP7");
    expect(spot.base_maker).toBe(-0.002);
    expect(spot.base_taker).toBe(0.025);
    const top = resolveFeeRate("okx", "spot", 5_000_000_000)!;
    expect(top.tier).toBe("VIP9");
    expect(top.base_maker).toBe(-0.0075);
    expect(top.base_taker).toBe(0.0175);
    const fut = resolveFeeRate("okx", "futures", 1_500_000_000)!;
    expect(fut.tier).toBe("VIP7");
    expect(fut.base_maker).toBe(-0.002);
  });

  it("compare keeps the rebate intact (referral discount cannot shrink it) and ranks rebate first", () => {
    const r = compareExchangeFees("spot", "JP", {
      monthlyVolumeUsd: 500_000_000,
      makerShare: 1,
    }) as any[];
    const okx = r.find((x) => x.exchange === "okx");
    expect(okx.effective_maker).toBe(-0.002);
    expect(okx.weighted_rate).toBe(-0.002);
    expect(r[0].exchange).toBe("okx");
  });

  it("negative maker flows through as net rebate in savings (pure maker and blended)", () => {
    const pure = calculateSavings("okx", 500_000_000, "spot", "JP", { makerShare: 1 }) as any;
    // 500M * -0.002% = -10,000 (rebate paid to the user); referral leaves it unchanged
    expect(pure.original_fee).toBe(-10000);
    expect(pure.fee_after_referral).toBe(-10000);
    expect(pure.final_fee).toBe(-10000);
    expect(pure.total_savings).toBe(0);

    const blended = calculateSavings("okx", 500_000_000, "spot", "JP", { makerShare: 0.5 }) as any;
    // maker -0.002 untouched, taker 0.025 * 0.8 = 0.02 -> blend 0.009% -> 45,000
    expect(blended.final_fee).toBe(45000);
  });

  it("recommend scores rebate venues 100 and keeps every score in 0-100", () => {
    const r = recommendExchange("spot", "JP", 500_000_000, { makerShare: 1 }) as any;
    expect(r.best.exchange).toBe("okx");
    expect(r.best.score).toBe(100);
    expect(r.best.estimated_fee).toBe(-10000);
    for (const c of [r.best, ...r.alternatives]) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
    }
  });

  it("zero-maker tier (OKX VIP6 pure maker) also scores 100", () => {
    const r = recommendExchange("spot", "JP", 200_000_000, { makerShare: 1 }) as any;
    expect(r.best.exchange).toBe("okx");
    expect(r.best.score).toBe(100);
    expect(r.best.estimated_fee).toBe(0);
  });
});

describe("v0.10: OKX account-asset qualification (volume OR assets)", () => {
  beforeEach(() => resetCachesForTest());

  it("upgrades zero-volume spot to VIP1 with $100k assets and reports the asset path", () => {
    const r = resolveFeeRate("okx", "spot", 0, undefined, 100_000)!;
    expect(r.tier).toBe("VIP1");
    expect(r.volume_tier).toBe("Regular");
    expect(r.base_maker).toBe(0.0675);
    expect(r.tier_upgraded).toBe(true);
    expect(r.upgrade_basis).toBe("assets");
    expect(r.asset_gate).toBe(true);
    expect(r.min_assets_usd).toBe(100_000);
    expect(r.next_tier).toBe("VIP2");
    expect(r.next_min_assets).toBe(200_000);
  });

  it("lifts $500M assets to VIP9 negative maker even with zero volume", () => {
    const r = resolveFeeRate("okx", "spot", 0, undefined, 500_000_000)!;
    expect(r.tier).toBe("VIP9");
    expect(r.base_maker).toBe(-0.0075);
    expect(r.base_taker).toBe(0.0175);
    expect(r.tier_upgraded).toBe(true);
    expect(r.min_assets_usd).toBe(500_000_000);
    expect(r.next_tier).toBeUndefined();
    expect(r.next_min_assets).toBeUndefined();
  });

  it("assets only upgrade, never downgrade the volume tier", () => {
    // Volume reaches VIP4 ($20M); $100k assets alone only qualify for VIP1.
    const r = resolveFeeRate("okx", "spot", 20_000_000, undefined, 100_000)!;
    expect(r.tier).toBe("VIP4");
    expect(r.tier_upgraded).toBeUndefined();
    expect(r.next_min_assets).toBe(20_000_000);
  });

  it("quotes the volume tier and an asset upgrade hint when assets are unknown", () => {
    const r = resolveFeeRate("okx", "spot", 1_000_000)!;
    expect(r.tier).toBe("VIP1");
    expect(r.tier_upgraded).toBeUndefined();
    expect(r.asset_gate).toBe(true);
    expect(r.next_tier).toBe("VIP2");
    expect(r.next_min_assets).toBe(200_000);
  });

  it("applies the same asset thresholds to futures", () => {
    const r = resolveFeeRate("okx", "futures", 0, undefined, 100_000)!;
    expect(r.tier).toBe("VIP1");
    expect(r.base_maker).toBe(0.016);
    expect(r.base_taker).toBe(0.045);
    expect(r.tier_upgraded).toBe(true);
  });

  it("does not let account assets affect Binance futures (no asset gate)", () => {
    const r = resolveFeeRate("binance", "futures", 15_000_000, undefined, 999_000_000_000)!;
    expect(r.tier).toBe("VIP1");
    expect(r.asset_gate).toBeUndefined();
    expect(r.upgrade_basis).toBeUndefined();
  });

  it("compareExchangeFees prices OKX via assets and explains the upgrade", () => {
    const rows = compareExchangeFees("spot", "JP", {
      monthlyVolumeUsd: 0,
      accountAssetsUsd: 100_000,
    }) as any[];
    const okx = rows.find((x) => x.exchange === "okx");
    expect(okx.tier).toBe("VIP1");
    expect(okx.volume_tier).toBe("Regular");
    expect(okx.tier_warning).toContain("account assets");
  });

  it("compareExchangeFees advertises the asset path without a known balance", () => {
    const rows = compareExchangeFees("spot", "JP", { monthlyVolumeUsd: 1_000_000 }) as any[];
    const okx = rows.find((x) => x.exchange === "okx");
    expect(okx.tier).toBe("VIP1");
    expect(okx.tier_warning).toContain("$200,000");
    expect(okx.tier_warning).toContain("VIP2");
  });

  it("plumbs assets through calculateSavings / compareTotalCost / recommend", () => {
    const sav = calculateSavings("okx", 1_000, "spot", "JP", { accountAssetsUsd: 100_000 }) as any;
    expect(sav.tier).toBe("VIP1");
    // 1000 * 0.08% = 0.8 original; with 20% referral = 0.64
    expect(sav.original_fee).toBe(0.8);
    expect(sav.final_fee).toBe(0.64);

    const total = compareTotalCost("spot", "JP", 1_000, { accountAssetsUsd: 100_000 }) as any[];
    expect(total.find((x) => x.exchange === "okx").tier).toBe("VIP1");

    const rec = recommendExchange("spot", "JP", 1_000, {
      accountAssetsUsd: 500_000_000,
      makerShare: 1,
    }) as any;
    expect(rec.best.exchange).toBe("okx");
    expect(rec.best.tier).toBe("VIP9");
    expect(rec.best.score).toBe(100);
  });
});

describe("v0.10: calculate_annual_cost", () => {
  beforeEach(() => resetCachesForTest());

  it("annualizes spot trading fees and quotes the next-tier saving (OKX)", () => {
    const r = calculateAnnualCost("okx", "spot", "JP", 1_000_000) as any;
    expect(r.exchange).toBe("okx");
    expect(r.tier).toBe("VIP1");
    // Pure taker 0.08% with 20% referral = 0.064% -> 640/mo -> 7680/yr
    expect(r.annual_trading_fee).toBe(7680);
    expect(r.annual_funding_cost).toBe(0);
    expect(r.annual_withdrawal_cost).toBe(0);
    expect(r.annual_total_cost).toBe(7680);
    // Next VIP2: taker 0.07% -> 0.056% -> 560/mo -> 6720/yr -> save 960
    expect(r.upgrade.next_tier).toBe("VIP2");
    expect(r.upgrade.requires_volume_usd).toBe(5_000_000);
    expect(r.upgrade.requires_assets_usd).toBe(200_000);
    expect(r.upgrade.annual_fee_current).toBe(7680);
    expect(r.upgrade.annual_fee_next_tier).toBe(6720);
    expect(r.upgrade.annual_savings).toBe(960);
    expect(r.upgrade.hint).toContain("VIP2");
  });

  it("annualizes futures funding and per-year withdrawal fees (Binance)", () => {
    const r = calculateAnnualCost("binance", "futures", "JP", 1_000_000, {
      holdingHours: 720,
      withdrawalAsset: "USDT",
      withdrawalNetwork: "TRC-20",
      withdrawalsPerYear: 12,
    }) as any;
    expect(r.tier).toBe("Regular");
    // 0.05% taker with 20% referral = 0.04% -> 400/mo -> 4800/yr
    expect(r.annual_trading_fee).toBe(4800);
    // 720h / 8h = 90 intervals/mo; 1M * 0.01% = 100 each -> 9000/mo -> 108000/yr
    expect(r.annual_funding_cost).toBe(108000);
    // 12 withdrawals x $1.5 TRC-20 fee (2026-09 schedule)
    expect(r.annual_withdrawal_cost).toBe(18);
    expect(r.withdrawals_per_year).toBe(12);
    expect(r.annual_total_cost).toBe(112818);
    expect(r.upgrade.next_tier).toBe("VIP1");
    expect(r.upgrade.requires_volume_usd).toBe(15_000_000);
    expect(r.upgrade.requires_bnb).toBeUndefined();
    // VIP1 futures taker 0.04% -> 0.032% -> 3840/yr -> save 960
    expect(r.upgrade.annual_fee_next_tier).toBe(3840);
    expect(r.upgrade.annual_savings).toBe(960);
  });

  it("prices negative maker tiers as annual rebates and larger next-tier rebates", () => {
    const r = calculateAnnualCost("okx", "spot", "JP", 500_000_000, { makerShare: 1 }) as any;
    expect(r.tier).toBe("VIP7");
    // -0.002% x 500M = -10000/mo -> -120000/yr
    expect(r.annual_trading_fee).toBe(-120000);
    expect(r.annual_total_cost).toBe(-120000);
    // VIP8 -0.005% -> -25000/mo -> -300000/yr -> 180000 more rebate per year
    expect(r.upgrade.next_tier).toBe("VIP8");
    expect(r.upgrade.requires_assets_usd).toBe(250_000_000);
    expect(r.upgrade.annual_fee_next_tier).toBe(-300000);
    expect(r.upgrade.annual_savings).toBe(180000);
  });

  it("follows the Gate GT upgrade path into the annual quote", () => {
    // $500k volume alone is VIP0; 1000 GT lifts the effective tier to VIP1.
    const r = calculateAnnualCost("gate", "spot", "JP", 500_000, {
      tokenBalance: 1000,
    }) as any;
    expect(r.tier).toBe("VIP1");
    expect(r.volume_tier).toBe("VIP0");
    // 0.18% x 0.8 referral = 0.144% -> 720/mo -> 8640/yr
    expect(r.annual_trading_fee).toBe(8640);
    // VIP2 0.16% x 0.8 = 0.128% -> 640/mo -> 7680/yr -> save 960
    expect(r.upgrade.next_tier).toBe("VIP2");
    expect(r.upgrade.requires_gt).toBe(3000);
    expect(r.upgrade.annual_savings).toBe(960);
    expect(r.tier_warning).toContain("GT");
  });

  it("supports display currency conversion", () => {
    const r = calculateAnnualCost("okx", "spot", "JP", 1_000_000, { currency: "CNH" }) as any;
    const cnhRate = 7.2;
    expect(r.currency).toBe("CNH");
    expect(r.annual_trading_fee).toBe(Math.round(7680 * cnhRate * 100) / 100);
  });

  it("returns structured errors for bad volume, unknown exchange, and blocked country", () => {
    const badVolume = calculateAnnualCost("okx", "spot", "JP", 0);
    expect(isToolErrorLike(badVolume)).toBe(true);
    expect((badVolume as any).code).toBe("INVALID_INPUT");

    const unknown = calculateAnnualCost("ftx", "spot", "JP", 1000);
    expect((unknown as any).code).toBe("UNKNOWN_EXCHANGE");

    const blocked = calculateAnnualCost("binance", "spot", "CN", 1000);
    expect((blocked as any).code).toBe("COUNTRY_BLOCKED");
  });
});

describe("v0.11: Bybit / MEXC / Bitget coverage", () => {
  beforeEach(() => resetCachesForTest());

  // ---- Bybit: volume OR account assets (dual-track) ----
  it("bybit spot VIP1 via $1M volume", () => {
    const r = resolveFeeRate("bybit", "spot", 1_000_000)!;
    expect(r.tier).toBe("VIP1");
    expect(r.base_maker).toBe(0.0675);
    expect(r.base_taker).toBe(0.08);
  });

  it("bybit spot lifts to VIP4 via $1M account assets (volume path lower)", () => {
    const r = resolveFeeRate("bybit", "spot", 0, undefined, 1_000_000)!;
    expect(r.tier).toBe("VIP4");
    expect(r.tier_upgraded).toBe(true);
    expect(r.base_maker).toBe(0.05);
  });

  it("bybit futures VIP0 taker 0.055", () => {
    const r = resolveFeeRate("bybit", "futures", 0)!;
    expect(r.tier).toBe("VIP0");
    expect(r.base_maker).toBe(0.02);
    expect(r.base_taker).toBe(0.055);
  });

  it("bybit futures Supreme via $500M volume (zero maker)", () => {
    const r = resolveFeeRate("bybit", "futures", 500_000_000)!;
    expect(r.tier).toBe("Supreme");
    expect(r.base_maker).toBe(0);
    expect(r.base_taker).toBe(0.03);
  });

  // ---- MEXC: flat Standard tier + MX discounts ----
  it("mexc stays Standard at any volume (spot 0/0.05, futures 0.01/0.04)", () => {
    const spot = resolveFeeRate("mexc", "spot", 250_000_000)!;
    expect(spot.tier).toBe("Standard");
    expect(spot.base_maker).toBe(0);
    expect(spot.base_taker).toBe(0.05);
    const fut = resolveFeeRate("mexc", "futures", 0)!;
    expect(fut.tier).toBe("Standard");
    expect(fut.base_maker).toBe(0.01);
    expect(fut.base_taker).toBe(0.04);
  });

  it("mexc MX toggle: 20% off by default, 500+ MX lifts it to 50%", () => {
    const base = calculateSavings("mexc", 100_000, "spot", "JP", { useToken: true }) as any;
    // taker 0.05% - 20% = 0.04% -> 40; no referral layer
    expect(base.token_applied).toBe(true);
    expect(base.final_fee).toBe(40);
    expect(base.referral_url).toBeUndefined();

    const rich = calculateSavings("mexc", 100_000, "spot", "JP", {
      useToken: true,
      tokenBalance: 500,
    }) as any;
    // 50% MX holding tier beats the 20% toggle
    expect(rich.final_fee).toBe(25);

    const futMaker = calculateSavings("mexc", 100_000, "futures", "JP", {
      useToken: true,
      tokenBalance: 500,
      makerShare: 1,
    }) as any;
    // futures maker 0.01% - 50% = 0.005% -> 5
    expect(futMaker.final_fee).toBe(5);
  });

  // ---- Bitget: VIP ladder + BGB 20% deduction ----
  it("bitget spot VIP1 via $30k assets with zero volume", () => {
    const r = resolveFeeRate("bitget", "spot", 0, undefined, 30_000)!;
    expect(r.tier).toBe("VIP1");
    expect(r.base_maker).toBe(0.08);
  });

  it("bitget BGB deduction takes 20% off spot taker", () => {
    const r = calculateSavings("bitget", 100_000, "spot", "JP", { useToken: true }) as any;
    // taker 0.1% → token -20% → referral -20% = 0.064% → 64
    expect(r.token_applied).toBe(true);
    expect(r.final_fee).toBe(64);
    expect(r.referral_discount).toBe("20%");
  });

  it("bitget futures VIP7 via $1B volume (zero maker)", () => {
    const r = resolveFeeRate("bitget", "futures", 1_000_000_000)!;
    expect(r.tier).toBe("VIP7");
    expect(r.base_maker).toBe(0);
  });

  // ---- Referral-optional behaviour ----
  it("getReferralLink returns NO_REFERRAL_LINK for exchanges without links", () => {
    for (const ex of ["bybit", "mexc"]) {
      const r = getReferralLink(ex, "JP") as any;
      expect(r.code).toBe("NO_REFERRAL_LINK");
    }
  });

  it("calculateSavings for mexc works without a referral layer", () => {
    const r = calculateSavings("mexc", 100_000, "spot", "JP") as any;
    expect(r.original_fee).toBe(50);
    expect(r.fee_after_referral).toBe(50);
    expect(r.final_fee).toBe(50);
    expect(r.total_savings).toBe(0);
    expect(r.referral_url).toBeUndefined();
  });

  it("compareTotalCost includes mexc with zero withdrawal-fee data gracefully", () => {
    const r = compareTotalCost("spot", "JP", 10_000) as any[];
    const mexc = r.find((x) => x.exchange === "mexc");
    expect(mexc).toBeDefined();
    expect(mexc.trading_fee).toBe(5); // 10000 * 0.0005
  });

  // ---- Compliance ----
  it("US allows okx + gate + kraken + coinbase + bitstamp spot (bybit/mexc/bitget/kucoin/blofin blocked)", () => {
    const r = compareExchangeFees("spot", "US") as any[];
    expect(r.map((x) => x.exchange).sort()).toEqual(["bitstamp", "coinbase", "gate", "kraken", "okx"]);
  });

  it("CN includes the three new exchanges and hyperliquid but blocks kucoin and kraken", () => {
    const r = compareExchangeFees("spot", "CN") as any[];
    const names = r.map((x) => x.exchange).sort();
    expect(names).toEqual(["bitget", "bybit", "gate", "hyperliquid", "mexc", "okx", "phemex"]);
    expect(names).not.toContain("kucoin");
    expect(names).not.toContain("kraken");
  });
});

describe("v0.12: pair-level fees & promos", () => {
  beforeEach(() => resetCachesForTest());

  it("normalizePair-style matching: BTCUSDT, btc-usdt, BTC/USDT all hit", () => {
    const r = calculateSavings("mexc", 100_000, "spot", "JP", { pair: "BTCUSDT" }) as any;
    expect(r.pricing_basis).toBe("pair");
    const r2 = calculateSavings("mexc", 100_000, "spot", "JP", { pair: "btc-usdt" }) as any;
    expect(r2.pricing_basis).toBe("pair");
    const r3 = calculateSavings("mexc", 100_000, "spot", "JP", { pair: "BTC/USDT" }) as any;
    expect(r3.pricing_basis).toBe("pair");
  });

  it("mexc BTC/USDT spot promo: 0 maker + 0 taker beats the standard 0/0.05", () => {
    const r = calculateSavings("mexc", 100_000, "spot", "JP", { pair: "BTC/USDT" }) as any;
    expect(r.original_fee).toBe(0);
    expect(r.final_fee).toBe(0);
    expect(r.total_savings).toBe(0);
    expect(r.pricing_basis).toBe("pair");
    expect(r.pair_note).toContain("0-fee");
  });

  it("mexc futures promo covers SOL/USDT with account-evaluation note", () => {
    const r = calculateSavings("mexc", 100_000, "futures", "JP", { pair: "SOL/USDT" }) as any;
    expect(r.pricing_basis).toBe("pair");
    expect(r.final_fee).toBe(0);
    expect(r.pair_note).toContain("account-evaluated");
  });

  it("binance FDUSD zero-maker overrides maker only; taker stays tier-based", () => {
    const r = resolveFeeRate("binance", "spot", 0)!;
    expect(r.base_maker).toBe(0.1); // sanity: tier rate before override
    const s = calculateSavings("binance", 100_000, "spot", "JP", { pair: "BTC/FDUSD", makerShare: 1 }) as any;
    // maker 0 (pair override) -> fee 0 even though taker is untouched
    expect(s.original_fee).toBe(0);
    expect(s.pricing_basis).toBe("pair");
    // taker side falls back to the account tier (0.1%)
    const takerOnly = calculateSavings("binance", 100_000, "spot", "JP", { pair: "BTC/FDUSD" }) as any;
    expect(takerOnly.original_fee).toBe(100);
  });

  it("binance USDC pairs override both sides (0 maker / 0.095 taker)", () => {
    const r = calculateSavings("binance", 100_000, "spot", "JP", { pair: "ETH/USDC" }) as any;
    expect(r.original_fee).toBe(95);
    expect(r.pricing_basis).toBe("pair");
  });

  it("bitget USDC/USDT promo is 0/0", () => {
    const r = calculateSavings("bitget", 100_000, "spot", "JP", { pair: "USDC/USDT" }) as any;
    expect(r.final_fee).toBe(0);
    expect(r.pair_note).toContain("does not count toward VIP");
  });

  it("unmatched pair falls back to account-tier pricing", () => {
    const r = calculateSavings("binance", 100_000, "spot", "JP", { pair: "PEPE/USDT" }) as any;
    expect(r.pricing_basis).toBe("account_tier");
    expect(r.pair_note).toBeUndefined();
    expect(r.original_fee).toBe(100);
  });

  it("no pair argument keeps v0.11 behaviour (account_tier)", () => {
    const r = compareExchangeFees("spot", "JP") as any[];
    for (const row of r) {
      expect(row.pricing_basis).toBe("account_tier");
      expect(row.pair_note).toBeUndefined();
    }
  });

  it("compareExchangeFees with pair mixes pair promos and tier pricing per exchange", () => {
    const r = compareExchangeFees("spot", "JP", { pair: "BTC/USDT", makerShare: 0.5 }) as any[];
    const byName = Object.fromEntries(r.map((x) => [x.exchange, x]));
    // MEXC 0/0 promo wins outright
    expect(byName.mexc.pricing_basis).toBe("pair");
    expect(byName.mexc.weighted_rate).toBe(0);
    // Others keep account-tier pricing for BTC/USDT (no standing promo)
    expect(byName.binance.pricing_basis).toBe("account_tier");
    expect(byName.bybit.pricing_basis).toBe("account_tier");
  });

  it("recommendExchange with pair puts mexc first with pair advice", () => {
    const r = recommendExchange("spot", "JP", 100_000, { pair: "BTC/USDT" }) as any;
    expect(r.best.exchange).toBe("mexc");
    expect(r.best.score).toBe(100);
    expect(r.best.pricing_basis).toBe("pair");
    expect(r.advice).toContain("Pair-level pricing applies to mexc");
  });

  it("calculateAnnualCost respects pair promos", () => {
    const r = calculateAnnualCost("mexc", "spot", "JP", 100_000, { pair: "BTC/USDT" }) as any;
    expect(r.annual_trading_fee).toBe(0);
    expect(r.pricing_basis).toBe("pair");
  });

  it("compareTotalCost includes pair promos in total cost", () => {
    const r = compareTotalCost("spot", "JP", 10_000, { pair: "BTC/USDT" }) as any[];
    const mexc = r.find((x) => x.exchange === "mexc");
    expect(mexc.trading_fee).toBe(0);
    expect(mexc.pricing_basis).toBe("pair");
  });
});

describe("v0.13: KuCoin integration (VIP0-12, KCS OR-ladder, Class A/B/C)", () => {
  beforeEach(() => resetCachesForTest());

  // ---- Volume-only tier resolution (Class A ladder) ----
  it("kucoin spot VIP0 defaults 0.1/0.1 and VIP1 at $1M volume is 0.095/0.1", () => {
    const v0 = resolveFeeRate("kucoin", "spot", 0)!;
    expect(v0.tier).toBe("VIP0");
    expect(v0.base_maker).toBe(0.1);
    expect(v0.base_taker).toBe(0.1);
    expect(v0.token_name).toBe("KCS");
    const v1 = resolveFeeRate("kucoin", "spot", 1_000_000)!;
    expect(v1.tier).toBe("VIP1");
    expect(v1.base_maker).toBe(0.095);
    expect(v1.base_taker).toBe(0.1);
  });

  it("kucoin spot upper tiers: VIP8 zero maker and VIP12 0/0.025", () => {
    const v8 = resolveFeeRate("kucoin", "spot", 250_000_000)!;
    expect(v8.tier).toBe("VIP8");
    expect(v8.base_maker).toBe(0);
    expect(v8.base_taker).toBe(0.042);
    const v12 = resolveFeeRate("kucoin", "spot", 0, 150_000)!;
    expect(v12.tier).toBe("VIP12");
    expect(v12.base_maker).toBe(0);
    expect(v12.base_taker).toBe(0.025);
  });

  // ---- Futures: separate per-product volume thresholds ----
  it("kucoin futures use their own volume ladder (VIP1 at $500k, not $1M)", () => {
    expect(resolveFeeRate("kucoin", "futures", 499_999)!.tier).toBe("VIP0");
    const v1 = resolveFeeRate("kucoin", "futures", 500_000)!;
    expect(v1.tier).toBe("VIP1");
    expect(v1.base_maker).toBe(0.018);
    expect(v1.base_taker).toBe(0.06);
    const v9 = resolveFeeRate("kucoin", "futures", 400_000_000)!;
    expect(v9.tier).toBe("VIP9");
    expect(v9.base_maker).toBe(0);
    expect(v9.base_taker).toBe(0.033);
  });

  // ---- KCS holdings OR-ladder ----
  it("KCS holdings alone upgrade spot tiers at zero volume (exact thresholds)", () => {
    expect(resolveFeeRate("kucoin", "spot", 0, 999)!.tier).toBe("VIP0");
    expect(resolveFeeRate("kucoin", "spot", 0, 1_000)!.tier).toBe("VIP1");
    const v2 = resolveFeeRate("kucoin", "spot", 0, 12_000)!;
    expect(v2.tier).toBe("VIP2");
    expect(v2.base_maker).toBe(0.09);
    expect(v2.volume_tier).toBe("VIP0");
    expect(v2.tier_upgraded).toBe(true);
    expect(resolveFeeRate("kucoin", "spot", 0, 40_000)!.tier).toBe("VIP5");
  });

  it("KCS also upgrades futures tiers and can never downgrade the volume tier", () => {
    const viaKcs = resolveFeeRate("kucoin", "futures", 0, 1_000)!;
    expect(viaKcs.tier).toBe("VIP1");
    expect(viaKcs.base_maker).toBe(0.018);
    // $500k volume already reaches VIP1; 1,000 KCS ties it — no downgrade flag.
    const tied = resolveFeeRate("kucoin", "futures", 500_000, 1_000)!;
    expect(tied.tier).toBe("VIP1");
    expect(tied.tier_held_back).toBeUndefined();
    // Zero KCS never holds back an OR ladder.
    const zero = resolveFeeRate("kucoin", "spot", 1_000_000, 0)!;
    expect(zero.tier).toBe("VIP1");
    expect(zero.tier_held_back).toBeUndefined();
  });

  it("effective tier is the higher of volume rung and KCS rung", () => {
    // $100M volume = VIP6; 1,000 KCS alone = VIP1 -> stays VIP6
    expect(resolveFeeRate("kucoin", "spot", 100_000_000, 1_000)!.tier).toBe("VIP6");
    // 150,000 KCS = VIP12 -> upgrades above volume VIP6
    const top = resolveFeeRate("kucoin", "spot", 100_000_000, 150_000)!;
    expect(top.tier).toBe("VIP12");
    expect(top.volume_tier).toBe("VIP6");
    expect(top.tier_upgraded).toBe(true);
  });

  it("surfaces a KCS upgrade hint when holdings are unknown", () => {
    const rows = compareExchangeFees("spot", "JP", { monthlyVolumeUsd: 1_000_000 }) as any[];
    const kc = rows.find((x) => x.exchange === "kucoin");
    expect(kc.tier).toBe("VIP1");
    expect(kc.tier_warning).toContain("10,000 KCS");
    expect(kc.tier_warning).toContain("VIP2");
    // After providing enough KCS the warning explains the upgrade itself.
    const upgraded = compareExchangeFees("spot", "JP", {
      monthlyVolumeUsd: 1_000_000,
      tokenBalance: 10_000,
    }) as any[];
    const kcUp = upgraded.find((x) => x.exchange === "kucoin");
    expect(kcUp.tier).toBe("VIP2");
    expect(kcUp.volume_tier).toBe("VIP1");
    expect(kcUp.tier_warning).toContain("lifts the effective fee tier to VIP2");
  });

  // ---- KCS 20% fee deduction ----
  it("KCS deduction takes 20% off spot fees with no referral layer", () => {
    const r = calculateSavings("kucoin", 100_000, "spot", "JP", { useToken: true }) as any;
    // taker 0.1% - 20% = 0.08% -> 80
    expect(r.token_applied).toBe(true);
    expect(r.final_fee).toBe(80);
    expect(r.referral_url).toBeUndefined();
  });

  it("at VIP8+ zero maker stays zero; KCS discount lands on taker only", () => {
    const taker = calculateSavings("kucoin", 250_000_000, "spot", "JP", { useToken: true }) as any;
    // taker 0.042% - 20% = 0.0336% -> 250M * 0.000336 = 84,000
    expect(taker.final_fee).toBe(84_000);
    const maker = calculateSavings("kucoin", 250_000_000, "spot", "JP", {
      useToken: true,
      makerShare: 1,
    }) as any;
    expect(maker.final_fee).toBe(0);
  });

  // ---- Spot Class A/B/C metadata ----
  it("exposes Class A/B/C metadata and annotates spot results only", () => {
    const classes = getSpotFeeClasses("kucoin")!;
    expect(classes.primary).toBe("A");
    expect(classes.multipliers.B).toBe(2);
    expect(classes.multipliers.C).toBe(3);
    expect(getSpotFeeClasses("gate")).toBeNull();

    const spot = compareExchangeFees("spot", "JP") as any[];
    const kcSpot = spot.find((x) => x.exchange === "kucoin");
    expect(kcSpot.spot_class_note).toContain("Class A");
    expect(kcSpot.spot_class_note).toContain("2x");
    const futures = compareExchangeFees("futures", "JP") as any[];
    const kcFut = futures.find((x) => x.exchange === "kucoin");
    expect(kcFut.spot_class_note).toBeUndefined();
  });

  // ---- Funding & withdrawals ----
  it("has 8h 0.01% funding and TRC-20/ERC-20 USDT withdrawal fees", () => {
    const fr = getFundingRate("kucoin")!;
    expect(fr.interval_hours).toBe(8);
    expect(fr.avg_rate_pct).toBe(0.01);
    const sav = calculateSavings("kucoin", 100_000, "futures", "JP", { holdingHours: 16 }) as any;
    expect(sav.funding_cost).toBe(20);
    const total = compareTotalCost("futures", "JP", 100_000, {
      holdingHours: 16,
      withdrawalAsset: "USDT",
      withdrawalNetwork: "TRC-20",
    }) as any[];
    const kc = total.find((x) => x.exchange === "kucoin");
    expect(kc.funding_cost).toBe(20);
    expect(kc.withdrawal_cost).toBe(1.5);
    const erc20 = compareTotalCost("futures", "JP", 100_000, {
      withdrawalAsset: "USDT",
      withdrawalNetwork: "ERC-20",
    }) as any[];
    expect(erc20.find((x) => x.exchange === "kucoin").withdrawal_cost).toBe(5.5);
  });

  // ---- Compliance ----
  it("blocks kucoin in US/CN/HK/SG/TH and serves it in JP; no referral link yet", () => {
    for (const cc of ["US", "CN", "HK", "SG", "TH"]) {
      const r = calculateSavings("kucoin", 1_000, "spot", cc);
      expect((r as any).code).toBe("COUNTRY_BLOCKED");
    }
    const jp = calculateSavings("kucoin", 1_000, "spot", "JP") as any;
    expect(jp.error).toBeUndefined();
    const link = getReferralLink("kucoin", "JP") as any;
    expect(link.code).toBe("NO_REFERRAL_LINK");
  });

  // ---- Annual cost KCS upgrade path ----
  it("annual quote offers the next tier via volume OR KCS holdings", () => {
    const r = calculateAnnualCost("kucoin", "spot", "JP", 500_000, { makerShare: 1 }) as any;
    expect(r.tier).toBe("VIP0");
    // maker 0.1% -> 500/mo -> 6000/yr (no referral)
    expect(r.annual_trading_fee).toBe(6000);
    expect(r.upgrade.next_tier).toBe("VIP1");
    expect(r.upgrade.requires_volume_usd).toBe(1_000_000);
    expect(r.upgrade.requires_kcs).toBe(1_000);
    // VIP1 maker 0.095% -> 475/mo -> 5700/yr -> save 300
    expect(r.upgrade.annual_savings).toBe(300);
    expect(r.upgrade.hint).toContain("1,000 KCS holdings");
  });
});

describe("v0.14: Kraken integration (unified Tier/Pro, triple-track AOP, maker rebates)", () => {
  beforeEach(() => resetCachesForTest());

  // ---- Spot volume ladder (17 unified tiers) ----
  it("kraken spot starts at Tier 1 0.40/0.80 and walks the volume ladder", () => {
    const t1 = resolveFeeRate("kraken", "spot", 0)!;
    expect(t1.tier).toBe("Tier 1");
    expect(t1.base_maker).toBe(0.4);
    expect(t1.base_taker).toBe(0.8);
    expect(t1.asset_gate).toBe(true);
    expect(resolveFeeRate("kraken", "spot", 2_500)!.tier).toBe("Tier 2");
    const t2 = resolveFeeRate("kraken", "spot", 2_500)!;
    expect(t2.base_maker).toBe(0.3);
    expect(t2.base_taker).toBe(0.6);
    expect(resolveFeeRate("kraken", "spot", 10_000)!.tier).toBe("Tier 3");
    expect(resolveFeeRate("kraken", "spot", 9_999_999)!.tier).toBe("Tier 11");
    const t12 = resolveFeeRate("kraken", "spot", 10_000_000)!;
    expect(t12.tier).toBe("Tier 12");
    expect(t12.base_maker).toBe(0);
    expect(t12.base_taker).toBe(0.1);
  });

  it("kraken spot Pro levels: $50M -> Pro 1, $500M -> Pro 5 at 0/0.05", () => {
    expect(resolveFeeRate("kraken", "spot", 50_000_000)!.tier).toBe("Pro 1");
    const p5 = resolveFeeRate("kraken", "spot", 500_000_000)!;
    expect(p5.tier).toBe("Pro 5");
    expect(p5.base_maker).toBe(0);
    expect(p5.base_taker).toBe(0.05);
  });

  // ---- Per-product volume thresholds (same tier name, different ladders) ----
  it("uses per-product thresholds: $5M is Tier 11 spot but only Tier 2 futures", () => {
    const spot = resolveFeeRate("kraken", "spot", 5_000_000)!;
    expect(spot.tier).toBe("Tier 11");
    expect(spot.base_maker).toBe(0.02);
    expect(spot.base_taker).toBe(0.12);
    const fut = resolveFeeRate("kraken", "futures", 5_000_000)!;
    expect(fut.tier).toBe("Tier 2");
    expect(fut.base_maker).toBe(0.0175);
    expect(fut.base_taker).toBe(0.045);
    expect(resolveFeeRate("kraken", "futures", 10_000_000)!.tier).toBe("Tier 3");
  });

  // ---- AOP (assets on platform) OR-ladder ----
  it("AOP upgrades zero-volume spot/futures to Tier 3 and reports the asset path", () => {
    const spot = resolveFeeRate("kraken", "spot", 0, undefined, 20_000)!;
    expect(spot.tier).toBe("Tier 3");
    expect(spot.volume_tier).toBe("Tier 1");
    expect(spot.base_maker).toBe(0.22);
    expect(spot.tier_upgraded).toBe(true);
    expect(spot.upgrade_basis).toBe("assets");
    expect(spot.asset_gate).toBe(true);
    expect(spot.min_assets_usd).toBe(20_000);
    expect(spot.next_tier).toBe("Tier 4");
    expect(spot.next_min_assets).toBe(50_000);
    const fut = resolveFeeRate("kraken", "futures", 0, undefined, 20_000)!;
    expect(fut.tier).toBe("Tier 3");
    expect(fut.base_maker).toBe(0.015);
    expect(fut.base_taker).toBe(0.04);
  });

  it("Tier 1 and Tier 2 have no asset path — holdings skip straight to Tier 3", () => {
    // $19,999 AOP is below the first asset threshold (Tier 3 $20k): stays Tier 1.
    expect(resolveFeeRate("kraken", "spot", 0, undefined, 19_999)!.tier).toBe("Tier 1");
    // Huge AOP can never land on Tier 2 — it jumps to the highest asset-qualified tier.
    const top = resolveFeeRate("kraken", "spot", 0, undefined, 100_000_000)!;
    expect(top.tier).toBe("Pro 5");
    expect(top.volume_tier).toBe("Tier 1");
    // Assets only upgrade, never downgrade a volume tier.
    const volTier12 = resolveFeeRate("kraken", "spot", 10_000_000, undefined, 19_999)!;
    expect(volTier12.tier).toBe("Tier 12");
    expect(volTier12.tier_upgraded).toBeUndefined();
  });

  // ---- Negative futures maker rates (rebates) ----
  it("negative futures maker from Tier 11 is a rebate and is never clamped", () => {
    const t11 = resolveFeeRate("kraken", "futures", 250_000_000)!;
    expect(t11.tier).toBe("Tier 11");
    expect(t11.base_maker).toBe(-0.003);
    expect(t11.base_taker).toBe(0.0175);
    const p5 = resolveFeeRate("kraken", "futures", 5_000_000_000)!;
    expect(p5.tier).toBe("Pro 5");
    expect(p5.base_maker).toBe(-0.006);
    expect(p5.base_taker).toBe(0.0125);

    const rows = compareExchangeFees("futures", "JP", {
      monthlyVolumeUsd: 250_000_000,
      makerShare: 1,
    }) as any[];
    const kr = rows.find((x) => x.exchange === "kraken");
    expect(kr.effective_maker).toBe(-0.003);
    expect(kr.weighted_rate).toBe(-0.003);
    // Most-negative maker ranks Kraken first at this volume.
    expect(rows[0].exchange).toBe("kraken");

    const sav = calculateSavings("kraken", 250_000_000, "futures", "JP", { makerShare: 1 }) as any;
    // 250M * -0.003% = -7,500 net rebate; no referral/token layer touches it.
    expect(sav.original_fee).toBe(-7500);
    expect(sav.final_fee).toBe(-7500);
    expect(sav.total_savings).toBe(0);
    expect(sav.token_applied).toBe(false);
  });

  // ---- No native token, no referral link ----
  it("has no native-token discount and no referral link configured", () => {
    expect(getTokenDiscount("kraken")).toBeNull();
    const sav = calculateSavings("kraken", 100_000, "spot", "JP", { useToken: true }) as any;
    expect(sav.token_applied).toBe(false);
    // $100k volume = Tier 6 taker 0.25% -> 250, unchanged by the (absent) token layer.
    expect(sav.tier).toBe("Tier 6");
    expect(sav.final_fee).toBe(250);
    const link = getReferralLink("kraken", "JP") as any;
    expect(link.code).toBe("NO_REFERRAL_LINK");
  });

  // ---- Funding & withdrawals ----
  it("has 8h 0.01% funding and dynamic BTC/USDT withdrawal fees", () => {
    const fr = getFundingRate("kraken")!;
    expect(fr.interval_hours).toBe(8);
    expect(fr.avg_rate_pct).toBe(0.01);
    const sav = calculateSavings("kraken", 100_000, "futures", "JP", { holdingHours: 16 }) as any;
    expect(sav.funding_cost).toBe(20);

    const trc = compareTotalCost("futures", "JP", 100_000, {
      holdingHours: 16,
      withdrawalAsset: "USDT",
      withdrawalNetwork: "TRC-20",
    }) as any[];
    const kr = trc.find((x) => x.exchange === "kraken");
    expect(kr.funding_cost).toBe(20);
    expect(kr.withdrawal_cost).toBe(1);

    const erc = compareTotalCost("futures", "JP", 100_000, {
      withdrawalAsset: "USDT",
      withdrawalNetwork: "ERC-20",
    }) as any[];
    // Kraken USDT ERC-20 dynamic fee 0.6442 (2026-07-16 snapshot); total-cost
    // money fields are rounded to cents: 0.6442 -> 0.64.
    expect(erc.find((x) => x.exchange === "kraken").withdrawal_cost).toBe(0.64);

    // Kraken BTC 0.00015 x price snapshot 77,298 = 11.5947 -> 11.59 at cent precision.
    const btc = compareTotalCost("futures", "JP", 100_000, { withdrawalAsset: "BTC" }) as any[];
    expect(btc.find((x) => x.exchange === "kraken").withdrawal_cost).toBe(11.59);
  });

  // ---- Compliance ----
  it("serves Kraken in US/HK/JP/TH and blocks it in CN/SG", () => {
    for (const cc of ["US", "HK", "JP", "TH"]) {
      const r = calculateSavings("kraken", 1_000, "spot", cc);
      expect((r as any).error).toBeUndefined();
    }
    for (const cc of ["CN", "SG"]) {
      const r = calculateSavings("kraken", 1_000, "spot", cc);
      expect((r as any).code).toBe("COUNTRY_BLOCKED");
    }
    // US comparison now surfaces Kraken alongside gate and okx.
    const us = compareExchangeFees("spot", "US") as any[];
    expect(us.find((x) => x.exchange === "kraken")).toBeDefined();
    const sg = compareExchangeFees("spot", "SG") as any[];
    expect(sg.find((x) => x.exchange === "kraken")).toBeUndefined();
    // v0.19: Coinbase (MAS-licensed) joins the SG whitelist — 6 + coinbase.
    // v0.20: Hyperliquid (no SG front-end block) also serves SG.
    // v0.24: Phemex (Singapore-based) also serves SG.
    // v0.38: Bitstamp (MAS MPI) joins spot (its futures stay product-gated).
    expect(sg.length).toBe(10);
  });

  // ---- Tier warning copy (AOP, fee-tier nouns) ----
  it("explains the AOP upgrade path with Kraken-specific wording", () => {
    const unknown = compareExchangeFees("spot", "JP", { monthlyVolumeUsd: 1_000_000 }) as any[];
    const kr = unknown.find((x) => x.exchange === "kraken");
    expect(kr.tier).toBe("Tier 9");
    expect(kr.tier_warning).toContain("assets on platform (AOP)");
    expect(kr.tier_warning).toContain("fee tiers");
    expect(kr.tier_warning).toContain("$2,500,000");
    expect(kr.tier_warning).toContain("Tier 10");

    const upgraded = compareExchangeFees("spot", "JP", {
      monthlyVolumeUsd: 0,
      accountAssetsUsd: 20_000,
    }) as any[];
    const krUp = upgraded.find((x) => x.exchange === "kraken");
    expect(krUp.tier).toBe("Tier 3");
    expect(krUp.volume_tier).toBe("Tier 1");
    expect(krUp.tier_warning).toContain("lift the effective fee tier to Tier 3");
  });

  // ---- Exchange notes surface on every tool path ----
  it("surfaces exchange_notes for Kraken (and never for other exchanges)", () => {
    expect(getExchangeNotes("kraken")!.length).toBeGreaterThanOrEqual(4);
    expect(getExchangeNotes("binance")).toBeNull();
    const joined = getExchangeNotes("kraken")!.join(" ");
    expect(joined).toContain("AOP");
    expect(joined).toContain("cross-product");

    const cmp = compareExchangeFees("futures", "JP") as any[];
    const krCmp = cmp.find((x) => x.exchange === "kraken");
    expect(krCmp.exchange_notes).toBeDefined();
    expect(krCmp.exchange_notes.length).toBeGreaterThanOrEqual(4);
    expect(cmp.find((x) => x.exchange === "okx").exchange_notes).toBeUndefined();

    const sav = calculateSavings("kraken", 1_000, "spot", "JP") as any;
    expect(sav.exchange_notes).toBeDefined();
    const total = compareTotalCost("spot", "JP", 1_000) as any[];
    expect(total.find((x) => x.exchange === "kraken").exchange_notes).toBeDefined();
    const annual = calculateAnnualCost("kraken", "spot", "JP", 1_000) as any;
    expect(annual.exchange_notes).toBeDefined();

    const rec = recommendExchange("spot", "US", 100_000) as any;
    const krRec = [rec.best, ...rec.alternatives].find((x: any) => x.exchange === "kraken");
    expect(krRec).toBeDefined();
    expect(krRec.exchange_notes).toBeDefined();
  });

  // ---- Annual cost upgrade quotes ----
  it("annual quote: Tier 2 is volume-only; higher tiers also quote the AOP path", () => {
    // Tier 1 taker 0.8% -> 96/yr; Tier 2 taker 0.6% -> 72/yr; save 24.
    const t1 = calculateAnnualCost("kraken", "spot", "JP", 1_000) as any;
    expect(t1.tier).toBe("Tier 1");
    expect(t1.annual_trading_fee).toBe(96);
    expect(t1.upgrade.next_tier).toBe("Tier 2");
    expect(t1.upgrade.requires_volume_usd).toBe(2_500);
    expect(t1.upgrade.requires_assets_usd).toBeUndefined();
    expect(t1.upgrade.annual_savings).toBe(24);
    expect(t1.upgrade.hint).toContain("$2,500 30-day volume");

    // $100k volume = Tier 6 (taker 0.25%): 250/mo -> 3,000/yr; Tier 7 taker
    // 0.22% -> 264/mo -> 2,640/yr; save 360. Qualify via $250k volume OR $400k AOP.
    const t6 = calculateAnnualCost("kraken", "spot", "JP", 100_000, {
      accountAssetsUsd: 200_000,
    }) as any;
    expect(t6.tier).toBe("Tier 6");
    expect(t6.annual_trading_fee).toBe(3000);
    expect(t6.upgrade.next_tier).toBe("Tier 7");
    expect(t6.upgrade.requires_volume_usd).toBe(250_000);
    expect(t6.upgrade.requires_assets_usd).toBe(400_000);
    expect(t6.upgrade.annual_savings).toBe(360);
    expect(t6.upgrade.hint).toContain("assets on platform (AOP)");
    expect(t6.upgrade.hint).toContain("$400,000");
  });
});

// =====================================================================
// v0.17: fiat on/off-ramp cost
// =====================================================================

describe("v0.17: getFiatCost", () => {
  beforeEach(() => resetCachesForTest());

  it("defaults: USD 1000 deposit ranks free rails first and reports saving vs worst", () => {
    const res = getFiatCost() as any;
    expect(res.direction).toBe("deposit");
    expect(res.currency).toBe("USD");
    expect(res.amount).toBe(1000);
    expect(res.amount_usd).toBe(1000);
    expect(res.fx_rate).toBe(1);
    expect(res.data_as_of).toBe("2026-09");
    expect(res.exchanges).toHaveLength(18);
    // v0.20: Hyperliquid has no direct fiat rails — surfaced as unavailable, never hidden.
    // v0.21: BingX likewise (P2P/third-party gateways only).
    // v0.24: Phemex likewise (no direct fiat rails).
    // v0.37: BloFin likewise (third-party card/SEPA widgets only).
    // v0.38: Bitstamp joins with ACH/SEPA/SWIFT/card direct rails.
    // v0.42: Bitvavo joins with EU-only SEPA/card rails (region routes listed
    // with the absent-country warning, not hidden).
    // v0.43: Finst likewise surfaces EU-only SEPA rails with the absent-country warning.
    // v0.44: Bitpanda likewise surfaces EEA/GB-only EUR/GBP rails — USD unmatched,
    // so it appears unavailable on the USD view rather than being hidden.
    // v0.45: Bison likewise surfaces EEA/CH EUR-only rails — USD unmatched.
    const hl = res.exchanges.find((e: any) => e.exchange === "hyperliquid");
    expect(hl.available).toBe(false);
    expect(hl.routes).toEqual([]);
    const blofin = res.exchanges.find((e: any) => e.exchange === "blofin");
    expect(blofin.available).toBe(false);
    expect(blofin.routes).toEqual([]);
    const bitpandaUsd = res.exchanges.find((e: any) => e.exchange === "bitpanda");
    expect(bitpandaUsd.available).toBe(false);
    expect(bitpandaUsd.routes).toEqual([]);
    const bisonUsd = res.exchanges.find((e: any) => e.exchange === "bison");
    expect(bisonUsd.available).toBe(false);
    expect(bisonUsd.routes).toEqual([]);
    expect(res.exchanges.filter((e: any) => e.available).every((e: any) => e.available)).toBe(true);
    expect(res.exchanges[0].available).toBe(true);

    expect(res.best.fee_usd).toBe(0);
    expect(["okx", "kraken", "bitget"]).toContain(res.best.exchange);
    // KuCoin cards 4.5% = $45 worst.
    const kucoin = res.exchanges.find((e: any) => e.exchange === "kucoin");
    expect(kucoin.cheapest_fee_usd).toBe(45);
    expect(res.saving_vs_worst_usd).toBe(45);
  });

  it("US residency: compliance filter + ACH free at OKX/Kraken/Coinbase/Bitstamp, Gate only has card", () => {
    const res = getFiatCost({ country: "US" }) as any;
    expect(res.exchanges.map((e: any) => e.exchange).sort()).toEqual(["bitstamp", "coinbase", "gate", "kraken", "okx"]);
    expect(res.best.fee_usd).toBe(0);
    expect(res.best.method).toBe("ach");
    const okx = res.exchanges.find((e: any) => e.exchange === "okx");
    expect(okx.routes[0].method).toBe("ach");
    const coinbase = res.exchanges.find((e: any) => e.exchange === "coinbase");
    expect(coinbase.available).toBe(true);
    expect(coinbase.cheapest_fee_usd).toBe(0);
    const gate = res.exchanges.find((e: any) => e.exchange === "gate");
    expect(gate.routes.map((r: any) => r.method)).toEqual(["card"]);
    expect(gate.cheapest_fee_usd).toBe(25);
    // Coinbase's worst rail is its 3.99% card, but cheapest-route logic keeps
    // Gate (card-only, $25) as the most expensive venue to escape.
    expect(res.saving_vs_worst_usd).toBe(25);
  });

  it("EU SEPA deposit (v0.45): free at the CASP-licensed zero-fee venues incl. Bitvavo, Finst, Bitpanda and Bison, Gate uniquely charges 0.5%", () => {
    const res = getFiatCost({ currency: "EUR", amount: 1000, country: "DE" }) as any;
    expect(res.fx_rate).toBe(0.92);
    // v0.41: binance/bitget/mexc/kucoin are EEA region-blocked (no CASP / FMA
    // prohibition); v0.42 adds Bitvavo, v0.43 adds Finst, v0.44 adds Bitpanda
    // and v0.45 adds Bison (BaFin-licensed, EEA+CH), so the eleven
    // EEA-usable venues are priced.
    expect(res.exchanges.map((e: any) => e.exchange).sort()).toEqual(
      ["bison", "bitpanda", "bitstamp", "bitvavo", "bybit", "coinbase", "finst", "gate", "hyperliquid", "kraken", "okx"],
    );
    const free = res.exchanges
      .filter((e: any) => e.cheapest_fee_usd === 0)
      .map((e: any) => e.exchange)
      .sort();
    // v0.42: Bitvavo SEPA/SEPA Instant is free both legs; v0.43: Finst's
    // iDEAL/Bancontact/instant-SEPA legs are free as well (bank-transfer only);
    // v0.44: Bitpanda SEPA/SEPA Instant is free too (funding cost sits in the
    // trading premium, not the rail); v0.45: Bison SEPA/SEPA Instant is free
    // (its 2.49% card surcharge does not affect the cheapest rail).
    expect(free).toEqual(["bison", "bitpanda", "bitstamp", "bitvavo", "finst", "kraken", "okx"]);
    const bitvavo = res.exchanges.find((e: any) => e.exchange === "bitvavo");
    expect(bitvavo.cheapest_method).toBe("sepa");
    expect(bitvavo.routes[0]).toMatchObject({ method: "sepa", fee: 0, fee_usd: 0, effective_pct: 0 });
    const bitpanda = res.exchanges.find((e: any) => e.exchange === "bitpanda");
    expect(bitpanda.cheapest_method).toBe("sepa");
    expect(bitpanda.routes[0]).toMatchObject({ method: "sepa", fee: 0, fee_usd: 0, effective_pct: 0 });
    const bison = res.exchanges.find((e: any) => e.exchange === "bison");
    expect(bison.cheapest_method).toBe("sepa");
    expect(bison.routes[0]).toMatchObject({ method: "sepa", fee: 0, fee_usd: 0, effective_pct: 0 });
    const gate = res.exchanges.find((e: any) => e.exchange === "gate");
    expect(gate.cheapest_method).toBe("sepa");
    expect(gate.routes[0]).toMatchObject({ method: "sepa", fee: 5, fee_usd: 5.43, effective_pct: 0.5, net: 995 });
    // Bybit: SEPA 0.19% (EUR 1.9 at this size) undercuts both card variants and SWIFT.
    const bybit = res.exchanges.find((e: any) => e.exchange === "bybit");
    expect(bybit.routes.map((r: any) => r.method)).toEqual(["sepa", "card", "swift", "card"]);
    expect(bybit.routes[0]).toMatchObject({ method: "sepa", fee: 1.9 });
    expect(bybit.routes[1]).toMatchObject({ method: "card", region: "EU", fee: 11 });
  });

  it("EUR cash-out (v0.45): OKX, Bitvavo, Finst, Bitpanda and Bison free SEPA; Gate 1% SEPA is the most expensive EEA-licensed rail", () => {
    const res = getFiatCost({ direction: "withdraw", currency: "EUR", amount: 1000, country: "DE" }) as any;
    expect(res.best).toMatchObject({ exchange: "okx", method: "sepa", fee: 0, net: 1000 });
    // v0.42: Bitvavo also offers free SEPA cash-out (ties OKX; ordering keeps OKX first).
    const bitvavo = res.exchanges.find((e: any) => e.exchange === "bitvavo");
    expect(bitvavo.cheapest_fee_usd).toBe(0);
    expect(bitvavo.routes.map((r: any) => r.method)).toEqual(["sepa"]);
    expect(res.exchanges).toHaveLength(11);
    // v0.43: Finst also offers free SEPA cash-out (iDEAL/Bancontact/SEPA only).
    const finstOut = res.exchanges.find((e: any) => e.exchange === "finst");
    expect(finstOut.cheapest_fee_usd).toBe(0);
    expect(finstOut.routes.map((r: any) => r.method)).toEqual(["sepa"]);
    // v0.44: Bitpanda also offers free SEPA cash-out (card leg is deposit-only
    // and filtered from the withdraw view).
    const bitpandaOut = res.exchanges.find((e: any) => e.exchange === "bitpanda");
    expect(bitpandaOut.cheapest_fee_usd).toBe(0);
    expect(bitpandaOut.routes.map((r: any) => r.method)).toEqual(["sepa"]);
    // v0.45: Bison also offers free SEPA cash-out (card 2.49% rail is
    // deposit-only and filtered from the withdraw view).
    const bisonOut = res.exchanges.find((e: any) => e.exchange === "bison");
    expect(bisonOut.cheapest_fee_usd).toBe(0);
    expect(bisonOut.routes.map((r: any) => r.method)).toEqual(["sepa"]);
    // Pre-v0.41 MEXC's 5% schedule was worst; MEXC is EEA-blocked now, leaving
    // Gate's 1% SEPA withdrawal (EUR 10 / $10.87) as the costliest direct rail.
    const gate = res.exchanges.find((e: any) => e.exchange === "gate");
    expect(gate.routes[0]).toMatchObject({ method: "sepa", fee: 10, fee_usd: 10.87, net: 990, effective_pct: 1 });
    expect(res.saving_vs_worst_usd).toBe(10.87);
    // Bybit exposes SEPA plus an expensive SWIFT fallback; no card cash-out.
    expect(res.exchanges.find((e: any) => e.exchange === "bybit").routes.map((r: any) => r.method)).toEqual(["sepa", "swift"]);
  });

  it("GBP FPS deposit is free at Kraken; Gate 0.5%, Bybit 0.92% via ZEN, Binance GBP 1 flat", () => {
    const res = getFiatCost({ currency: "GBP", amount: 1000, country: "GB" }) as any;
    expect(res.best).toMatchObject({ exchange: "kraken", method: "fps", fee: 0 });
    const binance = res.exchanges.find((e: any) => e.exchange === "binance");
    expect(binance.routes[0]).toMatchObject({ method: "fps", fee: 1 });
    const gate = res.exchanges.find((e: any) => e.exchange === "gate");
    expect(gate.routes[0]).toMatchObject({ method: "fps", fee: 5 });
    const bybit = res.exchanges.find((e: any) => e.exchange === "bybit");
    expect(bybit.routes[0]).toMatchObject({ method: "fps", fee: 9.2 });
    // Worst = KuCoin card at 4.5% = GBP 45.
    expect(res.saving_vs_worst_usd).toBe(56.96);
  });

  it("BRL PIX deposit free at most venues; Kraken 0.5% IOF-inclusive, Gate charges 3%, cards do not support BRL", () => {
    const res = getFiatCost({ currency: "BRL", amount: 1000, country: "BR" }) as any;
    expect(res.best.fee).toBe(0);
    expect(["binance", "okx", "bybit", "bitget", "kucoin"]).toContain(res.best.exchange);
    const kraken = res.exchanges.find((e: any) => e.exchange === "kraken");
    expect(kraken.routes[0]).toMatchObject({ method: "pix", fee: 5 });
    const gate = res.exchanges.find((e: any) => e.exchange === "gate");
    expect(gate.cheapest_method).toBe("pix");
    expect(gate.cheapest_fee_usd).toBe(5.45);
    // MEXC PIX is partner-only (null direct leg) and cards exclude BRL: unavailable direct.
    const mexc = res.exchanges.find((e: any) => e.exchange === "mexc");
    expect(mexc.available).toBe(false);
    expect(mexc.routes).toEqual([]);
    // v0.20: Hyperliquid joins MEXC as a no-direct-rail venue; v0.21 BingX makes three; v0.24 Phemex makes four; v0.37 BloFin makes five; v0.38 Bitstamp (no PIX) makes six.
    expect(res.warnings[0]).toContain("6 exchanges");
  });

  it("percent + fixed card fee: Kraken 3.75% + 0.25 on EUR 1000 = 37.75", () => {
    const res = getFiatCost({ currency: "EUR", amount: 1000, country: "DE", method: "card", exchanges: ["kraken"] }) as any;
    expect(res.exchanges[0].routes[0]).toMatchObject({
      method: "card",
      fee: 37.75,
      effective_pct: 3.775,
      net: 962.25,
    });
  });

  it("SEPA percentage floor: Bybit 0.19% with EUR 1 minimum on a small transfer", () => {
    const res = getFiatCost({ currency: "EUR", amount: 10, country: "DE", exchanges: ["bybit"] }) as any;
    const sepa = res.exchanges[0].routes.find((r: any) => r.method === "sepa");
    expect(sepa.fee).toBe(1);
  });

  it("card-only filter keeps regional EU variants for EU residents and global cards elsewhere", () => {
    const de = getFiatCost({ currency: "EUR", amount: 1000, country: "DE", method: "card" }) as any;
    // v0.45: eleven EEA-usable venues (eight quote cards incl. Bitpanda free
    // since its 2026 pricing change and Bison at 2.49%; coinbase/hyperliquid
    // have none and Finst is bank-transfer-only).
    expect(de.exchanges).toHaveLength(11);
    // v0.44: Bitpanda's Visa/MC/PayPal/Apple Pay card rail carries no surcharge
    // (the cost is recovered in the trading premium), so it beats v0.42
    // Bitvavo's ~1% card (EUR 10).
    expect(de.best).toMatchObject({ exchange: "bitpanda", method: "card", fee: 0 });
    // v0.42: Bitvavo's ~1% EU card is now the cheapest SURCHARGED rail
    // (EUR 10 = $10.87 at the 0.92 FX rate), narrowly beating Bybit's 1.1% (EUR 11);
    // v0.45 Bison's 2.49% instant card/Apple/Google Pay (EUR 24.90 = $27.07) is pricier.
    const bitvavoCard = de.exchanges.find((e: any) => e.exchange === "bitvavo");
    expect(bitvavoCard.cheapest_fee_usd).toBe(10.87);
    // v0.45: Bison quotes a card rail at 2.49% (Solaris/Deutsche Bank instant
    // funding fee), deposit-only — present and available in the card view.
    const bisonCard = de.exchanges.find((e: any) => e.exchange === "bison");
    expect(bisonCard.available).toBe(true);
    expect(bisonCard.routes[0]).toMatchObject({ method: "card", fee: 24.9, fee_usd: 27.07 });
    // v0.43: Finst lists no card rail — present as an EEA venue but unavailable.
    const finstCard = de.exchanges.find((e: any) => e.exchange === "finst");
    expect(finstCard.available).toBe(false);
    expect(finstCard.routes).toEqual([]);
    // EU residents see both the EU-issued 1.1% card and the global 3.05% variant.
    const bybitDe = de.exchanges.find((e: any) => e.exchange === "bybit");
    expect(bybitDe.routes).toHaveLength(2);
    expect(bybitDe.routes[0]).toMatchObject({ fee: 11, region: "EU" });

    const jp = getFiatCost({ currency: "EUR", amount: 1000, country: "JP", method: "card", exchanges: ["bybit"] }) as any;
    expect(jp.exchanges[0].routes[0]).toMatchObject({ method: "card", fee: 30.5 });
  });

  it("marks every venue unavailable when the rail/currency pair does not exist", () => {
    const res = getFiatCost({ currency: "USD", method: "sepa" }) as any;
    expect(res.best).toBeNull();
    expect(res.exchanges).toHaveLength(18);
    expect(res.exchanges.every((e: any) => e.available === false)).toBe(true);
    expect(res.warnings[0]).toContain("18 exchanges");
    expect(res.advice).toContain("gateways");
  });

  it("accepts amountUsd and converts via the display FX rate", () => {
    const res = getFiatCost({ amountUsd: 1000, currency: "EUR", country: "DE", exchanges: ["kraken"] }) as any;
    expect(res.amount).toBe(920);
    expect(res.amount_usd).toBe(1000);
    const sepa = res.exchanges[0].routes.find((r: any) => r.method === "sepa");
    expect(sepa.fee).toBe(0);
    expect(sepa.net).toBe(920);
  });

  it("warns when regional rails are included without a country", () => {
    const res = getFiatCost({ currency: "EUR", amount: 1000 }) as any;
    expect(res.warnings.some((w: string) => w.includes("No country provided"))).toBe(true);
  });

  it("rejects bad input with typed error codes", () => {
    expect((getFiatCost({ currency: "CHF" }) as any).code).toBe("INVALID_CURRENCY");
    expect((getFiatCost({ amount: 100, amountUsd: 100 }) as any).code).toBe("INVALID_AMOUNT");
    expect((getFiatCost({ amount: -5 }) as any).code).toBe("INVALID_AMOUNT");
    expect((getFiatCost({ exchanges: ["binance", "ftx"] }) as any).code).toBe("UNKNOWN_EXCHANGE");
  });
});

// =====================================================================
// v0.18: withdrawal (network) fee comparison
// =====================================================================

describe("v0.18: getWithdrawalCost", () => {
  beforeEach(() => resetCachesForTest());

  it("defaults to USDT and ranks every venue by its cheapest open route", () => {
    const res = getWithdrawalCost() as any;
    expect(res.asset).toBe("USDT");
    expect(res.asset_price_usd).toBe(1);
    expect(res.data_as_of).toBe("2026-09");
    expect(res.exchanges).toHaveLength(18);
    // v0.20: Hyperliquid lists no USDT route — surfaced as unsupported, never hidden.
    // v0.42: Bitvavo likewise lists no USDT route (spot/fiat venue, no modeled USDT chains).
    // v0.43: Finst likewise (BTC-only modeled withdrawal schedule).
    // v0.44: Bitpanda likewise (only BTC/ETH dynamic pass-through modeled).
    // v0.45: Bison likewise (only BTC/ETH modeled — both free, no USDT route).
    expect(res.exchanges.find((e: any) => e.exchange === "hyperliquid").supported).toBe(false);
    expect(res.exchanges.find((e: any) => e.exchange === "bitvavo").supported).toBe(false);
    expect(res.exchanges.find((e: any) => e.exchange === "finst").supported).toBe(false);
    expect(res.exchanges.find((e: any) => e.exchange === "bitpanda").supported).toBe(false);
    expect(res.exchanges.find((e: any) => e.exchange === "bison").supported).toBe(false);
    // v0.38: Bitstamp lists USDT on ERC-20 only (no TRC-20/Solana) at a semi-fixed ~20 — the worst open rail.
    expect(res.exchanges.find((e: any) => e.exchange === "bitstamp").cheapest_network).toBe("ERC-20");
    expect(res.exchanges.find((e: any) => e.exchange === "bitstamp").cheapest_fee_usd).toBe(20);
    // v0.37: BloFin's cheapest open USDT route is TRC-20 at 1.
    expect(res.exchanges.find((e: any) => e.exchange === "blofin").cheapest_network).toBe("TRC-20");
    expect(res.exchanges.find((e: any) => e.exchange === "blofin").cheapest_fee_usd).toBe(1);
    // v0.21: BingX cheapest open USDT route is Aptos at 0.01 (AVAX-C/opBNB suspended).
    expect(res.exchanges.find((e: any) => e.exchange === "bingx").cheapest_network).toBe("APT");
    expect(res.exchanges.find((e: any) => e.exchange === "bingx").cheapest_fee_usd).toBe(0.01);
    // MEXC Avalanche-C 0.000074 USDT is the cheapest route in the whole table.
    expect(res.best).toMatchObject({ exchange: "mexc", network: "Avalanche C", fee: 0.000074, fee_usd: 0.0001 });
    // KuCoin's cheapest open USDT route is TON at 0.5 (native TON coin alone is
    // suspended); Binance BEP20 0.01; OKX Arbitrum 0.0032; Coinbase Base 0.01.
    const byName = Object.fromEntries(res.exchanges.map((e: any) => [e.exchange, e]));
    expect(byName.kucoin.cheapest_network).toBe("TON");
    expect(byName.kucoin.cheapest_fee_usd).toBe(0.5);
    expect(byName.binance.cheapest_fee_usd).toBe(0.01);
    expect(byName.okx.cheapest_fee_usd).toBe(0.0032);
    expect(byName.coinbase.cheapest_network).toBe("Base");
    expect(byName.coinbase.cheapest_fee_usd).toBe(0.01);
    // v0.38: worst open venue is Bitstamp (ERC-20-only USDT at 20): round2(20 - 0.0001) = 20.
    expect(res.saving_vs_worst_usd).toBe(20);
    // Bitget Avalanche-C + BingX AVAX-C/opBNB are suspended: surfaced but not their cheapest.
    expect(res.warnings.some((w: string) => w.includes("3 suspended routes"))).toBe(true);
  });

  it("accepts network aliases and filters to TRC-20 (Coinbase has no TRC-20 route)", () => {
    const res = getWithdrawalCost({ network: "trc20" }) as any;
    expect(res.network).toBe("TRC-20");
    // Coinbase lists USDT only on ERC-20/Base/Solana — supported:false here.
    // v0.21: BingX open TRC-20 at 1.5 joins the 8 prior open venues = 9.
    // v0.24: Phemex open TRC-20 at 1.5 joins = 10.
    // v0.37: BloFin open TRC-20 at 1 joins = 11.
    expect(res.exchanges.filter((e: any) => e.supported)).toHaveLength(11);
    expect(res.exchanges.find((e: any) => e.exchange === "coinbase").supported).toBe(false);
    for (const q of res.exchanges.filter((e: any) => e.supported)) {
      expect(q.networks).toHaveLength(1);
      expect(q.networks[0].network).toBe("TRC-20");
    }
    expect(res.best).toMatchObject({ exchange: "mexc", network: "TRC-20", fee_usd: 0.5 });
    // Binance and BingX tie as the most expensive open TRC-20 venues at 1.5: 1.5-0.5 = 1.

    expect(res.exchanges.find((e: any) => e.exchange === "bingx").cheapest_fee_usd).toBe(1.5);
    expect(res.saving_vs_worst_usd).toBe(1);
  });

  it("USDT ERC-20: MEXC 0.094 cheapest, Kraken dynamic 0.6442, Bitstamp semi-fixed 20 worst (v0.38)", () => {
    const res = getWithdrawalCost({ asset: "USDT", network: "ERC-20" }) as any;
    expect(res.best).toMatchObject({ exchange: "mexc", fee: 0.094, fee_usd: 0.094 });
    const kraken = res.exchanges.find((e: any) => e.exchange === "kraken");
    expect(kraken.cheapest_fee_usd).toBe(0.6442);
    expect(kraken.networks[0].note).toContain("Dynamic");
    // Coinbase dynamic gas estimate ($5-20).
    expect(res.exchanges.find((e: any) => e.exchange === "coinbase").cheapest_fee_usd).toBe(8);
    // v0.38: Bitstamp's semi-fixed ~20 USDT ERC-20 fee is the most expensive route.
    expect(res.exchanges.find((e: any) => e.exchange === "bitstamp").cheapest_fee_usd).toBe(20);
    // round2(20 - 0.094) = 19.91.
    expect(res.saving_vs_worst_usd).toBe(19.91);
  });

  it("USDC on Base: 10 of 18 venues route it; Coinbase free, Kraken 1 worst", () => {
    const res = getWithdrawalCost({ asset: "USDC", network: "Base" }) as any;
    // v0.20: Hyperliquid only runs the flat-1-USDC Arbitrum/CCTP route — no Base.
    // v0.21: BingX routes USDC Base at 0.017.
    // v0.24: Phemex USDC is ERC-20 only — no Base route.
    // v0.37: BloFin models USDC on TRC-20/ERC-20 only — no Base route.
    // v0.42: Bitvavo models no USDC routes — no Base route.
    // v0.43: Finst models BTC only — no Base route.
    // v0.44: Bitpanda models BTC/ETH only — no Base route.
    // v0.45: Bison models BTC/ETH only — no Base route (still 10 of 18 route it).
    expect(res.exchanges.filter((e: any) => e.supported)).toHaveLength(10);
    expect(res.exchanges.find((e: any) => e.exchange === "bitvavo").supported).toBe(false);
    expect(res.exchanges.find((e: any) => e.exchange === "finst").supported).toBe(false);
    expect(res.exchanges.find((e: any) => e.exchange === "bitpanda").supported).toBe(false);
    expect(res.exchanges.find((e: any) => e.exchange === "bison").supported).toBe(false);
    expect(res.exchanges.find((e: any) => e.exchange === "hyperliquid").supported).toBe(false);
    expect(res.exchanges.find((e: any) => e.exchange === "bingx").cheapest_fee_usd).toBe(0.017);
    // Coinbase's promoted free USDC-on-Base route wins outright.
    expect(res.best).toMatchObject({ exchange: "coinbase", fee: 0 });
    // round2(1 - 0) = 1.
    expect(res.saving_vs_worst_usd).toBe(1);
  });

  it("USDC TRC-20: Gate/KuCoin/BingX list it suspended only; BloFin keeps the sole open route at 1", () => {
    const res = getWithdrawalCost({ asset: "USDC", network: "TRC-20" }) as any;
    // v0.37: BloFin's flat ~1 USDC TRC-20 route is the only open rail.
    expect(res.best).toMatchObject({ exchange: "blofin", network: "TRC-20", fee: 1, fee_usd: 1 });
    // v0.38: Bitstamp (ERC-20/multi-chain USDC, no TRC-20) joins the do-not-list bucket.
    // v0.42: Bitvavo (no USDC routes modeled) joins too.
    // v0.43: Finst (BTC-only modeled) joins too.
    // v0.44: Bitpanda (BTC/ETH-only modeled) joins too.
    // v0.45: Bison (BTC/ETH-only modeled) joins too — bucket = 14.
    expect(res.exchanges.filter((e: any) => e.supported === false)).toHaveLength(14);
    const suspended = res.exchanges.filter(
      (e: any) => e.supported && e.cheapest_fee_usd === undefined,
    );
    expect(suspended.map((e: any) => e.exchange).sort()).toEqual(["bingx", "gate", "kucoin"]);
    for (const q of suspended) {
      expect(q.cheapest_fee_usd).toBeUndefined();
      expect(q.networks[0].available).toBe(false);
    }
    expect(res.warnings.some((w: string) => w.includes("14 exchanges do not list"))).toBe(true);
    expect(res.warnings.some((w: string) => w.includes("3 exchanges only show suspended"))).toBe(true);
  });

  it("ETH across L2s: v0.45 Bison free mainnet cheapest, MEXC Base next; Kraken mainnet its cheapest; Phemex L1 the most expensive venue", () => {
    const res = getWithdrawalCost({ asset: "ETH" }) as any;
    expect(res.asset_price_usd).toBe(2512.03);
    // v0.45: Bison absorbs on-chain costs and advertises FREE ETH withdrawals
    // (Ethereum mainnet, min 0.01 ETH, no L2), undercutting MEXC's Base route.
    expect(res.best).toMatchObject({ exchange: "bison", network: "Ethereum", fee: 0, fee_usd: 0 });
    const bison = res.exchanges.find((e: any) => e.exchange === "bison");
    expect(bison.networks).toHaveLength(1);
    expect(bison.networks[0].available).toBe(true);
    // MEXC Base 0.0000013 ETH stays the cheapest non-Bison (L2) rail.
    const mexc = res.exchanges.find((e: any) => e.exchange === "mexc");
    expect(mexc.cheapest_network).toBe("Base");
    expect(mexc.cheapest_fee_usd).toBe(0.0033);
    const binance = res.exchanges.find((e: any) => e.exchange === "binance");
    expect(binance.cheapest_network).toBe("Optimism");
    expect(binance.cheapest_fee_usd).toBe(0.0377);
    const kraken = res.exchanges.find((e: any) => e.exchange === "kraken");
    expect(kraken.cheapest_network).toBe("ERC-20");
    expect(kraken.cheapest_fee_usd).toBe(0.3266);
    // Coinbase L1 gas estimate 0.0012 ETH = 3.0144 USD; Phemex ERC-20 0.008 ETH
    // = 20.0962 USD is the worst venue: round2(20.0962 - 0) = 20.10.
    expect(res.exchanges.find((e: any) => e.exchange === "coinbase").cheapest_fee_usd).toBe(3.0144);
    expect(res.saving_vs_worst_usd).toBe(20.1);
  });

  it("SOL native: OKX 0.0245 cheapest and KuCoin 0.8158 worst, USD via price snapshot", () => {
    const res = getWithdrawalCost({ asset: "SOL" }) as any;
    expect(res.best).toMatchObject({ exchange: "okx", network: "Solana", fee: 0.00024, fee_usd: 0.0245 });
    const kucoin = res.exchanges.find((e: any) => e.exchange === "kucoin");
    expect(kucoin.networks[0]).toMatchObject({ network: "Solana", fee: 0.008, fee_usd: 0.8158, available: true });
    expect(res.saving_vs_worst_usd).toBe(0.79);
  });

  it("XRP: MEXC 0.02 native cheapest, KuCoin 0.3 worst", () => {
    const res = getWithdrawalCost({ asset: "XRP" }) as any;
    expect(res.best).toMatchObject({ exchange: "mexc", network: "XRP", fee_usd: 0.0272 });
    expect(res.saving_vs_worst_usd).toBe(0.38);
    const gate = res.exchanges.find((e: any) => e.exchange === "gate");
    expect(gate.cheapest_fee_usd).toBe(0.0506);
  });

  it("DOGE: MEXC cheaper than Gate; the six flat-4-DOGE venues tie at 0.3368", () => {
    const res = getWithdrawalCost({ asset: "DOGE" }) as any;
    expect(res.best).toMatchObject({ exchange: "mexc", fee: 0.424, fee_usd: 0.0357 });
    const kucoin = res.exchanges.find((e: any) => e.exchange === "kucoin");
    expect(kucoin.cheapest_fee_usd).toBe(0.3368);
    expect(res.saving_vs_worst_usd).toBe(0.3);
  });

  it("TON: only OKX/Bitget/Kraken open; five venues are supported-but-suspended", () => {
    const res = getWithdrawalCost({ asset: "TON" }) as any;
    expect(res.best).toMatchObject({ exchange: "okx", fee: 0.0012, fee_usd: 0.0016 });
    const open = res.exchanges.filter((e: any) => e.cheapest_fee_usd !== undefined);
    expect(open.map((e: any) => e.exchange).sort()).toEqual(["bitget", "kraken", "okx"]);
    const binance = res.exchanges.find((e: any) => e.exchange === "binance");
    expect(binance.supported).toBe(true);
    expect(binance.cheapest_fee_usd).toBeUndefined();
    expect(binance.networks[0].available).toBe(false);
    expect(res.warnings.some((w: string) => w.includes("5 exchanges only show suspended"))).toBe(true);
  });

  it("DOT: Gate has no data (unsupported); Binance/Bitget relay suspended but AssetHub open at 0.0524", () => {
    const res = getWithdrawalCost({ asset: "DOT" }) as any;
    const gate = res.exchanges.find((e: any) => e.exchange === "gate");
    expect(gate.supported).toBe(false);
    expect(gate.networks).toEqual([]);
    // v0.38: Bitstamp (BTC/ETH/USDT/USDC only) joined the do-not-list bucket.
    // v0.42: Bitvavo (BTC-only modeled) joins too.
    // v0.43: Finst (BTC-only modeled) joins too.
    // v0.44: Bitpanda (BTC/ETH modeled, no DOT) joins too.
    // v0.45: Bison (BTC/ETH modeled, no DOT) joins too — bucket = 11.
    expect(res.warnings.some((w: string) => w.includes("11 exchanges do not list DOT"))).toBe(true);
    expect(res.best).toMatchObject({ exchange: "binance", network: "AssetHub", fee: 0.05, fee_usd: 0.0524 });
    const binance = res.exchanges.find((e: any) => e.exchange === "binance");
    expect(binance.networks.map((n: any) => [n.network, n.available])).toEqual([
      ["AssetHub", true],
      ["Polkadot", false],
    ]);
    expect(res.saving_vs_worst_usd).toBe(0.09);
  });

  it("POL: OKX native 0.0106 cheapest; Binance only lists costly ERC-20 POL and is worst", () => {
    const res = getWithdrawalCost({ asset: "POL" }) as any;
    expect(res.best).toMatchObject({ exchange: "okx", network: "Polygon", fee: 0.11, fee_usd: 0.0106 });
    const binance = res.exchanges.find((e: any) => e.exchange === "binance");
    expect(binance.cheapest_network).toBe("ERC-20");
    expect(binance.cheapest_fee_usd).toBe(0.7689);
    expect(res.saving_vs_worst_usd).toBe(0.76);
  });

  it("single-entry BTC resolves and converts via the price snapshot", () => {
    const res = getWithdrawalCost({ asset: "BTC", exchanges: ["kraken"] }) as any;
    expect(res.exchanges[0].networks).toHaveLength(1);
    expect(res.exchanges[0].networks[0]).toMatchObject({
      network: "Bitcoin",
      fee: 0.00015,
      fee_usd: 11.5947,
      available: true,
    });
    expect(res.best).toMatchObject({ exchange: "kraken", network: "Bitcoin", fee_usd: 11.5947 });
  });

  it("US residency compliance filter still applies", () => {
    const res = getWithdrawalCost({ country: "US" }) as any;
    expect(res.exchanges.map((e: any) => e.exchange).sort()).toEqual(["bitstamp", "coinbase", "gate", "kraken", "okx"]);
    expect(res.best).toMatchObject({ exchange: "okx", network: "Arbitrum", fee_usd: 0.0032 });
  });

  it("rejects unknown assets, impossible networks and unknown exchanges", () => {
    expect((getWithdrawalCost({ asset: "SHIB" }) as any).code).toBe("INVALID_ASSET");
    expect((getWithdrawalCost({ asset: "BTC", network: "TRC-20" }) as any).code).toBe("INVALID_NETWORK");
    expect((getWithdrawalCost({ exchanges: ["ftx"] }) as any).code).toBe("UNKNOWN_EXCHANGE");
  });
});

describe("v0.20: Hyperliquid integration (DEX, 14d volume tiers, staked-HYPE ladder, 1h funding)", () => {
  beforeEach(() => resetCachesForTest());

  it("resolveFeeRate: 7-tier volume-only ladder, spot rates sit above perp rates", () => {
    const t0 = resolveFeeRate("hyperliquid", "futures", 0) as any;
    expect(t0.tier).toBe("Tier 0");
    expect(t0.base_maker).toBe(0.015);
    expect(t0.base_taker).toBe(0.045);
    // Thresholds are the 14-day window ($5M/25M/100M/500M/2B/7B).
    expect((resolveFeeRate("hyperliquid", "futures", 5_000_000) as any).tier).toBe("Tier 1");
    expect((resolveFeeRate("hyperliquid", "futures", 25_000_000) as any).tier).toBe("Tier 2");
    expect((resolveFeeRate("hyperliquid", "futures", 500_000_000) as any).tier).toBe("Tier 4");
    // Tier 4+ maker is zero (not negative) — plain free maker.
    const t4 = resolveFeeRate("hyperliquid", "futures", 500_000_000) as any;
    expect(t4.base_maker).toBe(0);
    // Spot ladder differs: 0.040%/0.070% at Tier 0.
    const spot = resolveFeeRate("hyperliquid", "spot", 0) as any;
    expect(spot.base_maker).toBe(0.04);
    expect(spot.base_taker).toBe(0.07);
    // Holdings/assets do NOT qualify tiers (volume-only qualification).
    expect((resolveFeeRate("hyperliquid", "spot", 0, undefined, 1_000_000) as any).tier).toBe("Tier 0");
  });

  it("staked-HYPE discount ladder: 10→5%, 1k→15%, 500k→40%; below 10 HYPE nothing applies", () => {
    const td = getTokenDiscount("hyperliquid") as any;
    expect(td.token).toBe("HYPE");
    expect(td.spot_discount_pct).toBe(0);
    expect(td.futures_discount_pct).toBe(0);
    expect(td.holding_tiers).toHaveLength(6);

    // Tier 0 perp taker 0.045% with 10 staked HYPE -> 5% off = 0.04275, quoted at the 4-dp convention (0.0427).
    const small = compareExchangeFees("futures", "JP", { useToken: true, tokenBalance: 10 }) as any[];
    const hlSmall = small.find((x) => x.exchange === "hyperliquid");
    expect(hlSmall.effective_taker).toBe(0.0427);
    expect(hlSmall.token_applied).toBe(true);

    // 1,000 staked HYPE -> 15% off: 0.045 * 0.85 = 0.03825 -> 0.0383 at 4 dp.
    const mid = compareExchangeFees("futures", "JP", { useToken: true, tokenBalance: 1000 }) as any[];
    expect(mid.find((x) => x.exchange === "hyperliquid").effective_taker).toBe(0.0383);

    // 500,000 staked HYPE -> 40% off: 0.045 * 0.6 = 0.027.
    const max = compareExchangeFees("futures", "JP", { useToken: true, tokenBalance: 500_000 }) as any[];
    expect(max.find((x) => x.exchange === "hyperliquid").effective_taker).toBe(0.027);

    // 9 HYPE is below the Wood rung — no discount (staking is required, holding alone gives nothing).
    const none = compareExchangeFees("futures", "JP", { useToken: true, tokenBalance: 9 }) as any[];
    expect(none.find((x) => x.exchange === "hyperliquid").token_applied).toBe(false);

    // Discount stacks multiplicatively ON TOP of the volume tier (Tier 1 taker 0.04% - 20% = 0.032).
    const tier1 = compareExchangeFees("futures", "JP", { monthlyVolumeUsd: 10_000_000, useToken: true, tokenBalance: 10_000 }) as any[];
    expect(tier1.find((x) => x.exchange === "hyperliquid").effective_taker).toBe(0.032);
  });

  it("compliance: US front-end geo-blocked; CN/HK/SG/JP/TH allowed; no referral link; notes ride on results", () => {
    expect((calculateSavings("hyperliquid", 1_000, "spot", "US") as any).code).toBe("COUNTRY_BLOCKED");
    for (const cc of ["CN", "HK", "SG", "JP", "TH"]) {
      expect((calculateSavings("hyperliquid", 1_000, "spot", cc) as any).error).toBeUndefined();
    }
    const us = compareExchangeFees("spot", "US") as any[];
    expect(us.find((x) => x.exchange === "hyperliquid")).toBeUndefined();

    const link = getReferralLink("hyperliquid", "JP") as any;
    expect(link.code).toBe("NO_REFERRAL_LINK");

    // Exchange-specific caveats surface as exchange_notes on fee results.
    const row = compareExchangeFees("spot", "JP") as any[];
    const hl = row.find((x) => x.exchange === "hyperliquid");
    expect(Array.isArray(hl.exchange_notes)).toBe(true);
    expect(hl.exchange_notes.join(" ")).toContain("14-DAY");
    expect(getExchangeNotes("hyperliquid")?.length).toBe(6);
  });

  it("1h funding: 16h holding costs the same $20 per $100k as 8h CEX venues", () => {
    expect(getFundingRate("hyperliquid")).toMatchObject({ interval_hours: 1, avg_rate_pct: 0.00125 });
    const savings = calculateSavings("hyperliquid", 100_000, "futures", "JP", { holdingHours: 16 }) as any;
    expect(savings.funding_cost).toBe(20);
    // Taker-heavy futures at JP: Binance still wins on its 20% referral discount
    // (0.05% x 0.8 = 0.04% effective) vs Hyperliquid's no-link 0.045%.
    const rec = recommendExchange("futures", "JP", 100_000) as any;
    expect(rec.best.exchange).toBe("binance");
    // Hyperliquid is ranked among the alternatives with the same effective $20/16h funding.
    const hl = rec.alternatives.find((x: any) => x.exchange === "hyperliquid");
    expect(hl).toBeDefined();
  });

  it("withdrawal: flat ~1 USDC to Arbitrum/CCTP; no USDT route", () => {
    const res = getWithdrawalCost({ asset: "USDC", network: "arbitrum", exchanges: ["hyperliquid"] }) as any;
    expect(res.best).toMatchObject({ exchange: "hyperliquid", network: "Arbitrum", fee: 1, fee_usd: 1 });
    const noUsdt = getWithdrawalCost({ asset: "USDT", exchanges: ["hyperliquid"] }) as any;
    expect(noUsdt.exchanges[0].supported).toBe(false);
    expect(noUsdt.exchanges[0].networks).toEqual([]);
  });
});

describe("v0.21: BingX integration (VIP Club ladders, volume-only Elite/Supreme, asset OR-track, 8h funding)", () => {
  beforeEach(() => resetCachesForTest());

  it("futures ladder: Regular/Elite/VIP1/VIP3/VIP5/Supreme resolve at the verified thresholds", () => {
    expect(resolveFeeRate("bingx", "futures", 0) as any).toMatchObject({
      tier: "Regular",
      base_maker: 0.02,
      base_taker: 0.05,
    });
    // Elite is a volume-only rung inserted at $5M.
    expect(resolveFeeRate("bingx", "futures", 5_000_000) as any).toMatchObject({
      tier: "Elite",
      base_maker: 0.018,
      base_taker: 0.045,
    });
    expect(resolveFeeRate("bingx", "futures", 10_000_000) as any).toMatchObject({
      tier: "VIP1",
      base_maker: 0.014,
      base_taker: 0.04,
    });
    expect(resolveFeeRate("bingx", "futures", 50_000_000) as any).toMatchObject({
      tier: "VIP3",
      base_maker: 0.01,
      base_taker: 0.035,
    });
    expect(resolveFeeRate("bingx", "futures", 200_000_000) as any).toMatchObject({
      tier: "VIP5",
      base_maker: 0.006,
      base_taker: 0.03,
    });
    // Supreme at $500M: zero maker, 0.025 taker.
    expect(resolveFeeRate("bingx", "futures", 500_000_000) as any).toMatchObject({
      tier: "Supreme",
      base_maker: 0,
      base_taker: 0.025,
    });
    // One dollar short of Supreme stays VIP5.
    expect((resolveFeeRate("bingx", "futures", 499_999_999) as any).tier).toBe("VIP5");
  });

  it("spot ladder: 0.10/0.10 Regular, Elite at $0.5M, Supreme 0.005/0.02 at $15M", () => {
    expect(resolveFeeRate("bingx", "spot", 0) as any).toMatchObject({
      tier: "Regular",
      base_maker: 0.1,
      base_taker: 0.1,
    });
    expect(resolveFeeRate("bingx", "spot", 500_000) as any).toMatchObject({
      tier: "Elite",
      base_maker: 0.05,
      base_taker: 0.08,
    });
    expect(resolveFeeRate("bingx", "spot", 4_000_000) as any).toMatchObject({
      tier: "VIP3",
      base_maker: 0.015,
      base_taker: 0.045,
    });
    expect(resolveFeeRate("bingx", "spot", 15_000_000) as any).toMatchObject({
      tier: "Supreme",
      base_maker: 0.005,
      base_taker: 0.02,
    });
    expect((resolveFeeRate("bingx", "spot", 14_999_999) as any).tier).toBe("VIP5");
  });

  it("Elite and Supreme rungs carry no asset threshold in the normalized ladder", () => {
    const futures = getNormalizedLadder("bingx", "futures")!;
    expect(futures).toHaveLength(8);
    expect(futures[0].tier).toBe("Regular");
    expect(futures[0].min_assets_usd).toBeUndefined();
    expect(futures[1].tier).toBe("Elite");
    expect(futures[1].min_assets_usd).toBeUndefined();
    expect(futures[2]).toMatchObject({ tier: "VIP1", min_assets_usd: 50_000 });
    expect(futures[6]).toMatchObject({ tier: "VIP5", min_assets_usd: 3_000_000 });
    expect(futures[7].tier).toBe("Supreme");
    expect(futures[7].min_assets_usd).toBeUndefined();

    const spot = getNormalizedLadder("bingx", "spot")!;
    expect(spot[1]).toMatchObject({ tier: "Elite", min_volume_usd: 500_000 });
    expect(spot[1].min_assets_usd).toBeUndefined();
    expect(spot[7]).toMatchObject({ tier: "Supreme", min_volume_usd: 15_000_000 });
    expect(spot[7].min_assets_usd).toBeUndefined();
  });

  it("asset OR-track: $50k assets lifts zero-volume to VIP1, but assets can never reach Elite or Supreme", () => {
    // Futures: $50k previous-day assets -> VIP1, skipping Regular and Elite.
    const vip1 = resolveFeeRate("bingx", "futures", 0, undefined, 50_000) as any;
    expect(vip1.tier).toBe("VIP1");
    expect(vip1.volume_tier).toBe("Regular");
    expect(vip1.tier_upgraded).toBe(true);
    expect(vip1.upgrade_basis).toBe("assets");
    expect(vip1.asset_gate).toBe(true);
    expect(vip1.min_assets_usd).toBe(50_000);

    // Spot: $3M assets -> VIP5.
    const spotVip5 = resolveFeeRate("bingx", "spot", 0, undefined, 3_000_000) as any;
    expect(spotVip5.tier).toBe("VIP5");
    expect(spotVip5.base_maker).toBe(0.01);

    // Even $10B of assets caps at VIP5 — Supreme is volume-only.
    const rich = resolveFeeRate("bingx", "futures", 0, undefined, 10_000_000_000) as any;
    expect(rich.tier).toBe("VIP5");
    expect(rich.base_taker).toBe(0.03);

    // Assets never upgrade past the volume tier (volume Elite with only $100 stays Elite).
    const elite = resolveFeeRate("bingx", "futures", 5_000_000, undefined, 100) as any;
    expect(elite.tier).toBe("Elite");
    expect(elite.tier_upgraded).toBeUndefined();
  });

  it("no native token discount; standard 8h funding; 4 bps typical BTC spread", () => {
    expect(getTokenDiscount("bingx")).toBeNull();
    // useToken must not change BingX rates.
    const rows = compareExchangeFees("futures", "JP", { useToken: true, tokenBalance: 999_999 }) as any[];
    const bx = rows.find((x) => x.exchange === "bingx");
    expect(bx.effective_taker).toBe(0.05);
    expect(bx.token_applied).toBe(false);

    expect(getFundingRate("bingx")).toMatchObject({ interval_hours: 8, avg_rate_pct: 0.01 });
    // 16h holding = 2 intervals * 0.01% * 100k = $20.
    const sav = calculateSavings("bingx", 100_000, "futures", "JP", { holdingHours: 16 }) as any;
    expect(sav.funding_cost).toBe(20);

    expect(getSpreadEstimate("bingx", "BTC")).toMatchObject({
      full_spread_bps: 4,
      crossing_bps: 2,
      pair_class: "majors",
    });
  });

  it("compliance: blocked in US/CA/GB/CN/HK/SG and EEA-wide post-MiCA (v0.41), served in JP/TH/AU; no referral link; notes attached", () => {
    for (const cc of ["US", "CA", "GB", "CN", "HK", "SG", "DE", "FR", "NL", "IS"]) {
      expect((calculateSavings("bingx", 1_000, "spot", cc) as any).code).toBe("COUNTRY_BLOCKED");
    }
    for (const cc of ["JP", "TH", "AU"]) {
      expect((calculateSavings("bingx", 1_000, "spot", cc) as any).error).toBeUndefined();
    }
    const us = compareExchangeFees("spot", "US") as any[];
    expect(us.find((x) => x.exchange === "bingx")).toBeUndefined();
    const gb = compareExchangeFees("futures", "GB") as any[];
    expect(gb.find((x) => x.exchange === "bingx")).toBeUndefined();
    const jp = compareExchangeFees("futures", "JP") as any[];
    expect(jp.find((x) => x.exchange === "bingx")).toBeDefined();

    const link = getReferralLink("bingx", "JP") as any;
    expect(link.code).toBe("NO_REFERRAL_LINK");

    const row = jp.find((x) => x.exchange === "bingx");
    expect(Array.isArray(row.exchange_notes)).toBe(true);
    expect(row.exchange_notes.join(" ")).toContain("VOLUME-ONLY");
    expect(getExchangeNotes("bingx")?.length).toBe(6);
  });

  it("compareExchangeFees asset path upgrades BingX and surfaces an account-assets warning", () => {
    const rows = compareExchangeFees("futures", "JP", {
      monthlyVolumeUsd: 0,
      accountAssetsUsd: 2_000_000,
    }) as any[];
    const bx = rows.find((x) => x.exchange === "bingx");
    expect(bx.tier).toBe("VIP4");
    expect(bx.volume_tier).toBe("Regular");
    expect(bx.base_taker).toBe(0.0315);
    expect(bx.tier_warning).toContain("account assets");
  });

  it("withdrawals: USDT TRC-20 1.5 open, AVAX-C/opBNB suspended; USDC BEP20 free + TRC-20 suspended; no fiat rails", () => {
    const trc = getWithdrawalCost({ asset: "USDT", network: "TRC-20", exchanges: ["bingx"] }) as any;
    expect(trc.best).toMatchObject({ exchange: "bingx", network: "TRC-20", fee: 1.5, fee_usd: 1.5 });

    const usdtAll = getWithdrawalCost({ asset: "USDT", exchanges: ["bingx"] }) as any;
    const avax = usdtAll.exchanges[0].networks.find((n: any) => n.network === "Avalanche C");
    expect(avax).toMatchObject({ available: false, fee: 0.01 });
    const opbnb = usdtAll.exchanges[0].networks.find((n: any) => n.network === "OPBNB");
    expect(opbnb.available).toBe(false);

    const usdc = getWithdrawalCost({ asset: "USDC", exchanges: ["bingx"] }) as any;
    expect(usdc.best).toMatchObject({ network: "BEP20", fee: 0, fee_usd: 0 });
    const usdcTrc = usdc.exchanges[0].networks.find((n: any) => n.network === "TRC-20");
    expect(usdcTrc).toMatchObject({ available: false, fee: 1 });

    // Cheapest open BTC route is BEP20 (0.000001 BTC = $0.0773); mainnet is 0.00004 BTC = $3.0919.
    const btc = getWithdrawalCost({ asset: "BTC", exchanges: ["bingx"] }) as any;
    expect(btc.best).toMatchObject({ network: "BEP20", fee: 0.000001, fee_usd: 0.0773 });
    expect(btc.exchanges[0].cheapest_network).toBe("BEP20");
    const btcMainnet = btc.exchanges[0].networks.find((n: any) => n.network === "Bitcoin");
    expect(btcMainnet).toMatchObject({ fee: 0.00004, fee_usd: 3.0919, available: true });

    const fiat = getFiatCost({ exchanges: ["bingx"] }) as any;
    expect(fiat.exchanges[0]).toMatchObject({ exchange: "bingx", available: false });
    expect(fiat.exchanges[0].routes).toEqual([]);
  });
});

describe("v0.22: trader persona analysis (analyze_persona)", () => {
  beforeEach(() => resetCachesForTest());

  it("exposes 7 well-formed research-anchored personas with unique ids", () => {
    const ps = listPersonas();
    expect(ps.map((p) => p.id)).toEqual([
      "casual_buyer",
      "hodler_accumulator",
      "active_spot_trader",
      "swing_futures_trader",
      "day_scalper",
      "vip_institutional",
      "dex_native",
    ]);
    expect(new Set(ps.map((p) => p.id)).size).toBe(7);
    for (const p of ps) {
      expect(p.monthly_volume_usd).toBeGreaterThan(0);
      expect(p.maker_share).toBeGreaterThanOrEqual(0);
      expect(p.maker_share).toBeLessThanOrEqual(1);
      expect(["spot", "futures"]).toContain(p.purpose);
      expect(p.assumptions.length).toBeGreaterThan(1);
      expect(p.dominant_costs.length).toBeGreaterThan(0);
      for (const c of p.dominant_costs) {
        expect(["trading_fee", "funding", "execution", "withdrawal", "fiat"]).toContain(c);
      }
    }
  });

  it("rejects an unknown persona with INVALID_INPUT and lists valid ids", () => {
    const r = analyzePersona("whale", "US") as any;
    expect(isToolErrorLike(r)).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.suggested_action).toContain("casual_buyer");
    expect(r.suggested_action).toContain("dex_native");
  });

  it("casual_buyer US: card on-ramp dominates (>50% of winner cost), OKX wins, rail recorded", () => {
    const r = analyzePersona("casual_buyer", "US") as any;
    expect(isToolErrorLike(r)).toBe(false);
    expect(r.purpose).toBe("spot");
    expect(r.ranking).toHaveLength(5); // US spot: okx, gate, kraken, coinbase, bitstamp (futures gated, spot open)
    const allIns = r.ranking.map((x: any) => x.annual_all_in);
    expect(allIns).toEqual([...allIns].sort((a, b) => a - b));
    expect(r.best.exchange).toBe("okx");
    expect(r.best.saving_vs_runner_up).toBeGreaterThan(0);
    const winner = r.ranking[0];
    expect(winner.fiat_deposit_available).toBe(true);
    expect(winner.fiat_deposit_method).toBe("card");
    expect(winner.cost_mix_pct.fiat).toBeGreaterThan(50); // card fees dwarf trading fees
    expect(r.best_complete.exchange).toBe("okx");
    expect(r.best_complete.extra_vs_winner).toBe(0);
    expect(r.data_sources.length).toBe(3);
  });

  it("every row's annual_all_in equals the sum of priced components", () => {
    const r = analyzePersona("hodler_accumulator", "JP") as any;
    for (const row of r.ranking) {
      const sum =
        row.annual_trading_fee +
        row.annual_funding_cost +
        (row.annual_execution_cost ?? 0) +
        row.annual_withdrawal_cost +
        (row.annual_fiat_deposit_cost ?? 0) +
        (row.annual_fiat_cashout_cost ?? 0);
      expect(Math.abs(sum - row.annual_all_in)).toBeLessThanOrEqual(0.05);
      const mixTotal =
        row.cost_mix_pct.trading_fee +
        row.cost_mix_pct.funding +
        row.cost_mix_pct.execution +
        row.cost_mix_pct.withdrawal +
        row.cost_mix_pct.fiat;
      expect(Math.abs(mixTotal - 100)).toBeLessThanOrEqual(0.6);
    }
  });

  it("swing_futures_trader JP: 12 futures rows, spot-only/blocked venues absent, funding is the biggest line", () => {
    const r = analyzePersona("swing_futures_trader", "JP") as any;
    expect(r.ranking).toHaveLength(12);
    expect(r.ranking.some((x: any) => x.exchange === "coinbase")).toBe(false);
    // Hyperliquid has no USDT withdrawal route — flagged, not silently free.
    const hl = r.ranking.find((x: any) => x.exchange === "hyperliquid");
    expect(hl.withdrawal_unsupported).toBe(true);
    expect(r.warnings.join(" ")).toContain("USDT withdrawal route");
    expect(r.component_leaders.funding).toBeDefined();
    const winner = r.ranking[0];
    expect(winner.annual_funding_cost).toBeGreaterThan(winner.annual_trading_fee);
    expect(winner.cost_mix_pct.funding).toBeGreaterThan(50);
    // 150h exposure at 0.01%/8h: 150k * 0.0001 * 18.75 intervals * 12 = 3,375 ... exact 3,600 (160h)
    expect(winner.annual_funding_cost).toBe(3600);
  });

  it("hodler_accumulator DE: Hyperliquid wins the headline but is flagged on BOTH legs; best_complete redirects to Bitget", () => {
    const r = analyzePersona("hodler_accumulator", "DE") as any;
    const hl = r.ranking.find((x: any) => x.exchange === "hyperliquid");
    expect(hl).toBeDefined();
    expect(hl.withdrawal_unsupported).toBe(true); // no BTC route on Hyperliquid
    expect(hl.fiat_deposit_available).toBe(false);
    expect(hl.fiat_cashout_available).toBe(false);
    expect(r.best.exchange).toBe("hyperliquid");
    expect(r.best.tradeoffs.join(" ")).toMatch(/fiat rail/i);
    expect(r.best_complete.exchange).not.toBe("hyperliquid");
    expect(r.best_complete.extra_vs_winner).toBeGreaterThan(0);
    const warnText = r.warnings.join(" ");
    expect(warnText).toContain("EXCLUDED");
    expect(warnText).toContain("gateway");
    expect(r.advice.join(" ")).toContain("realistic pick");
  });

  it("day_scalper JP: 90% maker preset, Hyperliquid leads on execution, upgrade + funding advice present", () => {
    const r = analyzePersona("day_scalper", "JP") as any;
    expect(r.inputs.maker_share).toBe(0.9);
    expect(r.inputs.monthly_volume_usd).toBe(3_000_000);
    expect(r.component_leaders.execution.exchange).toBe("hyperliquid");
    expect(r.ranking[0].exchange).toBe("hyperliquid");
    const text = r.advice.join(" ");
    expect(text).toContain("Next-tier upgrade");
    expect(text).toContain("fundingMode=live");
  });

  it("vip_institutional: $3M assets preset and large-clip live-depth advice; futures rows = 12 in JP", () => {
    const r = analyzePersona("vip_institutional", "JP") as any;
    expect(r.inputs.account_assets_usd).toBe(3_000_000);
    expect(r.ranking).toHaveLength(12);
    expect(r.advice.join(" ")).toContain("spreadMode=live");
  });

  it("dex_native CN: 7 allowed venues (incl. Phemex), Hyperliquid priced with 24 USDC withdrawals, no fiat legs modeled", () => {
    const r = analyzePersona("dex_native", "CN") as any;
    expect(r.ranking).toHaveLength(7);
    const hl = r.ranking.find((x: any) => x.exchange === "hyperliquid");
    expect(hl).toBeDefined();
    expect(hl.withdrawal_unsupported).toBeUndefined();
    expect(hl.annual_withdrawal_cost).toBe(24); // flat ~1 USDC x 24
    expect(hl.annual_fiat_deposit_cost).toBeUndefined();
    expect(r.component_leaders.fiat).toBeUndefined();
  });

  it("caller overrides replace persona presets (volume/maker/useToken) and inputs echo them", () => {
    const base = analyzePersona("casual_buyer", "US", { monthlyVolumeUsd: 999, makerShare: 0.4 }) as any;
    expect(base.inputs.monthly_volume_usd).toBe(999);
    expect(base.inputs.maker_share).toBe(0.4);
    const withToken = analyzePersona("active_spot_trader", "JP", { useToken: true, tokenBalance: 0 }) as any;
    expect(withToken.inputs.use_token).toBe(true);
    expect(withToken.advice.join(" ")).not.toContain("Preset assumes NO native-token discount");
  });

  it("non-USD display currency scales every component (JPY ~150x)", () => {
    const r = analyzePersona("casual_buyer", "US", { currency: "JPY" }) as any;
    expect(r.currency).toBe("JPY");
    const usd = analyzePersona("casual_buyer", "US") as any;
    expect(r.ranking[0].annual_all_in).toBeGreaterThan(usd.ranking[0].annual_all_in * 100);
  });

  it("compliance filtering applies inside persona runs (GB excludes BingX from futures)", () => {
    const r = analyzePersona("swing_futures_trader", "GB") as any;
    expect(r.ranking.some((x: any) => x.exchange === "bingx")).toBe(false);
    // GB allows the other 11 venues (13 - bingx/phemex blocked), minus coinbase (no modeled futures) = 10 rows.
    expect(r.ranking).toHaveLength(10);
  });

  // v0.25: persona × token-discount cross-link
  it("active_spot_trader JP: top venues carry token_discount_hint and consolidated token_discount_hints", () => {
    const r = analyzePersona("active_spot_trader", "JP") as any;
    // Hints only appear when useToken=false (persona default).
    expect(r.inputs.use_token).toBe(false);
    expect(Array.isArray(r.token_discount_hints)).toBe(true);
    expect(r.token_discount_hints.length).toBeGreaterThan(0);
    // Every hint has the required shape.
    for (const h of r.token_discount_hints) {
      expect(typeof h.token).toBe("string");
      expect(typeof h.discount_pct).toBe("number");
      expect(h.discount_pct).toBeGreaterThan(0);
      expect(typeof h.annual_saving_usd).toBe("number");
      expect(typeof h.is_flat).toBe("boolean");
    }
    // The top-ranked venue's row carries the matching hint.
    const top = r.ranking[0];
    if (top.token_discount_hint) {
      const consolidated = r.token_discount_hints.find((h: any) => h.exchange === top.exchange);
      expect(consolidated).toBeDefined();
      expect(consolidated.token).toBe(top.token_discount_hint.token);
      expect(consolidated.discount_pct).toBe(top.token_discount_hint.discount_pct);
    }
    // Advice contains a concrete token-discount line (not the old generic one).
    const adviceText = r.advice.join(" ");
    expect(adviceText).toContain("Native-token discount opportunities");
    expect(adviceText).not.toContain("rerun with useToken=true (plus tokenBalance where relevant) to price it");
  });

  it("persona with useToken=true does NOT inject token_discount_hints (discount already priced)", () => {
    const r = analyzePersona("active_spot_trader", "JP", { useToken: true, tokenBalance: 0 }) as any;
    expect(r.inputs.use_token).toBe(true);
    expect(r.token_discount_hints).toBeUndefined();
    // No row carries a hint when the toggle is on.
    expect(r.ranking.every((x: any) => x.token_discount_hint === undefined)).toBe(true);
  });
});

function isToolErrorLike(v: unknown): boolean {
  return typeof v === "object" && v !== null && "error" in v && "code" in (v as object);
}

describe("v0.23: native-token discount payback (analyze_token_discount)", () => {
  beforeEach(() => resetCachesForTest());

  it("Binance spot $100k/mo taker: 25% BNB discount saves 25% of annual fees", () => {
    const r = analyzeTokenDiscount("binance", "SG", "spot", 100_000, { tokenBalance: 5 }) as any;
    expect(r.token).toBe("BNB");
    expect(r.has_native_discount).toBe(true);
    // 0.1% * 100k * 12 = $1,200 base.
    expect(r.base.annual_fee_usd).toBe(1200);
    const d = r.discounted;
    expect(d.discount_pct).toBe(25);
    expect(d.annual_fee_usd).toBe(900);
    expect(d.annual_saving_usd).toBe(300);
    // 5 BNB * $730 = $3,650 locked; payback = 3650 / (300/12) = 146 months.
    expect(d.holding_cost_usd).toBe(3650);
    expect(d.payback_months).toBe(146);
  });

  it("omitting tokenBalance returns the full tier table with a recommended best-payback tier", () => {
    const r = analyzeTokenDiscount("binance", "SG", "spot", 100_000) as any;
    expect(r.discounted).toBeUndefined();
    expect(Array.isArray(r.tiers_analysis)).toBe(true);
    expect(r.tiers_analysis.length).toBe(1);
    const t0 = r.tiers_analysis[0];
    expect(t0.discount_pct).toBe(25);
    expect(t0.annual_saving_usd).toBe(300);
    expect(t0.payback_months).toBeGreaterThan(0);
    expect(typeof r.recommended_tier_index).toBe("number");
  });

  it("Gate futures maker-heavy: maker-to-zero perk yields a large effective discount", () => {
    const r = analyzeTokenDiscount("gate", "JP", "futures", 500_000, { makerShare: 0.9 }) as any;
    expect(r.token).toBe("GT");
    // 5 tiers: 0 (maker→0), 100, 500, 2000, 20000.
    expect(r.tiers_analysis.length).toBe(5);
    const flat = r.tiers_analysis[0];
    expect(flat.min_balance).toBe(0);
    expect(flat.discount_pct).toBeGreaterThan(70);
    expect(flat.annual_saving_usd).toBeGreaterThan(1000);
  });

  it("OKX reports no separate native-token discount (OKX bakes it into VIP tiers)", () => {
    const r = analyzeTokenDiscount("okx", "SG", "spot", 100_000) as any;
    expect(r.has_native_discount).toBe(false);
    expect(r.tiers_analysis).toBeUndefined();
    expect(r.warnings.some((w: string) => w.includes("no separate native-token"))).toBe(true);
  });

  it("Hyperliquid HYPE staking tier: 1000 HYPE = 15% multiplicative discount", () => {
    const r = analyzeTokenDiscount("hyperliquid", "JP", "futures", 1_000_000, {
      tokenBalance: 1000,
      makerShare: 0.5,
    }) as any;
    expect(r.token).toBe("HYPE");
    expect(r.discounted.discount_pct).toBe(15);
    // 1000 HYPE * $80 = $80k.
    expect(r.discounted.holding_cost_usd).toBe(80000);
  });

  it("MEXC: 500 MX unlocks the 50% tier and is recommended over the 20% flat tier", () => {
    const r = analyzeTokenDiscount("mexc", "JP", "futures", 1_000_000, { makerShare: 0.5 }) as any;
    expect(r.tiers_analysis.length).toBe(2);
    const mx500 = r.tiers_analysis[1];
    expect(mx500.min_balance).toBe(500);
    expect(mx500.discount_pct).toBe(50);
    // 500 MX * $0.07 = $35.
    expect(mx500.holding_cost_usd).toBe(35);
    expect(r.recommended_tier_index).toBe(1);
  });

  it("compliance filtering and unknown exchange produce structured errors", () => {
    const blocked = analyzeTokenDiscount("binance", "CN", "spot", 1000) as any;
    expect(blocked.code).toBe("COUNTRY_BLOCKED");
    const unknown = analyzeTokenDiscount("foobar", "SG", "spot", 1000) as any;
    expect(unknown.code).toBe("UNKNOWN_EXCHANGE");
  });

  it("tokenPriceUsd override changes holding cost and payback", () => {
    const r = analyzeTokenDiscount("binance", "SG", "spot", 100_000, {
      tokenBalance: 5,
      tokenPriceUsd: 1000,
    }) as any;
    expect(r.token_price_usd).toBe(1000);
    expect(r.discounted.holding_cost_usd).toBe(5000);
  });
});

describe("v0.26: fiat on/off-ramp legs folded into all-in cost tools", () => {
  beforeEach(() => resetCachesForTest());

  it("calculateAnnualCost folds free SEPA deposits + free SEPA cash-outs (v0.41 OKX EU) into annual_total_cost", () => {
    // v0.41: Binance is EEA-blocked; OKX (MFSA-licensed) quotes free SEPA on
    // both legs for EU residents.
    const r = calculateAnnualCost("okx", "spot", "DE", 10_000, {
      fiatCurrency: "EUR",
      fiatDepositAmountUsd: 1000,
      fiatDepositsPerYear: 12,
      fiatCashoutAmountUsd: 5000,
      fiatCashoutsPerYear: 2,
    }) as any;
    expect(r.annual_fiat_deposit_cost).toBe(0);
    expect(r.fiat_deposit_available).toBe(true);
    expect(r.fiat_deposit_method).toBe("sepa");
    expect(r.annual_fiat_cashout_cost).toBe(0);
    expect(r.fiat_cashout_available).toBe(true);
    expect(r.fiat_cashout_method).toBe("sepa");
    expect(r.fiat_deposits_per_year).toBe(12);
    expect(r.fiat_cashouts_per_year).toBe(2);
    // $10k/mo spot at OKX referral-adjusted 0.08% taker = $96/yr trading fee.
    expect(r.annual_trading_fee).toBe(96);
    expect(r.annual_total_cost).toBe(96);
  });

  it("calculateAnnualCost charges Gate's 0.5% SEPA deposit on every event", () => {
    const r = calculateAnnualCost("gate", "spot", "DE", 10_000, {
      fiatCurrency: "EUR",
      fiatDepositAmountUsd: 1000,
      fiatDepositsPerYear: 12,
    }) as any;
    // $1,000 USD -> 920 EUR, Gate SEPA 0.5% = 4.60 EUR = $5.00 per deposit x12.
    expect(r.annual_fiat_deposit_cost).toBe(60);
    expect(r.fiat_deposit_available).toBe(true);
    expect(r.fiat_deposit_method).toBe("sepa");
    expect(r.annual_total_cost).toBe(
      Math.round((r.annual_trading_fee + r.annual_fiat_deposit_cost) * 100) / 100,
    );
  });

  it("calculateAnnualCost flags a venue with NO direct rail and excludes the leg", () => {
    const r = calculateAnnualCost("hyperliquid", "spot", "DE", 10_000, {
      fiatCurrency: "EUR",
      fiatDepositAmountUsd: 1000,
      fiatDepositsPerYear: 12,
    }) as any;
    expect(r.annual_fiat_deposit_cost).toBe(0);
    expect(r.fiat_deposit_available).toBe(false);
    expect(r.fiat_deposit_method).toBeUndefined();
    expect(r.fiat_deposits_per_year).toBe(12);
    // No rail -> leg excluded: total is just the trading fee, never silently a paid zero.
    expect(r.annual_total_cost).toBe(r.annual_trading_fee);
  });

  it("calculateAnnualCost omits fiat keys entirely when no fiat habit is passed (backward compatible)", () => {
    const r = calculateAnnualCost("binance", "spot", "DE", 10_000) as any;
    expect(r.annual_fiat_deposit_cost).toBeUndefined();
    expect(r.annual_fiat_cashout_cost).toBeUndefined();
    expect(r.fiat_deposit_available).toBeUndefined();
    expect(r.fiat_deposits_per_year).toBeUndefined();
    expect(r.annual_total_cost).toBe(r.annual_trading_fee);
  });

  it("compareTotalCost folds fiat deposits per row, keeps free-rail zero distinct from no-rail flag", () => {
    const rows = compareTotalCost("spot", "DE", 10_000, {
      fiatCurrency: "EUR",
      fiatDepositAmountUsd: 1000,
      fiatDepositsPerYear: 12,
    }) as any[];
    // v0.41: OKX (not Binance, which is EEA-blocked) is the free-SEPA exemplar.
    const okx = rows.find((x) => x.exchange === "okx");
    const gate = rows.find((x) => x.exchange === "gate");
    const hl = rows.find((x) => x.exchange === "hyperliquid");
    // Free but real rail: cost 0 AND available true.
    expect(okx.fiat_deposit_cost).toBe(0);
    expect(okx.fiat_deposit_available).toBe(true);
    expect(okx.fiat_deposit_method).toBe("sepa");
    // EEA-blocked venues are filtered out of the comparison entirely.
    expect(rows.find((x) => x.exchange === "binance")).toBeUndefined();
    expect(rows.find((x) => x.exchange === "mexc")).toBeUndefined();
    // Paid rail: $5 x 12 = $60 folded into total.
    expect(gate.fiat_deposit_cost).toBe(60);
    expect(gate.fiat_deposit_available).toBe(true);
    expect(gate.total_cost).toBe(
      Math.round((gate.trading_fee + gate.fiat_deposit_cost) * 100) / 100,
    );
    // No rail: excluded (0) but explicitly flagged false.
    expect(hl.fiat_deposit_cost).toBe(0);
    expect(hl.fiat_deposit_available).toBe(false);
    expect(hl.fiat_deposit_method).toBeUndefined();
  });

  it("compareTotalCost honors fiatMethod=card and omits fiat keys when not requested", () => {
    const cardRows = compareTotalCost("spot", "US", 10_000, {
      fiatDepositAmountUsd: 1000,
      fiatDepositsPerYear: 12,
      fiatMethod: "card",
    }) as any[];
    const okx = cardRows.find((x) => x.exchange === "okx");
    // OKX US card ~2% = $20 per $1,000 deposit x12 = $240/yr.
    expect(okx.fiat_deposit_cost).toBe(240);
    expect(okx.fiat_deposit_available).toBe(true);
    expect(okx.fiat_deposit_method).toBe("card");
    expect(okx.total_cost).toBe(
      Math.round((okx.trading_fee + okx.fiat_deposit_cost) * 100) / 100,
    );

    const plain = compareTotalCost("spot", "DE", 10_000) as any[];
    for (const row of plain) {
      expect(row.fiat_deposit_cost).toBeUndefined();
      expect(row.fiat_deposit_available).toBeUndefined();
    }
  });
});

describe("v0.27: recommend_exchange folds the fiat habit into the score", () => {
  beforeEach(() => resetCachesForTest());

  it("small monthly SEPA DCA buyer is recommended a free-bank-rail venue (v0.41: fiat flips Hyperliquid -> OKX)", () => {
    // v0.41: without the fiat habit, raw fees rank the no-rail Hyperliquid book
    // first among EEA-usable venues (MEXC/Binance are region-blocked).
    const plain = recommendExchange("spot", "DE", 500) as any;
    expect(plain.best.exchange).toBe("hyperliquid");
    expect(plain.best.fiat_deposit_cost).toBeUndefined();

    // With 12x €1,000 SEPA deposits/yr the free-SEPA CASP venues leap ahead:
    // OKX/Kraken/Bitstamp rails are free, Gate charges $60/yr.
    const r = recommendExchange("spot", "DE", 500, {
      fiatCurrency: "EUR",
      fiatDepositAmountUsd: 1000,
      fiatDepositsPerYear: 12,
    }) as any;
    const all = [r.best, ...r.alternatives];
    expect(r.best.exchange).toBe("okx");
    expect(r.best.fiat_deposit_cost).toBe(0);
    expect(r.best.fiat_deposit_available).toBe(true);
    expect(r.best.fiat_deposit_method).toBe("sepa");
    expect(r.best.reasons[0]).toContain("fiat on/off-ramping");
    expect(r.best.reasons.some((x: string) => x.startsWith("Direct fiat:"))).toBe(true);

    // Every other free-SEPA EEA venue also carries a zero, available leg.
    for (const ex of ["kraken", "bitstamp"]) {
      const row = all.find((x) => x.exchange === ex);
      expect(row.fiat_deposit_available).toBe(true);
      expect(row.fiat_deposit_cost).toBe(0);
    }

    const gate = all.find((x) => x.exchange === "gate");
    expect(gate.fiat_deposit_cost).toBe(60);

    // Rail-less Hyperliquid: leg flagged false, explicit tradeoff, cannot win.
    const hl = all.find((x) => x.exchange === "hyperliquid");
    expect(hl.fiat_deposit_available).toBe(false);
    expect(hl.fiat_deposit_method).toBeUndefined();
    expect(hl.tradeoffs.some((x: string) => x.includes("No direct EUR deposit rail"))).toBe(true);
    expect(hl.score).toBeLessThan(r.best.score);
  });

  it("US card-funded buyer: OKX wins with 12 x 2% card = $120/yr priced into the result", () => {
    const r = recommendExchange("spot", "US", 500, {
      fiatDepositAmountUsd: 500,
      fiatDepositsPerYear: 12,
      fiatMethod: "card",
    }) as any;
    const all = [r.best, ...r.alternatives];
    expect(r.best.exchange).toBe("okx");
    expect(r.best.fiat_deposit_cost).toBe(120);
    expect(r.best.fiat_deposit_available).toBe(true);
    expect(r.best.fiat_deposit_method).toBe("card");
    // Every ranked row carries the leg fields when the habit is passed.
    for (const row of all) {
      expect(typeof row.fiat_deposit_available).toBe("boolean");
      expect(typeof row.fiat_deposit_cost).toBe("number");
    }
  });

  it("cashout-only habit attaches cash-out legs and stays backward compatible when omitted", () => {
    const r = recommendExchange("spot", "GB", 10_000, {
      fiatCurrency: "GBP",
      fiatCashoutAmountUsd: 2000,
      fiatCashoutsPerYear: 4,
    }) as any;
    expect(typeof r.best.fiat_cashout_available).toBe("boolean");
    expect(r.best.fiat_deposit_cost).toBeUndefined();
    expect(r.best.reasons.some((x: string) => x.startsWith("Direct fiat:"))).toBe(true);

    const plain = recommendExchange("spot", "GB", 10_000) as any;
    expect(plain.best.fiat_cashout_cost).toBeUndefined();
    expect(plain.best.fiat_cashout_available).toBeUndefined();
    expect(typeof plain.advice).toBe("string");
  });

  it("fiat habit adds fiat_routes.json sources to provenance and omits them otherwise", () => {
    const r = recommendExchange("spot", "DE", 500, {
      fiatCurrency: "EUR",
      fiatDepositAmountUsd: 1000,
      fiatDepositsPerYear: 12,
    }) as any;
    const withFiat = JSON.stringify(r.data_sources ?? []);
    expect(withFiat).toContain("cexfinder.com");

    const plain = recommendExchange("spot", "DE", 500) as any;
    const noFiat = JSON.stringify(plain.data_sources ?? []);
    expect(noFiat).not.toContain("cexfinder.com");
  });
});

describe("v0.28: compare_personas multi-persona decision matrix", () => {
  beforeEach(() => resetCachesForTest());

  it("runs all 7 personas for JP and returns a consistent matrix", () => {
    const r = comparePersonas("JP") as any;
    expect(r.personas).toHaveLength(7);
    expect(r.personas.map((p: any) => p.persona.id)).toEqual(listPersonas().map((p) => p.id));
    // v0.38: JP allows 13 venues in the union (Coinbase blocked; Bitstamp
    // trades spot in JP but its regulated perps are EU/EEA-eligible only).
    expect(r.venues).toHaveLength(13);
    const purposeById = Object.fromEntries(listPersonas().map((p) => [p.id, p.purpose]));
    for (const entry of r.personas) {
      expect(entry.best).not.toBeNull();
      expect(entry.best_complete).not.toBeNull();
      // Spot personas price all 13 venues; futures personas drop Bitstamp
      // (product_blocked) and price 12.
      expect(entry.matrix).toHaveLength(purposeById[entry.persona.id] === "futures" ? 12 : 13);
      // Rows are cheapest-first and best matches the first row.
      const costs = entry.matrix.map((c: any) => c.annual_all_in);
      const sorted = [...costs].sort((a, b) => a - b);
      expect(costs).toEqual(sorted);
      expect(entry.best.exchange).toBe(entry.matrix[0].exchange);
      expect(entry.best.annual_all_in).toBe(entry.matrix[0].annual_all_in);
      expect(typeof entry.best.cost_mix_pct.trading_fee).toBe("number");
      expect(Array.isArray(entry.best.tradeoffs)).toBe(true);
    }
    // venue_wins sorted by complete wins then headline wins.
    for (let i = 1; i < r.venue_wins.length; i++) {
      const prev = r.venue_wins[i - 1];
      const cur = r.venue_wins[i];
      expect(
        cur.complete_persona_ids.length - prev.complete_persona_ids.length ||
          cur.headline_persona_ids.length - prev.headline_persona_ids.length,
      ).toBeLessThanOrEqual(0);
    }
    // OKX is the most versatile REALISTIC pick in JP (3 complete wins).
    expect(r.most_versatile).toBe("okx");
    const okxWins = r.venue_wins.find((w: any) => w.exchange === "okx");
    expect(okxWins.complete_persona_ids).toHaveLength(3);
    expect(r.data_as_of).toBeTruthy();
  });

  it("demotes rail-less headline winners: Hyperliquid headlines but never wins a complete pick", () => {
    const r = comparePersonas("JP") as any;
    const hlWins = r.venue_wins.find((w: any) => w.exchange === "hyperliquid");
    // Hyperliquid is the cheapest modeled venue for 3 personas (casual/HODLer/scalper)…
    expect(hlWins.headline_persona_ids.length).toBe(3);
    // …but has no direct fiat rails / missing withdrawal routes, so ZERO realistic wins.
    expect(hlWins.complete_persona_ids).toHaveLength(0);
    // The casual_buyer winner therefore carries a rail/route tradeoff.
    const casual = r.personas.find((p: any) => p.persona.id === "casual_buyer");
    expect(casual.best.exchange).toBe("hyperliquid");
    expect(casual.best_complete.exchange).not.toBe("hyperliquid");
    expect(
      casual.best.tradeoffs.some((t: string) => /rail|route/i.test(t)),
    ).toBe(true);
  });

  it("matches the standalone analyze_persona result for the same persona/country", () => {
    const batch = comparePersonas("JP", { personas: ["active_spot_trader"] }) as any;
    const single = analyzePersona("active_spot_trader", "JP") as any;
    expect(batch.personas).toHaveLength(1);
    expect(batch.personas[0].best.exchange).toBe(single.best.exchange);
    expect(batch.personas[0].best.annual_all_in).toBe(single.best.annual_all_in);
    expect(batch.personas[0].best_complete.exchange).toBe(single.best_complete.exchange);
  });

  it("honors persona subset ordering, dedupes, and validates unknown ids", () => {
    const sub = comparePersonas("JP", {
      personas: ["dex_native", "active_spot_trader"],
    }) as any;
    expect(sub.personas.map((p: any) => p.persona.id)).toEqual([
      "dex_native",
      "active_spot_trader",
    ]);

    const dup = comparePersonas("JP", { personas: ["dex_native", "dex_native"] }) as any;
    expect(dup.personas).toHaveLength(1);

    const bad = comparePersonas("JP", { personas: ["nope"] });
    expect((bad as any).code).toBe("INVALID_INPUT");
  });

  it("global useToken override changes the ranking vs the presets", () => {
    const plain = comparePersonas("JP") as any;
    const withToken = comparePersonas("JP", { useToken: true }) as any;
    const plainWinners = plain.personas.map((p: any) => p.best.exchange).join(",");
    const tokenWinners = withToken.personas.map((p: any) => p.best.exchange).join(",");
    expect(tokenWinners).not.toBe(plainWinners);
    // US: 5 venues in the union (okx/gate/kraken/coinbase + Bitstamp spot;
    // Bitstamp futures are product-gated), and every persona still ranks.
    const us = comparePersonas("US") as any;
    expect(us.personas).toHaveLength(7);
    expect(us.venues).toHaveLength(5);
  });
});

describe("v0.31: calculate_savings + compare_total_cost bilingual narrative", () => {
  beforeEach(() => resetCachesForTest());

  it("calculateSavings localizes tier_warning to Chinese while numbers stay machine-readable", () => {
    const zh = calculateSavings("binance", 1_000_000, "spot", "JP", {
      tokenBalance: 0,
      language: "zh",
    }) as any;
    expect(zh.tier_warning).toContain("交易量达到");
    expect(zh.tier_warning).toContain("实际生效档位为");
    expect(zh.tier_warning).toContain("BNB");
    expect(zh.tier_warning).toContain("VIP1");

    const en = calculateSavings("binance", 1_000_000, "spot", "JP", {
      tokenBalance: 0,
    }) as any;
    expect(en.tier_warning).toContain("Volume qualifies for tier");
    // Default (no language) is byte-identical to explicit en.
    const explicitEn = calculateSavings("binance", 1_000_000, "spot", "JP", {
      tokenBalance: 0,
      language: "en",
    }) as any;
    expect(en.tier_warning).toBe(explicitEn.tier_warning);
  });

  it("calculateSavings falls back to English for unknown language values", () => {
    const r = calculateSavings("binance", 1_000_000, "spot", "JP", {
      tokenBalance: 0,
      language: "fr" as any,
    }) as any;
    expect(r.tier_warning).toContain("Volume qualifies for tier");
    expect(r.tier_warning).not.toContain("交易量达到");
  });

  it("held-back BNB warning quotes the volume tier's real requirement (no 'undefined')", () => {
    // v0.31 regression: tokenBalance=0 (held back) previously exposed no min_token,
    // rendering "holding at least undefined BNB" in both languages.
    const r = calculateSavings("binance", 1_000_000, "spot", "JP", { tokenBalance: 0 }) as any;
    expect(r.tier_warning).toContain("at least 5 BNB");
    expect(r.tier_warning).not.toContain("undefined");
    // Sufficient balance still qualifies and stays warning-free.
    const ok = calculateSavings("binance", 1_000_000, "spot", "JP", { tokenBalance: 5 }) as any;
    expect(ok.tier_warning).toBeUndefined();
  });

  it("compareTotalCost localizes per-row tier_warning to Chinese and keeps EN default", () => {
    const zhRows = compareTotalCost("spot", "JP", 1_000_000, {
      tokenBalance: 0,
      language: "zh",
    }) as any[];
    const zhBinance = zhRows.find((x) => x.exchange === "binance")!;
    expect(zhBinance.tier_warning).toContain("交易量达到");
    expect(zhBinance.tier_warning).toContain("实际生效档位为");

    const enRows = compareTotalCost("spot", "JP", 1_000_000, { tokenBalance: 0 }) as any[];
    const enBinance = enRows.find((x) => x.exchange === "binance")!;
    expect(enBinance.tier_warning).toContain("Volume qualifies for tier");
    expect(enBinance.tier_warning).not.toContain("实际生效档位为");
  });
});

// v0.34: volumeWhatIf — sweep curves, tier crossings, next-rung advice
describe("v0.34: volumeWhatIf sweep", () => {
  it("builds a threshold-union sweep with consistent rankings and non-increasing fee curves", () => {
    const r = volumeWhatIf("spot", "US", {}) as any;
    expect(r.error).toBeUndefined();
    // US spot allowed venues: OKX, Gate, Kraken, Coinbase + Bitstamp (v0.38;
    // Binance blocked; Bitstamp futures are product-gated, spot open).
    expect(r.exchanges.map((e: any) => e.exchange).sort()).toEqual(
      ["bitstamp", "coinbase", "gate", "kraken", "okx"].sort(),
    );
    expect(r.volumes[0]).toBe(0);
    const sorted = [...r.volumes].sort((a: number, b: number) => a - b);
    expect(r.volumes).toEqual(sorted);
    expect(new Set(r.volumes).size).toBe(r.volumes.length); // deduped
    expect(r.points.length).toBe(r.volumes.length);

    for (const p of r.points) {
      // ranking sorted by weighted fee
      for (let i = 1; i < p.ranking.length; i++) {
        expect(p.ranking[i - 1].weighted_fee_pct).toBeLessThanOrEqual(p.ranking[i].weighted_fee_pct);
      }
      expect(p.cheapest).toMatchObject({
        exchange: p.ranking[0].exchange,
        tier: p.ranking[0].tier,
      });
      expect(p.annual_traded_notional_usd).toBe(p.monthly_volume_usd * 12);
    }
    // Zero volume = zero annual fee everywhere.
    expect(r.points[0].cheapest.annual_fee_usd).toBe(0);
    expect(r.points[0].ranking.every((x: any) => x.annual_fee_usd === 0)).toBe(true);

    // Per-venue weighted fee must never rise as volume grows.
    for (const ex of r.exchanges) {
      for (let i = 1; i < ex.sweep.length; i++) {
        expect(ex.sweep[i].weighted_fee_pct).toBeLessThanOrEqual(ex.sweep[i - 1].weighted_fee_pct);
        expect(ex.sweep[i].tier_crossed).toBe(
          ex.sweep[i].tier !== ex.sweep[i - 1].tier ? true : undefined,
        );
      }
    }

    // tier_crossings matches the per-venue sweep flags exactly.
    for (const c of r.tier_crossings) {
      const ex = r.exchanges.find((e: any) => e.exchange === c.exchange);
      const idx = ex.sweep.findIndex((s: any) => s.monthly_volume_usd === c.at_monthly_volume_usd);
      expect(idx).toBeGreaterThan(0);
      expect(ex.sweep[idx].tier).toBe(c.to_tier);
      expect(ex.sweep[idx - 1].tier).toBe(c.from_tier);
      expect(ex.sweep[idx].tier_crossed).toBe(true);
    }
  });

  it("computes exact next-rung thresholds and savings at the base volume", () => {
    const r = volumeWhatIf("spot", "US", { baseVolume: 80_000 }) as any;
    expect(r.base_monthly_volume_usd).toBe(80_000);
    expect(r.volumes).toContain(80_000);
    const coinbase = r.exchanges.find((e: any) => e.exchange === "coinbase");
    expect(coinbase.current).toMatchObject({ monthly_volume_usd: 80_000, tier: "Tier 3" });
    expect(coinbase.next_tier).toMatchObject({
      from_tier: "Tier 3",
      to_tier: "Tier 4",
      at_monthly_volume_usd: 100_000,
      additional_monthly_volume_usd: 20_000,
    });
    expect(coinbase.next_tier.saving_per_year_usd_at_current_volume).toBeCloseTo(288, 1);
    expect(coinbase.next_tier.blocked_by_holding_gate).toBeUndefined();
    // advice names the cheapest venue at base volume
    expect(r.advice[0]).toContain("80,000");
    expect(r.advice.some((a: string) => a.includes("Coinbase"))).toBe(true);
  });

  it("flags Binance spot BNB AND-gate rungs as unreachable by volume alone", () => {
    // Binance serves TH; zero BNB means higher volume rungs cannot take effect.
    const r = volumeWhatIf("spot", "TH", { baseVolume: 500_000, tokenBalance: 0 }) as any;
    const binance = r.exchanges.find((e: any) => e.exchange === "binance");
    expect(binance).toBeDefined();
    expect(binance.next_tier).not.toBeNull();
    expect(binance.next_tier.blocked_by_holding_gate).toBe(true);
    expect(binance.next_tier.weighted_fee_pct_next).toBe(binance.next_tier.weighted_fee_pct_now);
    expect(binance.next_tier.saving_per_year_usd_at_current_volume).toBe(0);
    // gated venues get an explicit advice line instead of fake savings
    expect(r.advice.some((a: string) => a.includes("Binance"))).toBe(true);
  });

  it("honours explicit volumes, futures purpose filtering, and pair/spot-only venues", () => {
    const r = volumeWhatIf("futures", "CN", {
      volumes: [100_000, 1_000_000, 10_000_000],
    }) as any;
    expect(r.volumes).toEqual([100_000, 1_000_000, 10_000_000]);
    expect(r.points.length).toBe(3);
    const venues = r.exchanges.map((e: any) => e.exchange);
    expect(venues).toContain("hyperliquid");
    expect(venues).not.toContain("coinbase"); // spot-only
    // no base volume -> no next_tier field and no current
    expect(r.exchanges.every((e: any) => e.current === null)).toBe(true);
    expect(r.exchanges.every((e: any) => e.next_tier === undefined)).toBe(true);
  });

  it("localizes narrative advice in Chinese", () => {
    const zh = volumeWhatIf("futures", "CN", { baseVolume: 200_000, language: "zh" as any }) as any;
    expect(zh.advice[0]).toContain("月成交量");
    expect(zh.advice[0]).toContain("交易费最低");
    const en = volumeWhatIf("futures", "CN", { baseVolume: 200_000, language: "en" as any }) as any;
    expect(en.advice[0]).toContain("/month");
    expect(en.advice[0]).not.toContain("月成交量");
  });

  it("rejects bad volume inputs and unsupported currency", () => {
    const badBase = volumeWhatIf("spot", "US", { baseVolume: -5 });
    expect(badBase).toHaveProperty("code", "BAD_VOLUME");
    const badArr = volumeWhatIf("spot", "US", { volumes: [1000, NaN] });
    expect(badArr).toHaveProperty("code", "BAD_VOLUME");
    const badCur = volumeWhatIf("spot", "US", { currency: "XYZ" });
    expect(badCur).toHaveProperty("code", "UNKNOWN_CURRENCY");
    const usFut = volumeWhatIf("futures", "US", {}) as any;
    expect(usFut.error).toBeUndefined();
    const futVenues = usFut.exchanges.map((e: any) => e.exchange);
    expect(futVenues).not.toContain("coinbase"); // spot-only
    expect(futVenues).not.toContain("hyperliquid"); // US blocked
    expect(futVenues).not.toContain("bitstamp"); // v0.38: perps EU/EEA-eligible only (product gate)
    expect(futVenues).toContain("kraken");
  });
});

// v0.35: compareCountries — same profile across countries, availability matrix, comparable basis
describe("v0.35: compareCountries matrix", () => {
  it("runs the default 7-country set with an internally consistent availability matrix", () => {
    const r = compareCountries("swing_futures_trader", {}) as any;
    expect(r.error).toBeUndefined();
    expect(r.countries).toEqual(["US", "GB", "DE", "JP", "SG", "BR", "CN"]);
    expect(r.rows).toHaveLength(7);
    expect(r.purpose).toBe("futures");
    for (const row of r.rows) {
      expect(row.winner).not.toBeNull();
      // v0.45: 18 venues total; available = venue-level onboarding (product
      // gating, e.g. Bitstamp US perps, lands in unsupported_product instead).
      expect(row.available_venues).toBe(18 - row.blocked_venues.length);
      // Every country row lists every 18 venues somewhere.
      expect(row.blocked_venues.length + row.unsupported_product_venues.length + row.ranking.length).toBe(18);
      expect(row.comparison_annual_all_in).not.toBeNull();
    }
    for (const va of r.venue_availability) {
      expect(Object.keys(va.per_country).sort()).toEqual([...r.countries].sort());
      for (const cc of r.countries) {
        const row = r.rows.find((x: any) => x.country === cc);
        if (row.blocked_venues.includes(va.exchange)) expect(va.per_country[cc]).toBe("blocked");
        else if (row.unsupported_product_venues.includes(va.exchange))
          expect(va.per_country[cc]).toBe("unsupported_product");
        else expect(va.per_country[cc]).toBe("available");
      }
    }
  });

  it("marks Coinbase blocked in JP/CN but only product-unsupported in DE for a futures persona", () => {
    const r = compareCountries("swing_futures_trader", { countries: ["DE", "FR", "JP", "CN"] }) as any;
    const coinbase = r.venue_availability.find((v: any) => v.exchange === "coinbase");
    expect(coinbase.per_country.DE).toBe("unsupported_product");
    expect(coinbase.per_country.FR).toBe("unsupported_product");
    expect(coinbase.per_country.JP).toBe("blocked");
    expect(coinbase.per_country.CN).toBe("blocked");
    const de = r.rows.find((x: any) => x.country === "DE");
    const fr = r.rows.find((x: any) => x.country === "FR");
    expect(de.unsupported_product_venues).toContain("coinbase");
    expect(de.blocked_venues).not.toContain("coinbase");
    // v0.41 futures persona: Bybit/Gate are EEA product-blocked (MiFID),
    // Coinbase is spot-only; v0.42 Bitvavo, v0.43 Finst, v0.44 Bitpanda and
    // v0.45 Bison are EEA-authorized but spot-only — exactly these seven are
    // unsupported in EEA.
    expect(de.unsupported_product_venues.sort()).toEqual(["bison", "bitpanda", "bitvavo", "bybit", "coinbase", "finst", "gate"]);
    expect(fr.unsupported_product_venues.sort()).toEqual(["bison", "bitpanda", "bitvavo", "bybit", "coinbase", "finst", "gate"]);
    // v0.41: the seven CASP-less/barred venues are venue-blocked in every EEA
    // member, even ones (FR) that resolve through the default country key.
    const eeaBlocked = ["binance", "mexc", "bitget", "kucoin", "bingx", "phemex", "blofin"].sort();
    expect(de.blocked_venues.sort()).toEqual(eeaBlocked);
    expect(fr.blocked_venues.sort()).toEqual(eeaBlocked);
    // 18 venues - 7 venue-blocked = 11 onboardable (4 futures-priced, 7 product-unsupported).
    expect(de.available_venues).toBe(11);
  });

  it("prices the casual card buyer on the comparable all-legs basis across countries", () => {
    const r = compareCountries("casual_buyer", {}) as any;
    // Outside the US, Hyperliquid headlines ($4 on-chain only) but misses card
    // fiat rails, so cross-country comparison must use the all-legs pick.
    const gb = r.rows.find((x: any) => x.country === "GB");
    expect(gb.winner.exchange).toBe("hyperliquid");
    expect(gb.comparison_basis).toBe("best_complete");
    expect(gb.comparison_annual_all_in).toBeGreaterThan(gb.winner.annual_all_in);
    expect(gb.extra_vs_cheapest_country_pct).toBeGreaterThan(0);
    // Germany's cheap SEPA/card rails via Bybit make it the cheapest realistic pick.
    expect(r.cheapest_country.country).toBe("DE");
    expect(r.cheapest_country.basis).toBe("best_complete");
    expect(r.costliest_country.country).toBe("US");
    expect(r.spread_usd).toBeCloseTo(52.55, 1);
    // one-decimal percentage
    for (const row of r.rows) {
      const pct = row.extra_vs_cheapest_country_pct!;
      expect(Math.abs(pct * 10 - Math.round(pct * 10))).toBeLessThan(1e-6);
    }
  });

  it("handles equal-cost countries, custom/deduped country lists and unknown personas", () => {
    // v0.38: DE/JP no longer share a futures stack — Bitstamp's 0.015% taker
    // perps are EU-eligible only (open in DE/default, product-gated in JP).
    // BR and AU both resolve through the default key, so their stacks are
    // byte-identical: same winner, zero gap.
    const r = compareCountries("swing_futures_trader", { countries: ["BR", "AU"] }) as any;
    expect(r.countries).toEqual(["BR", "AU"]);
    // Futures-only stack is country-independent when the same venue wins: zero gap.
    expect(r.rows.every((x: any) => x.extra_vs_cheapest_country_usd === 0)).toBe(true);
    expect(r.spread_usd).toBe(0);
    const dedup = compareCountries("active_spot_trader", {
      countries: ["us", "US", "de", "DE"],
    }) as any;
    expect(dedup.countries).toEqual(["US", "DE"]);
    const bad = compareCountries("ghost_trader");
    expect(bad).toHaveProperty("code", "INVALID_INPUT");
    const badCur = compareCountries("active_spot_trader", { currency: "XYZ" });
    expect(badCur).toHaveProperty("code", "UNKNOWN_CURRENCY");
  });

  it("renders Chinese narrative including cheapest and blocked-venue lines", () => {
    const zh = compareCountries("active_spot_trader", {
      countries: ["US", "DE"],
      language: "zh" as any,
    }) as any;
    expect(zh.advice.some((a: string) => a.includes("最便宜"))).toBe(true);
    expect(zh.advice.some((a: string) => a.includes("不可用"))).toBe(true);
    const en = compareCountries("active_spot_trader", {
      countries: ["US", "DE"],
      language: "en",
    }) as any;
    expect(en.advice.some((a: string) => a.includes("cheapest"))).toBe(true);
  });
});

// v0.36: markdown/CSV matrix rendering on the three matrix tools
describe("v0.36: rendered matrix tables", () => {
  it("renders the what-if sweep as markdown and clean numeric CSV (both)", () => {
    const r = volumeWhatIf("spot", "US", {
      volumes: [0, 100000, 1000000],
      format: "both",
      language: "zh" as any,
    }) as any;
    expect(r.rendered.metric).toBe("weighted_fee_pct");
    expect(r.rendered.markdown).toContain("| 月成交量（USD） | okx | gate | kraken | coinbase | bitstamp |");
    expect(r.rendered.markdown).toContain("| $100K |");
    expect(r.rendered.markdown.split("\n")[4]).toContain("| $0 |");
    // CSV: CRLF rows, raw numeric volume, no $, no currency symbols
    const csvLines = r.rendered.csv.split("\r\n");
    expect(csvLines[0]).toBe("月成交量（USD）,okx,gate,kraken,coinbase,bitstamp");
    expect(csvLines[1].startsWith("0,")).toBe(true);
    expect(csvLines[2].startsWith("100000,")).toBe(true);
    expect(r.rendered.csv).not.toContain("$");
  });

  it("supports the tier and annual-fee metrics, and format=markdown only", () => {
    const tier = volumeWhatIf("spot", "US", {
      volumes: [100000],
      format: "markdown",
      tableMetric: "tier",
    }) as any;
    expect(tier.rendered.csv).toBeUndefined();
    expect(tier.rendered.metric).toBe("tier");
    const tierDataLine = tier.rendered.markdown.split("\n")[4];
    expect(tierDataLine).toContain("Regular");
    const fee = volumeWhatIf("spot", "US", {
      volumes: [100000],
      format: "csv",
      tableMetric: "annual_fee_usd",
    }) as any;
    expect(fee.rendered.markdown).toBeUndefined();
    // $100k × okx 0.0736% × 12 = $883.2 annual
    const dataLine = fee.rendered.csv.split("\r\n")[1];
    const okxCell = dataLine.split(",")[1];
    expect(parseFloat(okxCell)).toBeCloseTo(883.2, 1);
  });

  it("renders the country availability matrix with three statuses, and cost metric", () => {
    const r = compareCountries("swing_futures_trader", {
      countries: ["DE", "JP"],
      format: "both",
      language: "zh" as any,
    }) as any;
    expect(r.rendered.metric).toBe("availability");
    const coinbaseLine = r.rendered.markdown.split("\n").find((l: string) => l.startsWith("| coinbase |"))!;
    expect(coinbaseLine).toContain("–"); // DE: product unsupported
    expect(coinbaseLine).toContain("⛔"); // JP: compliance blocked
    const cbCsv = r.rendered.csv.split("\r\n").find((l) => l.startsWith("coinbase,"))!;
    expect(cbCsv).toBe("coinbase,unsupported_product,blocked");

    const cost = compareCountries("swing_futures_trader", {
      countries: ["DE", "JP"],
      format: "csv",
      tableMetric: "cost",
    }) as any;
    expect(cost.rendered.metric).toBe("cost");
    expect(cost.rendered.csv.split("\r\n")[0]).toBe("Venue,DE,JP");
    // identical futures stack in both countries → equal row values
    const okxRow = cost.rendered.csv.split("\r\n").find((l: string) => l.startsWith("okx,"))!;
    const [, de, jp] = okxRow.split(",");
    expect(de).toBe(jp);
  });

  it("marks rail-missing persona cells with † only in markdown, never in CSV", () => {
    const r = comparePersonas("JP", {
      personas: ["casual_buyer", "dex_native"],
      format: "both",
    }) as any;
    const hlLine = r.rendered.markdown.split("\n").find((l: string) => l.startsWith("| hyperliquid |"))!;
    expect(hlLine).toContain("†");
    // CSV stays numeric-clean
    const hlCsv = r.rendered.csv.split("\r\n").find((l) => l.startsWith("hyperliquid,"))!;
    expect(hlCsv).not.toContain("†");
    expect(hlCsv.split(",").slice(1).every((c) => c === "" || !Number.isNaN(Number(c)))).toBe(true);
  });

  it("keeps default json output byte-shape stable (no rendered field) and rejects bad options", () => {
    const plain = volumeWhatIf("spot", "US", { volumes: [10000] });
    expect((plain as any).rendered).toBeUndefined();
    expect(comparePersonas("JP", {}).rendered).toBeUndefined();
    expect(compareCountries("active_spot_trader", { countries: ["DE"] }).rendered).toBeUndefined();
    expect(volumeWhatIf("spot", "US", { format: "pdf" as any })).toHaveProperty("code", "INVALID_INPUT");
    expect(
      volumeWhatIf("spot", "US", { format: "csv", tableMetric: "bogus" as any }),
    ).toHaveProperty("code", "INVALID_INPUT");
    expect(
      compareCountries("active_spot_trader", { countries: ["DE"], tableMetric: "bogus" as any }),
    ).toHaveProperty("code", "INVALID_INPUT");
  });

  it("escapes markdown pipes and RFC4180-quotes CSV fields with commas/quotes", () => {
    const fake = {
      country: "US",
      personas: [
        {
          persona: { id: "p1", name_en: "A | B, C", name_zh: "画像" },
          matrix: [{ exchange: "bin,ce", annual_all_in: 1, withdrawal_unsupported: false }],
        },
      ],
      venues: ["bin,ce"],
    } as any;
    const out = renderTable("personas", fake, "both", "en");
    const header = out.markdown!.split("\n")[2];
    expect(header).toContain("A \\| B, C"); // pipe escaped, comma intact
    const firstRow = out.markdown!.split("\n")[4];
    expect(firstRow).toContain("| bin,ce | 1 |"); // commas need no escaping in markdown
    // Comma in a CSV cell must be double-quoted; embedded quotes doubled.
    expect(out.csv!.split("\r\n")[0]).toContain('"A | B, C"');
    expect(out.csv!.split("\r\n")[1].startsWith('"bin,ce",')).toBe(true);

    // embedded double quotes are doubled per RFC 4180
    const quoteFake = {
      country: "US",
      personas: [
        {
          persona: { id: "p1", name_en: 'He said "hi"', name_zh: "画像" },
          matrix: [{ exchange: "x", annual_all_in: 1, withdrawal_unsupported: false }],
        },
      ],
      venues: ["x"],
    } as any;
    expect(renderTable("personas", quoteFake, "csv", "en").csv!.split("\r\n")[0]).toContain('"He said ""hi"""');
  });
});

// v0.37: BloFin — 13th venue (derivatives-led Cayman venue, asset-OR tiers, no token)
describe("v0.37: BloFin integration", () => {
  beforeEach(() => resetCachesForTest());

  it("base spot 0.10/0.10 and futures 0.02/0.06 at Regular", () => {
    const spot = resolveFeeRate("blofin", "spot", 0) as any;
    expect(spot).toMatchObject({ tier: "Regular", base_maker: 0.1, base_taker: 0.1 });
    const fut = resolveFeeRate("blofin", "futures", 0) as any;
    expect(fut).toMatchObject({ tier: "Regular", base_maker: 0.02, base_taker: 0.06 });
  });

  it("volume track: spot VIP1 at $1M -> VIP5 at $8M; futures VIP1 at $10M", () => {
    expect(resolveFeeRate("blofin", "spot", 1_000_000) as any).toMatchObject({
      tier: "VIP1",
      base_maker: 0.035,
      base_taker: 0.06,
    });
    expect(resolveFeeRate("blofin", "spot", 8_000_000) as any).toMatchObject({
      tier: "VIP5",
      base_maker: 0.01,
      base_taker: 0.0325,
    });
    expect(resolveFeeRate("blofin", "futures", 10_000_000) as any).toMatchObject({
      tier: "VIP1",
      base_maker: 0.006,
      base_taker: 0.05,
    });
    expect(resolveFeeRate("blofin", "futures", 500_000_000) as any).toMatchObject({
      tier: "VIP5",
      base_maker: 0,
      base_taker: 0.035,
    });
  });

  it("asset OR track: $50k assets alone lifts futures to VIP1; $3M reaches VIP5 zero maker", () => {
    const vip1 = resolveFeeRate("blofin", "futures", 0, undefined, 50_000) as any;
    expect(vip1).toMatchObject({ tier: "VIP1", base_maker: 0.006, base_taker: 0.05 });
    const vip5 = resolveFeeRate("blofin", "futures", 0, undefined, 3_000_000) as any;
    expect(vip5).toMatchObject({ tier: "VIP5", base_maker: 0, base_taker: 0.035 });
    // compareExchangeFees surfaces the asset-driven upgrade explicitly.
    const rows = compareExchangeFees("futures", "JP", {
      monthlyVolumeUsd: 0,
      accountAssetsUsd: 50_000,
    }) as any[];
    const bf = rows.find((x) => x.exchange === "blofin");
    expect(bf.tier).toBe("VIP1");
    expect(bf.volume_tier).toBe("Regular");
    expect(bf.base_taker).toBe(0.05);
    expect(bf.tier_warning).toContain("account assets");
  });

  it("no native token discount; standard 8h funding; 3 bps typical BTC spread", () => {
    expect(getTokenDiscount("blofin")).toBeNull();
    const rows = compareExchangeFees("futures", "JP", { useToken: true, tokenBalance: 999_999 }) as any[];
    const bf = rows.find((x) => x.exchange === "blofin");
    expect(bf.effective_taker).toBe(0.06);
    expect(bf.token_applied).toBe(false);

    expect(getFundingRate("blofin")).toMatchObject({ interval_hours: 8, avg_rate_pct: 0.01 });
    // 16h holding = 2 intervals * 0.01% * 100k = $20.
    const sav = calculateSavings("blofin", 100_000, "futures", "JP", { holdingHours: 16 }) as any;
    expect(sav.funding_cost).toBe(20);

    expect(getSpreadEstimate("blofin", "BTC")).toMatchObject({
      full_spread_bps: 3,
      crossing_bps: 1.5,
      pair_class: "majors",
    });
  });

  it("compliance: blocked in US/CA/CN/SG/DE (MiCA), served in JP/TH/HK/GB/BR; no referral link; notes attached", () => {
    for (const cc of ["US", "CA", "CN", "SG", "DE"]) {
      expect((calculateSavings("blofin", 1_000, "spot", cc) as any).code).toBe("COUNTRY_BLOCKED");
    }
    for (const cc of ["JP", "TH", "HK", "GB", "BR", "AU"]) {
      expect((calculateSavings("blofin", 1_000, "spot", cc) as any).error).toBeUndefined();
    }
    const us = compareExchangeFees("futures", "US") as any[];
    expect(us.find((x) => x.exchange === "blofin")).toBeUndefined();
    const de = compareExchangeFees("futures", "DE") as any[];
    expect(de.find((x) => x.exchange === "blofin")).toBeUndefined();
    const jp = compareExchangeFees("futures", "JP") as any[];
    expect(jp.find((x) => x.exchange === "blofin")).toBeDefined();

    const link = getReferralLink("blofin", "JP") as any;
    expect(link.code).toBe("NO_REFERRAL_LINK");

    const row = jp.find((x) => x.exchange === "blofin");
    expect(Array.isArray(row.exchange_notes)).toBe(true);
    expect(row.exchange_notes.join(" ")).toContain("non-API");
    expect(getExchangeNotes("blofin")?.length).toBe(5);
  });

  it("withdrawals: BTC 0.0002, USDT/USDC TRC-20 at 1, ETH L2 ~$1; no direct fiat rails", () => {
    const btc = getWithdrawalCost({ asset: "BTC", exchanges: ["blofin"] }) as any;
    expect(btc.best).toMatchObject({ exchange: "blofin", network: "Bitcoin", fee: 0.0002 });
    expect(btc.best.fee_usd).toBeCloseTo(15.46, 1);

    const trc = getWithdrawalCost({ asset: "USDT", network: "TRC-20", exchanges: ["blofin"] }) as any;
    expect(trc.best).toMatchObject({ network: "TRC-20", fee: 1, fee_usd: 1 });

    const usdcTrc = getWithdrawalCost({ asset: "USDC", network: "TRC-20", exchanges: ["blofin"] }) as any;
    expect(usdcTrc.best).toMatchObject({ network: "TRC-20", fee: 1, fee_usd: 1 });

    const eth = getWithdrawalCost({ asset: "ETH", exchanges: ["blofin"] }) as any;
    expect(eth.best.network).toBe("Arbitrum");
    expect(eth.best.fee_usd).toBeCloseTo(1.0048, 3);

    const fiat = getFiatCost({ exchanges: ["blofin"] }) as any;
    expect(fiat.exchanges[0].available).toBe(false);
    expect(fiat.exchanges[0].routes).toEqual([]);
  });
});

// v0.38: Bitstamp — 14th venue (oldest exchange, Luxembourg; Robinhood-owned;
// MiCA + BitLicense + FCA + MAS regulated; EU-only regulated perps via a NEW
// venue×country product-gating model: product_blocked)
describe("v0.38: Bitstamp integration", () => {
  beforeEach(() => resetCachesForTest());

  it("spot ladder: 0.30/0.40 entry on a single volume track, 0/0.03 at the $1B top rung", () => {
    const entry = resolveFeeRate("bitstamp", "spot", 0) as any;
    expect(entry).toMatchObject({ tier: "Under $10k", base_maker: 0.3, base_taker: 0.4 });
    expect(resolveFeeRate("bitstamp", "spot", 5_000_000) as any).toMatchObject({
      tier: "$5M+",
      base_maker: 0.03,
      base_taker: 0.12,
    });
    expect(resolveFeeRate("bitstamp", "spot", 1_000_000_000) as any).toMatchObject({
      tier: "$1B+",
      base_maker: 0,
      base_taker: 0.03,
    });
    // No holdings/assets track exists: large accountAssetsUsd cannot lift the tier.
    const withAssets = resolveFeeRate("bitstamp", "spot", 0, undefined, 10_000_000) as any;
    expect(withAssets.tier).toBe("Under $10k");
  });

  it("futures: flat -0.005% maker REBATE / 0.015% taker, single rung, 8h P2P funding", () => {
    const f = resolveFeeRate("bitstamp", "futures", 0) as any;
    expect(f).toMatchObject({ tier: "Flat (EU eligible)", base_maker: -0.005, base_taker: 0.015 });
    // Volume does not change the flat perp rate.
    expect(resolveFeeRate("bitstamp", "futures", 999_999_999) as any).toMatchObject({
      base_maker: -0.005,
      base_taker: 0.015,
    });
    expect(getFundingRate("bitstamp")).toMatchObject({ interval_hours: 8, avg_rate_pct: 0.01 });
  });

  it("US: spot open (5 venues incl. Bitstamp), futures product-gated with PRODUCT_BLOCKED_IN_COUNTRY", () => {
    const spot = compareExchangeFees("spot", "US") as any[];
    expect(spot.find((x) => x.exchange === "bitstamp")).toBeDefined();

    const fut = compareExchangeFees("futures", "US") as any[];
    expect(fut.find((x) => x.exchange === "bitstamp")).toBeUndefined();

    expect((calculateSavings("bitstamp", 100_000, "spot", "US") as any).error).toBeUndefined();
    const blocked = calculateSavings("bitstamp", 100_000, "futures", "US") as any;
    expect(blocked.code).toBe("PRODUCT_BLOCKED_IN_COUNTRY");
    expect(blocked.error).toContain("futures");

    // calculateAnnualCost applies the same gate.
    expect((calculateAnnualCost("bitstamp", "futures", "US", 100_000) as any).code).toBe(
      "PRODUCT_BLOCKED_IN_COUNTRY",
    );
    // Token-discount analysis is product-gated too.
    expect((analyzeTokenDiscount("bitstamp", "US", "futures", 100_000) as any).code).toBe(
      "PRODUCT_BLOCKED_IN_COUNTRY",
    );
  });

  it("DE: both spot and the EU-eligible perp are priced, with the negative maker surfaced", () => {
    const spot = compareExchangeFees("spot", "DE") as any[];
    const bsSpot = spot.find((x) => x.exchange === "bitstamp");
    expect(bsSpot).toBeDefined();

    const fut = compareExchangeFees("futures", "DE") as any[];
    const bsFut = fut.find((x) => x.exchange === "bitstamp");
    expect(bsFut).toMatchObject({ tier: "Flat (EU eligible)", base_maker: -0.005, base_taker: 0.015 });

    expect((calculateSavings("bitstamp", 100_000, "futures", "DE") as any).error).toBeUndefined();
    expect((calculateAnnualCost("bitstamp", "futures", "DE", 100_000) as any).error).toBeUndefined();
  });

  it("GB/SG/JP/CA/HK/TH: spot served but the perp is product-gated; CN blocks the venue outright", () => {
    for (const cc of ["GB", "SG", "JP", "CA", "HK", "TH"]) {
      expect(compareExchangeFees("spot", cc) as any[]).toContainEqual(
        expect.objectContaining({ exchange: "bitstamp" }),
      );
      expect(compareExchangeFees("futures", cc) as any[]).not.toContainEqual(
        expect.objectContaining({ exchange: "bitstamp" }),
      );
      expect((calculateSavings("bitstamp", 1, "futures", cc) as any).code).toBe(
        "PRODUCT_BLOCKED_IN_COUNTRY",
      );
    }
    for (const purpose of ["spot", "futures"] as const) {
      expect((calculateSavings("bitstamp", 1, purpose, "CN") as any).code).toBe("COUNTRY_BLOCKED");
    }
  });

  it("product gate flows through personas and the country matrix (available vs unsupported_product vs blocked)", () => {
    // Futures persona: Bitstamp priced in DE, dropped in US.
    const deFut = analyzePersona("swing_futures_trader", "DE") as any;
    expect(deFut.ranking.some((x: any) => x.exchange === "bitstamp")).toBe(true);
    const usFut = analyzePersona("swing_futures_trader", "US") as any;
    expect(usFut.ranking.some((x: any) => x.exchange === "bitstamp")).toBe(false);
    // Spot persona in the US keeps Bitstamp.
    const usSpot = analyzePersona("casual_buyer", "US") as any;
    expect(usSpot.ranking.some((x: any) => x.exchange === "bitstamp")).toBe(true);

    const matrix = compareCountries("swing_futures_trader", { countries: ["US", "DE", "CN"] }) as any;
    const bs = matrix.venue_availability.find((v: any) => v.exchange === "bitstamp");
    expect(bs.per_country).toMatchObject({
      US: "unsupported_product",
      DE: "available",
      CN: "blocked",
    });
    const usRow = matrix.rows.find((x: any) => x.country === "US");
    expect(usRow.unsupported_product_venues).toContain("bitstamp");
    expect(usRow.blocked_venues).not.toContain("bitstamp");
  });

  it("no native token, no referral link; exchange notes explain the EU-only perp", () => {
    expect(getTokenDiscount("bitstamp")).toBeNull();
    const rows = compareExchangeFees("futures", "DE", { useToken: true, tokenBalance: 999_999 }) as any[];
    const bs = rows.find((x) => x.exchange === "bitstamp");
    expect(bs.token_applied).toBe(false);
    expect(bs.effective_taker).toBe(0.015);
    expect((getReferralLink("bitstamp", "DE") as any).code).toBe("NO_REFERRAL_LINK");
    expect(getExchangeNotes("bitstamp")?.join(" ")).toContain("EU/EEA");
  });

  it("fiat rails: free ACH in the US, free SEPA in / EUR 3 out, 0.05%/0.1% SWIFT with floors, ~4% card", () => {
    const usIn = getFiatCost({ country: "US", exchanges: ["bitstamp"] }) as any;
    expect(usIn.best).toMatchObject({ method: "ach", fee_usd: 0 });
    const usOut = getFiatCost({ country: "US", direction: "withdraw", exchanges: ["bitstamp"] }) as any;
    expect(usOut.best).toMatchObject({ method: "ach", fee_usd: 0 });

    const sepaIn = getFiatCost({ country: "DE", currency: "EUR", amount: 1000, exchanges: ["bitstamp"] }) as any;
    expect(sepaIn.best).toMatchObject({ method: "sepa", fee: 0 });
    const sepaOut = getFiatCost({
      country: "DE",
      direction: "withdraw",
      currency: "EUR",
      amount: 1000,
      exchanges: ["bitstamp"],
    }) as any;
    expect(sepaOut.best).toMatchObject({ method: "sepa", fee: 3 });

    // SWIFT deposit 0.05% of $1,000 = $0.50 -> $7.5 floor; withdrawal 0.1% = $1 -> $25 floor.
    const swiftIn = getFiatCost({ currency: "USD", amount: 1000, method: "swift", exchanges: ["bitstamp"] }) as any;
    expect(swiftIn.best.fee).toBe(7.5);
    const swiftOut = getFiatCost({ direction: "withdraw", currency: "USD", amount: 1000, method: "swift", exchanges: ["bitstamp"] }) as any;
    expect(swiftOut.best.fee).toBe(25);

    // Large SWIFT deposit uses the percentage above the floor ($1M * 0.05% = $500, under the $300 cap).
    const swiftBig = getFiatCost({ currency: "USD", amount: 1_000_000, method: "swift", exchanges: ["bitstamp"] }) as any;
    expect(swiftBig.best.fee).toBe(300);

    const card = getFiatCost({ country: "DE", currency: "EUR", amount: 1000, method: "card", exchanges: ["bitstamp"] }) as any;
    expect(card.best.fee).toBe(40);
  });

  it("withdrawals: BTC 0.0005, USDT ERC-20-only at 20 (no TRC-20/Solana), USDC ERC-20 dynamic estimate", () => {
    const btc = getWithdrawalCost({ asset: "BTC", exchanges: ["bitstamp"] }) as any;
    expect(btc.best).toMatchObject({ exchange: "bitstamp", network: "Bitcoin", fee: 0.0005 });
    expect(btc.best.fee_usd).toBeCloseTo(38.649, 2);

    const usdt = getWithdrawalCost({ asset: "USDT", exchanges: ["bitstamp"] }) as any;
    expect(usdt.best).toMatchObject({ network: "ERC-20", fee: 20, fee_usd: 20 });

    const trc = getWithdrawalCost({ asset: "USDT", network: "TRC-20", exchanges: ["bitstamp"] }) as any;
    expect(trc.exchanges[0].supported).toBe(false);
    expect(trc.exchanges[0].networks).toEqual([]);

    const usdc = getWithdrawalCost({ asset: "USDC", network: "ERC-20", exchanges: ["bitstamp"] }) as any;
    expect(usdc.best).toMatchObject({ network: "ERC-20", fee: 4, fee_usd: 4 });
  });
});

// v0.40: replace the v0.38 negative-list default key (which over-opened
// Bitstamp perps to every unmodeled country, e.g. AU/BR) with a POSITIVE
// region allowlist: product_region_gates + regions.EEA (EU27 + IS/LI/NO).
describe("v0.40: region allowlist product gates (Bitstamp perps = EEA30 only)", () => {
  beforeEach(() => resetCachesForTest());

  it("EEA region table lists exactly 30 member states (EU27 + Iceland/Liechtenstein/Norway)", () => {
    const eea = getRegions().EEA ?? [];
    expect(eea).toHaveLength(30);
    expect(new Set(eea).size).toBe(30);
    for (const cc of ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO"]) {
      expect(eea).toContain(cc);
    }
    // GB left the EEA (Brexit); CH has bilateral deals but is not EEA; microstates are not members either.
    for (const cc of ["GB", "CH", "US", "CA", "JP", "AU", "BR", "TR", "KR", "SG", "HK"]) {
      expect(eea).not.toContain(cc);
    }
  });

  it("region gate config: only bitstamp futures is EEA-gated; bitstamp spot has no gate", () => {
    expect(getProductRegionGates()).toEqual({ bitstamp: { futures: ["EEA"] } });
    expect(getProductRegionGates().bitstamp?.spot).toBeUndefined();
  });

  it("perps OPEN in every EEA state, including ones that resolve via the default key (FR/NL/ES/IT/IS/LI/NO)", () => {
    for (const cc of ["FR", "NL", "ES", "IT", "IE", "IS", "LI", "NO", "DE", "LU"]) {
      expect(isProductBlockedInCountry("bitstamp", "futures", cc)).toBe(false);
      expect(isVenueUsableFor("bitstamp", cc, "futures")).toBe(true);
    }
    // Case-insensitive.
    expect(isCountryInRegion("fr", "EEA")).toBe(true);
    expect(isProductBlockedInCountry("Bitstamp", "futures", "fr")).toBe(false);
  });

  it("perps BLOCKED for non-EEA countries whether or not they have an explicit key (closes the v0.38 default over-open)", () => {
    // Explicit-key non-EEA markets.
    for (const cc of ["US", "GB", "JP", "SG", "HK", "TH", "CA"]) {
      expect(isProductBlockedInCountry("bitstamp", "futures", cc)).toBe(true);
    }
    // v0.38 bug: these routed through `default` and were wrongly eligible.
    for (const cc of ["AU", "BR", "CH", "TR", "KR", "MX", "AR", "IN", "ZA", "NZ"]) {
      expect(isProductBlockedInCountry("bitstamp", "futures", cc)).toBe(true);
      expect(isVenueUsableFor("bitstamp", cc, "futures")).toBe(false);
    }
  });

  it("absent country stays false-safe; spot is never region-gated", () => {
    expect(isProductBlockedInCountry("bitstamp", "futures", undefined)).toBe(false);
    for (const cc of ["US", "AU", "BR", "DE"]) {
      expect(isProductBlockedInCountry("bitstamp", "spot", cc)).toBe(false);
      expect(isVenueUsableFor("bitstamp", cc, "spot")).toBe(true);
    }
    // Other venues have no region gates at all.
    for (const venue of ["binance", "okx", "kraken", "blofin"]) {
      expect(isProductBlockedInCountry(venue, "futures", "AU")).toBe(false);
    }
  });

  it("venue-level block takes precedence: bitstamp remains COUNTRY_BLOCKED in CN for both products", () => {
    expect(isVenueUsableFor("bitstamp", "CN", "spot")).toBe(false);
    expect(isVenueUsableFor("bitstamp", "CN", "futures")).toBe(false);
  });

  it("end-to-end: v0.41 FR futures prices only the EEA-eligible stack (4 venues incl. Bitstamp); AU/BR keep 12", () => {
    const fr = compareExchangeFees("futures", "FR") as any[];
    // v0.40: 13 venues. v0.41: seven CASP-less venues are EEA venue-blocked and
    // Bybit/Gate perps are EEA product-blocked; the EEA futures stack is
    // Bitstamp/OKX/Kraken (licensed) plus the non-custodial Hyperliquid book.
    expect(fr).toHaveLength(4);
    expect(fr.map((x) => x.exchange).sort()).toEqual(["bitstamp", "hyperliquid", "kraken", "okx"]);
    expect(fr.find((x) => x.exchange === "bitstamp")).toMatchObject({
      tier: "Flat (EU eligible)",
      base_maker: -0.005,
      base_taker: 0.015,
    });
    for (const cc of ["AU", "BR"]) {
      const rows = compareExchangeFees("futures", cc) as any[];
      expect(rows).toHaveLength(12);
      expect(rows.find((x) => x.exchange === "bitstamp")).toBeUndefined();
      expect((calculateSavings("bitstamp", 100_000, "futures", cc) as any).code).toBe(
        "PRODUCT_BLOCKED_IN_COUNTRY",
      );
    }
    // Spot comparison in those markets still includes Bitstamp.
    expect((compareExchangeFees("spot", "AU") as any[]).find((x) => x.exchange === "bitstamp")).toBeDefined();
  });

  it("country matrix maps a default-key non-EEA country to unsupported_product, EEA member to available", () => {
    const matrix = compareCountries("swing_futures_trader", { countries: ["FR", "AU", "GB"] }) as any;
    const bs = matrix.venue_availability.find((v: any) => v.exchange === "bitstamp");
    expect(bs.per_country).toMatchObject({
      FR: "available",
      AU: "unsupported_product",
      GB: "unsupported_product",
    });
  });
});

// v0.41: post-MiCA-cliff (transition ended 2026-07-01) EEA enforcement.
// Seven venues without usable CASP authorization are venue-blocked EEA-wide;
// Bybit/Gate hold CASP but no MiFID II derivatives entity, so their perps are
// product-blocked EEA-wide while spot stays open. Hyperliquid (non-custodial
// perp DEX, no geo-block on the frontend) is deliberately retained.
describe("v0.41: post-MiCA-cliff negative region gates (EEA30)", () => {
  beforeEach(() => resetCachesForTest());

  const EEA_BLOCKED_VENUES = ["binance", "bingx", "bitget", "blofin", "kucoin", "mexc", "phemex"];
  const EEA_VENUES = getRegions().EEA;

  it("region_blocked config: exactly the seven CASP-less/barred venues, each mapped to EEA", () => {
    const blocks = getVenueRegionBlocks();
    expect(Object.keys(blocks).sort()).toEqual(EEA_BLOCKED_VENUES);
    for (const v of EEA_BLOCKED_VENUES) expect(blocks[v]).toEqual(["EEA"]);
    // The six licensed/open venues are absent from the venue block table.
    for (const v of ["okx", "gate", "bybit", "kraken", "coinbase", "bitstamp", "hyperliquid"]) {
      expect(blocks[v]).toBeUndefined();
    }
  });

  it("product_region_blocked config: exactly bybit+gate futures mapped to EEA", () => {
    const blocks = getProductRegionBlocks();
    expect(Object.keys(blocks).sort()).toEqual(["bybit", "gate"]);
    expect(blocks.bybit).toEqual({ futures: ["EEA"] });
    expect(blocks.gate).toEqual({ futures: ["EEA"] });
    expect(blocks.bybit?.spot).toBeUndefined();
  });

  it("isVenueRegionBlocked: true in every EEA member for the seven venues, false elsewhere and false-safe", () => {
    for (const v of EEA_BLOCKED_VENUES) {
      for (const cc of EEA_VENUES) {
        expect(isVenueRegionBlocked(v, cc)).toBe(true);
      }
    }
    // Case-insensitive input.
    expect(isVenueRegionBlocked("Binance", "de")).toBe(true);
    // Non-EEA residents never trip the EEA region, even where the venue is
    // separately blocked by an explicit country key.
    for (const v of EEA_BLOCKED_VENUES) {
      for (const cc of ["GB", "US", "CA", "AU", "BR", "JP", "HK", "SG", "TH", "CH", "TR"]) {
        expect(isVenueRegionBlocked(v, cc)).toBe(false);
      }
      expect(isVenueRegionBlocked(v, undefined)).toBe(false);
    }
  });

  it("all seven venues are unusable in EEA countries for BOTH products, via every gating entry point", () => {
    for (const v of EEA_BLOCKED_VENUES) {
      for (const cc of ["DE", "FR", "IT", "ES", "PL", "SE", "NL", "IS", "NO", "LI"]) {
        expect(isVenueUsableFor(v, cc)).toBe(false);
        expect(isVenueUsableFor(v, cc, "spot")).toBe(false);
        expect(isVenueUsableFor(v, cc, "futures")).toBe(false);
        expect((calculateSavings(v, 1_000, "spot", cc) as any).code).toBe("COUNTRY_BLOCKED");
        expect((calculateSavings(v, 1_000, "futures", cc) as any).code).toBe("COUNTRY_BLOCKED");
      }
    }
  });

  it("venue-level block takes precedence over product-level error (binance DE futures => COUNTRY_BLOCKED)", () => {
    expect((calculateSavings("binance", 10_000, "futures", "DE") as any).code).toBe("COUNTRY_BLOCKED");
    expect((calculateSavings("kucoin", 10_000, "futures", "FR") as any).code).toBe("COUNTRY_BLOCKED");
  });

  it("Bybit/Gate: spot OPEN in the EEA but perps PRODUCT_BLOCKED in every EEA member", () => {
    for (const v of ["bybit", "gate"]) {
      for (const cc of ["DE", "FR", "NL", "IS", "NO"]) {
        expect(isVenueUsableFor(v, cc, "spot")).toBe(true);
        expect(isVenueUsableFor(v, cc, "futures")).toBe(false);
        expect(isProductBlockedInCountry(v, "futures", cc)).toBe(true);
        expect(isProductBlockedInCountry(v, "spot", cc)).toBe(false);
        expect((calculateSavings(v, 1_000, "futures", cc) as any).code).toBe(
          "PRODUCT_BLOCKED_IN_COUNTRY",
        );
      }
    }
    // Outside the EEA the perps stay available.
    for (const cc of ["GB", "AU", "BR", "JP"]) {
      expect(isVenueUsableFor("bybit", cc, "futures")).toBe(true);
      expect(isVenueUsableFor("gate", cc, "futures")).toBe(true);
    }
  });

  it("EEA futures stack prices exactly four venues: bitstamp/kraken/okx (licensed) + hyperliquid", () => {
    for (const cc of ["DE", "FR", "IT", "ES", "PL", "SE", "NL", "IS", "NO", "LI"]) {
      const rows = compareExchangeFees("futures", cc) as any[];
      expect(rows.map((x) => x.exchange).sort()).toEqual(
        ["bitstamp", "hyperliquid", "kraken", "okx"],
      );
    }
  });

  it("the CASP-licensed/open venues keep spot open across the EEA (11-venue EEA spot stack incl. Hyperliquid, v0.42 Bitvavo, v0.43 Finst, v0.44 Bitpanda and v0.45 Bison)", () => {
    for (const cc of ["DE", "FR", "IT", "ES", "NL", "IS", "NO"]) {
      const rows = compareExchangeFees("spot", cc) as any[];
      expect(rows.map((x) => x.exchange).sort()).toEqual(
        ["bison", "bitpanda", "bitstamp", "bitvavo", "bybit", "coinbase", "finst", "gate", "hyperliquid", "kraken", "okx"],
      );
    }
  });

  it("Hyperliquid is deliberately retained in the EEA for both products (non-custodial, no frontend geo-block)", () => {
    for (const cc of ["DE", "FR", "IT", "IS"]) {
      expect(isVenueUsableFor("hyperliquid", cc, "spot")).toBe(true);
      expect(isVenueUsableFor("hyperliquid", cc, "futures")).toBe(true);
    }
    expect(getVenueRegionBlocks().hyperliquid).toBeUndefined();
  });

  it("non-EEA markets are untouched: default-key AU/BR keep all 14 venues on spot and 12 on futures", () => {
    for (const cc of ["AU", "BR"]) {
      expect(compareExchangeFees("spot", cc)).toHaveLength(14);
      expect(compareExchangeFees("futures", cc)).toHaveLength(12);
      // The EEA-licensed venues themselves remain available outside the EEA
      // (their EU gate is a venue ban, not an exclusive EEA license).
      for (const v of EEA_BLOCKED_VENUES) {
        expect(isVenueUsableFor(v, cc, "spot")).toBe(true);
      }
    }
  });

  it("compareCountries persona matrix: seven venue-blocked + seven product-unsupported rows in every EEA member", () => {
    const r = compareCountries("swing_futures_trader", { countries: ["DE", "FR", "IT", "IS"] }) as any;
    for (const cc of ["DE", "FR", "IT", "IS"]) {
      const row = r.rows.find((x: any) => x.country === cc);
      expect(row.blocked_venues.sort()).toEqual(EEA_BLOCKED_VENUES);
      // v0.42 Bitvavo, v0.43 Finst, v0.44 Bitpanda and v0.45 Bison join the
      // product-unsupported bucket (all EEA-authorized, spot-only).
      expect(row.unsupported_product_venues.sort()).toEqual(["bison", "bitpanda", "bitvavo", "bybit", "coinbase", "finst", "gate"]);
      expect(row.available_venues).toBe(11);
    }
    // Venue-side matrix view for a region-blocked venue.
    const binance = r.venue_availability.find((v: any) => v.exchange === "binance");
    expect(binance.blocked_in.sort()).toEqual(["DE", "FR", "IS", "IT"]);
    const bybit = r.venue_availability.find((v: any) => v.exchange === "bybit");
    for (const cc of ["DE", "FR", "IT", "IS"]) {
      expect(bybit.per_country[cc]).toBe("unsupported_product");
    }
  });

  it("absent country stays false-safe through both layers", () => {
    for (const v of [...EEA_BLOCKED_VENUES, "bybit", "gate"]) {
      expect(isVenueRegionBlocked(v, undefined)).toBe(false);
      expect(isProductBlockedInCountry(v, "futures", undefined)).toBe(false);
      expect(isVenueUsableFor(v, undefined)).toBe(true);
      expect(isVenueUsableFor(v, undefined, "futures")).toBe(true);
    }
  });
});

// =====================================================================
// v0.42: Bitvavo onboarding + venue-level positive region allowlist
// =====================================================================

describe("v0.42: venue-level positive region allowlist (region_allowed)", () => {
  beforeEach(() => resetCachesForTest());

  const ALL_18 = [
    "binance", "okx", "gate", "bybit", "mexc", "bitget", "kucoin", "kraken",
    "coinbase", "hyperliquid", "bingx", "bitstamp", "phemex", "blofin", "bitvavo", "finst", "bitpanda", "bison",
  ];
  const EEA_MEMBERS = ["DE", "FR", "NL", "IS", "NO", "LI", "IT", "ES", "SE", "PT"];
  const OUTSIDERS = ["GB", "US", "JP", "CH", "CA", "AU", "BR", "CN", "SG", "HK", "KR"];

  it("registers the four positive allowlist entries: bitvavo/finst => EEA, bitpanda => EEA+GB and bison => EEA+CH (v0.45)", () => {
    expect(getVenueRegionAllows()).toEqual({
      bitvavo: ["EEA"],
      finst: ["EEA"],
      bitpanda: ["EEA", "GB"],
      bison: ["EEA", "CH"],
    });
    for (const v of ALL_18.filter((x) => x !== "bitvavo" && x !== "finst" && x !== "bitpanda" && x !== "bison")) {
      expect(getVenueRegionAllows()[v]).toBeUndefined();
    }
  });

  it("classifies EEA residents as allowed and everyone else as restricted", () => {
    for (const cc of EEA_MEMBERS) {
      expect(isVenueRegionAllowed("bitvavo", cc)).toBe(true);
      expect(isVenueRegionRestricted("bitvavo", cc)).toBe(false);
    }
    for (const cc of OUTSIDERS) {
      expect(isVenueRegionAllowed("bitvavo", cc)).toBe(false);
      expect(isVenueRegionRestricted("bitvavo", cc)).toBe(true);
    }
  });

  it("is case-insensitive on both venue and country", () => {
    expect(isVenueRegionAllowed("Bitvavo", "de")).toBe(true);
    expect(isVenueRegionAllowed("BITVAVO", "Nl")).toBe(true);
    expect(isVenueRegionRestricted("bitvavo", "gb")).toBe(true);
  });

  it("stays false-safe for absent country and for venues without an entry", () => {
    expect(isVenueRegionAllowed("bitvavo", undefined)).toBe(false);
    expect(isVenueRegionRestricted("bitvavo", undefined)).toBe(false);
    for (const v of ALL_18.filter((x) => x !== "bitvavo" && x !== "finst" && x !== "bitpanda" && x !== "bison")) {
      expect(isVenueRegionAllowed(v, "DE")).toBe(false);
      expect(isVenueRegionRestricted(v, "DE")).toBe(false);
      expect(isVenueRegionRestricted(v, undefined)).toBe(false);
    }
  });

  it("makes Bitvavo spot usable across the EEA and unusable outside it", () => {
    for (const cc of EEA_MEMBERS) {
      expect(isVenueUsableFor("bitvavo", cc, "spot")).toBe(true);
    }
    for (const cc of OUTSIDERS) {
      expect(isVenueUsableFor("bitvavo", cc, "spot")).toBe(false);
    }
    // Venue gate only — product gate must not manufacture futures access.
    expect(isVenueUsableFor("bitvavo", undefined)).toBe(true);
  });

  it("keeps Bitvavo off the EEA futures stack: the venue is authorized but models no futures product", () => {
    // Same onboarding semantics as Coinbase: no regulatory product gate fires,
    // so isVenueUsableFor stays true, but the empty futures schedule removes it
    // from pricing and lands it in the persona-matrix unsupported_product bucket.
    for (const cc of ["DE", "FR", "NL", "IS"]) {
      expect(isVenueUsableFor("bitvavo", cc, "futures")).toBe(true);
      expect(isProductBlockedInCountry("bitvavo", "futures", cc)).toBe(false);
    }
    const deFutures = (compareExchangeFees("futures", "DE") as any[]).map((x) => x.exchange);
    expect(deFutures.sort()).toEqual(["bitstamp", "hyperliquid", "kraken", "okx"]);
    expect(deFutures).not.toContain("bitvavo");
    // Non-EEA stacks never contain Bitvavo on either product.
    for (const cc of ["GB", "JP", "US", "AU", "BR"]) {
      expect((compareExchangeFees("spot", cc) as any[]).map((x) => x.exchange)).not.toContain("bitvavo");
    }
  });
});

describe("v0.42: Bitvavo static economics (spot ladder, spread, rails, withdrawals)", () => {
  beforeEach(() => resetCachesForTest());

  it("quotes the nine-rung PRO spot schedule with a 0.15/0.25 base and non-increasing rates", () => {
    const ladder = getNormalizedLadder("bitvavo", "spot")!;
    expect(ladder).toHaveLength(9);
    expect(ladder.map((t) => t.min_volume_usd)).toEqual([
      0, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000, 25_000_000,
    ]);
    expect(ladder.map((t) => t.maker)).toEqual([0.15, 0.1, 0.08, 0.06, 0.05, 0.04, 0.04, 0, 0]);
    expect(ladder.map((t) => t.taker)).toEqual([0.25, 0.2, 0.16, 0.12, 0.1, 0.08, 0.06, 0.05, 0.02]);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i].maker).toBeLessThanOrEqual(ladder[i - 1].maker);
      expect(ladder[i].taker).toBeLessThanOrEqual(ladder[i - 1].taker);
    }
    const base = resolveFeeRate("bitvavo", "spot", 0) as any;
    expect(base.base_maker).toBe(0.15);
    expect(base.base_taker).toBe(0.25);
    const top = resolveFeeRate("bitvavo", "spot", 25_000_000) as any;
    expect(top.base_maker).toBe(0);
    expect(top.base_taker).toBe(0.02);
    // Spot-only: no futures ladder and no funding model.
    expect(getNormalizedLadder("bitvavo", "futures")).toBeNull();
  });

  it("models the tightest EU EUR-book spread at 1.0 bps full / 0.5 crossing", () => {
    expect(getSpreadEstimate("bitvavo", "BTC")).toMatchObject({
      full_spread_bps: 1,
      crossing_bps: 0.5,
    });
  });

  it("prices DE spot with the base tier and Kaiko spread", () => {
    const rows = compareExchangeFees("spot", "DE") as any[];
    const bitvavo = rows.find((x) => x.exchange === "bitvavo")!;
    expect(bitvavo).toBeDefined();
    expect(bitvavo).toMatchObject({ base_maker: 0.15, base_taker: 0.25, effective_maker: 0.15, effective_taker: 0.25 });
  });

  it("offers free SEPA deposits and withdrawals in the EEA, a ~1% EU card deposit, and no card cash-out", () => {
    const dep = getFiatCost({ currency: "EUR", amount: 1000, country: "DE", exchanges: ["bitvavo"] }) as any;
    const d = dep.exchanges[0];
    expect(d.available).toBe(true);
    expect(d.routes.map((r: any) => [r.method, r.fee])).toEqual([
      ["sepa", 0],
      ["card", 10],
    ]);
    expect(d.cheapest_fee_usd).toBe(0);

    const wd = getFiatCost({ direction: "withdraw", currency: "EUR", amount: 1000, country: "DE", exchanges: ["bitvavo"] }) as any;
    const w = wd.exchanges[0];
    expect(w.available).toBe(true);
    expect(w.routes.map((r: any) => r.method)).toEqual(["sepa"]);
    expect(w.cheapest_fee_usd).toBe(0);

    const cardWd = getFiatCost({ direction: "withdraw", currency: "EUR", amount: 1000, country: "DE", method: "card", exchanges: ["bitvavo"] }) as any;
    expect(cardWd.exchanges[0].available).toBe(false);
    expect(cardWd.exchanges[0].routes).toEqual([]);

    // The allowlist removes the venue from non-EEA results entirely (e.g. GBP).
    const gb = getFiatCost({ currency: "EUR", amount: 1000, country: "GB", exchanges: ["bitvavo"] }) as any;
    expect(gb.exchanges).toHaveLength(0);
    expect(gb.best).toBeNull();
  });

  it("charges 0.00005 BTC for on-chain Bitcoin withdrawal and lists no USDT/USDC routes", () => {
    const btc = getWithdrawalCost({ asset: "BTC" }) as any;
    const b = btc.exchanges.find((x: any) => x.exchange === "bitvavo");
    expect(b.supported).toBe(true);
    expect(b.networks).toHaveLength(1);
    expect(b.networks[0]).toMatchObject({ network: "Bitcoin", fee: 0.00005, fee_usd: 3.8649 });
    expect(b.cheapest_network).toBe("Bitcoin");

    for (const asset of ["USDT", "USDC", "ETH", "DOT"]) {
      const r = getWithdrawalCost({ asset }) as any;
      expect(r.exchanges.find((x: any) => x.exchange === "bitvavo").supported).toBe(false);
    }
  });

  it("lands in unsupported_product for an EEA futures persona and blocked outside the EEA", () => {
    const r = compareCountries("swing_futures_trader", { countries: ["DE", "FR", "US", "JP", "GB"] }) as any;
    for (const cc of ["DE", "FR"]) {
      const row = r.rows.find((x: any) => x.country === cc);
      expect(row.unsupported_product_venues).toContain("bitvavo");
      expect(row.blocked_venues).not.toContain("bitvavo");
    }
    for (const cc of ["US", "JP", "GB"]) {
      const row = r.rows.find((x: any) => x.country === cc);
      expect(row.blocked_venues).toContain("bitvavo");
      expect(row.unsupported_product_venues).not.toContain("bitvavo");
    }
    const matrix = r.venue_availability.find((v: any) => v.exchange === "bitvavo");
    expect(matrix.per_country.DE).toBe("unsupported_product");
    expect(matrix.per_country.FR).toBe("unsupported_product");
    for (const cc of ["US", "JP", "GB"]) expect(matrix.per_country[cc]).toBe("blocked");
  });
});

// =====================================================================
// v0.43: Finst onboarding — second EEA-only venue allowlist (brokerage model)
// =====================================================================

describe("v0.43: Finst venue-level EEA allowlist (region_allowed.finst)", () => {
  beforeEach(() => resetCachesForTest());

  const EEA_MEMBERS = ["DE", "FR", "NL", "IS", "NO", "LI", "IT", "ES", "SE", "PT", "AT", "BE", "FI", "GR", "IE", "LU"];
  const OUTSIDERS = ["GB", "US", "JP", "CH", "CA", "AU", "BR", "CN", "SG", "HK", "KR"];

  it("classifies every EEA resident as allowed and every outsider as restricted", () => {
    for (const cc of EEA_MEMBERS) {
      expect(isVenueRegionAllowed("finst", cc)).toBe(true);
      expect(isVenueRegionRestricted("finst", cc)).toBe(false);
      expect(isExchangeAllowedProbe(cc)).toBe(true);
    }
    for (const cc of OUTSIDERS) {
      expect(isVenueRegionAllowed("finst", cc)).toBe(false);
      expect(isVenueRegionRestricted("finst", cc)).toBe(true);
    }
    function isExchangeAllowedProbe(cc: string) {
      // mirror the folded single-entry-point gate via the pricing stack
      return (compareExchangeFees("spot", cc) as any[]).some((x) => x.exchange === "finst");
    }
  });

  it("is case-insensitive on venue and country", () => {
    expect(isVenueRegionAllowed("Finst", "de")).toBe(true);
    expect(isVenueRegionAllowed("FINST", "Nl")).toBe(true);
    expect(isVenueRegionRestricted("finst", "gb")).toBe(true);
  });

  it("stays false-safe for an absent country", () => {
    expect(isVenueRegionAllowed("finst", undefined)).toBe(false);
    expect(isVenueRegionRestricted("finst", undefined)).toBe(false);
  });

  it("makes Finst spot usable across the EEA and unusable outside it", () => {
    for (const cc of ["DE", "FR", "NL", "IS", "PT", "AT"]) {
      expect(isVenueUsableFor("finst", cc, "spot")).toBe(true);
    }
    for (const cc of OUTSIDERS) {
      expect(isVenueUsableFor("finst", cc, "spot")).toBe(false);
    }
  });

  it("keeps Finst off the EEA futures stack despite no regulatory product gate (empty schedule, same semantics as Bitvavo)", () => {
    for (const cc of ["DE", "FR", "NL", "IS"]) {
      expect(isVenueUsableFor("finst", cc, "futures")).toBe(true);
      expect(isProductBlockedInCountry("finst", "futures", cc)).toBe(false);
    }
    const deFutures = (compareExchangeFees("futures", "DE") as any[]).map((x) => x.exchange);
    expect(deFutures.sort()).toEqual(["bitstamp", "hyperliquid", "kraken", "okx"]);
    expect(deFutures).not.toContain("finst");
    expect(getNormalizedLadder("finst", "futures")).toBeNull();
  });

  it("appears in every EEA spot stack (11 venues in v0.45) and in no non-EEA stack", () => {
    for (const cc of ["DE", "FR", "IT", "ES", "NL", "IS", "NO", "LI"]) {
      const rows = compareExchangeFees("spot", cc) as any[];
      expect(rows).toHaveLength(11);
      expect(rows.some((x) => x.exchange === "finst")).toBe(true);
    }
    for (const cc of ["JP", "US", "AU", "BR", "CA", "KR"]) {
      expect((compareExchangeFees("spot", cc) as any[]).some((x) => x.exchange === "finst")).toBe(false);
    }
    // v0.44: GB keeps its own non-EEA stack shape for Finst (not onboarded).
    expect((compareExchangeFees("spot", "GB") as any[]).some((x) => x.exchange === "finst")).toBe(false);
  });
});

describe("v0.43: Finst static economics (flat 0.15% brokerage, spread, rails, withdrawal)", () => {
  beforeEach(() => resetCachesForTest());

  it("quotes a single flat 0.15%/0.15% rung at every volume, with no futures ladder", () => {
    const ladder = getNormalizedLadder("finst", "spot")!;
    expect(ladder).toHaveLength(1);
    expect(ladder[0]).toMatchObject({ min_volume_usd: 0, maker: 0.15, taker: 0.15 });
    for (const vol of [0, 100_000, 1_000_000, 25_000_000, 500_000_000]) {
      const r = resolveFeeRate("finst", "spot", vol) as any;
      expect(r.base_maker).toBe(0.15);
      expect(r.base_taker).toBe(0.15);
      expect(r.tier).toBe("Flat 0.15%");
    }
    expect(getNormalizedLadder("finst", "futures")).toBeNull();
  });

  it("models the SOR execution proxy at 1.0 bps full / 0.5 crossing", () => {
    expect(getSpreadEstimate("finst", "BTC")).toMatchObject({ full_spread_bps: 1, crossing_bps: 0.5 });
  });

  it("prices DE spot at the flat tier for the 9th EEA venue", () => {
    const rows = compareExchangeFees("spot", "DE") as any[];
    const finst = rows.find((x) => x.exchange === "finst")!;
    expect(finst).toBeDefined();
    expect(finst).toMatchObject({ base_maker: 0.15, base_taker: 0.15, effective_maker: 0.15, effective_taker: 0.15 });
  });

  it("offers free SEPA/iDEAL/Bancontact legs both ways but NO card rail, and vanishes outside the EEA", () => {
    const dep = getFiatCost({ currency: "EUR", amount: 1000, country: "DE", exchanges: ["finst"] }) as any;
    expect(dep.exchanges).toHaveLength(1);
    const d = dep.exchanges[0];
    expect(d.available).toBe(true);
    expect(d.routes.map((r: any) => r.method)).toEqual(["sepa"]);
    expect(d.cheapest_fee_usd).toBe(0);

    const wd = getFiatCost({ direction: "withdraw", currency: "EUR", amount: 1000, country: "NL", exchanges: ["finst"] }) as any;
    expect(wd.exchanges[0].cheapest_fee_usd).toBe(0);
    expect(wd.exchanges[0].routes[0]).toMatchObject({ method: "sepa", fee: 0 });

    const card = getFiatCost({ currency: "EUR", amount: 1000, country: "DE", method: "card", exchanges: ["finst"] }) as any;
    expect(card.exchanges[0].available).toBe(false);
    expect(card.exchanges[0].routes).toEqual([]);

    // Allowlist exclusion removes the venue from the array entirely.
    const gb = getFiatCost({ currency: "EUR", amount: 1000, country: "GB", exchanges: ["finst"] }) as any;
    expect(gb.exchanges).toHaveLength(0);
    expect(gb.best).toBeNull();
  });

  it("charges dynamic network fee + €2.50 on BTC (0.000085 / ≈$6.57) and lists no other modeled asset", () => {
    const btc = getWithdrawalCost({ asset: "BTC" }) as any;
    const b = btc.exchanges.find((x: any) => x.exchange === "finst");
    expect(b.supported).toBe(true);
    expect(b.networks).toHaveLength(1);
    expect(b.networks[0]).toMatchObject({ network: "Bitcoin", fee: 0.000085, fee_usd: 6.5703 });
    expect(b.cheapest_network).toBe("Bitcoin");
    expect(b.networks[0].note).toContain("2.50");

    for (const asset of ["USDT", "USDC", "ETH", "DOT", "SOL"]) {
      const r = getWithdrawalCost({ asset }) as any;
      expect(r.exchanges.find((x: any) => x.exchange === "finst").supported).toBe(false);
    }
  });

  it("lands in unsupported_product for an EEA futures persona and blocked outside the EEA", () => {
    const r = compareCountries("swing_futures_trader", { countries: ["DE", "NL", "FR", "US", "JP", "GB"] }) as any;
    for (const cc of ["DE", "NL", "FR"]) {
      const row = r.rows.find((x: any) => x.country === cc);
      expect(row.unsupported_product_venues).toContain("finst");
      expect(row.blocked_venues).not.toContain("finst");
    }
    for (const cc of ["US", "JP", "GB"]) {
      const row = r.rows.find((x: any) => x.country === cc);
      expect(row.blocked_venues).toContain("finst");
      expect(row.unsupported_product_venues).not.toContain("finst");
    }
    const matrix = r.venue_availability.find((v: any) => v.exchange === "finst");
    expect(matrix.per_country.DE).toBe("unsupported_product");
    for (const cc of ["US", "JP", "GB"]) expect(matrix.per_country[cc]).toBe("blocked");
  });

  it("has no referral program modeled (broker, no affiliate links)", () => {
    const link = getReferralLink("finst", "DE") as any;
    expect(link.code).toBe("NO_REFERRAL_LINK");
  });
});

// =====================================================================
// v0.44: Bitpanda — spread-model brokerage pricing (embedded premium +
// independent real-money execution evidence), EEA30 + GB service area
// =====================================================================

describe("v0.44: Bitpanda spread-model brokerage (1.49% premium, measured 6.23% round-trip)", () => {
  beforeEach(() => resetCachesForTest());

  it("declares the spread pricing model (legacy venues default to order_book, Finst stays flat)", () => {
    expect(getPricingModel("bitpanda")).toBe("spread");
    expect(getPricingModel("finst")).toBe("flat");
    expect(getPricingModel("binance")).toBe("order_book");
    expect(getPricingModel("bitvavo")).toBe("order_book");
  });

  it("quotes a single all-in premium rung: 1.49% per side for generic assets, no futures ladder", () => {
    const ladder = getNormalizedLadder("bitpanda", "spot")!;
    expect(ladder).toHaveLength(1);
    expect(ladder[0]).toMatchObject({ min_volume_usd: 0, maker: 1.49, taker: 1.49 });
    for (const vol of [0, 100_000, 1_000_000, 25_000_000]) {
      const r = resolveFeeRate("bitpanda", "spot", vol) as any;
      expect(r.base_maker).toBe(1.49);
      expect(r.base_taker).toBe(1.49);
    }
    expect(getNormalizedLadder("bitpanda", "futures")).toBeNull();
  });

  it("applies the 0.99% band to BTC and major stablecoin pairs via pair_fees", () => {
    for (const pair of ["BTC/EUR", "BTC/GBP", "BTC/USDC", "BTC/USDT", "USDC/EUR", "USDT/EUR"]) {
      const rows = compareExchangeFees("spot", "DE", { pair }) as any[];
      const row = rows.find((x: any) => x.exchange === "bitpanda");
      expect(row, pair).toBeDefined();
      expect(row).toMatchObject({ base_maker: 0.99, base_taker: 0.99, effective_maker: 0.99, effective_taker: 0.99 });
    }
    // A generic alt keeps the 1.49% headline premium.
    const alt = (compareExchangeFees("spot", "DE", { pair: "DOGE/EUR" }) as any[]).find(
      (x: any) => x.exchange === "bitpanda",
    );
    expect(alt).toMatchObject({ effective_maker: 1.49, effective_taker: 1.49 });
  });

  it("models NO additive bid-ask spread for the spread venue (anti-double-count guard)", () => {
    for (const base of ["BTC", "ETH", "DOGE"]) {
      expect(getSpreadEstimate("bitpanda", base)).toMatchObject({
        full_spread_bps: 0,
        crossing_bps: 0,
      });
    }
  });

  it("never charges spread twice in the annual cost: BTC/EUR premium 0.99% with zero spread leg", () => {
    // €1,200/month => €14,400/year turnover; all-taker at 0.99% = 142.56, and
    // the embedded premium must not reappear as an annual_spread_cost line.
    const r = calculateAnnualCost("bitpanda", "spot", "DE", 1200, {
      pair: "BTC/EUR",
      tradeSizeUsd: 1000,
    }) as any;
    expect(r.annual_trading_fee).toBe(142.56);
    expect(r.annual_spread_cost).toBe(0);
    expect(r.spread_source).toBe("bundled");
    // Generic asset: 1.49% of 14,400 = 214.56, spread leg still zero.
    const alt = calculateAnnualCost("bitpanda", "spot", "DE", 1200, {
      pair: "DOGE/EUR",
      tradeSizeUsd: 1000,
    }) as any;
    expect(alt.annual_trading_fee).toBe(214.56);
    expect(alt.annual_spread_cost).toBe(0);
  });

  it("surfaces the independent real-money execution evidence in notes (6.23% measured, 4.25 pp hidden)", () => {
    const notes = getExchangeNotes("bitpanda")!;
    const joined = notes.join(" ");
    expect(joined).toContain("6.23");
    expect(joined).toContain("4.25");
    expect(joined).toContain("2.98");
    expect(joined).toContain("Frankfurt School");
    // Legacy venues do not carry an execution-quality paragraph.
    expect((getExchangeNotes("binance") ?? []).join(" ")).not.toContain("measured mean round-trip");
  });

  it("is onboarded across the EEA and GB but blocked everywhere outside the EEA+GB service area", () => {
    for (const cc of ["DE", "FR", "AT", "NL", "IS", "NO", "LI", "PT", "GB"]) {
      expect(isVenueUsableFor("bitpanda", cc, "spot")).toBe(true);
    }
    for (const cc of ["US", "CA", "JP", "SG", "AU", "BR", "CN", "CH", "KR"]) {
      expect(isVenueUsableFor("bitpanda", cc, "spot")).toBe(false);
    }
    // GB is reached through the dedicated one-member region key, not a stale allowlist.
    expect(isVenueRegionAllowed("bitpanda", "GB")).toBe(true);
    expect(isVenueRegionRestricted("bitpanda", "GB")).toBe(false);
    expect(isVenueRegionAllowed("bitpanda", "US")).toBe(false);
    expect(isVenueRegionRestricted("bitpanda", "US")).toBe(true);
  });

  it("appears in the 11-venue EEA spot stack (v0.45) AND the GB spot stack, never in US/JP stacks", () => {
    for (const cc of ["DE", "FR", "IT", "ES", "NL"]) {
      expect((compareExchangeFees("spot", cc) as any[]).map((x) => x.exchange)).toContain("bitpanda");
    }
    const gb = compareExchangeFees("spot", "GB") as any[];
    expect(gb.map((x) => x.exchange)).toContain("bitpanda");
    const gbRow = gb.find((x: any) => x.exchange === "bitpanda");
    expect(gbRow).toMatchObject({ base_maker: 1.49, base_taker: 1.49 });
    for (const cc of ["US", "JP", "AU"]) {
      expect((compareExchangeFees("spot", cc) as any[]).map((x) => x.exchange)).not.toContain("bitpanda");
    }
  });

  it("classifies futures as unsupported_product inside the service area and blocked outside (no regulatory gate)", () => {
    for (const cc of ["DE", "GB"]) {
      expect(isVenueUsableFor("bitpanda", cc, "futures")).toBe(true);
      expect(isProductBlockedInCountry("bitpanda", "futures", cc)).toBe(false);
      expect((compareExchangeFees("futures", cc) as any[]).map((x) => x.exchange)).not.toContain("bitpanda");
    }
    const r = compareCountries("swing_futures_trader", { countries: ["DE", "GB", "US", "JP"] }) as any;
    const matrix = r.venue_availability.find((v: any) => v.exchange === "bitpanda");
    expect(matrix.per_country.DE).toBe("unsupported_product");
    expect(matrix.per_country.GB).toBe("unsupported_product");
    expect(matrix.per_country.US).toBe("blocked");
    expect(matrix.per_country.JP).toBe("blocked");
  });

  it("passes crypto withdrawals through at dynamic network cost: BTC 0.00000598/$0.46 and ETH 0.0006/$1.51", () => {
    const btc = getWithdrawalCost({ asset: "BTC", exchanges: ["bitpanda"] }) as any;
    expect(btc.exchanges[0].networks).toHaveLength(1);
    expect(btc.exchanges[0].networks[0]).toMatchObject({
      network: "Bitcoin",
      fee: 0.00000598,
      fee_usd: 0.4622,
      available: true,
    });
    expect(btc.best).toMatchObject({ exchange: "bitpanda", network: "Bitcoin", fee_usd: 0.4622 });
    const eth = getWithdrawalCost({ asset: "ETH", exchanges: ["bitpanda"] }) as any;
    expect(eth.exchanges[0].networks[0]).toMatchObject({
      network: "Ethereum",
      fee: 0.0006,
      fee_usd: 1.5072,
      available: true,
    });
  });

  it("offers free SEPA and card deposits in the EEA, free FPS/card in GB, and no USD rail", () => {
    const de = getFiatCost({ currency: "EUR", amount: 1000, country: "DE", exchanges: ["bitpanda"] }) as any;
    expect(de.exchanges[0].available).toBe(true);
    expect(de.exchanges[0].routes.map((r: any) => [r.method, r.fee])).toEqual([
      ["sepa", 0],
      ["card", 0],
    ]);
    const deOut = getFiatCost({
      direction: "withdraw",
      currency: "EUR",
      amount: 1000,
      country: "DE",
      exchanges: ["bitpanda"],
    }) as any;
    expect(deOut.exchanges[0].routes.map((r: any) => r.method)).toEqual(["sepa"]);
    const gb = getFiatCost({ currency: "GBP", amount: 1000, country: "GB", exchanges: ["bitpanda"] }) as any;
    expect(gb.exchanges[0].available).toBe(true);
    expect(gb.exchanges[0].routes.map((r: any) => [r.method, r.fee])).toEqual([
      ["fps", 0],
      ["card", 0],
    ]);
    // No USD rail modeled (absent country keeps the venue row present but
    // unavailable rather than dropping it via the compliance filter).
    const us = getFiatCost({ currency: "USD", amount: 1000, exchanges: ["bitpanda"] }) as any;
    expect(us.exchanges[0].exchange).toBe("bitpanda");
    expect(us.exchanges[0].available).toBe(false);
    expect(us.exchanges[0].routes).toEqual([]);
  });

  it("has no referral program modeled (no affiliate links for the brokerage)", () => {
    const link = getReferralLink("bitpanda", "DE") as any;
    expect(link.code).toBe("NO_REFERRAL_LINK");
  });
});

describe("v0.45: Bison spread-model brokerage (1.25% BTC/ETH, 1.75% other; TUM best transparency 2.58% vs 2.5%)", () => {
  beforeEach(() => resetCachesForTest());

  it("declares the spread pricing model (order-book and flat venues stay unchanged)", () => {
    expect(getPricingModel("bison")).toBe("spread");
    expect(getPricingModel("bitpanda")).toBe("spread");
    expect(getPricingModel("finst")).toBe("flat");
    expect(getPricingModel("binance")).toBe("order_book");
  });

  it("quotes a single all-in spread rung: 1.75% per side headline, volume-invariant, no futures ladder", () => {
    const ladder = getNormalizedLadder("bison", "spot")!;
    expect(ladder).toHaveLength(1);
    expect(ladder[0]).toMatchObject({ min_volume_usd: 0, maker: 1.75, taker: 1.75 });
    for (const vol of [0, 100_000, 1_000_000, 25_000_000]) {
      const r = resolveFeeRate("bison", "spot", vol) as any;
      expect(r.base_maker).toBe(1.75);
      expect(r.base_taker).toBe(1.75);
    }
    expect(getNormalizedLadder("bison", "futures")).toBeNull();
  });

  it("applies the 1.25% band to BTC and ETH euro pairs via pair_fees; generic alts keep 1.75%", () => {
    for (const pair of ["BTC/EUR", "ETH/EUR"]) {
      const row = (compareExchangeFees("spot", "DE", { pair }) as any[]).find((x) => x.exchange === "bison");
      expect(row, pair).toBeDefined();
      expect(row).toMatchObject({ base_maker: 1.25, base_taker: 1.25, effective_maker: 1.25, effective_taker: 1.25 });
    }
    const alt = (compareExchangeFees("spot", "DE", { pair: "DOGE/EUR" }) as any[]).find(
      (x) => x.exchange === "bison",
    );
    expect(alt).toMatchObject({ effective_maker: 1.75, effective_taker: 1.75 });
  });

  it("models NO additive bid-ask spread for the spread venue (anti-double-count guard)", () => {
    for (const base of ["BTC", "ETH", "DOGE"]) {
      expect(getSpreadEstimate("bison", base)).toMatchObject({
        full_spread_bps: 0,
        crossing_bps: 0,
      });
    }
  });

  it("never charges spread twice in the annual cost: BTC/EUR 1.25% = 180, generic 1.75% = 252, zero spread leg", () => {
    // €1,200/month => €14,400/year turnover.
    const btc = calculateAnnualCost("bison", "spot", "DE", 1200, {
      pair: "BTC/EUR",
      tradeSizeUsd: 1000,
    }) as any;
    expect(btc.annual_trading_fee).toBe(180);
    expect(btc.annual_spread_cost).toBe(0);
    expect(btc.spread_source).toBe("bundled");
    const alt = calculateAnnualCost("bison", "spot", "DE", 1200, {
      pair: "DOGE/EUR",
      tradeSizeUsd: 1000,
    }) as any;
    expect(alt.annual_trading_fee).toBe(252);
    expect(alt.annual_spread_cost).toBe(0);
  });

  it("surfaces the independent TUM real-money evidence in notes (2.58% measured, 0.08 pp hidden)", () => {
    const joined = getExchangeNotes("bison")!.join(" ");
    expect(joined).toContain("2.58");
    expect(joined).toContain("0.08");
    expect(joined).toContain("2.5");
    expect(joined).toContain("TUM");
  });

  it("is onboarded across the EEA and Switzerland but blocked in GB and everywhere outside EEA+CH", () => {
    for (const cc of ["DE", "FR", "AT", "NL", "IS", "NO", "LI", "PT", "CH"]) {
      expect(isVenueUsableFor("bison", cc, "spot")).toBe(true);
    }
    for (const cc of ["GB", "US", "CA", "JP", "SG", "AU", "BR", "CN", "KR"]) {
      expect(isVenueUsableFor("bison", cc, "spot")).toBe(false);
    }
    // CH is reached through the dedicated one-member region key (v0.45); GB is
    // the complementary gap vs Bitpanda (Bison serves CH, not GB).
    expect(isVenueRegionAllowed("bison", "CH")).toBe(true);
    expect(isVenueRegionRestricted("bison", "CH")).toBe(false);
    expect(isVenueRegionAllowed("bison", "GB")).toBe(false);
    expect(isVenueRegionRestricted("bison", "GB")).toBe(true);
    expect(isVenueRegionAllowed("bison", "US")).toBe(false);
  });

  it("appears in the 11-venue EEA spot stack AND the 15-venue CH stack, never in GB/US/JP stacks", () => {
    for (const cc of ["DE", "FR", "IT", "ES", "NL"]) {
      expect((compareExchangeFees("spot", cc) as any[]).map((x) => x.exchange)).toContain("bison");
    }
    expect((compareExchangeFees("spot", "DE") as any[])).toHaveLength(11);
    const ch = compareExchangeFees("spot", "CH") as any[];
    expect(ch).toHaveLength(15);
    expect(ch.map((x) => x.exchange)).toContain("bison");
    // Default (no pair) headline is the 1.75% generic rung.
    expect(ch.find((x) => x.exchange === "bison")).toMatchObject({ base_maker: 1.75, base_taker: 1.75 });
    for (const cc of ["GB", "US", "JP"]) {
      expect((compareExchangeFees("spot", cc) as any[]).map((x) => x.exchange)).not.toContain("bison");
    }
  });

  it("classifies futures as unsupported_product inside the service area (DE/CH) and blocked outside", () => {
    for (const cc of ["DE", "CH"]) {
      expect(isVenueUsableFor("bison", cc, "futures")).toBe(true);
      expect(isProductBlockedInCountry("bison", "futures", cc)).toBe(false);
      expect((compareExchangeFees("futures", cc) as any[]).map((x) => x.exchange)).not.toContain("bison");
    }
    const r = compareCountries("swing_futures_trader", { countries: ["DE", "CH", "GB", "US", "JP"] }) as any;
    const matrix = r.venue_availability.find((v: any) => v.exchange === "bison");
    expect(matrix.per_country.DE).toBe("unsupported_product");
    expect(matrix.per_country.CH).toBe("unsupported_product");
    expect(matrix.per_country.GB).toBe("blocked");
    expect(matrix.per_country.US).toBe("blocked");
    expect(matrix.per_country.JP).toBe("blocked");
  });

  it("subsidizes crypto withdrawals fully: BTC and ETH on-chain fees are zero (group absorbs network costs)", () => {
    const btc = getWithdrawalCost({ asset: "BTC", exchanges: ["bison"] }) as any;
    expect(btc.exchanges[0].networks).toHaveLength(1);
    expect(btc.exchanges[0].networks[0]).toMatchObject({
      network: "Bitcoin",
      fee: 0,
      fee_usd: 0,
      available: true,
    });
    expect(btc.best).toMatchObject({ exchange: "bison", network: "Bitcoin", fee_usd: 0 });
    const eth = getWithdrawalCost({ asset: "ETH", exchanges: ["bison"] }) as any;
    expect(eth.exchanges[0].networks).toHaveLength(1);
    expect(eth.exchanges[0].networks[0]).toMatchObject({
      network: "Ethereum",
      fee: 0,
      fee_usd: 0,
      available: true,
    });
    expect(eth.best).toMatchObject({ exchange: "bison", network: "Ethereum", fee_usd: 0 });
  });

  it("offers free SEPA plus 2.49% card deposits in DE and CH, free SEPA cash-out, and no rail for blocked countries/USD", () => {
    for (const cc of ["DE", "CH"]) {
      const q = getFiatCost({ currency: "EUR", amount: 1000, country: cc, exchanges: ["bison"] }) as any;
      expect(q.exchanges[0].available).toBe(true);
      expect(q.exchanges[0].routes.map((r: any) => [r.method, r.fee, r.fee_usd])).toEqual([
        ["sepa", 0, 0],
        ["card", 24.9, 27.07],
      ]);
      const out = getFiatCost({
        direction: "withdraw",
        currency: "EUR",
        amount: 1000,
        country: cc,
        exchanges: ["bison"],
      }) as any;
      expect(out.exchanges[0].available).toBe(true);
      expect(out.exchanges[0].routes.map((r: any) => r.method)).toEqual(["sepa"]);
    }
    // GB is outside the service area: venue-level gating drops the row entirely.
    const gb = getFiatCost({ currency: "EUR", amount: 1000, country: "GB", exchanges: ["bison"] }) as any;
    expect(gb.exchanges).toEqual([]);
    // No USD rail modeled; absent country keeps the row present but unavailable
    // rather than dropping it via the compliance filter.
    const us = getFiatCost({ currency: "USD", amount: 1000, exchanges: ["bison"] }) as any;
    expect(us.exchanges[0].exchange).toBe("bison");
    expect(us.exchanges[0].available).toBe(false);
    expect(us.exchanges[0].routes).toEqual([]);
  });

  it("has no referral program modeled (invite-a-friend exists but carries no affiliate URL)", () => {
    expect((getReferralLink("bison", "DE") as any).code).toBe("NO_REFERRAL_LINK");
    expect((getReferralLink("bison", "CH") as any).code).toBe("NO_REFERRAL_LINK");
  });
});

// =====================================================================
// v0.46: MiCA stablecoin regional access — USDT unavailable at EEA venues
// after the 2026-07-01 CASP cliff; USDC/EURC/EURI/EURCV/USDQ authorized.
// =====================================================================
describe("v0.46: MiCA stablecoin regional access (USDT EEA sweep)", () => {
  beforeEach(() => resetCachesForTest());

  it("reports USDT as non-authorized and restricted for an EEA resident with the 2026-07-01 cliff", () => {
    const r = getStablecoinAccessReport({ asset: "USDT", country: "DE" }) as any;
    expect(r.mica_authorized).toBe(false);
    expect(r.restriction).toMatchObject({
      applies: true,
      region: "EEA",
      effective: "2026-07-01",
      venue_trading: "unavailable",
    });
    expect(r.restriction.self_custody_allowed).toBe(true);
    expect(r.compliant_alternatives).toEqual(expect.arrayContaining(["USDC", "EURC"]));
    expect(r.data_as_of).toBe("2026-09");
    expect(r.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.regulation_note).toEqual(expect.any(String));
    expect(r.advice).toContain("MiCA");
  });

  it("applies the restriction across EEA members including IS/LI/NO, but never in CH/GB/US", () => {
    for (const cc of ["DE", "FR", "NL", "IT", "ES", "IS", "LI", "NO", "PT", "AT"]) {
      const r = getStablecoinAccessReport({ asset: "USDT", country: cc }) as any;
      expect(r.restriction.applies).toBe(true);
    }
    for (const cc of ["CH", "GB", "US", "JP", "SG", "BR"]) {
      const r = getStablecoinAccessReport({ asset: "USDT", country: cc }) as any;
      expect(r.restriction.applies).toBe(false);
    }
  });

  it("lists all 18 modeled venue rows for an EEA resident, sorted in supported-exchange order", () => {
    const r = getStablecoinAccessReport({ asset: "USDT", country: "DE" }) as any;
    expect(r.venues).toHaveLength(18);
    // Coinbase: first major delisting (December 2024), venue still serves DE.
    expect(r.venues.find((v: any) => v.exchange === "coinbase")).toMatchObject({
      status: "delisted",
      scope: "eea",
      since: "2024-12",
      venue_available_in_country: true,
    });
    // BISON: global policy — never offered either stablecoin, venue serves DE.
    expect(r.venues.find((v: any) => v.exchange === "bison")).toMatchObject({
      status: "never_offered",
      scope: "global",
      venue_available_in_country: true,
    });
    // MEXC: venue itself blocked in the EEA after the cliff.
    expect(r.venues.find((v: any) => v.exchange === "mexc")).toMatchObject({
      status: "venue_blocked",
      scope: "eea",
      venue_available_in_country: false,
    });
  });

  it("outside the EEA shows only global-scope venue policies (3 brokerages/DEX)", () => {
    const us = getStablecoinAccessReport({ asset: "USDT", country: "US" }) as any;
    expect(us.venues.map((v: any) => v.exchange).sort()).toEqual(
      ["bison", "finst", "hyperliquid"].sort(),
    );
    // All three global-scope venues are themselves unavailable to US residents
    // (BISON/Finst EEA-only; Hyperliquid US front-end geo-block modeled).
    expect(us.venues.find((v: any) => v.exchange === "bison").venue_available_in_country).toBe(false);
    expect(us.venues.find((v: any) => v.exchange === "hyperliquid").venue_available_in_country).toBe(false);
  });

  it("without a country returns asset/global status and the three global rows", () => {
    const r = getStablecoinAccessReport({ asset: "USDT" }) as any;
    expect(r.restriction.applies).toBe(false);
    expect(r.venues).toHaveLength(3);
    expect(r.venues.every((v: any) => v.scope === "global")).toBe(true);
    expect(r.venues.every((v: any) => v.venue_available_in_country === true)).toBe(true);
  });

  it("treats MiCA-authorized assets (USDC/EURC/EURI/EURCV/USDQ/EURQ) as unrestricted everywhere", () => {
    for (const asset of ["USDC", "EURC", "EURI", "EURCV", "USDQ", "EURQ"]) {
      const r = getStablecoinAccessReport({ asset, country: "DE" }) as any;
      expect(r.mica_authorized).toBe(true);
      expect(r.restriction.applies).toBe(false);
      // No venue-level USDT-style access book for authorized assets.
      expect(r.venues).toEqual([]);
    }
  });

  it("rejects an untracked asset with INVALID_ASSET and lists the tracked set", () => {
    const r = getStablecoinAccessReport({ asset: "DOGE", country: "DE" }) as any;
    expect(r.code).toBe("INVALID_ASSET");
    expect(r.suggested_action).toContain("USDT");
    expect(r.suggested_action).toContain("USDC");
  });

  it("honors the exchange filter, including the COUNTRY_BLOCKED precondition", () => {
    const one = getStablecoinAccessReport({ asset: "USDT", country: "DE", exchange: "bison" }) as any;
    expect(one.venues).toHaveLength(1);
    expect(one.venues[0]).toMatchObject({ exchange: "bison", status: "never_offered" });
    const bad = getStablecoinAccessReport({ asset: "USDT", country: "DE", exchange: "notarealvenue" }) as any;
    expect(bad.code).toBe("UNKNOWN_EXCHANGE");
    const blocked = getStablecoinAccessReport({ asset: "USDT", country: "US", exchange: "bison" }) as any;
    expect(blocked.code).toBe("COUNTRY_BLOCKED");
  });

  it("localizes advice and warnings in Chinese", () => {
    const r = getStablecoinAccessReport({ asset: "USDT", country: "DE", language: "zh" }) as any;
    expect(/[\u4e00-\u9fff]/.test(r.advice)).toBe(true);
    expect(r.advice).toContain("USDC");
  });

  it("annotates every compare_exchange_fees row for a USDT quote in the EEA, and none for USDC/EUR/non-EEA", () => {
    const de = compareExchangeFees("spot", "DE", { monthlyVolumeUsd: 10_000, pair: "BTC/USDT" }) as any[];
    expect(de.length).toBeGreaterThan(5);
    expect(de.every((x) => x.stablecoin_access?.asset === "USDT")).toBe(true);
    expect(de.find((x) => x.exchange === "coinbase").stablecoin_access).toMatchObject({ status: "delisted" });
    expect(de.find((x) => x.exchange === "bison").stablecoin_access).toMatchObject({ status: "never_offered" });
    // Futures stack (OKX/Kraken/Bitstamp + Hyperliquid) gets the same annotation.
    const fut = compareExchangeFees("futures", "DE", { pair: "BTC/USDT" }) as any[];
    expect(fut.every((x) => !!x.stablecoin_access)).toBe(true);
    // USDC quote: nothing.
    const usdc = compareExchangeFees("spot", "DE", { pair: "BTC/USDC" }) as any[];
    expect(usdc.every((x) => x.stablecoin_access === undefined)).toBe(true);
    // EUR quote (fiat): nothing.
    const eur = compareExchangeFees("spot", "DE", { pair: "BTC/EUR" }) as any[];
    expect(eur.every((x) => x.stablecoin_access === undefined)).toBe(true);
    // USDT quote outside the EEA: nothing.
    const us = compareExchangeFees("spot", "US", { pair: "BTC/USDT" }) as any[];
    expect(us.every((x) => x.stablecoin_access === undefined)).toBe(true);
  });

  it("attaches a trading-context stablecoin_warning to calculate_savings only inside the EEA", () => {
    const de = calculateSavings("coinbase", 10_000, "spot", "DE", { pair: "BTC/USDT" }) as any;
    expect(de.stablecoin_warning).toMatchObject({
      code: "STABLECOIN_UNAVAILABLE_IN_REGION",
      asset: "USDT",
      region: "EEA",
      context: "trading",
    });
    expect(de.stablecoin_warning.message).toContain("2026-07-01");
    const us = calculateSavings("coinbase", 10_000, "spot", "US", { pair: "BTC/USDT" }) as any;
    expect(us.stablecoin_warning).toBeUndefined();
    const ch = calculateSavings("coinbase", 10_000, "spot", "CH", { pair: "BTC/USDT" }) as any;
    expect(ch.stablecoin_warning).toBeUndefined();
  });

  it("annotates compare_total_cost rows in the EEA and leaves non-EEA rows clean", () => {
    const de = compareTotalCost("spot", "DE", 10_000, { pair: "BTC/USDT" }) as any[];
    expect(de.length).toBeGreaterThan(5);
    expect(de.every((x) => x.stablecoin_warning?.code === "STABLECOIN_UNAVAILABLE_IN_REGION")).toBe(true);
    const us = compareTotalCost("spot", "US", 10_000, { pair: "BTC/USDT" }) as any[];
    expect(us.every((x) => x.stablecoin_warning === undefined)).toBe(true);
  });

  it("puts the warning on recommend_exchange result, best/alternatives rows, and advice", () => {
    const r = recommendExchange("spot", "DE", 10_000, { pair: "BTC/USDT" }) as any;
    expect(r.stablecoin_warning).toMatchObject({ asset: "USDT", region: "EEA", context: "trading" });
    expect(r.best.stablecoin_access).toBeDefined();
    expect(r.alternatives.every((x: any) => !!x.stablecoin_access)).toBe(true);
    expect(r.advice).toContain("2026-07-01");
    const us = recommendExchange("spot", "US", 10_000, { pair: "BTC/USDT" }) as any;
    expect(us.stablecoin_warning).toBeUndefined();
  });

  it("puts the warning on calculate_annual_cost for a USDT pair in the EEA", () => {
    const de = calculateAnnualCost("coinbase", "spot", "DE", 10_000, { pair: "BTC/USDT" }) as any;
    expect(de.stablecoin_warning).toMatchObject({ code: "STABLECOIN_UNAVAILABLE_IN_REGION", context: "trading" });
    const usdc = calculateAnnualCost("coinbase", "spot", "DE", 10_000, { pair: "BTC/USDC" }) as any;
    expect(usdc.stablecoin_warning).toBeUndefined();
  });

  it("warns in withdrawal context (on-chain rights preserved) and tags each venue quote", () => {
    const de = getWithdrawalCost({ asset: "USDT", country: "DE", exchanges: ["coinbase", "bison"] }) as any;
    expect(de.stablecoin_warning).toMatchObject({ asset: "USDT", context: "withdrawal", region: "EEA" });
    expect(de.stablecoin_warning.self_custody_allowed).toBe(true);
    expect(de.exchanges.find((q: any) => q.exchange === "coinbase").stablecoin_access).toMatchObject({
      status: "delisted",
    });
    const us = getWithdrawalCost({ asset: "USDT", country: "US", exchanges: ["coinbase"] }) as any;
    expect(us.stablecoin_warning).toBeUndefined();
    const usdc = getWithdrawalCost({ asset: "USDC", country: "DE", exchanges: ["coinbase"] }) as any;
    expect(usdc.stablecoin_warning).toBeUndefined();
  });

  it("flags bundled execution-cost estimates on USDT pairs for EEA residents", async () => {
    const de = (await getExecutionCost({ pair: "BTC/USDT", country: "DE", purpose: "spot" })) as any;
    expect(de.stablecoin_warning).toMatchObject({ code: "STABLECOIN_UNAVAILABLE_IN_REGION", asset: "USDT" });
    const us = (await getExecutionCost({ pair: "BTC/USDT", country: "US", purpose: "spot" })) as any;
    expect(us.stablecoin_warning).toBeUndefined();
  });

  it("flags USDT-withdrawal personas in the EEA (rows + appended warning), not the USDC dex persona or US runs", () => {
    const de = analyzePersona("casual_buyer", "DE") as any;
    expect(de.stablecoin_warning).toMatchObject({ asset: "USDT", region: "EEA", context: "persona" });
    // Append-only: the localized message is the last human-readable warning.
    expect(de.warnings[de.warnings.length - 1]).toBe(de.stablecoin_warning.message);
    expect(de.ranking.find((r: any) => r.exchange === "bison").stablecoin_access).toMatchObject({
      status: "never_offered",
    });
    const us = analyzePersona("casual_buyer", "US") as any;
    expect(us.stablecoin_warning).toBeUndefined();
    // dex_native withdraws/quotes USDC — MiCA-authorized, no warning even in DE.
    const dex = analyzePersona("dex_native", "DE") as any;
    expect(dex.stablecoin_warning).toBeUndefined();
    expect(dex.ranking.every((r: any) => r.stablecoin_access === undefined)).toBe(true);
  });

  it("localizes the persona warning narrative in Chinese", () => {
    const r = analyzePersona("casual_buyer", "DE", { language: "zh" }) as any;
    expect(r.stablecoin_warning.message).toContain("稳定币");
  });

  it("exposes stablecoin_access.json as the 13th provenance file", () => {
    const r = listDataProvenance();
    const f = r.files.find((x) => x.file === "stablecoin_access.json")!;
    expect(f).toBeDefined();
    expect(f.sources!.length).toBeGreaterThan(0);
  });
});

// =====================================================================
// v0.47: consumer-vs-pro interface costs. Many venues run a cheap PRO
// order book AND an expensive consumer app whose spread is embedded in
// the quote (TUM real-money €100 round-trips 2025-10..11, replicated by
// Frankfurt School 2026-03): Bitvavo 0.58% < Bison 2.58% < Kraken app
// 5.81% < Bitpanda 6.23% < Coinbase 7.49%.
// =====================================================================
describe("v0.47: consumer-vs-pro interface costs", () => {
  beforeEach(() => resetCachesForTest());

  it("returns all six modeled venues in supported-exchange order with study provenance", () => {
    const r = compareInterfaceCosts() as any;
    expect(r.venues.map((v: any) => v.exchange)).toEqual([
      "kraken",
      "coinbase",
      "bitstamp",
      "bitvavo",
      "bitpanda",
      "bison",
    ]);
    expect(r.data_as_of).toBe("2026-09");
    expect(r.study_summary).toContain("TUM");
    expect(r.study_summary).toContain("Frankfurt School");
    expect(r.advice).toContain("monthly_volume_usd");
    expect(r.data_sources.length).toBeGreaterThan(0);
  });

  it("models the Kraken app as fee_plus_embedded_spread with the TUM-measured gap over Kraken Pro", () => {
    const r = compareInterfaceCosts({ exchange: "kraken" }) as any;
    expect(r.venues).toHaveLength(1);
    const row = r.venues[0];
    expect(row.venue_name).toBe("Kraken");
    expect(row.consumer.product_name).toBe("Kraken app (Instant Buy / custom orders)");
    expect(row.consumer.fee_model).toBe("fee_plus_embedded_spread");
    expect(row.consumer.modeled_one_way_pct).toBe(1.5);
    expect(row.consumer.measured_round_trip_pct).toBe(5.81);
    expect(row.consumer.published_one_way_pct).toMatchObject({ instant_recurring: 1.0, custom_order: 1.5 });
    expect(row.consumer.subscription).toMatchObject({ name: "Kraken+", monthly_usd: 4.99, waiver_monthly_usd: 10000 });
    expect(row.consumer.tier_credit).toBe(false);
    expect(row.pro).toMatchObject({
      product_name: "Kraken Pro (unified 17-tier order book since 2026-07-09)",
      base_maker_pct: 0.4,
      base_taker_pct: 0.8,
      published_round_trip_pct: 1.6,
    });
    expect(row.consumer_vs_pro_round_trip_pp).toBe(4.21);
    expect(row.consumer_vs_pro_annual_excess_usd).toBeUndefined();
    expect(row.notes.some((n: string) => n.includes("NO Kraken Pro tier credit"))).toBe(true);
  });

  it("prices the annual excess from monthly_volume_usd (kraken 84, coinbase 168 at $1k/mo)", () => {
    const r = compareInterfaceCosts({ monthlyVolumeUsd: 1000 }) as any;
    const byId = Object.fromEntries(r.venues.map((v: any) => [v.exchange, v]));
    // (1.5 - 0.8)/100 * 1000 * 12 = 84
    expect(byId.kraken.consumer_vs_pro_annual_excess_usd).toBe(84);
    // (2.0 - 0.6)/100 * 1000 * 12 = 168
    expect(byId.coinbase.consumer_vs_pro_annual_excess_usd).toBe(168);
    // Pass-through flow: consumer routes into the PRO book — no excess.
    expect(byId.bitvavo.consumer_vs_pro_annual_excess_usd).toBeUndefined();
    // Spread-model brokerages have no PRO interface to switch to.
    expect(byId.bitpanda.consumer_vs_pro_annual_excess_usd).toBeUndefined();
    expect(byId.bison.consumer_vs_pro_annual_excess_usd).toBeUndefined();
  });

  it("classifies Bitvavo as the pass-through transparency benchmark", () => {
    const r = compareInterfaceCosts({ exchange: "bitvavo" }) as any;
    const row = r.venues[0];
    expect(row.consumer.fee_model).toBe("order_book_pass_through");
    expect(row.consumer.modeled_one_way_pct).toBe(0.25);
    expect(row.consumer.measured_round_trip_pct).toBe(0.58);
    expect(row.consumer.measured_hidden_spread_pp).toBe(0.08);
    expect(row.consumer_vs_pro_round_trip_pp).toBe(0.08);
    expect(row.advice).toContain("transparency benchmark");
  });

  it("marks Bitstamp Basic as unmeasured (venue's own disclosure only)", () => {
    const r = compareInterfaceCosts({ exchange: "bitstamp" }) as any;
    const row = r.venues[0];
    expect(row.consumer.measured_round_trip_pct).toBeUndefined();
    expect(row.consumer_vs_pro_round_trip_pp).toBeUndefined();
    expect(row.consumer.measurement.n).toBe(0);
    expect(row.advice).toContain("unverified");
  });

  it("treats spread-model brokerages (Bitpanda/BISON) as broker-only with no PRO ladder", () => {
    const r = compareInterfaceCosts() as any;
    const byId = Object.fromEntries(r.venues.map((v: any) => [v.exchange, v]));
    expect(byId.bitpanda.pro).toBeUndefined();
    expect(byId.bison.pro).toBeUndefined();
    expect(byId.bitpanda.consumer.fee_model).toBe("broker_premium");
    expect(byId.bitpanda.consumer.measured_round_trip_pct).toBe(6.23);
    expect(byId.bitpanda.consumer_vs_pro_round_trip_pp).toBeUndefined();
    expect(byId.bitpanda.advice).toContain("Fusion");
    expect(byId.bison.consumer.measured_hidden_spread_pp).toBe(0.08);
    expect(byId.bison.advice).toContain("spread-model brokerage");
  });

  it("validates exchange and volume inputs", () => {
    const unknown = compareInterfaceCosts({ exchange: "binance" }) as any;
    expect(unknown.code).toBe("UNKNOWN_EXCHANGE");
    expect(unknown.suggested_action).toContain("bitvavo");
    for (const bad of [0, -5, "x" as unknown as number]) {
      const r = compareInterfaceCosts({ monthlyVolumeUsd: bad }) as any;
      expect(r.code).toBe("INVALID_VOLUME");
    }
  });

  it("applies the residency gate to single-venue queries and per-row availability", () => {
    expect((compareInterfaceCosts({ exchange: "bitvavo", country: "US" }) as any).code).toBe(
      "COUNTRY_BLOCKED",
    );
    const de = compareInterfaceCosts({ exchange: "bitvavo", country: "DE" }) as any;
    expect(de.venues[0].available_in_country).toBe(true);
    const us = compareInterfaceCosts({ country: "US" }) as any;
    const byId = Object.fromEntries(us.venues.map((v: any) => [v.exchange, v]));
    expect(byId.kraken.available_in_country).toBe(true);
    expect(byId.coinbase.available_in_country).toBe(true);
    expect(byId.bitstamp.available_in_country).toBe(true);
    expect(byId.bitvavo.available_in_country).toBe(false);
    expect(byId.bitpanda.available_in_country).toBe(false);
    expect(byId.bison.available_in_country).toBe(false);
  });

  it("localizes the study summary and per-venue advice in Chinese", () => {
    const r = compareInterfaceCosts({ language: "zh" }) as any;
    expect(r.study_summary).toContain("证据");
    expect(r.advice).toContain("两套价格");
    expect(r.venues[0].advice).toContain("存在两套价格");
    // No monthly volume → no annual-saving clause (regression: used to leak "—").
    expect(r.venues[0].advice).not.toContain("切换界面免费");
    expect(r.venues[0].advice).not.toContain("按每月 —");
    expect(r.venues[0].advice).not.toContain("可省约 —");
  });

  it("omits the annual-saving clause when monthly_volume_usd is absent (no em-dash leakage)", () => {
    const r = compareInterfaceCosts() as any;
    const byId = Object.fromEntries(r.venues.map((v: any) => [v.exchange, v]));
    for (const id of ["kraken", "coinbase"]) {
      expect(byId[id].advice).not.toMatch(/—\/(yr|mo)/);
      expect(byId[id].advice).not.toContain("saves ≈—");
      expect(byId[id].consumer_vs_pro_annual_excess_usd).toBeUndefined();
    }
    // Kraken+ publishes a concrete $10,000 waiver cap.
    expect(byId.kraken.advice).toContain("up to $10000/mo");
    // Coinbase One has no public cap figure: plan-caps wording, never "$0/mo".
    expect(byId.coinbase.advice).toContain("plan's own caps");
    expect(byId.coinbase.advice).not.toContain("$0/mo");
  });

  it("renders the annual-saving clause with figures when monthly_volume_usd is provided", () => {
    const en = compareInterfaceCosts({ monthlyVolumeUsd: 1000 }) as any;
    const enRows = Object.fromEntries(en.venues.map((v: any) => [v.exchange, v]));
    expect(enRows.kraken.advice).toContain("saves ≈$84/yr at $1000/mo");
    expect(enRows.coinbase.advice).toContain("saves ≈$168/yr at $1000/mo");
    expect(enRows.coinbase.advice).toContain("plan's own caps");
    const zh = compareInterfaceCosts({ monthlyVolumeUsd: 1000, language: "zh" }) as any;
    const zhRows = Object.fromEntries(zh.venues.map((v: any) => [v.exchange, v]));
    expect(zhRows.kraken.advice).toContain("切换界面免费");
    expect(zhRows.kraken.advice).toContain("一年可省约 $84");
    expect(zhRows.coinbase.advice).toContain("套餐");
    expect(zhRows.coinbase.advice).not.toContain("$0");
  });

  it("annotates compare_exchange_fees rows for gap venues only (kraken/coinbase yes, bitvavo/binance no)", () => {
    const us = compareExchangeFees("spot", "US") as any[];
    const kraken = us.find((x) => x.exchange === "kraken");
    expect(kraken.consumer_interface).toEqual({
      consumer_product: "Kraken app (Instant Buy / custom orders)",
      consumer_one_way_pct: 1.5,
      pro_taker_pct: 0.8,
      measured_round_trip_pct: 5.81,
    });
    expect(us.find((x) => x.exchange === "coinbase").consumer_interface).toMatchObject({
      pro_taker_pct: 0.6,
    });
    // Binance is venue-blocked for US residents; OKX has no dual-interface gap.
    expect(us.find((x) => x.exchange === "binance")).toBeUndefined();
    expect(us.find((x) => x.exchange === "okx").consumer_interface).toBeUndefined();
    // Bitvavo's consumer flow routes into the PRO book — no gap to flag.
    const de = compareExchangeFees("spot", "DE") as any[];
    expect(de.find((x) => x.exchange === "bitvavo").consumer_interface).toBeUndefined();
  });

  it("attaches the trading-context interface_warning to calculate_savings for gap venues", () => {
    const r = calculateSavings("kraken", 1000, "spot", "US") as any;
    expect(r.interface_warning).toMatchObject({
      code: "CONSUMER_INTERFACE_MORE_EXPENSIVE",
      exchange: "kraken",
      pro_taker_pct: 0.8,
      consumer_one_way_pct: 1.5,
      measured_round_trip_pct: 5.81,
    });
    expect(r.interface_warning.message).toContain("compare_interface_costs");
    const zh = calculateSavings("kraken", 1000, "spot", "US", { language: "zh" }) as any;
    expect(zh.interface_warning.message).toContain("界面成本差距");
    expect((calculateSavings("binance", 1000, "spot", "US") as any).interface_warning).toBeUndefined();
  });

  it("annotates recommend_exchange rows (and the best pick when it is a gap venue)", () => {
    const r = recommendExchange("spot", "US", 1000) as any;
    const rows = [r.best, ...r.alternatives];
    expect(rows.find((x: any) => x.exchange === "kraken").consumer_interface).toMatchObject({
      pro_taker_pct: 0.8,
    });
    expect(rows.find((x: any) => x.exchange === "okx").consumer_interface).toBeUndefined();
    if (r.best.exchange === "kraken" || r.best.exchange === "coinbase") {
      expect(r.interface_warning).toMatchObject({ code: "CONSUMER_INTERFACE_MORE_EXPENSIVE" });
    }
  });

  it("exposes interface_costs.json as the 14th provenance file", () => {
    const r = listDataProvenance();
    const f = r.files.find((x) => x.file === "interface_costs.json")!;
    expect(f).toBeDefined();
    expect(f.last_verified).toBe("2026-09");
    expect(f.sources!.length).toBeGreaterThanOrEqual(6);
  });
});
