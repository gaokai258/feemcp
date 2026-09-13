import "./polyfills.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  compareExchangeFees,
  getReferralLink,
  calculateSavings,
  compareTotalCost,
  recommendExchange,
  listDataSources,
  calculateAnnualCost,
  getFundingRates,
  getExecutionCost,
  getFiatCost,
  getWithdrawalCost,
  analyzePersona,
  comparePersonas,
  listPersonas,
  analyzeTokenDiscount,
  volumeWhatIf,
  compareCountries,
  COMPARE_COUNTRIES_DEFAULT_SET,
  exDisplayName,
  getStablecoinAccessReport,
  compareInterfaceCosts,
} from "./tools.js";
import { fetchFundingRatesLive, fetchExecutionCostLive } from "./live.js";
import {
  listSupportedExchanges,
  isExchangeAllowed,
  isProductBlockedInCountry,
  resolveFeeRate,
} from "./data.js";
import { fetchAccountFee, redactSecrets, accountFeeSupportFor } from "./account.js";
import { makeError, isToolError } from "./errors.js";
import type { FundingOverrides, SpreadOverrides } from "./types.js";

export const SERVER_NAME = "fee-optimizer-mcp";
export const SERVER_VERSION = "0.47.0";

// v0.29: server construction is a factory so both the stdio CLI entry (index.ts)
// and the Streamable HTTP listener (http.ts) — plus tests — get an isolated,
// fully-registered MCP server instance.
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: {},
    instructions:
      "Fee Optimizer MCP: compares crypto exchange trading fees across Binance, OKX, Gate.io, Bybit, MEXC, Bitget, KuCoin, Kraken, Coinbase, Hyperliquid, BingX, Phemex, BloFin, Bitstamp, Bitvavo, Finst, Bitpanda and BISON with full VIP tier support (v0.16 adds real execution cost: bid-ask spread crossing + order-book depth slippage for a specific order size via get_execution_cost, and tradeSizeUsd/spreadMode/spreadPair/side params on the savings, total-cost, recommend, and annual-cost tools; spreadMode=live walks the real top-100 order-book depth per venue via ccxt, venues that fail fall back to bundled typical-spread baselines and are listed in failures, shallow books are kept with warnings; v0.17 adds fiat on/off-ramp cost via get_fiat_cost: direct exchange-operated bank and card rails — cards 1.1%-4.5%, free ACH (US), free/near-free SEPA (EU), FPS (UK), PIX (BR), SWIFT/wire fees — for deposits and cash-outs in USD/EUR/GBP/BRL with per-rail fee, net received amount, ETA, region/residency filtering and cheapest-venue ranking; v0.18 adds get_withdrawal_fees: per-asset network withdrawal-fee comparison across all venues — 16 assets (BTC/ETH/USDT/USDC/SOL/XRP/DOGE/LTC/TRX/ADA/AVAX/DOT/LINK/BCH/TON/POL) on Tron/ERC-20/BEP20/Arbitrum/Optimism/Base/Polygon/Avalanche/Solana/Ton/AssetHub/native chains, native-unit and USD fees from a dated price snapshot, suspended-wallet flags, cheapest route per venue and best-venue ranking, with network aliases; v0.19 adds Coinbase Advanced Trade as the 9th venue: spot-only volume-tiered schedule (0.60%/0.40% entry down to 0.04%/0.00% above $400M, hourly tier refresh, volume-only qualification), serves all 50 US states + Singapore (MAS), USDT only on ERC-20/Base/Solana, free USDC withdrawals on Base, ACH free both ways, no native token and no fee-discount referral; its US CFTC-regulated retail nano BTC/ETH perps are noted via exchange_notes but not modeled, so futures comparisons exclude it; v0.20 adds Hyperliquid as the 10th venue — the first DEX: on-chain L1 order book with zero trading gas, USDC margin/quote, 14-day rolling volume tiers (spot volume counts 2x; perp 0.045%/0.015% entry, spot 0.070%/0.040%), hourly funding settlement (bundled 0.00125%/1h = the same neutral 0.01%/8h equivalent as CEX venues, live mode supported), staked-HYPE discount ladder 5-40% (staking required, holding alone gives nothing — useToken + tokenBalance = staked amount, stacks multiplicatively), flat ~1 USDC withdrawals to Arbitrum/CCTP chains, no KYC, no fiat rails, US front-end geo-blocked; v0.21 adds BingX as the 11th venue: per-product VIP Club ladder (futures Regular 0.050%/0.020% → Supreme 0.025%/0.000%; spot 0.10%/0.10% → 0.020%/0.005%) with a volume-only Elite rung between Regular and VIP1, three-track qualification (30d spot volume OR 30d futures volume OR previous-day account assets via accountAssetsUsd; Elite/Supreme unreachable via assets), VIP4+/Supreme API-volume ≤20% rule surfaced via exchange_notes, 8h funding, bundled 4 bps typical spread, USDT/USDC multi-chain withdrawals (several chains suspended), no native token, no referral link and no direct fiat rails; blocked for US/CA/GB/mainland China/HK/SG, served in JP/TH and 160+ other countries; its close-only Standard Futures copy-trading product (flat 0.045%) is not modeled; v0.22 adds analyze_persona: one-shot scenario recommendations for 7 research-anchored trader personas — casual_buyer (small monthly card buys, fiat rails dominate), hodler_accumulator (DCA + cold-storage withdrawals), active_spot_trader, swing_futures_trader (funding often costs more than fees), day_scalper (90% maker, $3M/mo), vip_institutional ($30M/mo + $3M assets, large clips), dex_native (self-custody/no-KYC, USDC on/off-chain) — each preset bundles monthly volume, maker share, position holding hours, clip size, withdrawal/fiat habits and runs the FULL annual cost stack (trading fees + funding + spread crossing + on-chain withdrawals + direct fiat deposits/cash-outs) across every venue allowed in the caller's country, then returns a ranked all-in table with per-venue cost mix %, component-level cheapest-venue leaders, a winner with reasons/trade-offs, and persona-specific advice (next-VIP upgrade saving, token-discount hint, live funding/depth prompts); every preset parameter is overridable; venues with no fiat rail or no open withdrawal route are FLAGGED with the leg excluded — never silently priced as zero); v0.23 adds analyze_token_discount: native-token fee-discount payback analysis — for an exchange + purpose + monthly volume it computes the annual fee with NO native token (zero-balance tier, no fee-deduction toggle) vs. WITH the token (tier lift from GT/KCS/BNB holdings + the BNB/MX/BGB/KCS fee-deduction discount or GT/HYPE/MX holding-tier discount or Gate futures maker-to-zero), the annual USD saving, the USD opportunity cost of locking the required token balance (at a 2026-09 snapshot price or an explicit tokenPriceUsd override), the payback in months, and the maximum one-year token price drop the saving can absorb before netting negative; when tokenBalance is omitted it returns every achievable discount tier as a ranked table with a recommended best-payback tier (Binance/Bybit/Bitget/Kraken/Coinbase/OKX venues with no separate token toggle are reported honestly rather than inventing a discount); v0.24 adds Phemex as the 12th venue (Singapore, ex-Morgan Stanley team): per-product 7-tier VIP ladder with the LOWEST futures maker fee in the industry at 0.01% base (Star VIP reaches 0% maker at $380M 30-day volume; spot 0.10%/0.10% base → 0%/0.04% at $15M), volume-only qualification (no holdings track), PT native token gives a flat 20% fee-deduction discount on spot+futures (toggle, not a tier gate), 8h funding, bundled ~2 bps typical spread on majors, BTC/ETH/USDT/USDC withdrawals, no referral link and limited fiat rails (third-party only); blocked for US/UK/CA/HK, served in SG/JP/TH/CN and most of EU/Asia/LatAm); v0.25 cross-links analyze_persona with analyze_token_discount: when a persona runs with useToken=false (the default), the top-3 ranked venues automatically get a token_discount_hint (token, discount %, annual USD saving, payback months, holding cost, flat-vs-tiered flag) plus a consolidated token_discount_hints array and concrete advice — e.g. \"MEXC: hold ~$35 of MX for 50% off, saves $84/yr, 5mo payback\" or \"Binance: enable BNB fee deduction for 10% off at any balance, no lock-up\" — so a single persona call answers both \"which exchange fits me\" and \"is holding its token worth it\" without a second tool call; v0.26 folds direct fiat on/off-ramp costs into the two all-in cost tools: compare_total_cost and calculate_annual_cost now accept fiatCurrency/fiatDepositAmountUsd/fiatDepositsPerYear/fiatCashoutAmountUsd/fiatCashoutsPerYear/fiatMethod and add the cheapest direct rail fee × yearly count as annual_fiat_deposit_cost / annual_fiat_cashout_cost legs inside annual_total_cost (with fiat_deposit_available / fiat_cashout_available flags and the chosen method), so a single call prices the FULL stack a retail trader actually pays — trading fees + funding + spread/slippage + on-chain withdrawals + bank/card deposits and cash-outs — and a venue with no direct rail is flagged with the leg excluded, never silently zero; v0.27 makes recommend_exchange fiat-aware: pass the same fiat habit params and direct deposit/cash-out rails join the recommendation score (fiat_deposit_cost/fiat_cashout_cost per row + availability flags), with a dispersion-driven fiat weight 0.2-0.5 so a small monthly card/SEPA on-ramper is recommended a free-bank-rail venue while a high-volume trader is still ranked on fees, and a rail-less venue scores zero on that leg with an explicit tradeoff; v0.28 adds compare_personas (14th tool): one call runs ALL seven research-anchored personas for a country through the full annual all-in stack and returns a decision matrix — per-persona headline winner plus a demoted best_complete (a rail-less venue like Hyperliquid can headline for 3 personas yet win ZERO realistic picks), a persona×venue annual-cost grid, cross-persona venue win counts, and the single most_versatile venue (realistic all-legs wins); accepts an optional personas subset, global useToken, and live funding/depth overrides; v0.30 adds bilingual narrative output: every narrative-bearing tool (compare_exchange_fees, compare_total_cost, calculate_savings, calculate_annual_cost, get_fiat_cost, get_withdrawal_fees, recommend_exchange, analyze_persona, compare_personas, analyze_token_discount) accepts language: \"en\" (default) or \"zh\" and returns its advice/warnings/tradeoffs/reasons/tier_warning narrative in that language — numbers, field names and error codes stay identical, so Chinese-speaking users get fully localized explanations without changing the data schema; v0.34 adds volume_what_if (15th tool): a volume what-if/sensitivity sweep — at each monthly-volume point (default: the union of all venues' VIP thresholds) it returns the cross-venue cheapest ranking, each venue's tier/maker/taker/weighted/annual-fee curve, and the exact tier-crossing list; with baseVolume it additionally reports each venue's next rung, the extra monthly volume required, and the USD/year saved at today's volume (volume-only-unreachable rungs such as Binance spot's BNB AND-gate are flagged blocked_by_holding_gate); v0.35 adds compare_countries (16th tool): one trader persona is priced through the full annual all-in stack across multiple countries in a single call — per-country winner/realistic best_complete, extra annual cost vs the cheapest country, a venue×country availability matrix (compliance-blocked vs product-unsupported such as spot-only Coinbase for futures), cross-country venue win counts and the cheapest/costliest gap; defaults to active_spot_trader across US/GB/DE/JP/SG/BR/CN, any persona and up to 12 countries supported; v0.36 adds matrix table rendering: compare_personas, volume_what_if and compare_countries accept format=markdown|csv|both and return a ready-to-paste rendered table in `rendered` (persona×venue annual cost; volume×venue weighted fee/annual fee/tier; venue×country availability ✓/⛔/– or cost), with tableMetric selecting the slice and RFC4180-escaped CSV for spreadsheets; default json behavior is unchanged; v0.37 adds BloFin as the 13th venue (Cayman/Marshall Islands entity BuildLight Future Limited, derivatives live since 2023, ~$1.2B/24h perp turnover, Fireblocks custody, 1:1 PoR, no-KYC with 20k USDT daily withdrawal cap): per-product 6-tier VIP ladder (futures Regular 0.020%/0.060% -> VIP5 0%/0.035% at $500M 30d volume; spot 0.10%/0.10% -> 0.01%/0.0325% at $8M), three-track OR qualification (30d futures volume OR 30d spot volume OR daily-snapshot account assets via accountAssetsUsd — just $50k assets reaches futures VIP1 0.006%/0.05%; VIP4/5 require >=80% non-API volume, surfaced in exchange_notes), 8h funding, bundled ~3 bps typical BTC perp spread, BTC/ETH/USDT/USDC multi-chain withdrawals (USDT/USDC TRC-20 at ~1, dynamic network pass-through, no fixed table), NO native token, no referral link and no direct fiat rails (third-party card/SEPA widgets only); blocked for US/CA/mainland China/Singapore and the EEA under MiCA after the 2026-07-01 cliff (Germany explicitly modeled blocked), served in HK/JP/TH/GB/Brazil and 150+ other countries; v0.38 adds Bitstamp as the 14th venue — the most regulated venue in the model (founded 2011, Luxembourg HQ, acquired by Robinhood for ~$200M; EU MiCA CASP passport, US NYDFS BitLicense + 40+ states, UK FCA, Singapore MAS, Canada): an 11-tier volume-only spot ladder on 30d USD turnover (0.30%/0.40% entry down to 0.00%/0.03% above $1B, single volume track, no platform token, Basic-UI spread quotes not modeled), plus regulated USD-margined perpetual futures at a FLAT -0.005% maker rebate / 0.015% taker with 8h P2P funding (00:00/08:00/16:00 UTC, no platform funding cut) — the perps are EU/EEA-eligible-residents only, modeled with the venue×country PRODUCT gate (v0.38 negative list; v0.40 POSITIVE EEA region allowlist — all 30 EEA states route both products; every other residency, incl. US/GB/CA/JP/SG/HK/TH and default-key countries like AU/BR, gets PRODUCT_BLOCKED_IN_COUNTRY on futures while spot stays open; CN is venue-blocked outright), and product gating is intentionally NOT applied to withdrawal/fiat/referral tools since US users still get Bitstamp spot and rails; deep direct fiat (free US ACH both directions, free SEPA in / EUR 3 out, 0.05% SWIFT in with $7.5 floor/$300 cap, 0.1% SWIFT out with $25 floor, ~4% card in USD/EUR/GBP) and conservative withdrawals (BTC 0.0005 no Lightning; ETH 0.005 ERC-20 only, no L2; USDT 20 ERC-20 only — the most expensive USDT route modeled; USDC 4 ERC-20 plus Solana/L2 routes), bundled ~2 bps typical major-pair spread on par with Coinbase Advanced; v0.39 adds get_account_fee_tier — the PERSONALIZED leap from public schedules to the caller's REAL fees: with a READ-ONLY API key (apiKey+secret; OKX/KuCoin-Futures also take passphrase as password; Hyperliquid takes only the public 0x wallet address) it calls the authenticated ccxt fee endpoints, returns the account's actual maker/taker in percent and the signed gap in bps vs the bundled public VIP tier at the stated monthly volume (negative = account pays less; captures server-side BNB deductions, the venue's own rolling-30d VIP window, negotiated/promo rates); coverage 13/18 venues — Binance/OKX/Gate/Bybit/MEXC/Bitget/KuCoin(spot+kucoinfutures)/Kraken(spot+krakenfutures)/Coinbase spot/Hyperliquid/BingX/Bitstamp/Bitvavo spot; Phemex and BloFin return ACCOUNT_FEES_UNSUPPORTED, Finst (v0.43) exposes no public trading API and ccxt ships no finst class so it returns ACCOUNT_FEES_UNSUPPORTED as well, Bitpanda (v0.44) and BISON (v0.45) are spread-quoting brokerages with no ccxt class and return the same code, as do Bitstamp and Bitvavo perps (both spot-only in the model); credentials are per-request, NEVER cached or logged (audit log redacts apiKey/secret/password; error strings scrub credential literals), venue×country and product gates run BEFORE any authenticated call, and failures are typed ACCOUNT_AUTH_FAILED (non-retryable) vs ACCOUNT_FEE_FETCH_FAILED (network/rate-limit retryable); always insist the user generate a READ-ONLY key without trading/withdrawal permissions; v0.40 upgrades country compliance modeling from negative lists to POSITIVE region allowlists (data fields regions + product_region_gates): Bitstamp regulated perpetuals are available ONLY to residents of the 30 EEA states (EU27 + Iceland/Liechtenstein/Norway); for ANY stated residency outside the EEA — including unmodeled countries routed via the default key such as AU/BR/CH/TR/KR/MX/IN — Bitstamp futures return PRODUCT_BLOCKED_IN_COUNTRY while its spot remains available; treat every EEA member (France, Netherlands, Spain, Italy, Ireland, Austria, Poland, the Nordics, IS/LI/NO...) as perp-eligible, and never surface Bitstamp as a futures option for non-EEA residency merely because the country lacks an explicit restrictions entry; v0.41 enforces the POST-CLIFF MiCA regime after the Article 143(3) transitional period ended 2026-07-01 (no extension): for ANY EEA-resident user (all 30 EEA states), Binance, MEXC, Bitget, KuCoin, BingX, Phemex and BloFin are VENUE-BLOCKED for every product (COUNTRY_BLOCKED) — none holds usable CASP authorization (Binance withdrew its HCMC Greece application 2026-06-24 and halted FR/IT/ES/PL/SE/LT onboarding/trading; KuCoin's FMA Austria CASP is under an active commencement-of-business ban since 2026-02-18; Bitget/BingX applications pending; MEXC/BloFin/Phemex have no authorization) — so never recommend, price, or link them for EEA residency; the EEA-usable venue set is OKX (MFSA Malta), Gate (MFSA Malta), Bybit (FMA Austria), Kraken (CBI Ireland), Coinbase (CSSF Luxembourg) and Bitstamp (CSSF Luxembourg) for SPOT, and ONLY OKX (X-Perps), Kraken and Bitstamp for PERPETUALS — Bybit/Gate perps return PRODUCT_BLOCKED_IN_COUNTRY EEA-wide because ESMA treats perps as CFDs requiring separate MiFID II investment-firm authorization (both applications still pending/unfiled as of 2026-09); Hyperliquid is the sole deliberate exception — non-custodial perp DEX with no frontend geo-block for EEA users, retained in results but always flag the regulatory gray-zone/self-custody risk; these negative region gates narrow EEA results ONLY and must never change recommendations for non-EEA residency (US/GB/AU/BR/JP/SG/HK/...); trigger phrases like '欧盟能用的交易所 / EU licensed exchange / MiCA 合规 / EEA residents / CASP' must route through country-filtered tools with the user's actual EEA country code; v0.42 adds Bitvavo as the 15th venue — the largest home-grown euro spot exchange (Amsterdam, founded 2018, ~4M+ users, roughly half of global EUR-denominated spot volume; AFM MiCA CASP registration #41000010 with EEA passporting) — modeled with a NEW venue-level POSITIVE service-area gate (data field region_allowed): Bitvavo may serve ONLY residents of the 30 EEA states, and for every other residency (US/GB/CH/JP/SG/AU/BR/CN/... including countries routed via the default key) it is VENUE-BLOCKED (COUNTRY_BLOCKED) for every product; a whitelist hit authorizes the venue even where a stale per-country allowed enum disagrees; Bitvavo is SPOT-ONLY (no modeled perpetuals — EEA futures stacks stay OKX/Kraken/Bitstamp/Hyperliquid and a futures persona puts Bitvavo in unsupported_product): a nine-rung single-track 30-day EUR-volume PRO schedule, 0.15%/0.25% entry stepping down to 0.00%/0.02% above €25M (no token and no assets track; the Basic consumer interface's embedded spread is not modeled), the tightest EU EUR-book spread in the model at 1.0 bps full / 0.5 bps crossing (Kaiko May 2026 measured 0.981 bps, best of any European venue), FREE SEPA/SEPA Instant deposits AND withdrawals in EUR (iDEAL/Bancontact ride SEPA; €25k/day cash-out cap) plus a ~1% EU-region card DEPOSIT with NO card cash-out leg, and a dynamic BTC-only on-chain withdrawal modeled at 0.00005 BTC (no Lightning; USDT/USDC/ETH/alts not modeled and surfaced as unsupported); account-fee tier lookup is covered for spot; the separate Bitvavo UK and Swiss entities are deliberately not modeled, so GB/CH stay outside the whitelist; trigger phrases like 'bitvavo / Bitvavo / 荷兰交易所 / 欧洲本土交易所 / 荷兰买币 / EU exchange with free SEPA / iDEAL买币 / AFM CASP / 欧元现货所' must route through country-filtered tools with the user's EEA country code; v0.43 adds Finst as the 16th venue — an Amsterdam SMART-ORDER-ROUTING BROKERAGE rather than an order-book venue (founded 2022 by an ex-DEGIRO team; AFM MiCA CASP #41000015 granted 2025-07, EEA passport, ~30 countries/110k+ users): the same venue-level region_allowed gate as Bitvavo applies — Finst serves ONLY the 30 EEA states and is VENUE-BLOCKED (COUNTRY_BLOCKED) for every other residency (the EEA spot stack becomes 9 venues and Finst vanishes from every non-EEA result, including default-key countries); it is SPOT-ONLY with a FLAT 0.15% fee on every buy/sell/swap/auto-invest — no maker/taker split, no volume ladder, no minimum and no spread markup, with liquidity aggregated externally by SOR (modeled as one volume-independent rung plus a 1.0 bps full / 0.5 bps crossing cohort spread proxy) — so a futures persona sees Finst as unsupported_product inside the EEA and blocked outside; fiat rails are FREE SEPA/SEPA Instant/iDEAL/Bancontact for BOTH deposits and withdrawals in EUR ONLY — NO card rail (explicit card queries return available:false), NO PayPal, no USD/GBP; crypto withdrawals are dynamic network fee at cost PLUS a flat €2.50 third-party charge per withdrawal — the schema has no surcharge field, so BTC is modeled ALL-IN at 0.000085 BTC (≈$6.57 at the dated snapshot; the route note discloses both components) while the other 400+ markets are surfaced as unsupported; there is no referral program and NO public trading API (ccxt ships no finst class), so get_account_fee_tier returns ACCOUNT_FEES_UNSUPPORTED for Finst and live account coverage stays 13/16; trigger phrases like 'finst / Finst / 荷兰券商 / 阿姆斯特丹券商 / 0.15%统一费率 / 智能订单路由 / SOR broker / free SEPA broker / no card crypto EU' must route through country-filtered tools with the user's EEA country code; v0.44 adds Bitpanda as the 17th venue — the first SPREAD-MODEL BROKERAGE in the server (Vienna, founded 2014, 7.4M+ users; BaFin MiCA CASP authorization 2025-01-27 with EEA30 passporting plus the Austrian FMA license, and UK FCA-registered entity Bitpanda Broker UK Ltd): unlike order-book venues its consumer app quotes an ALL-IN price with the fee EMBEDDED as a markup and zero separate commission, modeled with pricing_model=spread (no maker/taker split, no volume ladder) — 1.49% per side is the headline for most assets, 0.99% per side for BTC and stablecoin pairs via pair-level overrides, 2.49% per side for sub-€100M small caps (the modeled spot rung is 1.49%; the 1.99% crypto-index band and the consumer app's 10x margin are not modeled; futures unsupported); because the embedded markup IS the spread cost, the bundled typical-spread baseline is pinned to 0 bps for Bitpanda so the two are never double-counted, and an execution_quality evidence block discloses the REAL cost — advertised 2.98% round trip vs TUM's real-money €100 round-trip measurement of 6.23% (4.25 percentage points of hidden markup, Oct-Nov 2025, independently replicated by the Frankfurt School of Finance in 2026-03 with 432 round trips across 9 platforms) — making the hidden embedded spread the single largest measured European retail cost gap, exactly the failure mode this model now makes visible; Bitpanda serves ONLY the 30 EEA states plus Great Britain (region_allowed EEA+GB, GB modeled as a single-member region key) and is VENUE-BLOCKED (COUNTRY_BLOCKED) for US/CA/CN/CH and every other residency — the EEA spot stack becomes 10 venues, and a futures persona puts Bitpanda in unsupported_product (Bitpanda Fusion is a SEPARATE pro exchange with 0.02-0.25% aggregated external-liquidity pricing and is deliberately NOT modeled, disclosed via exchange_notes, as are stocks/metals/ETFs); ALL consumer-app fiat rails have been FREE since 2026 — SEPA/SEPA Instant, Visa/Mastercard cards (DEPOSIT-ONLY, no card cash-out leg), PayPal and Apple/Google Pay in EUR, plus FPS and cards in GBP — with NO USD route at all (USD fiat queries retain the row with available:false rather than dropping it); crypto withdrawals pass the dynamic network fee through with no markup, modeled at BTC 0.00000598 BTC (~$0.46) and ETH 0.0006 ETH (~$1.51) at the dated snapshot; there is no referral link and NO public trading API (ccxt ships no bitpanda class), so get_account_fee_tier returns ACCOUNT_FEES_UNSUPPORTED and live account coverage stays 13/17; trigger phrases like 'bitpanda / Bitpanda / 奥地利券商 / 维也纳券商 / Vienna broker / 点差券商 / spread broker / 隐藏点差 / hidden spread / hidden markup / 0.99% / 1.49% / 内嵌加价 / embedded premium / BaFin CASP / FMA牌照' must route through country-filtered tools with the user's EEA country code or GB; v0.45 adds BISON as the 18th venue — the second SPREAD-MODEL BROKERAGE (Boerse Stuttgart Group, Stuttgart, launched 2019, 1M+ active users, 56 cryptocurrencies; EUWAX AG quotes an all-in price AS PRINCIPAL for roughly 10 seconds with no order book; Boerse Stuttgart Digital Custody, formerly blocknox, held the FIRST BaFin MiCA crypto custody/transfer license from 2025-01-17, passported to 29 states, and EUWAX AG's crypto exchange service has been MiCA-authorized since 2025-04-01): like Bitpanda the consumer app quotes an ALL-IN price modeled with pricing_model=spread (no maker/taker split, no volume ladder) — 1.25% per side for BTC and ETH via pair-level overrides, 1.75% per side for every other cryptocurrency (round trip about 2.5% vs 3.5%, floating with market conditions and ticket size), making it materially cheaper than Bitpanda's headline 1.49%; the bundled typical-spread baseline is pinned to 0 bps so spread is never double-counted, and an execution_quality evidence block shows the REAL alignment — advertised 2.5% round trip vs TUM's real-money €100 round-trip measurement of 2.58%, only about 0.08 percentage points undisclosed (Oct-Nov 2025, six MiCA-licensed platforms) — by far the closest published-vs-measured of the six platforms tested (next best Bitvavo; Bitpanda 6.23%, Coinbase 7.49%), i.e. the European transparency benchmark rather than a hidden-markup story; BISON serves the 30 EEA states AND Switzerland (region_allowed EEA+CH, CH modeled as a NEW single-member region key; DE/AT/CH are actively marketed while other EEA residents are served passively under freedoms) and is VENUE-BLOCKED (COUNTRY_BLOCKED) for Great Britain — the exact complementary gap to Bitpanda (EEA+GB, not CH) — plus US/CA/JP/SG/AU/BR/CN/KR and every other residency; the EEA spot stack becomes 11 venues, the CH stack 15, BISON never appears in GB/US/JP results, and a futures persona sees unsupported_product (no exchange-hosted futures or margin at all); crypto withdrawals are officially FREE with NO network-fee line — on-chain costs are absorbed by EUWAX/the group (unlike Bitpanda's dynamic pass-through) — modeled at BTC 0 and ETH 0, which makes BISON the globally cheapest modeled withdrawal for both assets (minimum 0.001 BTC, no Lightning and no Taproot bc1p; Ethereum mainnet only, minimum 0.01 ETH, no Arbitrum/Base/Optimism/Polygon L2 payouts); fiat is EUR ONLY — SEPA/SEPA Instant deposits AND cash-outs FREE in both directions including Swiss users funding in EUR, while instant card/Apple Pay/Google Pay deposits cost 2.49% (Solaris SE/Deutsche Bank partner fee, DEPOSIT-ONLY with no card cash-out; no GBP/USD/CHF rail, and USD queries keep the unavailable row rather than dropping it); the €1.99 German stocks/ETFs order fee and the 27% staking reward commission are not crypto trading fees and are not modeled; the invite-a-friend program carries no affiliate URL (NO_REFERRAL_LINK) and there is NO public trading API (ccxt 4.5.78 ships no bison/euwax class), so get_account_fee_tier returns ACCOUNT_FEES_UNSUPPORTED and live account coverage stays 13/18; trigger phrases like 'bison / BISON / Bison / 斯图加特 / 斯图加特交易所 / Stuttgart / Boerse Stuttgart / Börse Stuttgart / EUWAX / 德国券商 / 德国加密App / 1.25% / 1.75% / 免费提币 / 德国免费提币 / MiCAR首个牌照 / 瑞士买币 / Switzerland crypto app' must route through country-filtered tools with the user's EEA country code or CH; v0.46 adds get_stablecoin_access (18th tool) — MiCA stablecoin REGIONAL ACCESS intelligence: Tether never applied for MiCA EMT authorization (its ~60%-EU-bank-deposit reserve requirement is incompatible with the US-T-bill reserve model), and after the CASP transition cliff 2026-07-01 (ESMA75-113276571-1679, no extension) USDT venue trading is UNAVAILABLE across the entire EEA (all 30 states) — Coinbase delisted 2024-12, Crypto.com 2025-01, Binance/Kraken/OKX/Gate/Bitstamp/Bitpanda/Bitvavo and the rest through 2025-03, Revolut ended buying 2026-07-06 and auto-converts residuals 2026-08-31; the restriction binds VENUES, not people or the asset — personal holding, peer/on-chain transfer and withdrawal to self-custody stay legal (most delisted venues keep custody + on-chain withdrawal + Convert; Binance committed withdrawals continue), DEXs sit outside the perimeter, and MEXC/Bitget/KuCoin/BingX/Phemex/BloFin are venue_blocked anyway (no CASP/FMA ban); MiCA-authorized alternatives modeled: USDC and EURC (Circle, France EMI, first authorized 2024-07), EURI (Banking Circle), EURCV (SocGen FORGE), USDQ/EURQ (Quantoz; Bybit EU quote coins); venue facts include BISON never listing USDC OR USDT (EURCV only), Finst EUR/USDC only, Hyperliquid USDC only, Bybit EU never having USDT (USDQ/EURQ instead); the tool returns per-asset issuer/MiCA status, the region restriction (applies + effective + custody/self-custody rules), per-venue status (delisted/never_offered/venue_blocked with since dates, scope eea/global, and whether the venue itself is available in the country), compliant alternatives and localized advice; CH/GB are deliberately OUTSIDE the EEA region (their USDT access is governed globally, not by MiCA); the same warning is auto-injected into compare_exchange_fees/calculate_savings/compare_total_cost/calculate_annual_cost/recommend_exchange rows and results whenever a USDT-quoted pair meets an EEA country, into get_withdrawal_fees (withdrawal context — on-chain rights preserved), get_execution_cost and analyze_persona (5 of 7 personas habitually withdraw USDT), with code STABLECOIN_UNAVAILABLE_IN_REGION; trigger phrases like 'USDT 欧洲还能交易吗 / USDT EEA / USDT delisting / Tether MiCA / USDT下架 / 稳定币下架 / stablecoin access / MiCA stablecoin / EURC / USDC Europe / 合规稳定币 / USDT 提币到自托管 / USDT self-custody / EMT authorized / Revolut USDT' must route here or to country-filtered tools with the user's actual country code; v0.47 adds compare_interface_costs (19th tool) — the SAME VENUE, TWO PRICE TAGS model: most venues run a cheap PRO order-book interface (the maker/taker ladders priced everywhere in this server) AND an expensive consumer app whose spread is EMBEDDED in the quoted price and invisible on any fee schedule — evidenced by the TUM real-money €100 round-trip study (2025-10..11, six MiCA-licensed EU platforms, replicated by Frankfurt School 2026-03 with 432 round-trips): retail round-trips span 13x — Bitvavo Basic 0.58% (routes into the PRO book at published fees, only 0.08 pp hidden: the transparency benchmark), Bison 2.58%, Kraken app 5.81% (Instant Buy 1% / custom orders 1.5% PLUS a retained spread = 3.81 pp hidden; app volume earns NO Kraken Pro tier credit; Kraken+ $4.99/mo waives app fees on $10k/mo but NOT spreads), Bitpanda 6.23% and Coinbase Simple 7.49% (worst: ~0.5-1% embedded spread + flat $0.99-$2.99 fees that dominate small DCA buys + 1.49% above $200, and a simple LIMIT order still adds a 1% execution fee; Coinbase One does NOT waive it) — hidden markups of 3.8-4.5 pp mean published fees capture less than half of the real cost on broker-model platforms; the tool returns per venue the consumer product, its modeled one-way all-in cost, the measured round-trip, the PRO base maker/taker, the gap in pp, and with monthly_volume_usd the annualized excess of staying on the consumer app (Coinbase at $1k/mo ≈ $168/yr, Kraken ≈ $84/yr); switching to the venue's Pro/Advanced interface (or API) on the SAME account is free and is the single largest cost lever this server surfaces; the gap is also auto-injected as consumer_interface hints into compare_exchange_fees / calculate_savings / compare_total_cost / recommend_exchange rows and as a CONSUMER_INTERFACE_MORE_EXPENSIVE warning on savings and recommendation results; trigger phrases like 'Kraken app 手续费 / Instant Buy 多少钱 / Coinbase Simple / 简单交易手续费 / App 买币为什么这么贵 / 同一个交易所两个价格 / 两套价格 / 界面成本 / consumer vs pro / hidden spread app / 隐藏点差 / 隐藏加价 / two price tags / interface cost / TUM study / app 买币贵' must route here; (Binance spot BNB AND gate via tokenBalance; Gate volume OR GT holdings; KuCoin volume OR KCS holdings; OKX/Bybit/Bitget volume OR account assets via accountAssetsUsd; Kraken unified Tier/Pro levels via spot volume OR futures volume OR assets-on-platform (AOP) via accountAssetsUsd), KuCoin spot Class A/B/C symbol groups (ladder quotes Class A; Class B = 2x, Class C = 3x, surfaced via spot_class_note), Kraken futures maker rebates from Tier 11, pair-level fee promos (MEXC 0-fee spot, Binance FDUSD zero-maker, Bitget USDC/USDT) via the pair parameter, token discounts (BNB/OKB/GT/MX/BGB/KCS/HYPE staking ladder; Kraken and Coinbase have no native token), optional referral links, savings calculations, total cost analysis (trading fees + funding rates + withdrawal fees), annualized all-in cost with next-tier upgrade savings (calculate_annual_cost), and personalized exchange recommendations (recommend_exchange). Supports maker/taker weighted rates and multi-currency display (USD/EUR/JPY/CNH/GBP). get_funding_rates returns bundled long-run average funding rates or real-time current rates (fundingMode=live, perp pair default BTC/USDT); the savings/total-cost/recommend/annual-cost tools also accept fundingMode=live plus fundingPair to price positions with the current funding rate, and tag every funding figure with funding_source (live|bundled) and funding_rate_ts; per-exchange live fetch failures transparently fall back to bundled values. Results include data_as_of freshness stamps, tier qualification warnings, and stale-data warnings; get_data_sources returns full provenance. Always requires a country code for compliance filtering. Trigger keywords: crypto exchange fees, fee comparison, annual cost, yearly cost, referral link, rebate, discount registration, funding rate, 资金费率, 资金费, funding, 交易所手续费, 年化成本, 一年手续费, 推荐链接, 返佣, 注册优惠, spread, bid-ask, 点差, 买卖价差, slippage, 滑点, 冲击成本, 订单簿, order book, 深度, 执行成本, execution cost, market impact, 大单成本, 吃单成本, fiat deposit, 入金, 充值, 出金, 提现到银行卡, bank transfer, SEPA, ACH, wire, SWIFT, FPS, PIX, credit card fee, 刷卡买币, 银行卡手续费, 法币, cash out, on-ramp, off-ramp, 电汇, withdrawal fee, 提币, 提币手续费, 转出手续费, 网络费, 链上转账费, network fee, move to wallet, 转到钱包, TRC-20, ERC-20, BEP20, Arbitrum, Optimism, Base, Solana network, Polygon network, 哪个链便宜, 提币网络, coinbase, Coinbase, Advanced Trade, hyperliquid, Hyperliquid, HYPE, bingx, BingX, Elite VIP, DEX, 去中心化交易所, 链上交易, persona, trader profile, trader type, which exchange for me, 交易员画像, 用户画像, 画像, 我这种情况, 像我这样, 新手适合哪个交易所, 散户, 定投, 囤币, HODL, 波段, 刷单, 高频交易, 机构费率, 适合我的交易所, 场景推荐, 一年总花费, all-in cost, trader persona, token discount, BNB discount, GT discount, KCS discount, BGB discount, MX discount, HYPE staking, platform token, 平台币折扣, 持有BNB划算吗, GT值不值得持有, 平台币回本, fee payback, 折扣回本周期, break-even token, 持币折扣, 用平台币抵手续费, phemex, Phemex, PT token, 最低maker费率, 0.01% maker, 摩根士丹利交易所, blofin, BloFin, BuildLight, blofin手续费, BloFin合规, 无KYC合约交易所, 无平台币交易所, MiCA封锁交易所, 开曼交易所, bitstamp, Bitstamp, 卢森堡交易所, Robinhood交易所, MiCA合规交易所, 欧盟合规交易所, 欧盟能用的交易所, 欧盟居民能用的交易所, 欧盟交易所推荐, CASP牌照, MiFID牌照, MiCA过渡期结束, EEA合规, 强监管交易所, regulated exchange, EU licensed exchange, EU perps, 欧盟永续, regulated perpetuals, SEPA免费入金, BitLicense, NYDFS, 最合规交易所, product blocked, PRODUCT_BLOCKED, 某国不能交易永续, 现货能开合约不能, EEA居民交易所, bitvavo, Bitvavo, 荷兰交易所, 欧洲本土交易所, 荷兰买币, iDEAL买币, 欧元现货所, AFM注册交易所, EU exchange with free SEPA, finst, Finst, 荷兰券商, 阿姆斯特丹券商, Finst券商, 0.15%统一费率, 统一费率券商, 智能订单路由, SOR券商, SOR broker, 免费SEPA券商, free SEPA broker, 无信用卡入金欧洲, no card crypto EU, bitpanda, Bitpanda, 奥地利券商, 维也纳券商, Vienna broker, 点差券商, spread broker, 隐藏点差, hidden spread, hidden markup, 0.99%, 1.49%, 内嵌加价, embedded premium, BaFin CASP, FMA牌照, bison, BISON, Bison, 斯图加特, 斯图加特交易所, Stuttgart, Boerse Stuttgart, Börse Stuttgart, EUWAX, 德国券商, 德国加密App, 1.25%, 1.75%, 免费提币, 德国免费提币, MiCAR首个牌照, 瑞士买币, Switzerland crypto app, my actual fee, account fee tier, real VIP rate, API key fee, read-only key, 我的实际费率, 账户真实费率, 真实VIP档位, API查手续费, 只读密钥, 只读API, 账户费率查询, authenticated fee, wallet address fee, Hyperliquid地址费率, token discount in persona, platform token recommendation, 持有平台币推荐, 平台币回本推荐, 持有代币划算吗, holding token worth it, full cost stack, all-in with fiat, total cost including deposit, annual cost including withdrawal to bank, fiat legs in comparison, 入金费计入总成本, 出金费计入年化, 年化含入金出金, 一年总花费含法币, 完整成本对比, 刷卡成本年化, SEPA年费对比, deposits per year, cashouts per year, 定投入金成本, 每月入金手续费, recommend with deposit fee, 推荐考虑入金费, 刷卡买币推荐哪个交易所, 定投选哪个交易所, 入金免费的交易所, no deposit fee exchange, recommendation including fiat rails, 推荐含法币通道, DCA exchange recommendation, 小额买币交易所推荐, compare all personas, all trader types at once, 全部画像对比, 所有用户类型对比, 什么人用什么交易所, 决策矩阵, decision matrix, exchange for every trader type, 最全能的交易所, 适合最多人的交易所, most versatile exchange, persona matrix, 画像矩阵, 选型总览, 交易所选型, beginner vs institution, 新手和机构分别用什么, one comparison for all traders, what-if, volume sweep, fee sensitivity, tier crossing, next VIP tier, volume curve, cost curve across volume, 升档, 升级VIP, 刷量升档, 再交易多少, 还差多少成交量, 档位跳变, 成交量曲线, 月交易量费率, 费率随成交量, 如果交易量增长, 不同成交量对比, 各交易所升档门槛, VIP门槛对比, same profile across countries, country comparison, moving countries, residency fees, which country cheapest, blocked in my country, 跨国对比, 不同国家手续费, 搬家, 换居住地, 哪个国家交易最便宜, 各国有什么交易所, 国家差异, 居住地限制, 哪些所在我国不能用, country availability matrix, markdown table, export csv, 贴表格, 导出表格, 表格形式, CSV, Excel, 可粘贴表格, matrix as table, format markdown, USDT, Tether, usdt, 泰达币, USDT下架, USDT欧洲, USDT欧盟, USDT还能买吗, USDT交易, 稳定币, stablecoin, stablecoins, MiCA稳定币, EMT, e-money token, EURC, EURI, EURCV, USDQ, USDC Europe, 合规稳定币, delisting, delisted, 下架稳定币, Revolut USDT, USDT自托管, self-custody USDT, USDT withdrawal Europe, stablecoin access, regional stablecoin, interface cost, interface costs, consumer interface, consumer app, two price tags, Instant Buy, Coinbase Simple, simple trade, Kraken app, app 买币贵, App买币手续费, 买币界面, 同一个交易所两个价格, TUM study, consumer vs pro.",
  },
);

