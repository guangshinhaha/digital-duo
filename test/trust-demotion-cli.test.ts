import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { acceptPromotionOffer, PROMOTION_THRESHOLD, recordCleanInstance } from "../src/trust/promotion.js";
import { resolveOrCreatePassphrase } from "../src/store/passphrase.js";

const tempDir = useTempDir();

async function initStore(storePath: string, cwd: string): Promise<void> {
  const result = await runCli(["init"], { cwd, env: { DUO_STORE_PATH: storePath } });
  expect(result.exitCode).toBe(0);
}

describe("duo trust correct / ledger", () => {
  it("demotes a promoted cell and records the correction in the ledger", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDir = join(tempDir(), "duo");
    await initStore(storePath, tempDir());
    writeTopicsFile(duoDir, [{ id: "topic-a", label: "Topic A", createdAt: "2026-01-01T00:00:00.000Z" }]);

    const passphrase = resolveOrCreatePassphrase(storePath, {});
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      recordCleanInstance(storePath, passphrase, "topic-a", "T0");
    }
    acceptPromotionOffer(storePath, passphrase, "topic-a", "T0"); // ask -> approve

    const correctResult = await runCli(["trust", "correct", "topic-a", "T0", "--reason", "sent a wrong answer, see audit-42"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDir },
    });
    expect(correctResult.exitCode).toBe(0);
    expect(correctResult.stdout).toMatch(/Demoted.*approve -> ask/);

    const ledgerResult = await runCli(["trust", "ledger"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDir } });
    expect(ledgerResult.exitCode).toBe(0);
    expect(ledgerResult.stdout).toMatch(/demoted/);
    expect(ledgerResult.stdout).toMatch(/audit-42/);
  });

  it("reports no trust events yet on a fresh store", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const result = await runCli(["trust", "ledger"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no trust events/i);
  });
});
