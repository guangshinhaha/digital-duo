import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe(".gitignore", () => {
  it("ignores data/, where the encrypted store and passphrase live", () => {
    const path = fileURLToPath(new URL("../.gitignore", import.meta.url));
    const contents = readFileSync(path, "utf8");
    expect(contents.split("\n").map((line) => line.trim())).toContain("data/");
  });
});