function wrapResult(result: unknown) {
  if (isToolError(result)) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: true,
    };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

function logCall(toolName: string, args: Record<string, unknown>) {
  // v0.39: apiKey/secret/password/walletAddress values never reach logs.
  const safe = redactSecrets(args);
  console.error(`[audit] ${new Date().toISOString()} tool=${toolName} args=${JSON.stringify(safe)}`);
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
};

// v0.15: shared funding-rate parameters for the four cost tools.
const fundingModeParam = z
  .enum(["bundled", "live"])
  .optional()
  .describe(
    "资金费率来源：bundled=内置长期均值(默认，离线稳定)；live=实时拉取该合约当前资金费率(逐所独立请求，单所失败自动回退内置值；结果含 funding_source/funding_rate_ts/funding_pair 溯源字段)",
  );
const fundingPairParam = z
  .string()
  .optional()
  .describe("资金费率合约对，默认 BTC/USDT 永续；仅 fundingMode=live 时生效，如 ETH/USDT、SOL-USDT");

// v0.15: resolve live funding overrides for the cost tools; undefined in bundled mode.
async function resolveFundingOverrides(
  fundingMode: "bundled" | "live" | undefined,
  fundingPair: string | undefined,
  exchanges: string[],
): Promise<FundingOverrides | undefined> {
  if (fundingMode !== "live") return undefined;
  const live = await fetchFundingRatesLive(exchanges, { pair: fundingPair });
  return live.rates;
}

