import { describe, it, expect } from "vitest";
import {
  fetchAccountFee,
  accountFeeSupportFor,
  redactSecrets,
  ACCOUNT_FEE_SUPPORT,
  type AccountCcxtModule,
  type AccountCcxtClient,
} from "../src/account.js";
import type { LiveDeps } from "../src/live.js";

// ---------- fake ccxt plumbing ----------

interface FakeSettings {
  apiKey?: string;
  secret?: string;
  password?: string;
  walletAddress?: string;
  timeout?: number;
  enableRateLimit?: boolean;
}

const BTC_SPOT = {
  symbol: "BTC/USDT",
  base: "BTC",
  quote: "USDT",
  settle: undefined as string | undefined,
  swap: false,
  linear: false,
};
const BTC_PERP = {
  symbol: "BTC/USDT:USDT",
  base: "BTC",
  quote: "USDT",
  settle: "USDT",
  swap: true,
  linear: true,
};

interface FakeBehavior {
  hasFees?: boolean | string;
  hasFee?: boolean | string;
  fees?: Record<string, unknown>;
  fee?: { maker?: number | null; taker?: number | null };
  throwOn?: "fees" | "fee" | "load" | "never";
  errorName?: string;
  errorMessage?: string;
  markets?: Array<Record<string, unknown>>;
}

const ALL_CLASS_IDS = [
  "binance",
  "okx",
  "gate",
  "bybit",
  "mexc",
  "bitget",
  "kucoin",
  "kucoinfutures",
  "kraken",
  "krakenfutures",
  "coinbaseexchange",
  "hyperliquid",
  "bingx",
  "bitstamp",
  "phemex",
  "blofin",
];

function makeFakeModule(behavior: FakeBehavior, captured: FakeSettings[]): AccountCcxtModule {
  class FakeClient implements Partial<AccountCcxtClient> {
    timeout: number;
    has = {
      fetchTradingFees: behavior.hasFees as boolean | string | undefined,
      fetchTradingFee: behavior.hasFee as boolean | string | undefined,
    };
    markets: Record<string, any> = {};
    settings: FakeSettings;
    constructor(settings: Record<string, unknown> = {}) {
      this.settings = settings as FakeSettings;
      captured.push(this.settings);
      this.timeout = (settings.timeout as number) ?? 8000;
      for (const m of behavior.markets ?? [BTC_SPOT, BTC_PERP]) {
        this.markets[m.symbol as string] = m;
      }
    }
    async loadMarkets() {
      if (behavior.throwOn === "load") throw namedError(behavior);
      return undefined;
    }
    async fetchTradingFees() {
      if (behavior.throwOn === "fees") throw namedError(behavior);
      return behavior.fees ?? {};
    }
    async fetchTradingFee() {
      if (behavior.throwOn === "fee") throw namedError(behavior);
      return behavior.fee ?? {};
    }
  }
  return Object.fromEntries(
    ALL_CLASS_IDS.map((id) => [id, FakeClient]),
  ) as unknown as AccountCcxtModule;
}

function namedError(b: FakeBehavior): Error {
  const err = new Error(b.errorMessage ?? "boom");
  if (b.errorName) {
    Object.defineProperty(err, "constructor", {
      value: { name: b.errorName },
    });
    // err.constructor.name drives classifyError
  }
  return err;
}

/** Build a class whose constructor.name equals the ccxt error class name. */
function errorWithName(name: string, message: string): Error {
  const cls = {
    [name]: class extends Error {},
  }[name]!;
  return new cls(message);
}

function depsFor(behavior: FakeBehavior, captured: FakeSettings[] = []): LiveDeps {
  return {
    createCcxt: async () => makeFakeModule(behavior, captured),
  };
}

// ---------- tests ----------

