import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe(".gitignore", () => {
  it("ignores data/, where the encrypted store and passphrase live", () => {
    const path = fileURLToPath(new URL("../.gitignore", import.meta.url));
    const contents = readFileSync(path, "utf8");
    expect(contents.split("\n").map((line) => line.trim())).toContain("data/");
  });

  it("ignores jev-spike-runtime/, where the spike's recorded exchanges and reports land", () => {
    const path = fileURLToPath(new URL("../.gitignore", import.meta.url));
    const contents = readFileSync(path, "utf8");
    expect(contents.split("\n").map((line) => line.trim())).toContain("jev-spike-runtime/");
  });
});

describe("structural egress scan (R2/KTD10)", () => {
  // Imports of network-capable modules, `fetch(` call sites, and WebSocket
  // constructions — a comment *mentioning* a primitive (src/serve/server.ts
  // cites the client design's proposed WebSocket shape) matches nothing and
  // stays legal; only code that can actually issue network I/O is flagged.
  const IMPORT_RE = /\b(?:import|export)\b[^;\n]*from\s+["'](node:)?(http|https|http2|net|tls|dgram|undici|ws)["']/;
  const BARE_IMPORT_RE = /^\s*import\s+["'](node:)?(http|https|undici|ws)["']/m;
  const FETCH_CALL_RE = /\bfetch\s*\(/;
  const WEBSOCKET_USE_RE = /\bnew\s+WebSocket\b|\bWebSocket\s*\(/;

  it("has no network primitive outside src/provider/ — the adapter-only Jev footprint", () => {
    const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string, isSrcRoot: boolean): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          // src/provider/ is the sanctioned boundary; everything under it is exempt.
          if (isSrcRoot && entry.name === "provider") {
            continue;
          }
          walk(path, false);
        } else if (entry.name.endsWith(".ts")) {
          const text = readFileSync(path, "utf8");
          if (IMPORT_RE.test(text) || BARE_IMPORT_RE.test(text) || FETCH_CALL_RE.test(text) || WEBSOCKET_USE_RE.test(text)) {
            offenders.push(path);
          }
        }
      }
    };
    walk(srcRoot, true);
    expect(offenders).toEqual([]);
  });
});