// v0.16: shared execution-cost parameters for the four cost tools.
const spreadModeParam = z
  .enum(["bundled", "live"])
  .optional()
  .describe(
    "执行成本来源：bundled=内置典型点差基准(默认，半价差、零滑点，离线秒回)；live=实时拉取订单簿前100档逐档行走，算出真实半价差+市场冲击滑点(逐所独立请求，单所失败自动回退内置基准并记入 failures，深度不足保留实测值并给 warning)。需配合 tradeSizeUsd 才会计入",
  );
const tradeSizeUsdParam = z
  .number()
  .positive()
  .optional()
  .describe(
    "单笔吃单市价单规模(USD)，默认不计执行成本。传入后总成本/年化/推荐会加上单边点差穿越成本(半价差)；spreadMode=live 时再加上该规模下的订单簿滑点，如 10000=$1万、100000=$10万",
  );
const spreadPairParam = z
  .string()
  .optional()
  .describe(
    "执行成本测算交易对，默认沿用 pair，再默认 BTC/USDT。live 模式现货自动解析现货市场(如 KuCoin 用 kucoin 而非 kucoinfutures)，如 ETH/USDT、SOL-USDT",
  );
const sideParam = z
  .enum(["buy", "sell"])
  .optional()
  .describe("吃单方向，默认 buy；live 模式下 buy 行走卖盘 asks，sell 行走买盘 bids");

