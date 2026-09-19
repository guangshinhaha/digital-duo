import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { PROMOTION_THRESHOLD, recordCleanInstance } from "../src/trust/promotion.js";
import { resolveOrCreatePassphrase } from "../src/store/passphrase.js";

const tempDir = useTempDir();

async function initStore(storePath: string, cwd: string): Promise<void> {
  const result = await runCli(["init"], { cwd, env: { DUO_STORE_PATH: storePath } });
  expect(result.exitCode).toBe(0);
}

describe("duo trust promotions / promote", () => {
  it("reports no offers pending on a fresh store", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const result = await runCli(["trust", "promotions"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no promotion offers pending/i);
  });

  it("lists a due offer, then accepting it moves the cell and clears the offer", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDir = join(tempDir(), "duo");
    await initStore(storePath, tempDir());
    writeTopicsFile(duoDir, [{ id: "topic-a", label: "Topic A", createdAt: "2026-01-01T00:00:00.000Z" }]);

    const passphrase = resolveOrCreatePassphrase(storePath, {});
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      recordCleanInstance(storePath, passphrase, "topic-a", "T0");
    }

    const listResult = await runCli(["trust", "promotions"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDir } });
    expect(listResult.stdout).toMatch(/topic-a.*T0.*ask -> approve/);

    const acceptResult = await runCli(["trust", "promote", "topic-a", "T0", "--accept"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDir },
    });
    expect(acceptResult.exitCode).toBe(0);
    expect(acceptResult.stdout).toMatch(/Promoted.*approve/);

    const afterResult = await runCli(["trust", "promotions"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDir } });
    expect(afterResult.stdout).toMatch(/no promotion offers pending/i);
  });

  it("requires exactly one of --accept/--decline", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const result = await runCli(["trust", "promote", "topic-a", "T0"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/exactly one/i);
  });
});
