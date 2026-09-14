# Privacy Policy — Fee Optimizer MCP

**Last updated: 2026-09-14**

Fee Optimizer MCP ("the Extension") is a local MCP server that compares cryptocurrency exchange trading fees. This policy describes how the Extension handles data.

## Data Collection

**The Extension does not collect, store, or transmit any personally identifiable information.**

All market data (fee schedules, funding rates, order-book spreads, fiat rail costs, withdrawal fees, stablecoin access rules) is bundled locally inside the package. No telemetry, analytics, or usage tracking is included.

## API Keys (Optional)

The `get_account_fee_tier` tool optionally accepts exchange API credentials to fetch the user's actual fee tier via authenticated ccxt endpoints. These credentials:

- Are passed directly to the exchange's public API at the user's request
- Are **never cached** — they exist only for the duration of the single tool call
- Are **never logged** — the audit logger redacts sensitive fields before writing
- Are **never transmitted** to any third party other than the exchange the user specifies

Users are not required to provide API keys. All other 18 tools work without any credentials.

## Live Market Data (Optional)

The `get_funding_rates` and `get_execution_cost` tools can optionally fetch real-time data from exchange public APIs (funding rates and order books). These calls:

- Go directly to the exchange's public REST endpoints
- Do not send any user-identifying information
- Are best-effort with automatic fallback to bundled data
- Are cached for 5 minutes (funding rates) or 30 seconds (order books) in memory only, never persisted to disk

## Third-Party Services

The Extension does not integrate with any third-party analytics, advertising, or tracking services.

## Open Source

The Extension's full source code is available at [github.com/gaokai258/feemcp](https://github.com/gaokai258/feemcp) under the MIT license. Users can audit all data handling behavior directly.

## Contact

For privacy questions, open an issue at [github.com/gaokai258/feemcp/issues](https://github.com/gaokai258/feemcp/issues).
