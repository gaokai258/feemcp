# Changelog

All notable changes to **fee-optimizer-mcp** are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); the project uses semantic versioning.

> Note: this project predates this changelog. Entries for 0.20.0–0.46.0 are reconstructed from release notes embedded in `README.md` / `server.json`; their original release dates and git tags were not recorded (no pre-existing git history in the working tree). Only 0.47.0 carries an actual completion date. Patch releases, if any, were folded into the minor entries.

## [0.49.0] — 2026-09-20

### Added
- **Referral coverage 4 → 10 venues**: [`data/referral_links.json`](data/referral_links.json) now carries the operator's 20%-user-discount invite links for **Bybit, MEXC, KuCoin, BingX, BloFin and Bitvavo** (official venue domains / invite short links), alongside the existing Binance, OKX, Bitget and Gate.io programs. All six are `regions: ["global"]`; compliance gating in the tools is unchanged (a link only resolves where the venue itself is allowed).
- **Plan-B reachability probe** — the first step toward the deferred continuous spread-observation pipeline. `scripts/probe-reachability.mjs` (`npm run probe:reachability`) exercises the *real* live code path per venue × purpose — ccxt `loadMarkets()` → engine symbol resolution → `fetchOrderBook()` — from the current host, classifies failures (`geo_block` 451 / `http_403` / `timeout` / `dns` / `rate_limited` / …, one retry on transient network errors), and emits a console table, a GitHub Job-Summary markdown table and a `--json` report. The new manually dispatched workflow `.github/workflows/reachability-probe.yml` records the runner's egress location via ipinfo.io and uploads the JSON report as a 90-day artifact; only `reachable+booked` rows are candidates for a scheduled GH-runner collector. Read-only, no credentials, no schedule.
- `src/live.ts` now exports `CCXT_IDS` and `CCXT_SPOT_ID_OVERRIDES` so the probe can never drift from the venue mappings the live engine actually uses.

### Changed
- **Recommendation economics now price the six new referral layers.** MEXC's 0.04% futures taker × 0.8 = 0.032% makes it the cheapest taker-heavy futures pick in JP (previously Binance) and the most versatile venue in the JP persona matrix (4 complete wins, previously OKX with 3); the JP casual-buyer cross-country spread moves $52.55 → $53.75 (Germany-via-Bybit remains the cheapest realistic complete pick). Spot/futures effective rates for the six venues now include the 20% layer (e.g. BingX 0.05→0.04, BloFin 0.06→0.048, Bitvavo 0.15/0.25→0.12/0.20); token + referral stacking tests updated for MEXC and KuCoin.
- `ReferralLink.my_rebate_rate` is now **optional**: the operator rebate share remains recorded for the four original affiliate programs but is not published for the six new ones. The field was never exposed by any tool.

## [0.48.0] — 2026-09-14

