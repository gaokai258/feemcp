import { describe, it, expect } from "vitest";
import "../src/polyfills.js";

// Regression: Node 18 has no global Web Crypto without
// --experimental-global-webcrypto. The MCP SDK needs globalThis.crypto, and
// without the polyfill every Streamable HTTP POST failed with
// "ReferenceError: crypto is not defined" (JSON-RPC -32700, HTTP 400).
describe("Node 18 compatibility: Web Crypto polyfill", () => {
  it("exposes globalThis.crypto", () => {
    expect(globalThis.crypto).toBeDefined();
  });

  it("supports randomUUID (used by the MCP SDK for JSON-RPC ids)", () => {
    const id = globalThis.crypto.randomUUID();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("supports getRandomValues", () => {
    const buf = new Uint8Array(8);
    globalThis.crypto.getRandomValues(buf);
    expect(buf.some((b) => b !== 0)).toBe(true);
  });
});
