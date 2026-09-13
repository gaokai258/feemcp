// Smoke test: spawn server, send MCP initialize + tools/list + tools/call, print responses.
import { spawn } from "node:child_process";

const child = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) console.log("RESP:", line);
  }
});

child.on("close", (code) => {
  console.log("server exited with", code);
});

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

// 1. initialize
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  },
});

setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }), 200);
setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), 400);
setTimeout(() => {
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "compare_exchange_fees", arguments: { purpose: "spot", country: "JP" } },
  });
}, 600);
setTimeout(() => {
  send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "get_referral_link", arguments: { exchange: "binance", country: "JP" } },
  });
}, 800);
setTimeout(() => {
  send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "calculate_savings",
      arguments: { exchange: "binance", volume: 100000, type: "futures", country: "JP" },
    },
  });
}, 1000);
setTimeout(() => {
  send({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "recommend_exchange",
      arguments: { purpose: "spot", country: "JP", volume: 100000, makerShare: 0.8, currency: "JPY" },
    },
  });
}, 1200);
setTimeout(() => {
  send({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "get_data_sources", arguments: {} },
  });
}, 1400);
setTimeout(() => {
  // Gate OR ladder: $10M volume = VIP3, but 12000 GT upgrades to VIP4.
  send({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "JP", monthlyVolumeUsd: 10000000, tokenBalance: 12000 },
    },
  });
}, 1600);
setTimeout(() => {
  // OKX VIP7 negative maker (rebate), pure maker trader at $500M volume.
  send({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "recommend_exchange",
      arguments: { purpose: "spot", country: "JP", volume: 500000000, makerShare: 1 },
    },
  });
}, 1800);
setTimeout(() => {
  // OKX asset path: zero volume but $500M account assets lifts spot to VIP9.
  send({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "JP", monthlyVolumeUsd: 0, accountAssetsUsd: 500000000 },
    },
  });
}, 2000);
setTimeout(() => {
  // Annualized cost: futures trading + funding + withdrawals + VIP upgrade quote.
  send({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "calculate_annual_cost",
      arguments: {
        exchange: "binance",
        purpose: "futures",
        country: "JP",
        monthlyVolumeUsd: 1000000,
        holdingHours: 720,
        withdrawalAsset: "USDT",
        withdrawalNetwork: "TRC-20",
        withdrawalsPerYear: 12,
      },
    },
  });
}, 2200);
setTimeout(() => {
  // v0.11: bybit asset path — zero volume, $1M assets lifts spot to VIP4.
  send({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "JP", monthlyVolumeUsd: 0, accountAssetsUsd: 1000000 },
    },
  });
}, 2400);
setTimeout(() => {
  // v0.11: MEXC without a referral link — MX 20% deduction, no referral layer.
  send({
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: {
      name: "calculate_savings",
      arguments: { exchange: "mexc", volume: 100000, type: "spot", country: "JP", useToken: true },
    },
  });
}, 2600);
setTimeout(() => {
  // v0.11: referral link not configured for the new exchanges.
  send({
    jsonrpc: "2.0",
    id: 14,
    method: "tools/call",
    params: { name: "get_referral_link", arguments: { exchange: "bitget", country: "JP" } },
  });
}, 2800);
setTimeout(() => {
  // v0.11: CN recommends across the five allowed exchanges.
  send({
    jsonrpc: "2.0",
    id: 15,
    method: "tools/call",
    params: {
      name: "recommend_exchange",
      arguments: { purpose: "futures", country: "CN", volume: 100000, makerShare: 1 },
    },
  });
}, 3000);
setTimeout(() => {
  // v0.12: pair-level promo — MEXC spot BTC/USDT is 0/0 in the 0-fee program.
  send({
    jsonrpc: "2.0",
    id: 16,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "JP", pair: "BTC/USDT", makerShare: 0.5 },
    },
  });
}, 3200);
setTimeout(() => {
  // v0.12: Binance FDUSD zero-maker promo — maker only, taker stays tier-based.
  send({
    jsonrpc: "2.0",
    id: 17,
    method: "tools/call",
    params: {
      name: "calculate_savings",
      arguments: { exchange: "binance", volume: 100000, type: "spot", country: "JP", pair: "BTC/FDUSD" },
    },
  });
}, 3400);
setTimeout(() => {
  // v0.13: KuCoin KCS OR-ladder — $1M volume = VIP1, 40,000 KCS lifts to VIP5;
  // spot rows also carry the Class A/B/C note.
  send({
    jsonrpc: "2.0",
    id: 18,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "JP", monthlyVolumeUsd: 1000000, tokenBalance: 40000 },
    },
  });
}, 3600);
setTimeout(() => {
  // v0.13: compliance — KuCoin is blocked in the US alongside bybit/mexc/bitget.
  send({
    jsonrpc: "2.0",
    id: 19,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "US" },
    },
  });
}, 3800);
setTimeout(() => {
  // v0.14: Kraken AOP OR-ladder — zero volume but $20k assets on platform lifts
  // spot from Tier 1 to Tier 3; row also carries exchange_notes caveats.
  send({
    jsonrpc: "2.0",
    id: 20,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "JP", monthlyVolumeUsd: 0, accountAssetsUsd: 20000 },
    },
  });
}, 4000);
setTimeout(() => {
  // v0.14: US availability — Kraken now shows up for US users (gate/kraken/okx).
  send({
    jsonrpc: "2.0",
    id: 21,
    method: "tools/call",
    params: {
      name: "recommend_exchange",
      arguments: { purpose: "spot", country: "US", volume: 100000 },
    },
  });
}, 4200);
setTimeout(() => {
  // v0.15: funding rates tool in bundled mode — offline, all 8 venues at 0.01%/8h.
  send({
    jsonrpc: "2.0",
    id: 22,
    method: "tools/call",
    params: {
      name: "get_funding_rates",
      arguments: { fundingMode: "bundled", fundingPair: "BTC/USDT" },
    },
  });
}, 4400);
setTimeout(() => {
  // v0.16: execution cost tool in bundled mode — offline typical-spread baselines,
  // 8 venues, half-spread crossing on a $25k BTC market order (no slippage offline).
  send({
    jsonrpc: "2.0",
    id: 23,
    method: "tools/call",
    params: {
      name: "get_execution_cost",
      arguments: { spreadMode: "bundled", pair: "BTC/USDT", purpose: "futures", side: "buy", tradeSizeUsd: 25000 },
    },
  });
}, 4600);
setTimeout(() => {
  // v0.16: total-cost comparison with bundled execution cost folded in.
  send({
    jsonrpc: "2.0",
    id: 24,
    method: "tools/call",
    params: {
      name: "compare_total_cost",
      arguments: { purpose: "futures", country: "JP", volume: 100000, tradeSizeUsd: 10000 },
    },
  });
}, 4800);
setTimeout(() => {
  // v0.17: fiat on-ramp cost, EU resident funding EUR 1000 — SEPA vs cards.
  send({
    jsonrpc: "2.0",
    id: 25,
    method: "tools/call",
    params: {
      name: "get_fiat_cost",
      arguments: { direction: "deposit", currency: "EUR", amount: 1000, country: "DE" },
    },
  });
}, 5000);
setTimeout(() => {
  // v0.17: USD cash-out without residency — wires/ACH region variants kept and labeled.
  send({
    jsonrpc: "2.0",
    id: 26,
    method: "tools/call",
    params: {
      name: "get_fiat_cost",
      arguments: { direction: "withdraw", currency: "USD", amount: 5000 },
    },
  });
}, 5200);
setTimeout(() => {
  // v0.18: withdrawal fees for USDT on TRC-20 across all 8 venues — offline table.
  send({
    jsonrpc: "2.0",
    id: 27,
    method: "tools/call",
    params: {
      name: "get_withdrawal_fees",
      arguments: { asset: "USDT", network: "TRC-20" },
    },
  });
}, 5400);
setTimeout(() => {
  // v0.18: ETH without a network — every venue's cheapest open L2/mainnet route,
  // native-unit fees converted via the bundled price snapshot.
  send({
    jsonrpc: "2.0",
    id: 28,
    method: "tools/call",
    params: {
      name: "get_withdrawal_fees",
      arguments: { asset: "ETH" },
    },
  });
}, 5600);
setTimeout(() => {
  // v0.19: Coinbase Advanced Trade as 9th venue — US spot fees at $50k/mo volume
  // (Tier 3: 0.20/0.35) alongside okx/gate/kraken; futures-only venues would break.
  send({
    jsonrpc: "2.0",
    id: 29,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "US", monthlyVolumeUsd: 50000 },
    },
  });
}, 5800);
setTimeout(() => {
  // v0.19: spot execution cost now spans all 10 venues — Coinbase bundled 2.0 bps
  // full spread (half-spread 1.0 crossing, no slippage offline).
  send({
    jsonrpc: "2.0",
    id: 30,
    method: "tools/call",
    params: {
      name: "get_execution_cost",
      arguments: { spreadMode: "bundled", pair: "BTC/USDT", purpose: "spot", side: "buy", tradeSizeUsd: 10000 },
    },
  });
}, 6000);
setTimeout(() => {
  // v0.20: futures execution cost excludes spot-only Coinbase (9 venues, not 10) —
  // Hyperliquid joins the perp table with a 0.8 bps bundled BTC spread.
  send({
    jsonrpc: "2.0",
    id: 31,
    method: "tools/call",
    params: {
      name: "get_execution_cost",
      arguments: { spreadMode: "bundled", pair: "BTC/USDT", purpose: "futures", side: "buy", tradeSizeUsd: 10000 },
    },
  });
}, 6200);
setTimeout(() => {
  // v0.20: Hyperliquid as 10th venue — JP futures at $100k/mo volume (Tier 0:
  // 0.015/0.045) with 10k HYPE staked (20% off → 0.012/0.036 effective)
  send({
    jsonrpc: "2.0",
    id: 32,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "futures", country: "JP", monthlyVolumeUsd: 100000, useToken: true, tokenBalance: 10000 },
    },
  });
}, 6400);
setTimeout(() => {
  // v0.20: USDC withdrawal to Arbitrum — Hyperliquid's single flat ~1 USDC route
  // appears alongside cheaper CEX routes (MEXC $0.0033 wins on Arbitrum)
  send({
    jsonrpc: "2.0",
    id: 33,
    method: "tools/call",
    params: {
      name: "get_withdrawal_fees",
      arguments: { asset: "USDC", network: "Arbitrum" },
    },
  });
}, 6600);
setTimeout(() => {
  // v0.21: JP spot comparison now returns 10 rows — BingX (served in JP) joins
  // at the Regular 0.10%/0.10% tier with no referral discount.
  send({
    jsonrpc: "2.0",
    id: 34,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "JP" },
    },
  });
}, 6800);
setTimeout(() => {
  // v0.21: BingX asset OR-track — $5M futures volume alone qualifies only the
  // volume-only Elite rung (0.018/0.045), but $50k previous-day account assets
  // lifts the effective tier to VIP1 (0.014/0.04); exchange_notes carry the
  // Elite/Supreme volume-only + API-volume <=20% caveats.
  send({
    jsonrpc: "2.0",
    id: 35,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "futures", country: "JP", monthlyVolumeUsd: 5000000, accountAssetsUsd: 50000 },
    },
  });
}, 7000);
setTimeout(() => {
  // v0.21: GB is a blocked jurisdiction for BingX — the GB futures table omits
  // BingX (and spot-only Coinbase never appears in futures comparisons).
  send({
    jsonrpc: "2.0",
    id: 36,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "futures", country: "GB" },
    },
  });
}, 7200);
setTimeout(() => {
  // v0.22: casual_buyer persona in US — card on-ramp dominates the annual
  // all-in; OKX wins with the card leg priced (4 US spot rows).
  send({
    jsonrpc: "2.0",
    id: 37,
    method: "tools/call",
    params: {
      name: "analyze_persona",
      arguments: { persona: "casual_buyer", country: "US" },
    },
  });
}, 7400);
setTimeout(() => {
  // v0.22: swing futures persona in JP — 10 futures rows, funding (160h/mo) is
  // the largest component, Hyperliquid flagged for missing USDT withdrawal.
  send({
    jsonrpc: "2.0",
    id: 38,
    method: "tools/call",
    params: {
      name: "analyze_persona",
      arguments: { persona: "swing_futures_trader", country: "JP" },
    },
  });
}, 7600);
setTimeout(() => {
  // v0.22: DEX-native persona in CN — 6 allowed venues incl. Hyperliquid,
  // whose 24x USDC CCTP withdrawals (~$24/yr) are fully priced.
  send({
    jsonrpc: "2.0",
    id: 39,
    method: "tools/call",
    params: {
      name: "analyze_persona",
      arguments: { persona: "dex_native", country: "CN" },
    },
  });
}, 7800);
setTimeout(() => {
  // v0.23: Binance spot BNB discount payback for a $100k/mo taker holding 5 BNB.
  send({
    jsonrpc: "2.0",
    id: 40,
    method: "tools/call",
    params: {
      name: "analyze_token_discount",
      arguments: { exchange: "binance", purpose: "spot", country: "SG", monthlyVolumeUsd: 100000, tokenBalance: 5 },
    },
  });
}, 8000);
setTimeout(() => {
  // v0.23: MEXC futures tier table — the 500-MX 50% tier should be recommended.
  send({
    jsonrpc: "2.0",
    id: 41,
    method: "tools/call",
    params: {
      name: "analyze_token_discount",
      arguments: { exchange: "mexc", purpose: "futures", country: "JP", monthlyVolumeUsd: 1000000, makerShare: 0.5 },
    },
  });
}, 8200);
setTimeout(() => {
  // v0.23: OKX has no separate native-token discount — returns an honest warning.
  send({
    jsonrpc: "2.0",
    id: 42,
    method: "tools/call",
    params: {
      name: "analyze_token_discount",
      arguments: { exchange: "okx", purpose: "spot", country: "SG", monthlyVolumeUsd: 100000 },
    },
  });
}, 8400);
setTimeout(() => {
  // v0.24: Phemex as 12th venue — JP spot at $2.5M/mo volume lands on VIP3
  // (0.045/0.065), volume-only ladder, no referral link.
  send({
    jsonrpc: "2.0",
    id: 43,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "JP", monthlyVolumeUsd: 2500000 },
    },
  });
}, 8600);
setTimeout(() => {
  // v0.24: Phemex PT token discount — flat 20% fee-deduction on spot+futures,
  // single synthetic tier (no holding ladder).
  send({
    jsonrpc: "2.0",
    id: 44,
    method: "tools/call",
    params: {
      name: "analyze_token_discount",
      arguments: { exchange: "phemex", purpose: "spot", country: "SG", monthlyVolumeUsd: 100000 },
    },
  });
}, 8800);
setTimeout(() => {
  // v0.24: Phemex futures — lowest maker in the industry at 0.01% standard tier.
  send({
    jsonrpc: "2.0",
    id: 45,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "futures", country: "JP" },
    },
  });
}, 9000);
setTimeout(() => {
  // v0.25: persona × token-discount cross-link — a single active_spot_trader
  // call returns the ranked all-in table PLUS concrete token-discount payback
  // hints for the top venues (e.g. MEXC MX 50% off, Binance BNB flat 10%).
  send({
    jsonrpc: "2.0",
    id: 46,
    method: "tools/call",
    params: {
      name: "analyze_persona",
      arguments: { persona: "active_spot_trader", country: "JP" },
    },
  });
}, 9200);
setTimeout(() => {
  // v0.26: full cost stack in compare_total_cost — 12 monthly EUR SEPA deposits
  // folded into each venue's total; free rails cost 0 but available=true,
  // Hyperliquid (no rail) is flagged fiat_deposit_available=false.
  send({
    jsonrpc: "2.0",
    id: 47,
    method: "tools/call",
    params: {
      name: "compare_total_cost",
      arguments: {
        purpose: "spot",
        country: "DE",
        volume: 10000,
        fiatCurrency: "EUR",
        fiatDepositAmountUsd: 1000,
        fiatDepositsPerYear: 12,
      },
    },
  });
}, 9400);
setTimeout(() => {
  // v0.26: calculate_annual_cost with both fiat legs — a German retail trader
  // doing monthly SEPA deposits and two SEPA cash-outs a year gets deposit +
  // cash-out costs inside annual_total_cost (Binance: free deposit, ~$2.18/yr
  // cash-out on top of the $96 trading fee).
  send({
    jsonrpc: "2.0",
    id: 48,
    method: "tools/call",
    params: {
      name: "calculate_annual_cost",
      arguments: {
        exchange: "binance",
        purpose: "spot",
        country: "DE",
        monthlyVolumeUsd: 10000,
        fiatCurrency: "EUR",
        fiatDepositAmountUsd: 1000,
        fiatDepositsPerYear: 12,
        fiatCashoutAmountUsd: 5000,
        fiatCashoutsPerYear: 2,
      },
    },
  });
}, 9600);
setTimeout(() => {
  // v0.27: fiat-aware recommend_exchange — a small German DCA buyer (€1,000 x12
  // SEPA/yr) is recommended Binance (free SEPA rail) over the fee-cheaper but
  // paid-SEPA MEXC; Hyperliquid carries fiat_deposit_available=false and an
  // explicit no-rail tradeoff.
  send({
    jsonrpc: "2.0",
    id: 49,
    method: "tools/call",
    params: {
      name: "recommend_exchange",
      arguments: {
        purpose: "spot",
        country: "DE",
        volume: 500,
        fiatCurrency: "EUR",
        fiatDepositAmountUsd: 1000,
        fiatDepositsPerYear: 12,
      },
    },
  });
}, 9800);
setTimeout(() => {
  // v0.28: compare_personas — all 7 personas for JP in one call: per-persona
  // winners, persona×venue matrix, venue win counts and most_versatile.
  // Hyperliquid headlines 3 personas but wins zero realistic (best_complete)
  // picks because it lacks fiat/withdrawal rails; OKX is most versatile.
  send({
    jsonrpc: "2.0",
    id: 50,
    method: "tools/call",
    params: {
      name: "compare_personas",
      arguments: { country: "JP" },
    },
  });
}, 10000);
setTimeout(() => {
  // v0.34: volume_what_if — US spot at $80k/mo: threshold-union sweep points,
  // per-venue tier curves/crossings, Coinbase next rung Tier 4 at $100k (+$20k,
  // ~$288/yr saving), Chinese narrative advice.
  send({
    jsonrpc: "2.0",
    id: 51,
    method: "tools/call",
    params: {
      name: "volume_what_if",
      arguments: { purpose: "spot", country: "US", baseVolume: 80000, language: "zh" },
    },
  });
}, 10200);
setTimeout(() => {
  // v0.35: compare_countries — casual card buyer across the default 7 countries:
  // Hyperliquid headlines outside US but lacks fiat rails (comparison basis
  // best_complete), DE cheapest realistic pick via Bybit rails, venue×country
  // availability matrix, Chinese narrative.
  send({
    jsonrpc: "2.0",
    id: 52,
    method: "tools/call",
    params: {
      name: "compare_countries",
      arguments: { persona: "casual_buyer", language: "zh" },
    },
  });
}, 10400);
setTimeout(() => {
  // v0.39: get_account_fee_tier — Phemex has no ccxt authenticated fee
  // endpoint, so the typed ACCOUNT_FEES_UNSUPPORTED error returns without any
  // network call (safe offline smoke).
  send({
    jsonrpc: "2.0",
    id: 53,
    method: "tools/call",
    params: {
      name: "get_account_fee_tier",
      arguments: {
        exchange: "phemex",
        purpose: "spot",
        country: "AU",
        apiKey: "redacted-smoke-key",
        secret: "redacted-smoke-secret",
      },
    },
  });
}, 10600);
setTimeout(() => {
  // v0.40: region allowlist — Bitstamp perps are EEA30-only, so an Australian
  // residency routed through the default key must be product-blocked (v0.38
  // wrongly over-opened this). Offline negative path, expected isError envelope.
  send({
    jsonrpc: "2.0",
    id: 54,
    method: "tools/call",
    params: {
      name: "calculate_savings",
      arguments: { exchange: "bitstamp", volume: 100000, type: "futures", country: "AU" },
    },
  });
}, 10750);
setTimeout(() => {
  // v0.41: post-MiCA-cliff venue-level region block — Binance holds no usable
  // CASP authorization, so a German resident gets COUNTRY_BLOCKED on any product.
  send({
    jsonrpc: "2.0",
    id: 55,
    method: "tools/call",
    params: {
      name: "calculate_savings",
      arguments: { exchange: "binance", volume: 10000, type: "futures", country: "DE" },
    },
  });
}, 10900);
setTimeout(() => {
  // v0.41: product-level region block — Bybit serves EEA spot (FMA CASP) but
  // its perps are unavailable EEA-wide pending MiFID II authorization.
  send({
    jsonrpc: "2.0",
    id: 56,
    method: "tools/call",
    params: {
      name: "calculate_savings",
      arguments: { exchange: "bybit", volume: 10000, type: "futures", country: "FR" },
    },
  });
}, 11050);
setTimeout(() => {
  // v0.42: Bitvavo (AFM MiCA CASP, EEA-passported) prices for DE spot at the
  // 0.15%/0.25% PRO base tier — the 8th EEA-usable spot venue.
  send({
    jsonrpc: "2.0",
    id: 57,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "DE" },
    },
  });
}, 11200);
setTimeout(() => {
  // v0.42: venue-level positive service-area allowlist — outside the EEA
  // (default-key AU residency) Bitvavo is venue-blocked, not silently open.
  send({
    jsonrpc: "2.0",
    id: 58,
    method: "tools/call",
    params: {
      name: "calculate_savings",
      arguments: { exchange: "bitvavo", volume: 10000, type: "spot", country: "AU" },
    },
  });
}, 11350);
setTimeout(() => {
  // v0.43: Finst (AFM MiCA CASP #41000015, SOR brokerage) prices for DE spot
  // at the flat 0.15%/0.15% rate — the 9th EEA-usable spot venue.
  send({
    jsonrpc: "2.0",
    id: 59,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "DE" },
    },
  });
}, 11500);
setTimeout(() => {
  // v0.43: venue-level positive allowlist — outside the EEA (default-key AU
  // residency, same for GB/CH) Finst is venue-blocked, not silently open.
  send({
    jsonrpc: "2.0",
    id: 60,
    method: "tools/call",
    params: {
      name: "calculate_savings",
      arguments: { exchange: "finst", volume: 10000, type: "spot", country: "AU" },
    },
  });
}, 11650);
setTimeout(() => {
  // v0.44: Bitpanda (BaFin/FMA spread-model brokerage) prices for GB spot at
  // the 1.49%/1.49% embedded premium — unlike Finst/Bitvavo its service area
  // INCLUDES Great Britain (EEA+GB region allowlist, GB single-member key).
  send({
    jsonrpc: "2.0",
    id: 61,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "GB" },
    },
  });
}, 11800);
setTimeout(() => {
  // v0.44: outside the EEA+GB service area (US residency) Bitpanda is
  // venue-blocked — the spread brokerage never silently opens to US users.
  send({
    jsonrpc: "2.0",
    id: 62,
    method: "tools/call",
    params: {
      name: "calculate_savings",
      arguments: { exchange: "bitpanda", volume: 10000, type: "spot", country: "US" },
    },
  });
}, 11950);
setTimeout(() => {
  // v0.45: BISON (EUWAX principal spread brokerage, EEA+CH service area via the
  // single-member CH region key) prices for CH spot at the 1.75%/1.75% headline
  // (no pair passed) — the 15th venue in the Swiss stack; notes carry the TUM
  // 2.58% measured vs 2.5% advertised transparency evidence.
  send({
    jsonrpc: "2.0",
    id: 63,
    method: "tools/call",
    params: {
      name: "compare_exchange_fees",
      arguments: { purpose: "spot", country: "CH" },
    },
  });
}, 12100);
setTimeout(() => {
  // v0.45: outside the EEA+CH service area (US residency; same for GB) BISON is
  // venue-blocked — deliberately complementary to Bitpanda (EEA+GB, not CH).
  send({
    jsonrpc: "2.0",
    id: 64,
    method: "tools/call",
    params: {
      name: "calculate_savings",
      arguments: { exchange: "bison", volume: 10000, type: "spot", country: "US" },
    },
  });
}, 12250);
setTimeout(() => {
  // v0.46: USDT MiCA access report for DE — restriction applies with the
  // 2026-07-01 cliff, self-custody preserved, 18 venue rows (coinbase
  // delisted 2024-12, bison never_offered, mexc venue_blocked).
  send({
    jsonrpc: "2.0",
    id: 65,
    method: "tools/call",
    params: {
      name: "get_stablecoin_access",
      arguments: { asset: "USDT", country: "DE" },
    },
  });
}, 12450);
setTimeout(() => {
  // v0.46: control case — USDC for DE is a MiCA-authorized asset (Circle
  // France EMI) with mica_authorized:true and applies:false.
  send({
    jsonrpc: "2.0",
    id: 66,
    method: "tools/call",
    params: {
      name: "get_stablecoin_access",
      arguments: { asset: "USDC", country: "DE" },
    },
  });
}, 12600);
setTimeout(() => {
  // v0.47: Kraken app vs Kraken Pro with monthly volume — expect the TUM
  // measured 5.81% round trip, the 4.21pp gap over Pro and the annualized
  // $84 excess at $1k/mo ((1.5 - 0.8)/100 * 1000 * 12).
  send({
    jsonrpc: "2.0",
    id: 67,
    method: "tools/call",
    params: {
      name: "compare_interface_costs",
      arguments: { exchange: "kraken", country: "DE", monthly_volume_usd: 1000 },
    },
  });
}, 12750);
setTimeout(() => {
  // v0.47: full six-venue report — Bitvavo 0.58% pass-through benchmark,
  // Coinbase Simple 7.49% worst, Bitpanda/BISON broker-only (no PRO ladder).
  send({
    jsonrpc: "2.0",
    id: 68,
    method: "tools/call",
    params: {
      name: "compare_interface_costs",
      arguments: {},
    },
  });
}, 12900);
setTimeout(() => child.kill(), 13050);