### Added
- **`get_fee_changes` (20th tool)** — the auditable fee-schedule change feed (the project's data-moat layer). Returns curated, official-announcement-verified changes (`confidence: high|medium`, with effective date, source URL, bilingual summary and structured before/after where the source states numbers) merged with `detected` rows auto-derived by diffing consecutive monthly fee-ladder snapshots — clearly labeled unverified, since a snapshot delta can be a data correction rather than a venue-side change. Covers `rate | threshold | ladder_structure | promo | token_discount | pricing_model` kinds; filters `exchange` / `product` (`spot|futures|all`) / `since_month` / `limit`; sorted date-descending then confidence rank; bilingual advice.
- New pure/offline engine `src/fee-history.ts`: deterministic ladder normalization, snapshot diffing (rungs matched by tier name; rate fields use round4 percent precision; non-numeric edits intentionally ignored), adjacent-snapshot change detection, current-data drift detection and report assembly — shared by the tool and the CLI so the logic has one implementation.
- New data bundle [`data/fee_changes.json`](data/fee_changes.json) (15th audited data file) with seven high-confidence seeds (Bitstamp 2026-09-01, OKX 2026-08-14, Kraken 2026-07-09, BingX Elite rung ×2 on 2026-06-26, KuCoin 2026-05-07, Bitget 2025-07-01). Complete pre-2026-09 history is not reconstructable from primary sources, so only changes evidenced by official pages already cited in `fee_rates.json` are seeded; the file states this explicitly.
- Monthly deterministic snapshots in **repo-only** `snapshots/fee_ladders/YYYY-MM.json` (2026-09 baseline, 18 venues) plus the `scripts/fee-snapshot.mjs` CLI (`npm run snapshot:fees -- snapshot|diff|latest`; exit codes 0/2 for no-change/change, 3 when no snapshot exists). Snapshots are excluded from the npm tarball via the existing `files` allowlist; npm consumers degrade to the curated feed with `snapshot_coverage.available: false`, and a missing/corrupt snapshot directory never throws.
- New GitHub Actions workflow `.github/workflows/data-snapshot.yml`: on the 1st of each month (03:17 UTC, also manually dispatchable) it rebuilds and captures the snapshot, diffs against the previous month, and opens a **review-only PR** with the detected changes. Detected rows never enter `fee_changes.json` automatically — a human verifies against the official fee page and curates the entry separately. No exchange API calls are made, so runner geo-restrictions are irrelevant.
- CI `pack` job now asserts `data/fee_changes.json` ships in the tarball and negatively asserts that `snapshots/` does not.

### Fixed
- **Rate-diff precision bug** (caught by the new engine tests): rate fields were compared at raw precision, so a sub-round4 delta (e.g. 0.1 vs 0.10004) emitted a `detected` rate change whose before/after bags were identical. Rate fields are now compared after round4.
- `package.json` description advertised a `list_personas` tool that is used internally but never registered as an MCP tool; the tool list now ends with the actual 20-tool set including `get_fee_changes`.
- `resetCachesForTest()` now also clears the fee-changes/snapshot loaders' caches for test isolation.

### Changed
- Tool count 19 → 20 and audited data files 14 → 15 across `package.json` / `server.json` / `manifest.json` / README / HTTP smoke and test assertions; 22 new offline engine tests (481 total).

## [0.47.3] — 2026-09-14

### Fixed
- **Reported version drift**: `SERVER_VERSION` was hardcoded at `0.47.0` in `mcp-server.ts`, so 0.47.x packages self-reported `fee-optimizer-mcp v0.47.0` via `--version` and MCP `initialize` serverInfo. Version is now read from `package.json` at runtime; a new version-consistency test fails the suite if the two ever diverge again.

## [0.47.2] — 2026-09-14

### Fixed
- **Node 18 compatibility**: the MCP SDK relies on global `crypto` (JSON-RPC id generation), but Node 18 does not expose the Web Crypto API globally without `--experimental-global-webcrypto`. Every Streamable HTTP POST failed with `ReferenceError: crypto is not defined` → JSON-RPC -32700 / HTTP 400 (all 22 HTTP integration tests under Node 18). Added a `node:crypto` webcrypto polyfill installed at entry points (`src/polyfills.ts`, imported first in `index.ts` and `mcp-server.ts`); no-op on Node 20+. Regression tests added; full 455-test suite green on Node 18.20 / 20 / 22 / 24.

## [0.47.1] — 2026-09-13

### Project
- `package.json` `mcpName: io.github.gaokai258/fee-optimizer-mcp` and Registry-schema `server.json` for publishing to the official MCP Registry (validated with `mcp-publisher validate`).
- GitHub Actions OIDC publish workflow (`.github/workflows/publish-mcp.yml`): publishes to registry.modelcontextprotocol.io on `v*` tags without any secret.

## [0.47.0] — 2026-09-13

### Fixed
- `compare_interface_costs` advice: without `monthly_volume_usd` the per-venue sentence leaked literal placeholders (`saves ≈—/yr at —/mo`) in both languages, and Coinbase One (whose waiver cap is not published) rendered `up to $0/mo`. The annual-saving sentence now only renders when a volume is supplied, and subscriptions without a public cap use plan-caps wording. Regression tests added (no-arg English/Chinese and with-volume bilingual).

### Added
- **`compare_interface_costs` (19th tool)** — consumer app vs PRO order-book dual-interface cost model on the same account. Covers six venues (Kraken, Coinbase, Bitstamp, Bitvavo, Bitpanda, BISON) using the TUM real-money €100 round-trip study (2025-10..11) replicated by Frankfurt School (432 round-trips, 2026-03): Bitvavo 0.58% (pass-through) < BISON 2.58% < Kraken app 5.81% < Bitpanda 6.23% < Coinbase Simple 7.49%. Returns per-venue consumer product/fee model, modeled one-way cost, measured round-trip, hidden markup pp, PRO maker/taker base, gap in pp, and — with `monthly_volume_usd` — annualized excess of the consumer app vs PRO (e.g. Coinbase at $1k/mo ≈ $168/yr).
- New data bundle [`data/interface_costs.json`](data/interface_costs.json) (14th audited data file) with study provenance, subscription waivers (Kraken+ $4.99/10k, Coinbase One) and per-venue measurement metadata.
- `consumer_interface` hints auto-injected into `compare_exchange_fees` / `calculate_savings` / `compare_total_cost` / `recommend_exchange` rows, plus top-level `CONSUMER_INTERFACE_MORE_EXPENSIVE` warnings on savings/recommendation results.
- Tool-count, data-file-count and version bumps across `server.json`, package metadata, README and smoke tests.

### Project
- GitHub Actions CI (`.github/workflows/ci.yml`): audit → build → 450-test suite → HTTP smoke on Node 18/20/22, plus an `npm pack` artifact-content and empty-project install/`--version` check.
- Real repository metadata (`github.com/gaokai258/fee-optimizer-mcp`) in `package.json` / `server.json` / README, replacing the previous `youruser` placeholders.
- This changelog introduced; shipped in the npm tarball via the `files` allowlist.

## [0.46.0]

### Added
- **`get_stablecoin_access` (18th tool)** — MiCA stablecoin regional-access intelligence (default USDT; also USDC/EURC/EURI/EURCV/USDQ/EURQ): issuer/EMT authorization, the EEA30 venue-trading restriction after the 2026-07-01 CASP cliff, custody/withdrawal/self-custody rights (the ban binds venues, not people), per-venue status with delisting dates, compliant alternatives and bilingual advice.
- `STABLECOIN_UNAVAILABLE_IN_REGION` warning auto-injected into fee, savings, total-cost, annual-cost, recommendation, withdrawal, execution-cost and persona flows for USDT/EEA requests.
- New data bundle `data/stablecoin_access.json`.

## [0.45.0]

### Added
- **BISON (18th venue)** — second spread-model brokerage (Boerse Stuttgart Group / EUWAX principal quotes, first BaFin MiCA custody license): 1.25%/side BTC-ETH via pair overrides, 1.75% other coins; TUM measured 2.58% round-trip vs 2.5% advertised (~0.08pp hidden, closest alignment of the six tested platforms); service area EEA30+CH (new single-member `CH` region key), blocked in GB (complementary to Bitpanda); free BTC/ETH on-chain withdrawals; EUR-only rails (free SEPA incl. Swiss users, 2.49% deposit-only cards).

## [0.44.0]

### Added
- **Bitpanda (17th venue)** — first spread-model brokerage (`pricing_model: "spread"`): 1.49%/side headline, 0.99% BTC/stablecoin pairs, 2.49% small caps; spread baseline pinned to 0 bps to avoid double-counting; `execution_quality` block — advertised 2.98% vs TUM measured 6.23% round-trip (4.25pp hidden); service area EEA30+GB (new single-member `GB` region key); free consumer fiat rails since 2026; dynamic network-cost pass-through withdrawals.

## [0.43.0]

### Added
- **Finst (16th venue)** — first brokerage/SOR venue (Amsterdam, ex-DEGIRO): flat 0.15% on every buy/sell/swap, no tiers, no spread markup; EEA-only via the venue-level positive allowlist; free SEPA/iDEAL/Bancontact EUR-only both legs; BTC withdrawal at 0.000085 (network fee + €2.50 third-party charge folded in); no trading API → account-fee lookup unsupported.

## [0.42.0]

### Added
- **Bitvavo (15th venue)** — largest home-grown euro spot exchange: nine-rung 30d EUR-volume PRO ladder (0.15%/0.25% → 0%/0.02%), tightest EU EUR-book spread in the model (~1.0 bps full), free SEPA both legs, BTC-only dynamic withdrawal; spot-only.
- New venue-level **positive service-area gate** (`region_allowed`); Bitvavo serves EEA30 only and disappears from every non-EEA result (separate GB/CH entities deliberately unmodeled).

## [0.41.0]

### Added
- **Post-cliff MiCA enforcement** (Article 143(3) transition ended 2026-07-01): Binance, MEXC, Bitget, KuCoin, BingX, Phemex, BloFin venue-blocked EEA-wide; Bybit/Gate perps product-blocked pending MiFID II authorization; negative gates narrow EEA results only, non-EEA markets unchanged.

## [0.40.0]

### Changed
- Negative-list product gates replaced by **positive region allowlists** (`regions` + `product_region_gates`); Bitstamp perps correctly require EEA residency instead of being over-opened via the default key.

## [0.39.0]

### Added
- **`get_account_fee_tier` (17th tool)** — read-only API-key authenticated lookup of the caller's actual maker/taker fee vs the bundled VIP schedule (signed bps gap); 13/18 venues supported; credentials per-request only, never cached/logged (audit lines redacted), compliance gates run before any authenticated call; typed auth/network error codes.

## [0.38.0]

### Added
- **Bitstamp (14th venue)** — Luxembourg (2011), Robinhood-owned, the most regulated venue (MiCA CASP / BitLicense / FCA / MAS): 11-tier volume-only spot ladder (0.30%/0.40% → 0%/0.03% at $1B), EEA-only USD perps at −0.005% maker rebate / 0.015% taker with 8h P2P funding; free ACH, free SEPA-in/€3-out, 0.05%/0.1% SWIFT, ~4% cards; ERC-20-heavy withdrawals.

## [0.37.0]

### Added
- **BloFin (13th venue)** — derivatives-led venue: 6-tier ladders (futures 0.020%/0.060% base), three-track OR qualification (futures volume / spot volume / $50k assets for futures VIP1), 8h funding; blocked US/CA/CN/SG and EEA under MiCA.

## [0.36.0]

### Added
- `format: "markdown" | "csv" | "both"` plus a `rendered` block on `compare_personas`, `volume_what_if` and `compare_countries` (RFC 4180 CRLF CSV; `tableMetric` selects availability/cost or fee/annual/tier slices); default JSON calls unchanged.

## [0.35.0]

### Added
- **`compare_countries` (16th tool)** — one persona through the full annual stack across up to 12 countries; comparable-basis `best_complete` deltas, blocked vs product-unsupported venue lists, venue×country matrix, win counts and cheapest/costliest gap.

## [0.34.0]

### Added
- **`volume_what_if` (15th tool)** — cross-venue volume sensitivity sweep: cheapest curves, exact `tier_crossings`, and per-venue next-rung extra-volume/annual-saving with `baseVolume` (holding-gated rungs flagged `blocked_by_holding_gate`).

## [0.33.0]

### Added
- Per-file freshness in `get_data_sources`: `months_behind`, `is_stale`, report-level `stale_after_months` and `stale_files`; offline `npm run audit:data` consistency gate.

## [0.32.0]

### Added
- Public-hosting hardening for the HTTP transport: opt-in bearer-token auth, per-IP rate limiting, structured JSON access logs, production multi-stage Dockerfile.

## [0.30.0] / [0.31.0]

### Added
- Bilingual narrative output (`language: "en" | "zh"`) across every advice/warnings/tradeoffs string; numbers, field names and error codes unchanged.

### Fixed
- 0.31: held-back BNB tier warning previously rendered "holding at least undefined BNB".

## [0.29.0]

### Added
- **Streamable HTTP transport** alongside stdio: per-request isolated servers, JSON responses, `/health` probe, CLI flags `--transport/--host/--port/--endpoint` plus env-var equivalents.

## [0.28.0]

### Added
- **`compare_personas` (14th tool)** — multi-persona decision matrix: headline vs realistic `best_complete` wins, persona×venue grid, `venue_wins` and `most_versatile`.

## [0.27.0]

### Changed
- `recommend_exchange` folds the direct fiat on/off-ramp habit into the score with a dispersion-driven 0.2–0.5 weight; rail-less venues get an explicit tradeoff instead of winning on an unpriced leg.

## [0.26.0]

### Added
- Annualized direct-rail fiat deposit/cash-out legs (`fiat*AmountUsd`/`fiat*PerYear`/`fiatMethod`/`fiatCurrency`) folded into total/annual cost with rail-availability flags (missing legs excluded, never counted as $0).

## [0.25.0]

### Added
- `analyze_persona` with `useToken=false` cross-links `analyze_token_discount`: top-3 venues carry `token_discount_hint` (discount %, annual saving, payback, holding cost) plus a consolidated `token_discount_hints` array.

## [0.24.0]

### Added
- **Phemex (12th venue)** — 0.01% base futures maker (industry-low), seven volume-only ladders, 8h funding, flat 20% PT fee deduction on spot + futures.

## [0.21.0]

### Added
- **BingX (11th venue)** — per-product spot/futures VIP Club ladders with a volume-only Elite rung, volume-OR-assets qualification track, 8h funding.

## [0.20.0]

### Added
- **Hyperliquid (10th venue, first DEX)** — fully on-chain L1 order book, 14-day rolling volume tiers with daily refresh (spot counts 2x), hourly funding settlement, USDC margin, staked-HYPE multiplicative discount ladder (staking required), no KYC, CCTP V2 USDC deposits.

## [0.1.0] – [0.19.0] — initial versions (reconstructed summary)

The pre-0.20 history is not recorded; the following features existed by 0.19.0 based on the current tool surface:

- Core venues: Binance, OKX, Gate.io, Bybit, MEXC, Bitget, KuCoin, Kraken (unified 17-tier ladder with futures maker rebates), Coinbase Advanced Trade.
- Core tools: `compare_exchange_fees`, `get_referral_link`, `calculate_savings`, `compare_total_cost`, `recommend_exchange`, `get_data_sources`, `calculate_annual_cost` (with VIP upgrade block), `get_funding_rates` (bundled averages), `get_execution_cost` (bundled spread baselines), `get_fiat_cost` (card/ACH/SEPA/FPS/PIX/wire/SWIFT in USD/EUR/GBP/BRL), `get_withdrawal_fees`, the seven-persona system (`list_personas` / `analyze_persona`) and `analyze_token_discount` (BNB/OKB/GT/MX/BGB/KCS, Gate GT / KuCoin KCS holding qualification).
- Token-payback analysis (annual fee with/without token, opportunity cost, months-to-breakeven), maker/taker weighted rates, pair-level fee promos (MEXC 0-fee, Binance FDUSD/USDC, Bitget USDC/USDT), KuCoin Class A/B/C fee groups and per-network crypto withdrawal fees.
- Live modes were introduced during this period: `fundingMode: "live"` (real-time ccxt funding with bundled fallback) and `spreadMode: "live"` (top-100 VWAP book walks).
