// v0.39: read-only account fee-tier adapter.
//
// Bundled fee_rates.json quotes the PUBLIC fee schedule. Users with an
// account often pay a different EFFECTIVE rate (VIP tier reached on the
// venue's own 30-day window, BNB/GT/KCS deductions applied server-side,
// negotiated / sub-account rates, promotional programs). This module pulls
// the caller's ACTUAL maker/taker via ccxt's authenticated fee endpoints
// using a READ-ONLY API key supplied per request.
//
// Security constraints (deliberate):
// - Credentials arrive per call and are NEVER cached, logged or returned.
//   There is deliberately no TTL cache here (unlike live.ts public data):
//   cache keys would have to include secrets.
// - Every error string is scrubbed of the supplied credential values before
//   it leaves this module (exchange error payloads occasionally echo keys).
// - The tool schema/description only ever asks for READ-ONLY keys.
//
// ccxt 4.5.78 capability matrix (has flags inspected at runtime):
//   spot:     fetchTradingFees  binance/gate/bybit/bitget/coinbase/bitstamp
//             fetchTradingFee   okx/mexc/kucoin/kraken/hyperliquid(wallet)/bingx
//             unsupported       phemex, blofin
//   futures:  fetchTradingFees  binance/gate/bybit/bitget/krakenfutures/
//                               (bitstamp perps not modeled by ccxt spot class)
//             fetchTradingFee   okx/mexc/kucoinfutures/hyperliquid(wallet)/bingx
//             unsupported       phemex, blofin, bitstamp (ccxt gap), coinbase (spot-only)

import { normalizeFundingPair, resolveTradeSymbol } from "./live.js";
import type { CcxtMarket, LiveDeps } from "./live.js";
import type { TradingPurpose } from "./types.js";

// ---------- credentials ----------

export interface AccountCredentials {
  /** API key; for Hyperliquid this is the PUBLIC wallet address (0x…). */
  apiKey: string;
  /** API secret; not required for the wallet-address-based Hyperliquid flow. */
  secret?: string;
  /** Passphrase: OKX API passphrase, KuCoin Futures passphrase, etc. */
  password?: string;
}

export type CredentialType = "api_key" | "wallet_address";

// ---------- ccxt structural surface ----------

export interface CcxtFeeEntry {
  maker?: number | null;
  taker?: number | null;
  symbol?: string;
  percentage?: boolean;
  info?: unknown;
}

export interface CcxtFees {
  trading?: CcxtFeeEntry;
  [symbol: string]: CcxtFeeEntry | unknown;
}

export interface AccountCcxtClient {
  timeout: number;
  has: {
    fetchTradingFees?: boolean | string;
    fetchTradingFee?: boolean | string;
  };
  markets: Record<string, CcxtMarket>;
  walletAddress?: string;
  loadMarkets(): Promise<unknown>;
  fetchTradingFees?(params?: Record<string, unknown>): Promise<CcxtFees>;
  fetchTradingFee?(
    symbol: string,
    params?: Record<string, unknown>,
  ): Promise<CcxtFeeEntry>;
}

export type AccountCcxtModule = Record<
  string,
  new (settings?: Record<string, unknown>) => AccountCcxtClient
>;

// ---------- static venue capability matrix ----------

export type FeeAccessMode = "fees" | "fee_symbol" | "wallet_symbol" | "unsupported";

interface VenueAccountSupport {
  /** ccxt class id for spot markets. */
  spot_class: string;
  /** ccxt class id for futures markets; null = ccxt has no such class. */
  futures_class: string | null;
  /** "wallet_symbol" only for Hyperliquid (public address, no secret). */
  mode: FeeAccessMode;
  note?: string;
}

/**
 * Static support as of ccxt 4.5.78. Modes reflect what the installed ccxt
 * actually implements (has flag); "unsupported" venues fail fast WITHOUT a
 * network call. Spot/futures split venues use dedicated futures classes.
 */