describe("v0.39: static account-fee support matrix", () => {
  it("covers 13 of 18 venues for spot and the modeled futures split (v0.43 Finst, v0.44 Bitpanda and v0.45 Bison have no ccxt class)", () => {
    const venues = Object.keys(ACCOUNT_FEE_SUPPORT);
    expect(venues).toHaveLength(15);

    // v0.43: Finst offers no public trading API and ccxt 4.5.x ships no finst
    // class — it is deliberately absent from the matrix and must resolve via
    // the missing-spec unsupported path (ACCOUNT_FEES_UNSUPPORTED at the tool).
    expect(accountFeeSupportFor("finst", "spot")).toMatchObject({ supported: false, mode: "unsupported" });
    expect(accountFeeSupportFor("finst", "futures")).toMatchObject({ supported: false, mode: "unsupported" });

    // v0.44: Bitpanda's consumer brokerage quotes all-in spread prices with no
    // public fee API and ccxt 4.5.78 ships no bitpanda class (Fusion is a
    // separate product) — same missing-spec unsupported path.
    expect(accountFeeSupportFor("bitpanda", "spot")).toMatchObject({ supported: false, mode: "unsupported" });
    expect(accountFeeSupportFor("bitpanda", "futures")).toMatchObject({ supported: false, mode: "unsupported" });

    // v0.45: Bison is an EUWAX-principal spread brokerage with no order-book
    // API and ccxt 4.5.78 ships no bison/euwax class — same missing-spec path.
    expect(accountFeeSupportFor("bison", "spot")).toMatchObject({ supported: false, mode: "unsupported" });
    expect(accountFeeSupportFor("bison", "futures")).toMatchObject({ supported: false, mode: "unsupported" });

    const spotSupported = venues.filter((v) => accountFeeSupportFor(v, "spot").supported);
    expect(spotSupported.sort()).toEqual(
      [
        "binance",
        "okx",
        "gate",
        "bybit",
        "mexc",
        "bitget",
        "kucoin",
        "kraken",
        "coinbase",
        "hyperliquid",
        "bingx",
        "bitstamp",
        "bitvavo",
      ].sort(),
    );

    const futuresSupported = venues.filter((v) => accountFeeSupportFor(v, "futures").supported);
    expect(futuresSupported.sort()).toEqual(
      [
        "binance",
        "okx",
        "gate",
        "bybit",
        "mexc",
        "bitget",
        "kucoin",
        "kraken",
        "hyperliquid",
        "bingx",
      ].sort(),
    );

    // Split venues pick dedicated futures classes.
    expect(accountFeeSupportFor("kucoin", "futures").classId).toBe("kucoinfutures");
    expect(accountFeeSupportFor("kraken", "futures").classId).toBe("krakenfutures");
    expect(accountFeeSupportFor("coinbase", "futures").supported).toBe(false);
    expect(accountFeeSupportFor("bitstamp", "futures").supported).toBe(false);
    expect(accountFeeSupportFor("bitvavo", "futures").supported).toBe(false);
    expect(accountFeeSupportFor("bitvavo", "spot").classId).toBe("bitvavo");
    expect(accountFeeSupportFor("phemex", "spot").supported).toBe(false);
    expect(accountFeeSupportFor("blofin", "futures").supported).toBe(false);
  });
});