// v0.30: shared output-language parameter for the narrative-bearing tools.
const languageParam = z
  .enum(["en", "zh"])
  .optional()
  .describe(
    "输出语言：en=英文(默认)，zh=中文。仅影响 advice/warnings/tradeoffs/reasons 等叙述性文字，数值、字段名与错误码不受影响",
  );

// v0.36: matrix table rendering for the three matrix tools.
const formatParam = z
  .enum(["json", "markdown", "csv", "both"])
  .optional()
  .describe(
    "矩阵渲染格式：json=仅结构化 JSON(默认，行为不变)；markdown=在结果中额外附 rendered.markdown 可直接粘贴的表格；csv=附 rendered.csv（CRLF、RFC4180 转义，可导入 Excel）；both=两者都附",
  );

// v0.16: resolve live execution overrides for the cost tools; undefined unless live.
async function resolveSpreadOverrides(
  spreadMode: "bundled" | "live" | undefined,
  spreadPair: string | undefined,
  purpose: "spot" | "futures",
  exchanges: string[],
  side: "buy" | "sell" | undefined,
  tradeSizeUsd: number | undefined,
): Promise<SpreadOverrides | undefined> {
  if (spreadMode !== "live" || !tradeSizeUsd) return undefined;
  const live = await fetchExecutionCostLive(exchanges, {
    pair: spreadPair,
    purpose,
    side: side ?? "buy",
    tradeSizeUsd,
  });
  return live.costs;
}