export const ACCOUNT_FEE_SUPPORT: Record<string, VenueAccountSupport> = {
  binance: { spot_class: "binance", futures_class: "binance", mode: "fees" },
  okx: {
    spot_class: "okx",
    futures_class: "okx",
    mode: "fee_symbol",
    note: "requires the API passphrase as password",
  },
  gate: { spot_class: "gate", futures_class: "gate", mode: "fees" },
  bybit: { spot_class: "bybit", futures_class: "bybit", mode: "fees" },
  mexc: { spot_class: "mexc", futures_class: "mexc", mode: "fee_symbol" },
  bitget: { spot_class: "bitget", futures_class: "bitget", mode: "fees" },
  kucoin: {
    spot_class: "kucoin",
    futures_class: "kucoinfutures",
    mode: "fee_symbol",
    note: "futures use the kucoinfutures class with its own API key+passphrase",
  },
  kraken: {
    spot_class: "kraken",
    futures_class: "krakenfutures",
    mode: "fee_symbol",
  },
  coinbase: {
    spot_class: "coinbaseexchange",
    futures_class: null,
    mode: "fees",
    note: "spot only (Advanced Trade); retail nano perps not in ccxt",
  },
  hyperliquid: {
    spot_class: "hyperliquid",
    futures_class: "hyperliquid",
    mode: "wallet_symbol",
    note: "no API key/secret — pass the PUBLIC wallet address as apiKey",
  },
  bingx: { spot_class: "bingx", futures_class: "bingx", mode: "fee_symbol" },
  phemex: {
    spot_class: "phemex",
    futures_class: "phemex",
    mode: "unsupported",
    note: "ccxt 4.5.78 exposes no authenticated fee endpoint for Phemex",
  },
  blofin: {
    spot_class: "blofin",
    futures_class: "blofin",
    mode: "unsupported",
    note: "ccxt 4.5.78 exposes no authenticated fee endpoint for BloFin",
  },
  bitstamp: {
    spot_class: "bitstamp",
    futures_class: null,
    mode: "fees",
    note: "spot via ccxt; EU/EEA perps are not modeled by the ccxt class yet",
  },
  bitvavo: {
    spot_class: "bitvavo",
    futures_class: null,
    mode: "fees",
    note: "spot only; no exchange-hosted derivatives (AFM MiCA CASP, EEA-only)",
  },
};

export function accountFeeSupportFor(
  exchange: string,
  purpose: TradingPurpose,
): { supported: boolean; classId?: string; mode: FeeAccessMode; note?: string } {
  const spec = ACCOUNT_FEE_SUPPORT[exchange.toLowerCase()];
  if (!spec || spec.mode === "unsupported") {
    return { supported: false, mode: "unsupported", note: spec?.note };
  }
  const classId = purpose === "spot" ? spec.spot_class : spec.futures_class;
  if (!classId) {
    return {
      supported: false,
      mode: "unsupported",
      note: spec.note ?? `no ccxt market class for ${purpose}`,
    };
  }
  return { supported: true, classId, mode: spec.mode, note: spec.note };
}

// ---------- result / error types ----------

export interface AccountFeeSuccess {
  ok: true;
  exchange: string;
  purpose: TradingPurpose;
  pair: string;
  fetched_at: string;
  /** Which ccxt surface produced the rate. */
  method: "fetchTradingFees" | "fetchTradingFee";
  credential_type: CredentialType;
  /** Actual account rates in PERCENT (0.02 = 0.02%; negative maker = rebate). */
  maker_pct: number;
  taker_pct: number;
}

export type AccountFeeErrorCode =
  | "ACCOUNT_FEES_UNSUPPORTED"
  | "ACCOUNT_MISSING_CREDENTIALS"
  | "ACCOUNT_AUTH_FAILED"
  | "ACCOUNT_FEE_FETCH_FAILED";

export interface AccountFeeFailure {
  ok: false;
  exchange: string;
  purpose: TradingPurpose;
  code: AccountFeeErrorCode;
  error: string;
  /** True when retrying later may help (rate limit / network), else false. */
  retryable: boolean;
  note?: string;
}

export type AccountFeeResult = AccountFeeSuccess | AccountFeeFailure;

// ---------- helpers ----------

const DEFAULT_TIMEOUT_MS = 10000;
const SECRET_KEY_RE = /^(api[_-]?key|api[_-]?secret|secret|password|passphrase|private[_-]?key|wallet[_-]?address)$/i;

