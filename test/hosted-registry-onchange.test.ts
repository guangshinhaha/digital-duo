import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostedRegistry } from "../src/hosted/registry.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

function registryAt(dir = tempDir()): { registry: HostedRegistry; dir: string } {
  return { registry: new HostedRegistry(join(dir, "registry.json"), "master-key-for-tests"), dir };
}

describe("HostedRegistry.onChange", () => {
  it("fires once per write that lands, and unsubscribe stops it", () => {
    const { registry } = registryAt();
    const seen: number[] = [];
    const off = registry.onChange(() => seen.push(1));
    registry.createOrg("Acme");
    expect(seen).toHaveLength(1);
    off();
    registry.createOrg("Beta");
    expect(seen).toHaveLength(1);
  });

  it("a throwing listener does not fail the write, nor keep the others from hearing of it", () => {
    const { registry, dir } = registryAt();
    const heard: string[] = [];
    registry.onChange(() => {
      heard.push("first");
      throw new Error("boom");
    });
    registry.onChange(() => heard.push("second"));
    const org = registry.createOrg("Acme");
    expect(heard).toEqual(["first", "second"]);
    // The write landed in memory and on disk.
    expect(registry.orgs().some((candidate) => candidate.id === org.id)).toBe(true);
    expect(new HostedRegistry(join(dir, "registry.json"), "master-key-for-tests").orgs().some((candidate) => candidate.id === org.id)).toBe(true);
  });

  it("fires nothing when the write fails, and leaves the registry as it was", () => {
    const { registry, dir } = registryAt();
    registry.createOrg("Before");
    const calls: number[] = [];
    registry.onChange(() => calls.push(1));
    const before = registry.orgs().length;
    calls.length = 0;
    // A directory where the temp file is written makes the write fail on any user, root included.
    mkdirSync(join(dir, `.registry-${process.pid}.tmp`));
    expect(() => registry.createOrg("Fails")).toThrow();
    expect(calls).toHaveLength(0);
    expect(registry.orgs()).toHaveLength(before);
  });
});
