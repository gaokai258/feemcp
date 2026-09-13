// Node 18 does not expose the Web Crypto API on globalThis without
// --experimental-global-webcrypto (crypto became a stable global in Node 20).
// The MCP SDK relies on globalThis.crypto (random UUID generation), so on
// Node 18 every request otherwise fails with "ReferenceError: crypto is not
// defined". Install the node:crypto implementation when the global is missing.
import { webcrypto } from "node:crypto";

if (typeof (globalThis as { crypto?: typeof webcrypto }).crypto === "undefined") {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    writable: true,
    configurable: true,
  });
}