describe("v0.39: fetchAccountFee", () => {
  it("binance spot: prefers the per-symbol fee from fetchTradingFees and converts fractions to percent", async () => {
    const captured: FakeSettings[] = [];
    const res = await fetchAccountFee(
      "binance",
      "spot",
      { apiKey: "key-123", secret: "sec-456" },
      {
        deps: depsFor(
          {
            hasFees: true,
            fees: {
              trading: { maker: 0.001, taker: 0.001 },
              "BTC/USDT": { maker: 0.00075, taker: 0.001, symbol: "BTC/USDT" },
            },
          },
          captured,
        ),
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.method).toBe("fetchTradingFees");
    expect(res.pair).toBe("BTC/USDT");
    expect(res.maker_pct).toBe(0.075); // 0.00075 fraction = 0.075%
    expect(res.taker_pct).toBe(0.1);
    expect(res.credential_type).toBe("api_key");
    expect(captured[0]).toMatchObject({
      apiKey: "key-123",
      secret: "sec-456",
      enableRateLimit: true,
    });
  });

  it("falls back to the account-wide trading fee when the symbol entry is incomplete", async () => {
    const res = await fetchAccountFee(
      "bybit",
      "futures",
      { apiKey: "k", secret: "s" },
      {
        deps: depsFor({
          hasFees: true,
          fees: {
            "BTC/USDT:USDT": { maker: null, taker: 0.00055 },
            trading: { maker: 0.0002, taker: 0.00055 },
          },
        }),
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pair).toBe("BTC/USDT:USDT");
    expect(res.maker_pct).toBe(0.02);
    expect(res.taker_pct).toBe(0.055);
  });

  it("okx futures: uses fetchTradingFee(symbol) and forwards the passphrase as password", async () => {
    const captured: FakeSettings[] = [];
    const res = await fetchAccountFee(
      "okx",
      "futures",
      { apiKey: "okx-key", secret: "okx-sec", password: "my-passphrase" },
      {
        deps: depsFor(
          { hasFees: false, hasFee: true, fee: { maker: 0.0002, taker: 0.0005 } },
          captured,
        ),
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.method).toBe("fetchTradingFee");
    expect(res.pair).toBe("BTC/USDT:USDT");
    expect(res.maker_pct).toBe(0.02);
    expect(res.taker_pct).toBe(0.05);
    expect(captured[0].password).toBe("my-passphrase");
  });

  it("hyperliquid: public wallet address only — no secret required, walletAddress wired", async () => {
    const captured: FakeSettings[] = [];
    const addr = "0x0123456789abcdef0123456789abcdef01234567";
    const res = await fetchAccountFee(
      "hyperliquid",
      "futures",
      { apiKey: addr },
      {
        deps: depsFor(
          { hasFees: false, hasFee: true, fee: { maker: 0.00035, taker: 0.00035 } },
          captured,
        ),
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.credential_type).toBe("wallet_address");
    expect(captured[0].walletAddress).toBe(addr);
    expect(captured[0].apiKey).toBeUndefined();
    expect(captured[0].secret).toBeUndefined();
  });

  it("rejects missing credentials without any network-ish call", async () => {
    const r1 = await fetchAccountFee("binance", "spot", { apiKey: "k" });
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.code).toBe("ACCOUNT_MISSING_CREDENTIALS");

    const r2 = await fetchAccountFee("hyperliquid", "spot", { apiKey: "" });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.code).toBe("ACCOUNT_MISSING_CREDENTIALS");
  });

  it("statically unsupported venues fail with ACCOUNT_FEES_UNSUPPORTED (phemex/blofin/bitstamp perps, v0.44 bitpanda, v0.45 bison)", async () => {
    const r1 = await fetchAccountFee("phemex", "spot", { apiKey: "k", secret: "s" });
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.code).toBe("ACCOUNT_FEES_UNSUPPORTED");
    expect(r1.note).toMatch(/ccxt/i);

    const r2 = await fetchAccountFee("blofin", "futures", { apiKey: "k", secret: "s" });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.code).toBe("ACCOUNT_FEES_UNSUPPORTED");

    const r3 = await fetchAccountFee("bitstamp", "futures", { apiKey: "k", secret: "s" });
    expect(r3.ok).toBe(false);
    if (r3.ok) return;
    expect(r3.code).toBe("ACCOUNT_FEES_UNSUPPORTED");

    // v0.44: no ccxt bitpanda class — unsupported for either product without touching deps.
    const r4 = await fetchAccountFee("bitpanda", "spot", { apiKey: "k", secret: "s" });
    expect(r4.ok).toBe(false);
    if (r4.ok) return;
    expect(r4.code).toBe("ACCOUNT_FEES_UNSUPPORTED");
    const r5 = await fetchAccountFee("bitpanda", "futures", { apiKey: "k", secret: "s" });
    expect(r5.ok).toBe(false);
    if (r5.ok) return;
    expect(r5.code).toBe("ACCOUNT_FEES_UNSUPPORTED");

    // v0.45: no ccxt bison class — same static unsupported path.
    const r6 = await fetchAccountFee("bison", "spot", { apiKey: "k", secret: "s" });
    expect(r6.ok).toBe(false);
    if (r6.ok) return;
    expect(r6.code).toBe("ACCOUNT_FEES_UNSUPPORTED");
  });

  it("runtime class with no usable fee surface also reports ACCOUNT_FEES_UNSUPPORTED", async () => {
    const res = await fetchAccountFee(
      "mexc",
      "spot",
      { apiKey: "k", secret: "s" },
      { deps: depsFor({ hasFees: false, hasFee: false }) },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("ACCOUNT_FEES_UNSUPPORTED");
  });

  it("classifies AuthenticationError as ACCOUNT_AUTH_FAILED, non-retryable", async () => {
    const res = await fetchAccountFee(
      "binance",
      "spot",
      { apiKey: "k", secret: "s" },
      {
        deps: {
          createCcxt: async () => ({
            binance: class {
              timeout = 8000;
              has = { fetchTradingFees: true, fetchTradingFee: false };
              markets = { "BTC/USDT": BTC_SPOT };
              async loadMarkets() {}
              async fetchTradingFees() {
                throw errorWithName("AuthenticationError", "bad key");
              }
            } as unknown as AccountCcxtModule[string],
          }) as unknown as Promise<AccountCcxtModule>,
        },
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("ACCOUNT_AUTH_FAILED");
    expect(res.retryable).toBe(false);
  });

  it("classifies network/timeout errors as retryable ACCOUNT_FEE_FETCH_FAILED", async () => {
    const res = await fetchAccountFee(
      "gate",
      "spot",
      { apiKey: "k", secret: "s" },
      {
        deps: {
          createCcxt: async () => ({
            gate: class {
              timeout = 8000;
              has = { fetchTradingFees: true };
              markets = { "BTC/USDT": BTC_SPOT };
              async loadMarkets() {}
              async fetchTradingFees() {
                throw errorWithName("RequestTimeout", "timed out");
              }
            } as unknown as AccountCcxtModule[string],
          }) as unknown as Promise<AccountCcxtModule>,
        },
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("ACCOUNT_FEE_FETCH_FAILED");
    expect(res.retryable).toBe(true);
  });

  it("scrubs literal credential values out of error messages", async () => {
    const secret = "supersecret-value-987654";
    const res = await fetchAccountFee(
      "binance",
      "spot",
      { apiKey: "key-abc", secret },
      {
        deps: {
          createCcxt: async () => ({
            binance: class {
              timeout = 8000;
              has = { fetchTradingFees: true };
              markets = { "BTC/USDT": BTC_SPOT };
              async loadMarkets() {}
              async fetchTradingFees() {
                throw errorWithName(
                  "ExchangeError",
                  `signature mismatch for ${secret}&passphrase=leaked-pass`,
                );
              }
            } as unknown as AccountCcxtModule[string],
          }) as unknown as Promise<AccountCcxtModule>,
        },
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toContain(secret);
    expect(res.error).toContain("***REDACTED***");
    expect(res.error).not.toContain("leaked-pass");
  });

  it("fails cleanly when no market for the pair exists", async () => {
    const res = await fetchAccountFee(
      "binance",
      "futures",
      { apiKey: "k", secret: "s" },
      {
        pair: "DOGE/USD",
        deps: depsFor({
          hasFees: true,
          markets: [BTC_SPOT], // no swap, no DOGE
        }),
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("ACCOUNT_FEE_FETCH_FAILED");
    expect(res.error).toMatch(/no futures market/);
  });

  it("redactSecrets masks credential keys recursively and leaves other data intact", () => {
    const out = redactSecrets({
      tool: "get_account_fee_tier",
      args: {
        exchange: "binance",
        apiKey: "abc",
        nested: { secret: "xyz", password: "p", keep: 1 },
      },
    });
    expect(out.args.apiKey).toBe("***REDACTED***");
    expect(out.args.nested.secret).toBe("***REDACTED***");
    expect(out.args.nested.password).toBe("***REDACTED***");
    expect(out.args.nested.keep).toBe(1);
    expect(out.tool).toBe("get_account_fee_tier");
  });
});
