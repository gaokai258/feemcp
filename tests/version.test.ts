import { describe, it, expect } from "vitest";
import { SERVER_NAME, SERVER_VERSION } from "../src/mcp-server.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

describe("version metadata consistency", () => {
  it("SERVER_VERSION matches package.json version", () => {
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it("SERVER_NAME matches package.json name", () => {
    expect(SERVER_NAME).toBe(pkg.name);
  });
});
