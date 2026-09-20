import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { createRecord } from "../src/ingest/record.js";
import { ingestRecords } from "../src/ingest/two-phase.js";
import { appendUsageEntry } from "../src/shared-duo/usage-log.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "test-passphrase";

describe("duo knowledge — the owner-facing summary of what this duo knows (#175)", () => {
  it("refuses to run without an initialized store, naming duo init", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["knowledge"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo init/);
  });

  it("prints record counts by source, the last import, the corpus verdict, rule counts, providers, and shared usage", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    createEncryptedStore(storePath, PASSPHRASE);
    ingestRecords(storePath, PASSPHRASE, [
      createRecord({ source: "paste", sourceRef: null, kind: "question_to_me", author: "other", text: "what is the leave policy?", timestamp: "2026-01-01T10:00:00.000Z", threadId: "t1", audience: "channel" }),
      createRecord({ source: "paste", sourceRef: null, kind: "my_answer", author: "me", text: "five days per quarter", timestamp: "2026-01-01T10:01:00.000Z", threadId: "t1", audience: "channel" }),
    ]);
    const usageLogPath = join(tempDir(), "shared-duo-runtime", "usage.json");
    appendUsageEntry(usageLogPath, { question: "who wins the world cup?", askerId: "sam", declined: true, citedTitles: [], staleCitation: false });

    const result = await runCli(["knowledge"], {
      cwd: tempDir(),
      env: {
        DUO_STORE_PATH: storePath,
        DUO_PASSPHRASE: PASSPHRASE,
        DUO_DIR: join(tempDir(), "duo"),
        DUO_SHARED_USAGE_LOG_PATH: usageLogPath,
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("records: 2");
    expect(result.stdout).toContain("paste: 2");
    expect(result.stdout).toMatch(/last import: 20\d\d-/);
    expect(result.stdout).toMatch(/too thin/i);
    expect(result.stdout).toMatch(/rules:/);
    expect(result.stdout).toContain("shared duo");
  });
});