/**
 * Recursively replace credential-bearing values (and explicit key names) with
 * a redaction marker. Used before any args/error string hits a log sink.
 */
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "***REDACTED***" : redactSecrets(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** Scrub the literal credential values out of an exchange error message. */
function scrubMessage(message: string, creds: AccountCredentials): string {
  let out = message;
  for (const v of [creds.apiKey, creds.secret, creds.password]) {
    if (v && v.length >= 4) {
      out = out.split(v).join("***REDACTED***");
    }
  }
  // Never echo a full signed query string even if keys were URL-encoded oddly.
  out = out.replace(/(signature|sign|passphrase|password)=([^&\s"]+)/gi, "$1=***REDACTED***");
  return out.slice(0, 500);
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** ccxt fees are decimal fractions while our model stores PERCENT. */
function fractionToPct(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return round6(v * 100);
}

function pickBundledStyleFee(fees: CcxtFees, symbol: string | undefined): {
  maker_pct: number;
  taker_pct: number;
  method: "fetchTradingFees" | "fetchTradingFee";
} {
  // Prefer the account fee for the actual requested market (venues run
  // different rates per class/quote); fall back to the account-wide default.
  const candidates: CcxtFeeEntry[] = [];
  if (symbol) {
    const exact = fees[symbol];
    if (exact && typeof exact === "object") candidates.push(exact as CcxtFeeEntry);
  }
  if (fees.trading && typeof fees.trading === "object") candidates.push(fees.trading);
  for (const c of candidates) {
    const maker = fractionToPct(c.maker);
    const taker = fractionToPct(c.taker);
    if (maker !== null && taker !== null) {
      return { maker_pct: maker, taker_pct: taker, method: "fetchTradingFees" };
    }
  }
  throw new Error("fee response carried no numeric maker/taker");
}

/** Classify ccxt error class names into our auth/network/other buckets. */
function classifyError(
  err: unknown,
): { code: AccountFeeErrorCode; retryable: boolean } {
  const name = err instanceof Error ? err.constructor.name : "";
  if (/Authentication|PermissionDenied|AccountSuspended|AccountNotEnabled|Login/i.test(name)) {
    return { code: "ACCOUNT_AUTH_FAILED", retryable: false };
  }
  if (/Network|RequestTimeout|DDoSProtection|RateLimitExceeded|ExchangeNotAvailable|OnMaintenance/i.test(name)) {
    return { code: "ACCOUNT_FEE_FETCH_FAILED", retryable: true };
  }
  return { code: "ACCOUNT_FEE_FETCH_FAILED", retryable: false };
}

let ccxtModulePromise: Promise<AccountCcxtModule> | null = null;

async function loadCcxt(deps?: LiveDeps): Promise<AccountCcxtModule> {
  if (deps?.createCcxt) {
    return (await deps.createCcxt()) as unknown as AccountCcxtModule;
  }
  if (!ccxtModulePromise) {
    ccxtModulePromise = import("ccxt") as unknown as Promise<AccountCcxtModule>;
  }
  return ccxtModulePromise;
}

/** Visible for tests. */
export function _resetAccountCcxtCache(): void {
  ccxtModulePromise = null;
}

// ---------- main entry ----------

export interface FetchAccountFeeOptions {
  /** Market pair to resolve the fee for, default BTC/USDT. */
  pair?: string;
  timeoutMs?: number;
  /** Test seam: fake ccxt module (same injection shape as live.ts). */
  deps?: LiveDeps;
}

/**
 * Fetch the account's REAL maker/taker fee with read-only credentials.
 * Never throws: every failure is a typed AccountFeeFailure with a scrubbed
 * message. No caching — credentials must not linger in memory.
 */
export async function fetchAccountFee(
  exchange: string,
  purpose: TradingPurpose,
  creds: AccountCredentials,
  opts: FetchAccountFeeOptions = {},
): Promise<AccountFeeResult> {
  const lower = exchange.toLowerCase();
  const support = accountFeeSupportFor(lower, purpose);
  const fail = (
    code: AccountFeeErrorCode,
    error: string,
    retryable: boolean,
    note?: string,
  ): AccountFeeFailure => ({ ok: false, exchange: lower, purpose, code, error, retryable, ...(note ? { note } : {}) });

  if (!support.supported || !support.classId) {
    return fail(
      "ACCOUNT_FEES_UNSUPPORTED",
      `Authenticated fee lookup for ${lower} ${purpose} is not supported by the bundled ccxt 4.5.x connector.`,
      false,
      support.note,
    );
  }

  const isWallet = support.mode === "wallet_symbol";
  if (!creds.apiKey || !creds.apiKey.trim()) {
    return fail(
      "ACCOUNT_MISSING_CREDENTIALS",
      isWallet
        ? "Hyperliquid requires the PUBLIC wallet address (0x…) in apiKey."
        : "apiKey is required.",
      false,
    );
  }
  if (!isWallet && !(creds.secret && creds.secret.trim())) {
    return fail("ACCOUNT_MISSING_CREDENTIALS", "secret is required for this exchange.", false);
  }

  const pair = normalizeFundingPair(opts.pair);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let ccxtModule: AccountCcxtModule | null = null;
  try {
    ccxtModule = await loadCcxt(opts.deps);
  } catch (err) {
    return fail(
      "ACCOUNT_FEE_FETCH_FAILED",
      scrubMessage(err instanceof Error ? err.message : String(err), creds),
      true,
      "ccxt module unavailable",
    );
  }

  const Klass = ccxtModule[support.classId];
  if (!Klass) {
    return fail(
      "ACCOUNT_FEES_UNSUPPORTED",
      `ccxt has no exchange class '${support.classId}'.`,
      false,
      support.note,
    );
  }

  const clientSettings: Record<string, unknown> = {
    timeout: timeoutMs,
    enableRateLimit: true,
  };
  if (isWallet) {
    // Hyperliquid: public address only; the fee endpoint is a public
    // userFees query keyed by the address — no signing secret involved.
    clientSettings.walletAddress = creds.apiKey.trim();
  } else {
    clientSettings.apiKey = creds.apiKey.trim();
    clientSettings.secret = creds.secret!.trim();
    if (creds.password && creds.password.trim()) {
      clientSettings.password = creds.password.trim();
    }
  }

  try {
    const client = new Klass(clientSettings);
    await client.loadMarkets();
    const [base, quote] = pair.split("/");
    const symbol = resolveTradeSymbol(client.markets, base, quote, purpose);
    if (!symbol) {
      return fail(
        "ACCOUNT_FEE_FETCH_FAILED",
        `no ${purpose} market for ${pair} on ${support.classId}`,
        false,
      );
    }

    // 1) Account-wide fee schedule when the class implements it.
    const hasFees = client.has?.fetchTradingFees;
    if (hasFees === true && client.fetchTradingFees) {
      const fees = await client.fetchTradingFees();
      const picked = pickBundledStyleFee(fees, symbol);
      return {
        ok: true,
        exchange: lower,
        purpose,
        pair: symbol,
        fetched_at: new Date().toISOString(),
        method: picked.method,
        credential_type: isWallet ? "wallet_address" : "api_key",
        maker_pct: picked.maker_pct,
        taker_pct: picked.taker_pct,
      };
    }

    // 2) Per-symbol actual fee (often hits a private fee-rate endpoint).
    const hasFee = client.has?.fetchTradingFee;
    if (hasFee && client.fetchTradingFee) {
      const fee = await client.fetchTradingFee(symbol);
      const maker = fractionToPct(fee.maker);
      const taker = fractionToPct(fee.taker);
      if (maker === null || taker === null) {
        throw new Error("fee response carried no numeric maker/taker");
      }
      return {
        ok: true,
        exchange: lower,
        purpose,
        pair: symbol,
        fetched_at: new Date().toISOString(),
        method: "fetchTradingFee",
        credential_type: isWallet ? "wallet_address" : "api_key",
        maker_pct: maker,
        taker_pct: taker,
      };
    }

    return fail(
      "ACCOUNT_FEES_UNSUPPORTED",
      `ccxt class '${support.classId}' reports no authenticated fee endpoint at runtime.`,
      false,
      support.note,
    );
  } catch (err) {
    const { code, retryable } = classifyError(err);
    return fail(
      code,
      scrubMessage(
        err instanceof Error ? err.message : String(err),
        creds,
      ) || "fee fetch failed without an error message",
      retryable,
      code === "ACCOUNT_AUTH_FAILED"
        ? "check that the key/secret/passphrase are correct and IP-restriction / KYC requirements are met"
        : undefined,
    );
  }
}