// Tool 1: compare_exchange_fees
server.registerTool(
  "compare_exchange_fees",
  {
    description:
      "当用户询问加密货币交易所的手续费、费率比较、或哪个交易所交易成本最低时使用此工具。Use when the user asks about crypto exchange fees, fee comparison, or which exchange has the lowest trading cost. Supports spot and futures, with full VIP tier resolution based on monthly volume. Returns exchanges sorted by weighted effective fee rate, including referral discount and optional token discount (BNB/OKB/GT/MX/BGB/KCS). Requires country code for compliance filtering. Pass monthlyVolumeUsd for accurate VIP tier pricing; pass useToken=true if user holds the exchange's native token; pass makerShare (0-1) if the user trades mostly via limit orders.",
    inputSchema: {
      purpose: z.enum(["spot", "futures"]).describe("交易类型: spot=现货, futures=期货"),
      country: z.string().min(2).describe("ISO 3166-1 alpha-2 国家代码，如 CN, US, JP"),
      monthlyVolumeUsd: z.number().min(0).optional().describe("月交易量(USD)，用于匹配 VIP 阶梯"),
      useToken: z.boolean().optional().describe("是否使用平台币(BNB/OKB/GT/KCS 等)折扣"),
      makerShare: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("挂单(maker)成交占比 0-1，默认 0=纯吃单。限价交易者设 0.7-1 更准确"),
      tokenBalance: z
        .number()
        .min(0)
        .optional()
        .describe("持有的平台币数量(BNB / GT / KCS)。币安现货 VIP1+ 需交易量 AND BNB 持仓(如 VIP1 需 5 BNB，传 0 会降档)；Gate 按 30 日交易量 OR GT 持仓取高者；KuCoin 按 30 日交易量(现货/合约门槛分别计算) OR KCS 持仓取高者(如持 1,000 KCS 升 VIP1，10,000 升 VIP2，40,000 升 VIP5，KCS 只会升档不会降档)。不传则按交易量给档并提示持仓影响"),
      accountAssetsUsd: z
        .number()
        .min(0)
        .optional()
        .describe("账户总资产(USD)。OKX/Bybit/Bitget 按 30 日交易量 OR 账户资产取高者定 VIP 档(如 $100,000 资产即 VIP1，$500,000,000 达 VIP9 享负 maker 返佣)；Kraken 按平台资产 AOP 参与统一 Tier/Pro 定档($20,000 升 Tier3，$100 万升 Tier9，Tier1-2 无资产通道)。资产只会升档不会降档。不传则按交易量给档并提示资产升档路径"),
      pair: z
        .string()
        .optional()
        .describe("交易对，如 BTC/USDT、BTC/FDUSD、BTCUSDT 均可。命中币对级费率/0费促销时按促销价计费(输出 pricing_basis=pair 并附 pair_note)，未命中则按整所 VIP 档计费"),
      language: languageParam,
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("compare_exchange_fees", args);
    const result = compareExchangeFees(args.purpose, args.country, {
      monthlyVolumeUsd: args.monthlyVolumeUsd,
      useToken: args.useToken,
      makerShare: args.makerShare,
      tokenBalance: args.tokenBalance,
      accountAssetsUsd: args.accountAssetsUsd,
      pair: args.pair,
      language: args.language,
    });
    return wrapResult(result);
  },
);

// Tool 2: get_referral_link
server.registerTool(
  "get_referral_link",
  {
    description:
      "当用户要求获取某个加密货币交易所的优惠注册链接、推荐码或返佣链接时使用。Use when the user asks for a discount registration link, referral code, or rebate link for a specific crypto exchange. Returns the referral URL with the fee discount the user will receive. Supports Binance, OKX, Gate.io. Requires exchange name and country code.",
    inputSchema: {
      exchange: z.string().describe("交易所名称，如 binance, okx, gate"),
      country: z.string().min(2).describe("ISO 3166-1 alpha-2 国家代码"),
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("get_referral_link", args);
    const result = getReferralLink(args.exchange, args.country);
    return wrapResult(result);
  },
);

// Tool 3: calculate_savings
server.registerTool(
  "calculate_savings",
  {
    description:
      "当用户询问通过推荐链接注册能节省多少手续费时使用。Use when the user asks how much they can save on fees by registering via a referral link. Computes savings based on monthly trading volume, trade type, VIP tier resolution, optional token discount (BNB/OKB/GT/MX/BGB/KCS), and optional funding cost for futures positions held over time. Returns the savings amount and the referral link to register.",
    inputSchema: {
      exchange: z.string().describe("交易所名称"),
      volume: z.number().positive().describe("月交易量，USDT"),
      type: z.enum(["spot", "futures"]).describe("交易类型"),
      country: z.string().min(2).describe("ISO 3166-1 alpha-2 国家代码"),
      useToken: z.boolean().optional().describe("是否使用平台币折扣"),
      holdingHours: z.number().min(0).optional().describe("期货持仓时长(小时)，用于计算资金费率"),
      makerShare: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("挂单(maker)成交占比 0-1，默认 0=纯吃单"),
      currency: z
        .enum(["USD", "EUR", "JPY", "CNH", "GBP"])
        .optional()
        .describe("显示币种，默认 USD；汇率仅用于展示"),
      tokenBalance: z
        .number()
        .min(0)
        .optional()
        .describe("持有的平台币数量(BNB / GT / KCS)。币安现货为 AND 门槛(不足降档)；Gate OR GT 持仓、KuCoin OR KCS 持仓均可升档(不降档)；同时用于平台币持仓折扣"),
      accountAssetsUsd: z
        .number()
        .min(0)
        .optional()
        .describe("账户总资产(USD)，适用于 OKX/Bybit/Bitget(30 日交易量 OR 账户资产取高定 VIP 档)与 Kraken(平台资产 AOP：Tier3 需 $20,000、Tier9 需 $100 万、Pro5 需 $1 亿；资产只升档不降档)，如 $100,000 即 OKX VIP1 / Kraken Tier 9"),
      pair: z
        .string()
        .optional()
        .describe("交易对，如 BTC/USDT、BTC/FDUSD、BTCUSDT 均可。命中币对级费率/0费促销时按促销价计费，未命中则按整所 VIP 档计费"),
      fundingMode: fundingModeParam,
      fundingPair: fundingPairParam,
      tradeSizeUsd: tradeSizeUsdParam,
      spreadMode: spreadModeParam,
      spreadPair: spreadPairParam,
      side: sideParam,
      language: languageParam,
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("calculate_savings", args);
    const fundingRates = await resolveFundingOverrides(
      args.fundingMode,
      args.fundingPair,
      [args.exchange.toLowerCase()],
    );
    const spreadRates = await resolveSpreadOverrides(
      args.spreadMode,
      args.spreadPair ?? args.pair,
      args.type,
      [args.exchange.toLowerCase()],
      args.side,
      args.tradeSizeUsd,
    );
    const result = calculateSavings(args.exchange, args.volume, args.type, args.country, {
      useToken: args.useToken,
      holdingHours: args.holdingHours,
      makerShare: args.makerShare,
      currency: args.currency,
      tokenBalance: args.tokenBalance,
      accountAssetsUsd: args.accountAssetsUsd,
      pair: args.pair,
      fundingRates,
      fundingPair: args.fundingPair,
      tradeSizeUsd: args.tradeSizeUsd,
      spreadRates,
      spreadPair: args.spreadPair,
      language: args.language,
    });
    return wrapResult(result);
  },
);

// Tool 4: compare_total_cost
server.registerTool(
  "compare_total_cost",
  {
    description:
      "当用户要求比较不同交易所的真实总成本（交易手续费+资金费率+提现费+点差，v0.26 起可选年化法币入金/出金费）时使用。Use when the user asks for a total cost comparison across exchanges including trading fees, funding rates for futures positions, withdrawal fees, spread, and (v0.26) optional annualized direct fiat deposit/cash-out fees. This is the most comprehensive comparison tool. Requires purpose, country, and monthly volume. Optionally pass holdingHours for funding cost, useToken for token discount, withdrawal details, and fiatDepositAmountUsd/fiatDepositsPerYear (+cashout equivalents) to fold bank/card on/off-ramping into the ranked total.",
    inputSchema: {
      purpose: z.enum(["spot", "futures"]).describe("交易类型"),
      country: z.string().min(2).describe("ISO 3166-1 alpha-2 国家代码"),
      volume: z.number().positive().describe("月交易量，USDT"),
      holdingHours: z.number().min(0).optional().describe("持仓时长(小时)，用于资金费率"),
      useToken: z.boolean().optional().describe("是否使用平台币折扣"),
      withdrawalAsset: z.string().optional().describe("提现资产，如 BTC, ETH, USDT"),
      withdrawalNetwork: z.string().optional().describe("提现网络，如 TRC-20, ERC-20, Arbitrum"),
      makerShare: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("挂单(maker)成交占比 0-1，默认 0=纯吃单"),
      currency: z
        .enum(["USD", "EUR", "JPY", "CNH", "GBP"])
        .optional()
        .describe("显示币种，默认 USD；汇率仅用于展示"),
      tokenBalance: z
        .number()
        .min(0)
        .optional()
        .describe("持有的平台币数量(BNB / GT / KCS)。币安现货为 AND 门槛(不足降档)；Gate OR GT 持仓、KuCoin OR KCS 持仓均可升档(不降档)；同时用于平台币持仓折扣"),
      accountAssetsUsd: z
        .number()
        .min(0)
        .optional()
        .describe("账户总资产(USD)，适用于 OKX/Bybit/Bitget(30 日交易量 OR 账户资产取高定 VIP 档)与 Kraken(平台资产 AOP：Tier3 需 $20,000、Tier9 需 $100 万、Pro5 需 $1 亿；资产只升档不降档)，如 $100,000 即 OKX VIP1 / Kraken Tier 9"),
      pair: z
        .string()
        .optional()
        .describe("交易对，如 BTC/USDT、BTC/FDUSD、BTCUSDT 均可。命中币对级费率/0费促销时按促销价计费，未命中则按整所 VIP 档计费"),
      fundingMode: fundingModeParam,
      fundingPair: fundingPairParam,
      tradeSizeUsd: tradeSizeUsdParam,
      spreadMode: spreadModeParam,
      spreadPair: spreadPairParam,
      side: sideParam,
      fiatCurrency: z
        .enum(["USD", "EUR", "GBP", "BRL"])
        .optional()
        .describe("法币入金/出金币种，默认 USD（v0.26：可把年化法币通道费并入总成本）"),
      fiatDepositAmountUsd: z
        .number()
        .positive()
        .optional()
        .describe("单次法币入金金额(USD)；与 fiatDepositsPerYear 同时传入时，按该所最便宜直连通道计入年化入金费"),
      fiatDepositsPerYear: z
        .number()
        .min(0)
        .optional()
        .describe("每年法币入金次数；年化入金费=单次最便宜通道费×次数"),
      fiatCashoutAmountUsd: z
        .number()
        .positive()
        .optional()
        .describe("单次法币出金(提现回银行卡)金额(USD)；与 fiatCashoutsPerYear 同时传入时计入年化出金费"),
      fiatCashoutsPerYear: z
        .number()
        .min(0)
        .optional()
        .describe("每年法币出金次数；年化出金费=单次最便宜通道费×次数"),
      fiatMethod: z
        .enum(["card", "ach", "sepa", "fps", "wire", "swift", "pix"])
        .optional()
        .describe("只按指定法币渠道计价(默认取最便宜)：card/ach/sepa/fps/wire/swift/pix"),
      language: languageParam,
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("compare_total_cost", args);
    const allowed = listSupportedExchanges().filter((e) => isExchangeAllowed(e, args.country));
    const fundingRates = await resolveFundingOverrides(args.fundingMode, args.fundingPair, allowed);
    const spreadRates = await resolveSpreadOverrides(
      args.spreadMode,
      args.spreadPair ?? args.pair,
      args.purpose,
      allowed,
      args.side,
      args.tradeSizeUsd,
    );
    const result = compareTotalCost(args.purpose, args.country, args.volume, {
      holdingHours: args.holdingHours,
      useToken: args.useToken,
      withdrawalAsset: args.withdrawalAsset,
      withdrawalNetwork: args.withdrawalNetwork,
      makerShare: args.makerShare,
      currency: args.currency,
      tokenBalance: args.tokenBalance,
      accountAssetsUsd: args.accountAssetsUsd,
      pair: args.pair,
      fundingRates,
      fundingPair: args.fundingPair,
      tradeSizeUsd: args.tradeSizeUsd,
      spreadRates,
      spreadPair: args.spreadPair,
      fiatCurrency: args.fiatCurrency,
      fiatDepositAmountUsd: args.fiatDepositAmountUsd,
      fiatDepositsPerYear: args.fiatDepositsPerYear,
      fiatCashoutAmountUsd: args.fiatCashoutAmountUsd,
      fiatCashoutsPerYear: args.fiatCashoutsPerYear,
      fiatMethod: args.fiatMethod,
      language: args.language,
    });
    return wrapResult(result);
  },
);

// Tool 5: recommend_exchange
server.registerTool(
  "recommend_exchange",
  {
    description:
      "当用户不确定选哪个交易所、希望根据自身情况获得个性化推荐时使用。Use when the user wants a personalized exchange recommendation based on their trading volume, style, and holding habits. Scores available exchanges on weighted fees (maker/taker blend), token discounts, referral discounts, funding cost for futures, and (v0.27) the user's direct fiat deposit/cash-out habit — small monthly card/SEPA on-rampers get ranked on fiat rails too (the fiat weight grows 0.2→0.5 as venue-to-venue fiat-fee differences dominate trading-fee differences, and venues with no direct rail score zero on that leg rather than winning on an unpriced cost). Returns the best option with score, concrete reasons, tradeoffs, and actionable advice, plus ranked alternatives. Requires purpose, country, and volume.",
    inputSchema: {
      purpose: z.enum(["spot", "futures"]).describe("交易类型"),
      country: z.string().min(2).describe("ISO 3166-1 alpha-2 国家代码"),
      volume: z.number().positive().describe("月交易量，USDT"),
      makerShare: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("挂单(maker)成交占比 0-1，默认 0=纯吃单。限价交易者设 0.7-1"),
      useToken: z.boolean().optional().describe("是否持有并使用平台币(BNB/OKB/GT/MX/BGB/KCS)折扣"),
      holdingHours: z.number().min(0).optional().describe("期货平均持仓时长(小时)，用于资金费率评分"),
      currency: z
        .enum(["USD", "EUR", "JPY", "CNH", "GBP"])
        .optional()
        .describe("显示币种，默认 USD；汇率仅用于展示"),
      tokenBalance: z
        .number()
        .min(0)
        .optional()
        .describe("持有的平台币数量(BNB / GT / KCS)。币安现货 AND 门槛(不足降档)；Gate OR GT、KuCoin OR KCS 均可升档(不降档)；用于实际 VIP 档位与平台币持仓折扣，不传会提示持仓影响"),
      accountAssetsUsd: z
        .number()
        .min(0)
        .optional()
        .describe("账户总资产(USD)：OKX/Bybit/Bitget 按交易量 OR 账户资产取高定 VIP 档(如 $100,000 即 VIP1，$5 亿达 VIP9 负 maker)；Kraken 按 AOP 定档($20,000 升 Tier3)。不传会提示资产升档路径"),
      pair: z
        .string()
        .optional()
        .describe("交易对，如 BTC/USDT、BTC/FDUSD、BTCUSDT 均可。命中币对级费率/0费促销时按促销价计费，未命中则按整所 VIP 档计费"),
      fundingMode: fundingModeParam,
      fundingPair: fundingPairParam,
      tradeSizeUsd: tradeSizeUsdParam,
      spreadMode: spreadModeParam,
      spreadPair: spreadPairParam,
      side: sideParam,
      fiatCurrency: z
        .enum(["USD", "EUR", "GBP", "BRL"])
        .optional()
        .describe("法币入金/出金币种，默认 USD（v0.27：传入入金/出金习惯后，推荐评分会纳入法币通道成本，小额刷卡/定投用户尤其重要）"),
      fiatDepositAmountUsd: z
        .number()
        .positive()
        .optional()
        .describe("单次法币入金金额(USD)；与 fiatDepositsPerYear 同时传入时，推荐评分纳入年化入金通道费"),
      fiatDepositsPerYear: z
        .number()
        .min(0)
        .optional()
        .describe("每年法币入金次数，如月薪/定投 12；法币费在各所差异越大，评分权重越高(0.2-0.5)"),
      fiatCashoutAmountUsd: z
        .number()
        .positive()
        .optional()
        .describe("单次法币出金(提现回银行卡)金额(USD)；与 fiatCashoutsPerYear 同时传入时纳入评分"),
      fiatCashoutsPerYear: z
        .number()
        .min(0)
        .optional()
        .describe("每年法币出金次数；无直连通道的所该腿得 0 分，不会因成本未计而虚高"),
      fiatMethod: z
        .enum(["card", "ach", "sepa", "fps", "wire", "swift", "pix"])
        .optional()
        .describe("只按指定法币渠道评分(默认取最便宜)：card/ach/sepa/fps/wire/swift/pix"),
      language: languageParam,
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("recommend_exchange", args);
    const allowed = listSupportedExchanges().filter((e) => isExchangeAllowed(e, args.country));
    const fundingRates = await resolveFundingOverrides(args.fundingMode, args.fundingPair, allowed);
    const spreadRates = await resolveSpreadOverrides(
      args.spreadMode,
      args.spreadPair ?? args.pair,
      args.purpose,
      allowed,
      args.side,
      args.tradeSizeUsd,
    );
    const result = recommendExchange(args.purpose, args.country, args.volume, {
      makerShare: args.makerShare,
      useToken: args.useToken,
      holdingHours: args.holdingHours,
      currency: args.currency,
      tokenBalance: args.tokenBalance,
      accountAssetsUsd: args.accountAssetsUsd,
      pair: args.pair,
      fundingRates,
      fundingPair: args.fundingPair,
      tradeSizeUsd: args.tradeSizeUsd,
      spreadRates,
      spreadPair: args.spreadPair,
      fiatCurrency: args.fiatCurrency,
      fiatDepositAmountUsd: args.fiatDepositAmountUsd,
      fiatDepositsPerYear: args.fiatDepositsPerYear,
      fiatCashoutAmountUsd: args.fiatCashoutAmountUsd,
      fiatCashoutsPerYear: args.fiatCashoutsPerYear,
      fiatMethod: args.fiatMethod,
      language: args.language,
    });
    return wrapResult(result);
  },
);

// Tool 6: get_data_sources
server.registerTool(
  "get_data_sources",
  {
    description:
      "当用户质疑费率数据的来源、新鲜度或准确性时使用（例如：这个数据哪来的？费率多久更新一次？）。Use when the user asks where the fee data comes from, how fresh it is, or wants to verify accuracy. Returns per-file last-verified dates and source URLs (official exchange fee pages) plus caveats. No parameters required.",
    inputSchema: {},
    annotations: readOnlyAnnotations,
  },
  async () => {
    logCall("get_data_sources", {});
    return wrapResult(listDataSources());
  },
);

// Tool 7: calculate_annual_cost
server.registerTool(
  "calculate_annual_cost",
  {
    description:
      "当用户想知道一年下来在某交易所的真实总花费（年化交易手续费+年化资金费+年提现费）或升 VIP 档位一年能省多少钱时使用。Use when the user asks for annual/yearly cost of trading on an exchange, or how much reaching the next VIP tier would save per year. Annualizes 12 months of trading fees at the resolved VIP tier (referral + optional token discounts), 12 months of futures funding exposure, and per-event withdrawal fees times yearly withdrawal count. Includes an upgrade quote: the next VIP tier, how to qualify (volume, OKX/Bybit/Bitget/Kraken account assets (Kraken AOP), Gate GT, KuCoin KCS, or Binance BNB), and estimated annual saving. Requires exchange, purpose, country, and monthlyVolumeUsd.",
    inputSchema: {
      exchange: z.string().describe("交易所名称，如 binance, okx, gate"),
      purpose: z.enum(["spot", "futures"]).describe("交易类型: spot=现货, futures=期货"),
      country: z.string().min(2).describe("ISO 3166-1 alpha-2 国家代码"),
      monthlyVolumeUsd: z.number().positive().describe("月交易量(USD)，年化按此 ×12"),
      makerShare: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("挂单(maker)成交占比 0-1，默认 0=纯吃单"),
      useToken: z.boolean().optional().describe("是否使用平台币(BNB/OKB/GT/MX/BGB/KCS)折扣"),
      tokenBalance: z
        .number()
        .min(0)
        .optional()
        .describe("持有的平台币数量(BNB / GT / KCS)。币安现货 AND 门槛；Gate OR GT、KuCoin OR KCS 双轨可升档；同时用于平台币持仓折扣"),
      accountAssetsUsd: z
        .number()
        .min(0)
        .optional()
        .describe("OKX 账户总资产(USD)，OKX 按交易量 OR 资产取高定档"),
      holdingHours: z
        .number()
        .min(0)
        .optional()
        .describe("期货每月平均持仓时长(小时)，用于年化资金费(×12)"),
      withdrawalAsset: z.string().optional().describe("提现资产，如 BTC, ETH, USDT"),
      withdrawalNetwork: z.string().optional().describe("提现网络，如 TRC-20, ERC-20"),
      withdrawalsPerYear: z
        .number()
        .min(0)
        .optional()
        .describe("每年提现次数，年化提现费=单次提现费×次数，默认 0"),
      currency: z
        .enum(["USD", "EUR", "JPY", "CNH", "GBP"])
        .optional()
        .describe("显示币种，默认 USD；汇率仅用于展示"),
      pair: z
        .string()
        .optional()
        .describe("交易对，如 BTC/USDT、BTC/FDUSD、BTCUSDT 均可。命中币对级费率/0费促销时按促销价计费，未命中则按整所 VIP 档计费"),
      fundingMode: fundingModeParam,
      fundingPair: fundingPairParam,
      tradeSizeUsd: tradeSizeUsdParam,
      spreadMode: spreadModeParam,
      spreadPair: spreadPairParam,
      side: sideParam,
      fiatCurrency: z
        .enum(["USD", "EUR", "GBP", "BRL"])
        .optional()
        .describe("法币入金/出金币种，默认 USD（v0.26：可把年化法币通道费并入 annual_total_cost，得到完整成本栈）"),
      fiatDepositAmountUsd: z
        .number()
        .positive()
        .optional()
        .describe("单次法币入金金额(USD)；与 fiatDepositsPerYear 同时传入时，按该所最便宜直连通道计入年化入金费"),
      fiatDepositsPerYear: z
        .number()
        .min(0)
        .optional()
        .describe("每年法币入金次数，如月薪定投 12；年化入金费=单次最便宜通道费×次数"),
      fiatCashoutAmountUsd: z
        .number()
        .positive()
        .optional()
        .describe("单次法币出金(提现回银行卡)金额(USD)；与 fiatCashoutsPerYear 同时传入时计入年化出金费"),
      fiatCashoutsPerYear: z
        .number()
        .min(0)
        .optional()
        .describe("每年法币出金次数；年化出金费=单次最便宜通道费×次数"),
      fiatMethod: z
        .enum(["card", "ach", "sepa", "fps", "wire", "swift", "pix"])
        .optional()
        .describe("只按指定法币渠道计价(默认取最便宜)：card/ach/sepa/fps/wire/swift/pix"),
      language: languageParam,
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("calculate_annual_cost", args);
    const fundingRates = await resolveFundingOverrides(
      args.fundingMode,
      args.fundingPair,
      [args.exchange.toLowerCase()],
    );
    const spreadRates = await resolveSpreadOverrides(
      args.spreadMode,
      args.spreadPair ?? args.pair,
      args.purpose,
      [args.exchange.toLowerCase()],
      args.side,
      args.tradeSizeUsd,
    );
    const result = calculateAnnualCost(args.exchange, args.purpose, args.country, args.monthlyVolumeUsd, {
      makerShare: args.makerShare,
      useToken: args.useToken,
      tokenBalance: args.tokenBalance,
      accountAssetsUsd: args.accountAssetsUsd,
      holdingHours: args.holdingHours,
      withdrawalAsset: args.withdrawalAsset,
      withdrawalNetwork: args.withdrawalNetwork,
      withdrawalsPerYear: args.withdrawalsPerYear,
      currency: args.currency,
      pair: args.pair,
      fundingRates,
      fundingPair: args.fundingPair,
      tradeSizeUsd: args.tradeSizeUsd,
      spreadRates,
      spreadPair: args.spreadPair,
      fiatCurrency: args.fiatCurrency,
      fiatDepositAmountUsd: args.fiatDepositAmountUsd,
      fiatDepositsPerYear: args.fiatDepositsPerYear,
      fiatCashoutAmountUsd: args.fiatCashoutAmountUsd,
      fiatCashoutsPerYear: args.fiatCashoutsPerYear,
      fiatMethod: args.fiatMethod,
      language: args.language,
    });
    return wrapResult(result);
  },
);

// Tool 8: get_funding_rates
server.registerTool(
  "get_funding_rates",
  {
    description:
      "当用户询问资金费率、资金费、funding rate、当前持仓的资金成本、各交易所永续合约资金费对比时使用。Use when the user asks about perpetual futures funding rates across exchanges, or the current cost of holding a long/short. Returns per-exchange funding rate + settlement interval for a perpetual pair (default BTC/USDT). fundingMode=bundled (default) returns the offline long-run averages instantly; fundingMode=live fetches the real-time current rate from each venue independently via ccxt — venues that fail (timeout, geo-block, missing pair) fall back to the bundled average and are listed in failures, and every row is tagged with source/live timestamp.",
    inputSchema: {
      fundingMode: z
        .enum(["bundled", "live"])
        .optional()
        .describe("bundled=内置长期均值(默认，0.01%/8h，离线秒回)；live=实时拉取当前资金费率(逐所容错，失败回退内置值)"),
      fundingPair: z
        .string()
        .optional()
        .describe("永续合约对，默认 BTC/USDT；也支持 ETH/USDT、SOL-USDT、BTCUSD 等写法"),
      exchanges: z
        .array(z.string())
        .optional()
        .describe("只查询指定交易所(如 ['binance','okx'])；默认返回全部 9 家(合约比较不含 Coinbase)"),
      country: z
        .string()
        .min(2)
        .optional()
        .describe("ISO 3166-1 alpha-2 国家代码；传入后按合规可用性过滤交易所"),
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("get_funding_rates", args);
    const result = await getFundingRates({
      fundingMode: args.fundingMode,
      fundingPair: args.fundingPair,
      exchanges: args.exchanges,
      country: args.country,
    });
    return wrapResult(result);
  },
);

// Tool 9: get_execution_cost
server.registerTool(
  "get_execution_cost",
  {
    description:
      "当用户询问买卖点差、滑点、订单簿深度、大单冲击成本、市价单实际成交成本、各所吃单执行成本对比时使用。Use when the user asks about bid-ask spread, slippage, order-book depth, market impact, or the real execution cost of a marketable order across exchanges. Returns per-exchange one-way execution cost in bps and USD for a specific order size (default $10,000): full spread, crossing cost (half spread), depth-walk slippage beyond the top level, total one-way cost, levels consumed, and fill status. spreadMode=bundled (default) uses offline typical-spread baselines by venue and pair class (majors/large-cap/mid-alt) instantly; spreadMode=live fetches the real top-100 order book per venue independently via ccxt and VWAP-walks it — failures fall back to bundled baselines (listed in failures), shallow books keep the measured cost with a warning. Spot requests use the spot market (e.g. kucoin rather than kucoinfutures). Requires country for compliance filtering unless exchanges are given explicitly.",
    inputSchema: {
      tradeSizeUsd: z
        .number()
        .positive()
        .optional()
        .describe("单笔市价单规模(USD)，默认 10000($1万)。滑点对规模高度敏感，大单务必传真实值，如 50000、250000"),
      pair: z
        .string()
        .optional()
        .describe("交易对，默认 BTC/USDT；支持 ETH/USDT、SOL-USDT 等。山寨币点差按内置档位放大(mid-alt ×3)，live 模式按真实订单簿"),
      purpose: z
        .enum(["spot", "futures"])
        .optional()
        .describe("市场类型，默认 futures(永续)；spot 自动解析各所现货市场与符号"),
      side: z
        .enum(["buy", "sell"])
        .optional()
        .describe("方向，默认 buy；buy 吃卖盘、sell 吃买盘，live 时两侧深度可能不同"),
      spreadMode: z
        .enum(["bundled", "live"])
        .optional()
        .describe("bundled=内置典型点差基准(默认，秒回、零滑点)；live=实时订单簿前100档 VWAP 行走，含真实滑点，单所失败回退 bundled 并记入 failures"),
      exchanges: z
        .array(z.string())
        .optional()
        .describe("只查询指定交易所(如 ['binance','kraken'])；默认返回全部 9 家(合约比较不含 Coinbase)"),
      country: z
        .string()
        .min(2)
        .optional()
        .describe("ISO 3166-1 alpha-2 国家代码；传入后按合规可用性过滤交易所(EEA 居民查 USDT 报价对会附稳定币区域可用性警告)"),
      language: languageParam,
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("get_execution_cost", args);
    const result = await getExecutionCost({
      spreadMode: args.spreadMode,
      pair: args.pair,
      purpose: args.purpose,
      side: args.side,
      tradeSizeUsd: args.tradeSizeUsd,
      exchanges: args.exchanges,
      country: args.country,
      language: args.language,
    });
    return wrapResult(result);
  },
);

// Tool 10: get_fiat_cost
server.registerTool(
  "get_fiat_cost",
  {
    description:
      "当用户询问法币入金/出金成本、刷卡买币手续费、银行卡/信用卡充值费用、银行转账(SEPA/ACH/FPS/PIX/电汇 SWIFT/wire)哪个便宜、提现到银行卡实际到账多少时使用。Use when the user asks how much it costs to move fiat money INTO an exchange (deposit/buy crypto with card or bank transfer) or OUT to a bank account (cash out / withdraw fiat). Prices the direct, exchange-operated rails across venues: credit/debit cards (about 1.1% EU at Bybit to 4.5% at KuCoin; most venues have no card cash-out), US ACH (free at OKX and Kraken), EU SEPA (free deposits at OKX/Kraken/Bitget, about EUR 1 withdrawals; Gate charges 0.5%/1%), UK Faster Payments, Brazil PIX, and SWIFT/domestic wire (fixed USD 4-35 withdrawals). For every venue returns each available rail with fee in fiat AND USD, effective percentage, net amount that arrives, ETA and caveats, plus cheapest overall pick and saving vs the most expensive supported venue. Region/residency-aware: pass country so non-resident rails are filtered (SEPA is EU-only, ACH/wire US-only, FPS GB-only, PIX BR-only). Covers ONLY direct rails — third-party gateway quotes (Banxa/Simplex/MoonPay: 1.99%-5.5% at checkout) and zero-fee P2P (cost embedded in the quote spread) are excluded and called out in notes/advice.",
    inputSchema: {
      direction: z
        .enum(["deposit", "withdraw"])
        .optional()
        .describe("资金方向：deposit=入金买币(默认)，withdraw=卖出提现到银行账户"),
      amount: z
        .number()
        .positive()
        .optional()
        .describe("法币金额(按 currency 单位，如 1000 欧元)，默认 1000；与 amountUsd 二选一"),
      amountUsd: z
        .number()
        .positive()
        .optional()
        .describe("以美元计的金额，工具按内置展示汇率换算成所选法币；与 amount 二选一"),
      currency: z
        .enum(["USD", "EUR", "GBP", "BRL"])
        .optional()
        .describe("法币种类，默认 USD。EUR→SEPA 通道，GBP→FPS，BRL→PIX，USD→ACH/wire/卡"),
      country: z
        .string()
        .min(2)
        .optional()
        .describe("ISO 3166-1 alpha-2 居住国(如 US/DE/GB/BR/JP)；同时用于通道地区过滤与交易所合规过滤"),
      method: z
        .enum(["card", "ach", "sepa", "fps", "wire", "swift", "pix"])
        .optional()
        .describe("只看指定渠道：card=信用卡/借记卡，ach=美国 ACH，sepa=欧洲银行转账，fps=英国快速转账，wire=美国国内电汇，swift=国际电汇，pix=巴西即时支付"),
      exchanges: z
        .array(z.string())
        .optional()
        .describe("只查询指定交易所(如 ['kraken','okx'])；默认返回全部 9 家(合约比较不含 Coinbase)"),
      language: languageParam,
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("get_fiat_cost", args);
    const result = getFiatCost({
      direction: args.direction,
      amount: args.amount,
      amountUsd: args.amountUsd,
      currency: args.currency,
      country: args.country,
      method: args.method,
      exchanges: args.exchanges,
      language: args.language,
    });
    return wrapResult(result);
  },
);

// Tool 11: get_withdrawal_fees
server.registerTool(
  "get_withdrawal_fees",
  {
    description:
      "当用户询问提币手续费、转出/提现到钱包或其他交易所哪个网络便宜、USDT/USDC 走 TRC-20/ERC-20/BEP20/Arbitrum/Optimism/Base/Polygon/Solana/Avalanche 各要多少、某交易所是否支持某链、BTC/ETH/SOL/XRP/DOGE 等原生币提币费、链上转账费对比时使用。Use when the user asks which exchange has the cheapest crypto withdrawal / network fee for an asset on a given chain, whether a venue supports a network, or wants to compare on-chain transfer costs before moving coins to a wallet or another exchange. Returns every supported route per venue with the fee in native units AND USD (converted from a dated price snapshot), marks wallets currently suspended, names each venue's cheapest open route, and ranks venues with an overall best pick plus saving vs the most expensive one. Covers 16 assets (BTC, ETH, USDT, USDC, SOL, XRP, DOGE, LTC, TRX, ADA, AVAX, DOT, LINK, BCH, TON, POL) across Tron/Ethereum/BSC/Arbitrum/Optimism/Base/Polygon/Avalanche/Solana/Ton/native chains at all venues with routes (Coinbase only lists BTC/ETH/USDT/USDC — dynamic network-fee estimates). Fees are exchange-charged, pass-through on-chain costs (Kraken/KuCoin dynamic), not trading fees — for the all-in cost of a trade use compare_total_cost instead.",
    inputSchema: {
      asset: z
        .string()
        .min(2)
        .optional()
        .describe("资产符号，默认 USDT。支持：BTC/ETH/USDT/USDC/SOL/XRP/DOGE/LTC/TRX/ADA/AVAX/DOT/LINK/BCH/TON/POL"),
      network: z
        .string()
        .min(2)
        .optional()
        .describe("只看指定网络并接受常见别名：TRC-20(trc20/tron)、ERC-20(erc20/ethereum)、BEP20(bsc)、Arbitrum(arb)、Optimism(op)、Base、Polygon(matic)、Avalanche C(avax/c-chain)、Solana(sol)、TON、AssetHub 等；省略则返回该资产全部网络"),
      country: z
        .string()
        .min(2)
        .optional()
        .describe("ISO 3166-1 alpha-2 国家代码；传入后按合规可用性过滤交易所(如 US 只剩 okx/gate/kraken)"),
      exchanges: z
        .array(z.string())
        .optional()
        .describe("只查询指定交易所(如 ['binance','okx'])；默认返回全部 9 家(合约比较不含 Coinbase)"),
      language: languageParam,
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("get_withdrawal_fees", args);
    const result = getWithdrawalCost({
      asset: args.asset,
      network: args.network,
      country: args.country,
      exchanges: args.exchanges,
      language: args.language,
    });
    return wrapResult(result);
  },
);

// Tool 12: analyze_persona (v0.22)
const personaIds = listPersonas().map((p) => p.id) as [string, ...string[]];
server.registerTool(
  "analyze_persona",
  {
    description:
      "当用户描述自己的交易类型/身份（新手小额买入、定投囤币、活跃现货、合约波段、高频刷单、高净值机构、链上无 KYC 玩家）并想知道哪种交易所最适合自己、一年真实总花费多少时使用。Use when the user asks which exchange fits THEIR kind of trading, describes themselves as a beginner/HODLer/swing trader/scalper/institution/no-KYC trader, or wants an all-in annual cost for a trader scenario. Loads a research-anchored persona preset (casual_buyer, hodler_accumulator, active_spot_trader, swing_futures_trader, day_scalper, vip_institutional, dex_native) that bundles monthly volume, maker share, futures holding hours, market-order clip size, withdrawal and fiat on/off-ramp habits, then runs the FULL annual cost stack across every venue allowed in the country — trading fees + funding + spread crossing + on-chain withdrawals + direct fiat deposit/cash-out legs — and returns the ranked venues with cost-mix %, cheapest-venue leader for each cost component, a winner with concrete reasons and trade-offs, and tailored advice (VIP upgrade saving, token-discount hint, live funding/depth suggestions). Every preset parameter can be overridden. Requires persona id and country code.",
    inputSchema: {
      persona: z
        .enum(personaIds)
        .describe("交易员画像：casual_buyer=小额随买(银行卡入金主导)；hodler_accumulator=定投囤币(银行通道+冷钱包提币)；active_spot_trader=活跃现货；swing_futures_trader=合约波段(资金费敏感)；day_scalper=高频刷单(90% maker、$300万/月)；vip_institutional=高净值/机构($3000万/月+$300万资产)；dex_native=链上无KYC(USDC 自托管出入)"),
      country: z.string().min(2).describe("ISO 3166-1 alpha-2 居住国代码，如 US/CN/JP/GB/DE/BR；用于交易所合规过滤和法币通道地区过滤"),
      monthlyVolumeUsd: z.number().positive().optional().describe("覆盖画像默认月交易量(USD)"),
      makerShare: z.number().min(0).max(1).optional().describe("覆盖画像默认 maker 占比 0-1"),
      useToken: z.boolean().optional().describe("是否使用平台币折扣(覆盖画像默认 false)"),
      tokenBalance: z.number().min(0).optional().describe("平台币/质押数量，配合 useToken"),
      accountAssetsUsd: z.number().min(0).optional().describe("覆盖画像默认账户总资产(USD)"),
      holdingHours: z.number().min(0).optional().describe("覆盖画像默认月持仓敞口小时数(合约资金费)"),
      tradeSizeUsd: z.number().positive().optional().describe("覆盖画像默认单笔市价单规模(USD)，触发点差穿越成本"),
      currency: z.enum(["USD", "EUR", "JPY", "CNH", "GBP"]).optional().describe("显示币种，默认 USD；汇率仅用于展示（法币通道币种由画像设定，默认 USD）"),
      fundingMode: fundingModeParam,
      fundingPair: fundingPairParam,
      spreadMode: spreadModeParam,
      spreadPair: spreadPairParam,
      side: sideParam,
      language: languageParam,
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("analyze_persona", args);
    const allowed = listSupportedExchanges().filter((e) => isExchangeAllowed(e, args.country));
    const purpose = listPersonas().find((p) => p.id === args.persona)?.purpose ?? "spot";
    const fundingRates = await resolveFundingOverrides(args.fundingMode, args.fundingPair, allowed);
    const spreadRates = await resolveSpreadOverrides(
      args.spreadMode,
      args.spreadPair,
      purpose,
      allowed,
      args.side,
      args.tradeSizeUsd,
    );
    const result = analyzePersona(args.persona, args.country, {
      monthlyVolumeUsd: args.monthlyVolumeUsd,
      makerShare: args.makerShare,
      useToken: args.useToken,
      tokenBalance: args.tokenBalance,
      accountAssetsUsd: args.accountAssetsUsd,
      holdingHours: args.holdingHours,
      tradeSizeUsd: args.tradeSizeUsd,
      currency: args.currency,
      fundingRates,
      fundingPair: args.fundingPair,
      spreadRates,
      spreadPair: args.spreadPair,
      language: args.language,
    });
    return wrapResult(result);
  },
);

// Tool 13: analyze_token_discount (v0.23)
server.registerTool(
  "analyze_token_discount",
  {
    description:
      "当用户问持有某个交易所的平台币（BNB/GT/KCS/BGB/MX/HYPE）来抵扣手续费是否划算、多久能回本、能承受币价跌多少时使用。Use when the user asks whether holding an exchange's native token for fee discounts is worth it, how long until the discount pays back the locked capital, or how far the token price can drop before the saving is wiped out. Computes the annual trading fee WITHOUT the native token (zero-balance tier, no fee-deduction toggle) vs. WITH the token (GT/KCS/BNB holdings can lift the VIP tier; BNB/MX/BGB/KCS give a flat fee-deduction; Gate GT and MEXC MX and Hyperliquid HYPE have holding-tier discount ladders; Gate futures maker drops to zero). Returns annual USD saving, the USD opportunity cost of locking the required token balance (2026-09 snapshot price or explicit tokenPriceUsd override), payback in months, and the maximum one-year token price drop the saving can absorb. When tokenBalance is omitted it returns every achievable discount tier as a table with a recommended best-payback tier. Requires exchange, purpose, country, and monthlyVolumeUsd.",
    inputSchema: {
      exchange: z.string().describe("交易所名称，如 binance, gate, kucoin, mexc, bitget, hyperliquid"),
      purpose: z.enum(["spot", "futures"]).describe("交易类型: spot=现货, futures=期货"),
      country: z.string().min(2).describe("ISO 3166-1 alpha-2 居住国代码，用于合规过滤"),
      monthlyVolumeUsd: z.number().positive().describe("月交易量(USD)"),
      makerShare: z.number().min(0).max(1).optional().describe("maker 挂单占比 0-1，默认 0（纯吃单）"),
      tokenBalance: z.number().min(0).optional().describe("已持有的平台币数量；省略则返回所有可达档位的回本对比表；对 Hyperliquid 填已质押(staked)的 HYPE"),
      accountAssetsUsd: z.number().min(0).optional().describe("账户总资产(USD)，用于 OKX/Bybit/Bitget/Kraken 的资产档位升级路径"),
      tokenPriceUsd: z.number().positive().optional().describe("平台币当前 USD 单价；省略使用内置 2026-09 快照价"),
      currency: z.enum(["USD", "EUR", "JPY", "CNH", "GBP"]).optional().describe("显示币种，默认 USD"),
      language: languageParam,
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("analyze_token_discount", args);
    const result = analyzeTokenDiscount(args.exchange, args.country, args.purpose, args.monthlyVolumeUsd, {
      makerShare: args.makerShare,
      tokenBalance: args.tokenBalance,
      accountAssetsUsd: args.accountAssetsUsd,
      tokenPriceUsd: args.tokenPriceUsd,
      currency: args.currency,
      language: args.language,
    });
    return wrapResult(result);
  },
);

// Tool 14: compare_personas (v0.28) — multi-persona decision matrix
server.registerTool(
  "compare_personas",
  {
    description:
      "当用户想一次看清\"什么类型的交易者该用哪个交易所\"、要全部 7 种画像并排对比、做决策矩阵/选型总览，或问\"哪个交易所适合最多人/最全能\"时使用。Use when the user wants a side-by-side decision matrix of ALL trader personas (casual buyer, DCA HODLer, active spot, swing futures, scalper, VIP/institutional, no-KYC on-chain) for their country in one call. Runs each persona's full annual all-in stack across every allowed venue, then returns per-persona winner + realistic best_complete pick (every cost leg actually priced — headline winners with no fiat/withdrawal rail are demoted), a persona×venue annual-cost matrix, cross-persona venue win counts, and the single most versatile venue. Requires only the country; optionally restrict personas or force useToken. This is the fastest way to answer \"which exchange for which kind of trader\".",
    inputSchema: {
      country: z.string().min(2).describe("ISO 3166-1 alpha-2 居住国代码，如 US/CN/JP/GB/DE/BR；合规过滤与法币通道按此国执行"),
      personas: z
        .array(z.enum(personaIds))
        .optional()
        .describe("只跑指定画像子集（默认全部 7 个，按传入顺序去重）：casual_buyer/hodler_accumulator/active_spot_trader/swing_futures_trader/day_scalper/vip_institutional/dex_native"),
      useToken: z
        .boolean()
        .optional()
        .describe("对所有画像统一开启/关闭平台币折扣（默认沿用各画像设定，多数为 false）"),
      currency: z.enum(["USD", "EUR", "JPY", "CNH", "GBP"]).optional().describe("显示币种，默认 USD"),
      fundingMode: fundingModeParam,
      fundingPair: fundingPairParam,
      spreadMode: spreadModeParam,
      spreadPair: spreadPairParam,
      side: sideParam,
      language: languageParam,
      format: formatParam,
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("compare_personas", args);
    const allowed = listSupportedExchanges().filter((e) => isExchangeAllowed(e, args.country));
    const fundingRates = await resolveFundingOverrides(args.fundingMode, args.fundingPair, allowed);
    // Live depth depends on each persona's purpose AND clip size, so resolve one
    // override map per selected persona; bundled mode needs no per-persona call.
    let spreadRatesByPersona: Record<string, SpreadOverrides> | undefined;
    if (args.spreadMode === "live") {
      spreadRatesByPersona = {};
      const wanted = listPersonas().filter(
        (p) => !args.personas || args.personas.includes(p.id),
      );
      for (const p of wanted) {
        const overrides = await resolveSpreadOverrides(
          args.spreadMode,
          args.spreadPair,
          p.purpose,
          allowed,
          args.side,
          p.trade_size_usd,
        );
        if (overrides) spreadRatesByPersona[p.id] = overrides;
      }
    }
    const result = comparePersonas(args.country, {
      personas: args.personas,
      useToken: args.useToken,
      currency: args.currency,
      fundingRates,
      fundingPair: args.fundingPair,
      spreadRatesByPersona,
      spreadPair: args.spreadPair,
      language: args.language,
      format: args.format,
    });
    return wrapResult(result);
  },
);

// Tool 15: volume_what_if (v0.34) — fee cost curve over volume levels + tier crossings
server.registerTool(
  "volume_what_if",
  {
    description:
      "当用户问\"月交易量达到 X 手续费多少/如果成交量增长到不同水平呢/再刷多少量能升 VIP 档省钱/各交易所档位跳变点\"，或要看一条跨成交量的费率-成本曲线时使用。Use for volume what-if / sensitivity analysis: scans monthly trading volume from zero up through the VIP ladder for spot OR futures across EVERY venue allowed in the country, returning (1) per-volume-point cross-venue ranking with the cheapest venue and its annual trading fee, (2) per-venue sweep curves with tier/maker/taker/weighted fee at each point, (3) the exact tier-crossing list (at which volume each venue moves to which rung), and when baseVolume is given, (4) each venue's next volume rung, how much MORE monthly volume it needs, and the USD/year it would save at the caller's current volume (holding-gated rungs like Binance spot's BNB requirement are explicitly flagged as unreachable by volume alone). Sweep points default to the union of every venue's tier thresholds (sampled if >16); pass explicit volumes for custom points. Applies referral discounts and the optional platform-token toggle exactly like compare_exchange_fees. Trading fees only — funding, spread, withdrawals and fiat are not included (use compare_total_cost for the full stack).",
    inputSchema: {
      purpose: z.enum(["spot", "futures"]).describe("交易类型：spot 现货 / futures 合约"),
      country: z.string().min(2).describe("ISO 3166-1 alpha-2 居住国代码，如 US/CN/JP/GB/DE/BR"),
      baseVolume: z
        .number()
        .nonnegative()
        .optional()
        .describe("你当前的 30 天成交量（USD）。提供后会返回精确的\"下一 VIP 档还需多少量、当前量下一年省多少\"建议，并保证该点出现在扫描中"),
      volumes: z
        .array(z.number().nonnegative())
        .optional()
        .describe("自定义扫描点（月成交量 USD 数组，最多 24 个，自动去重排序）。不传则默认取所有交易所档位阈值的并集（超过 16 个时全区间抽样并给出警告）"),
      makerShare: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Maker 成交占比 0-1，默认 0.4；用于 maker/taker 加权费率"),
      useToken: z.boolean().optional().describe("是否开启平台币抵扣/折扣（BNB/MX/BGB/GT/KCS/HYPE/PT 等），默认 false"),
      tokenBalance: z
        .number()
        .nonnegative()
        .optional()
        .describe("平台币持仓数量（BNB/GT/KCS 枚数，或 MX/HYPE 等的枚数）；影响 AND/OR 档位与持仓折扣"),
      accountAssetsUsd: z
        .number()
        .nonnegative()
        .optional()
        .describe("账户总资产 USD（OKX/Bybit/Bitget/Kraken 等的资产升档通道）"),
      pair: z
        .string()
        .optional()
        .describe("特定交易对（如 BTC/USDT、FDUSD、USDC）以适用交易对专属费率活动；默认账户档位费率"),
      currency: z.enum(["USD", "EUR", "JPY", "CNH", "GBP"]).optional().describe("显示币种，默认 USD"),
      language: languageParam,
      format: formatParam,
      tableMetric: z
        .enum(["weighted_fee_pct", "annual_fee_usd", "tier"])
        .optional()
        .describe("format 非 json 时表格的指标列：weighted_fee_pct=加权费率%(默认) / annual_fee_usd=年化交易费 / tier=生效档位名"),
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("volume_what_if", args);
    const result = volumeWhatIf(args.purpose, args.country, {
      volumes: args.volumes,
      baseVolume: args.baseVolume,
      makerShare: args.makerShare,
      useToken: args.useToken,
      tokenBalance: args.tokenBalance,
      accountAssetsUsd: args.accountAssetsUsd,
      pair: args.pair,
      currency: args.currency,
      language: args.language,
      format: args.format,
      tableMetric: args.tableMetric,
    });
    return wrapResult(result);
  },
);

// Tool 16: compare_countries (v0.35) — same trader profile priced across countries
server.registerTool(
  "compare_countries",
  {
    description:
      "当用户问\"同样的交易习惯在哪个国家最便宜/我要搬家或换居住地（美国/日本/德国/新加坡…）手续费和可用交易所有什么不同/哪些所在我国被封锁/同一画像跨国对比\"时使用。Use to run ONE trader persona/profile through the FULL annual all-in stack (trading fees + funding + spread + withdrawals + fiat rails) across SEVERAL countries in a single call and see how residency changes the result: per-country winner + realistic best_complete pick, annual cost and the extra vs the cheapest country (USD and %), the venues blocked by compliance and the venues that simply do not offer the profile's product (e.g. spot-only Coinbase for a futures trader), a venue×country availability matrix, cross-country venue win counts, the cheapest/costliest country and the annual cost gap, and bilingual narrative advice. Defaults to the active_spot_trader persona across 7 representative countries (US, GB, DE, JP, SG, BR, CN); pick any of the 7 personas via persona and pass an explicit countries list (up to 12). Every persona parameter can be overridden (volume, maker share, token, assets, holding hours, clip). Live funding/depth overrides are resolved once over the union of venues allowed in ANY selected country.",
    inputSchema: {
      persona: z
        .enum(personaIds)
        .optional()
        .describe("交易者画像，默认 active_spot_trader：casual_buyer/hodler_accumulator/active_spot_trader/swing_futures_trader/day_scalper/vip_institutional/dex_native"),
      countries: z
        .array(z.string().min(2))
        .optional()
        .describe("ISO 3166-1 alpha-2 国家代码列表（最多 12 个，去重），默认 US/GB/DE/JP/SG/BR/CN 七国对比"),
      monthlyVolumeUsd: z.number().positive().optional().describe("覆盖画像默认的月成交量（USD）"),
      makerShare: z.number().min(0).max(1).optional().describe("覆盖画像默认的 Maker 占比 0-1"),
      useToken: z.boolean().optional().describe("覆盖画像默认的平台币折扣开关"),
      tokenBalance: z.number().nonnegative().optional().describe("平台币持仓数量（BNB/GT/KCS 等）"),
      accountAssetsUsd: z.number().nonnegative().optional().describe("账户总资产 USD"),
      holdingHours: z.number().nonnegative().optional().describe("每次合约持仓小时数（资金费成本）"),
      tradeSizeUsd: z.number().positive().optional().describe("单笔下单规模 USD（执行成本）"),
      pair: z.string().optional().describe("特定交易对费率活动，如 BTC/USDT"),
      currency: z.enum(["USD", "EUR", "JPY", "CNH", "GBP"]).optional().describe("显示币种，默认 USD"),
      fundingMode: fundingModeParam,
      fundingPair: fundingPairParam,
      spreadMode: spreadModeParam,
      spreadPair: spreadPairParam,
      side: sideParam,
      language: languageParam,
      format: formatParam,
      tableMetric: z
        .enum(["availability", "cost"])
        .optional()
        .describe("format 非 json 时表格内容：availability=交易所×国家可用性(✓/⛔/–，默认) / cost=交易所×国家年化总成本"),
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("compare_countries", args);
    const personaId = args.persona ?? "active_spot_trader";
    const persona = listPersonas().find((p) => p.id === personaId)!;
    const selectedCountries = (
      args.countries && args.countries.length > 0
        ? [...new Set(args.countries.map((c) => c.toUpperCase()))].slice(0, 12)
        : [...COMPARE_COUNTRIES_DEFAULT_SET]
    );
    // Live data is venue-keyed; fetch once over every venue allowed in ANY of
    // the selected countries. Country filtering still happens per row.
    const unionVenues = listSupportedExchanges().filter((e) =>
      selectedCountries.some((cc) => isExchangeAllowed(e, cc)),
    );
    const fundingRates = await resolveFundingOverrides(
      args.fundingMode,
      args.fundingPair,
      unionVenues,
    );
    const spreadRates = await resolveSpreadOverrides(
      args.spreadMode,
      args.spreadPair,
      persona.purpose,
      unionVenues,
      args.side,
      args.tradeSizeUsd ?? persona.trade_size_usd,
    );
    const byCountry = <T,>(overrides: T | undefined): Record<string, T> | undefined =>
      overrides
        ? Object.fromEntries(selectedCountries.map((cc) => [cc, overrides]))
        : undefined;
    const result = compareCountries(personaId, {
      countries: args.countries,
      monthlyVolumeUsd: args.monthlyVolumeUsd,
      makerShare: args.makerShare,
      useToken: args.useToken,
      tokenBalance: args.tokenBalance,
      accountAssetsUsd: args.accountAssetsUsd,
      holdingHours: args.holdingHours,
      tradeSizeUsd: args.tradeSizeUsd,
      pair: args.pair,
      currency: args.currency,
      fundingPair: args.fundingPair,
      spreadPair: args.spreadPair,
      fundingRatesByCountry: byCountry(fundingRates),
      spreadRatesByCountry: byCountry(spreadRates),
      language: args.language,
      format: args.format,
      tableMetric: args.tableMetric,
    });
    return wrapResult(result);
  },
);

// Tool 17 (v0.39): get_account_fee_tier — authenticated REAL account fees.
server.registerTool(
  "get_account_fee_tier",
  {
    description:
      "当用户想知道\"我账户里实际生效的手续费率/我的真实 VIP 档位费率/API 查我的 maker taker/为什么我实际手续费和公开表不一样\"时使用。Use a READ-ONLY exchange API key (apiKey + secret, OKX/KuCoin-Futures also need passphrase as password; Hyperliquid needs only the PUBLIC 0x wallet address as apiKey) to fetch the account's ACTUAL maker/taker fee for spot or futures, then compares it against this server's bundled public VIP schedule at the given monthly volume and shows the gap in bps. Credentials are used per request only, never cached, never logged (audit logs redact them). Always generate a READ-ONLY key (no trading/withdrawal permissions). Supported: Binance, OKX, Gate, Bybit, MEXC, Bitget, KuCoin (spot + kucoinfutures), Kraken (spot + krakenfutures), Coinbase (spot), Hyperliquid (wallet address), BingX, Bitstamp (spot); NOT supported by the bundled ccxt connector: Phemex, BloFin, Bitstamp perps. Country compliance/product gates are enforced before any authenticated call.",
    inputSchema: {
      exchange: z.string().min(2).describe("交易所 id：binance/okx/gate/bybit/mexc/bitget/kucoin/kraken/coinbase/hyperliquid/bingx/bitstamp"),
      purpose: z.enum(["spot", "futures"]).describe("交易类型: spot=现货, futures=合约/永续"),
      country: z.string().min(2).describe("ISO 3166-1 alpha-2 居住国代码，如 US/DE/JP（合规与产品闸门先于鉴权调用）"),
      apiKey: z
        .string()
        .min(1)
        .describe("只读 API Key；Hyperliquid 传公开钱包地址(0x…)。必须是只读权限，绝不要给交易/提币权限的 key"),
      secret: z
        .string()
        .optional()
        .describe("API Secret（Hyperliquid 钱包模式不需要；其他交易所必填）"),
      password: z
        .string()
        .optional()
        .describe("API passphrase：OKX 必填；KuCoin Futures 使用合约 API 的 passphrase"),
      pair: z
        .string()
        .optional()
        .describe("用于解析费率的交易对，默认 BTC/USDT（按所解析为现货或永续市场）"),
      monthlyVolumeUsd: z
        .number()
        .nonnegative()
        .optional()
        .describe("月成交量(USD)，仅用于选择内置公开费率表的对比档位，默认 0=入门档"),
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("get_account_fee_tier", args);
    const lower = args.exchange.toLowerCase();
    const purpose = args.purpose;
    const country = args.country.toUpperCase();

    if (!listSupportedExchanges().includes(lower)) {
      return wrapResult(
        makeError(`Exchange '${args.exchange}' is not supported.`, {
          code: "UNKNOWN_EXCHANGE",
          suggested_action: `Supported exchanges: ${listSupportedExchanges().join(", ")}.`,
        }),
      );
    }
    if (!isExchangeAllowed(lower, country)) {
      return wrapResult(
        makeError(
          `Exchange '${exDisplayName(lower)}' is not available in country ${country}.`,
          { code: "COUNTRY_BLOCKED" },
        ),
      );
    }
    if (isProductBlockedInCountry(lower, purpose, country)) {
      return wrapResult(
        makeError(
          `${exDisplayName(lower)} does not offer ${purpose} trading to residents of ${country} (venue is available for other products).`,
          { code: "PRODUCT_BLOCKED_IN_COUNTRY" },
        ),
      );
    }

    // Public-schedule comparison leg (0 volume = entry tier when omitted).
    const monthlyVolumeUsd = args.monthlyVolumeUsd ?? 0;
    const bundled = resolveFeeRate(lower, purpose, monthlyVolumeUsd);
    if (!bundled) {
      return wrapResult(
        makeError(
          `No ${purpose} fee schedule is modeled for ${exDisplayName(lower)}.`,
          {
            code: "NO_FEE_DATA",
            suggested_action:
              purpose === "futures"
                ? "This is a spot-only venue; query purpose=spot."
                : undefined,
          },
        ),
      );
    }

    const live = await fetchAccountFee(
      lower,
      purpose,
      { apiKey: args.apiKey, secret: args.secret, password: args.password },
      { pair: args.pair },
    );
    if (!live.ok) {
      return wrapResult(
        makeError(live.error, {
          code: live.code,
          retryable: live.retryable,
          suggested_action: live.note,
        }),
      );
    }

    const bps = (livePct: number, bundledPct: number): number =>
      Math.round((livePct - bundledPct) * 100 * 100) / 100;

    return wrapResult({
      exchange: lower,
      exchange_name: exDisplayName(lower),
      purpose,
      country,
      pair: live.pair,
      credential_type: live.credential_type,
      fetch_method: live.method,
      fetched_at: live.fetched_at,
      data_as_of: listDataSources().data_as_of,
      live_fee: {
        maker_pct: live.maker_pct,
        taker_pct: live.taker_pct,
      },
      bundled_fee: {
        tier: bundled.tier,
        maker_pct: bundled.base_maker,
        taker_pct: bundled.base_taker,
        monthly_volume_usd: monthlyVolumeUsd,
      },
      // Negative bps = the account pays LESS than the public tier; positive = more.
      delta_vs_bundled_bps: {
        maker: bps(live.maker_pct, bundled.base_maker),
        taker: bps(live.taker_pct, bundled.base_taker),
      },
      security_note:
        "Credentials were used for this read-only request only, never cached or logged. Use exclusively READ-ONLY API keys (no trading/withdrawal permissions); rotate the key if it was ever granted more.",
      notes: [
        "live_fee is the account's ACTUAL exchange-side rate (may already include server-side BNB deductions, VIP level reached on the venue's own rolling window, or negotiated rates); bundled_fee is the public schedule tier at the stated volume without token/referral adjustments.",
        ...(accountFeeSupportFor(lower, purpose).note
          ? [accountFeeSupportFor(lower, purpose).note as string]
          : []),
      ],
    });
  },
);

// Tool 18 (v0.46): get_stablecoin_access — MiCA regional stablecoin access (USDT EEA sweep).
server.registerTool(
  "get_stablecoin_access",
  {
    description:
      "当用户问\"USDT/Tether/稳定币在我的国家(尤其欧洲/EEA/欧盟)还能不能交易、买卖、提币？哪些交易所下架了 USDT？MiCA 合规稳定币有哪些(USDC/EURC/EURI/EURCV/USDQ)？Revolut 的 USDT 怎么办？\"时使用。Returns the MiCA regional access status of a stablecoin (default USDT): issuer + MiCA EMT authorization status, whether venue trading is barred in the resident's region (USDT: unavailable across all 30 EEA states after the 2026-07-01 CASP cliff), custody/withdrawal and self-custody rights (holding and on-chain withdrawal stay legal; the restriction binds venues, not people), a per-venue table (delisted with date / never_offered / venue_blocked; scope eea vs global; whether the venue itself serves the country), compliant alternatives and localized advice. CH and GB are NOT in the EEA region. Without a country, global/asset-level status is returned. Also auto-injected as STABLECOIN_UNAVAILABLE_IN_REGION warnings into fee/withdrawal/execution/persona tools for USDT-quoted requests from EEA residents.",
    inputSchema: {
      asset: z
        .string()
        .min(2)
        .optional()
        .describe("稳定币符号，默认 USDT；已建模：USDT、USDC、EURC、EURI、EURCV、USDQ、EURQ"),
      country: z
        .string()
        .min(2)
        .optional()
        .describe("ISO 3166-1 alpha-2 居住国代码，如 DE/FR/NL/US/GB/CH；不传则返回全球/资产级状态，场馆行只含全球策略"),
      exchange: z
        .string()
        .min(2)
        .optional()
        .describe("可选：只看单个交易所（场馆 id，如 coinbase/bison/binance），仍按居住国判定适用性"),
      language: languageParam,
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("get_stablecoin_access", args);
    const result = getStablecoinAccessReport({
      ...(args.asset ? { asset: args.asset } : {}),
      ...(args.country ? { country: args.country.toUpperCase() } : {}),
      ...(args.exchange ? { exchange: args.exchange } : {}),
      language: args.language,
    });
    return wrapResult(result);
  },
);

// Tool 19 (v0.47): compare_interface_costs — consumer app vs PRO order book.
server.registerTool(
  "compare_interface_costs",
  {
    description:
      "当用户问\"同一个交易所为什么 App 买币这么贵？Kraken app / Instant Buy / Coinbase Simple / 简单交易的手续费是多少？听说 App 里藏了点差（hidden spread）？同一家交易所有两套价格？TUM 实测哪个欧洲平台最坑？\"时使用。Compares each venue's CONSUMER interface (Kraken app Instant Buy/custom orders, Coinbase Simple, Bitstamp Basic, Bitvavo Basic one-tap, Bitpanda/BISON spread-model brokerage) against its own PRO order-book benchmark on the same account. Evidence: TUM real-money €100 round-trip study (2025-10..11, six MiCA-licensed EU platforms) independently replicated by Frankfurt School (432 round-trips, 2026-03) — retail round-trips span 13x: Bitvavo 0.58% (pass-through, transparency benchmark) < Bison 2.58% < Kraken app 5.81% (3.81 pp hidden) < Bitpanda 6.23% (4.25 pp hidden) < Coinbase Simple 7.49% (4.51 pp hidden, worst; $2.99 flat fee dominates small DCA buys and simple LIMIT orders still carry a 1% execution fee). Returns per venue: consumer product name + fee model, modeled one-way all-in cost, measured round-trip, hidden markup pp, the PRO maker/taker base, the gap in pp, and — when monthly_volume_usd is passed — the annualized excess of using the consumer app instead of PRO (e.g. Coinbase at $1k/mo ≈ $168/yr); subscription caveats (Kraken+ $4.99/10k waiver, Coinbase One) and the fact that app volume earns NO PRO tier credit. Bitpanda/BISON have no separate PRO interface (the premium IS the fee); Bitstamp Basic is flagged unverified (no third-party measurement). Pass country to apply residency gating (Bitvavo/Bitpanda/BISON are venue-blocked outside their service areas). The same gap is auto-injected as consumer_interface hints into compare_exchange_fees / calculate_savings / compare_total_cost / recommend_exchange rows and as CONSUMER_INTERFACE_MORE_EXPENSIVE warnings on savings/recommendation results.",
    inputSchema: {
      exchange: z
        .string()
        .min(2)
        .optional()
        .describe("可选：只看单个交易所（已建模双界面的场馆：kraken/coinbase/bitvavo/bitstamp/bitpanda/bison）"),
      country: z
        .string()
        .min(2)
        .optional()
        .describe("ISO 3166-1 alpha-2 居住国代码，如 DE/FR/US/GB；用于逐行标注该场馆在居住国是否可用"),
      monthly_volume_usd: z
        .number()
        .positive()
        .optional()
        .describe("月交易额（USD），传入后计算 consumer 界面相对 PRO 的一年多花金额"),
      language: languageParam,
    },
    annotations: readOnlyAnnotations,
  },
  async (args) => {
    logCall("compare_interface_costs", args);
    const result = compareInterfaceCosts({
      ...(args.exchange ? { exchange: args.exchange } : {}),
      ...(args.country ? { country: args.country.toUpperCase() } : {}),
      ...(args.monthly_volume_usd !== undefined ? { monthlyVolumeUsd: args.monthly_volume_usd } : {}),
      language: args.language,
    });
    return wrapResult(result);
  },
);

  return server;
}
