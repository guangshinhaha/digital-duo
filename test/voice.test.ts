import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { defaultRegisterDescription, runVoiceProfile } from "../src/derivation/voice.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function duoDir(): string {
  return join(tempDir(), "duo");
}

let counter = 0;
function record(overrides: Partial<RecordInput> & { text: string }) {
  counter += 1;
  return createRecord({
    source: "test",
    sourceRef: `ref-${counter}`,
    kind: "my_answer",
    author: "me",
    timestamp: `2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`,
    threadId: `t${counter}`,
    audience: "channel",
    ...overrides,
  });
}

describe("runVoiceProfile", () => {
  it("computes statistics from the owner's own messages only", async () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [
      record({ text: "hi, maybe we should ship this Friday" }),
      record({ text: "hi, probably fine to merge now" }),
      record({ text: "not from the owner", author: "other", kind: "question_to_me" }),
    ]);

    const result = await runVoiceProfile(storePath, PASSPHRASE, duoDir());
    expect(result.stats.sampleSize).toBe(2); // the "other"-authored record is excluded
    expect(result.stats.hedgeRate).toBe(1); // both owner messages hedge ("maybe"/"probably")
    expect(result.stats.greetingRate).toBe(1); // both start with "hi"
  });

  it("writes duo/voice.md as readable prose with the computed stats", async () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record({ text: "five days per quarter, thanks" })]);

    const result = await runVoiceProfile(storePath, PASSPHRASE, duoDir());
    expect(result.written).toBe(true);

    const content = readFileSync(join(duoDir(), "voice.md"), "utf8");
    expect(content).toMatch(/^# Voice profile/);
    expect(content).toContain("Sample size: 1 message(s)");
    expect(content).toContain(result.register);
  });

  it("never overwrites an existing voice.md unless force is passed", async () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record({ text: "five days per quarter" })]);
    await runVoiceProfile(storePath, PASSPHRASE, duoDir());

    const { writeFileSync } = await import("node:fs");
    const path = join(duoDir(), "voice.md");
    writeFileSync(path, "# Hand-edited voice notes\n\nI'm actually quite formal.\n");

    const withoutForce = await runVoiceProfile(storePath, PASSPHRASE, duoDir());
    expect(withoutForce.written).toBe(false);
    expect(readFileSync(path, "utf8")).toContain("Hand-edited voice notes");

    const withForce = await runVoiceProfile(storePath, PASSPHRASE, duoDir(), { force: true });
    expect(withForce.written).toBe(true);
    expect(readFileSync(path, "utf8")).not.toContain("Hand-edited voice notes");
  });

  it("carries an existing '## Corrections' section forward across a force overwrite, instead of discarding it (#37-39's log)", async () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record({ text: "five days per quarter" })]);
    await runVoiceProfile(storePath, PASSPHRASE, duoDir());

    const { writeFileSync } = await import("node:fs");
    const path = join(duoDir(), "voice.md");
    const correctionEntry = '- (2026-01-01T00:00:00.000Z) draft "a" -> sent "b" (question: "q", draft d1)';
    writeFileSync(path, `# Voice profile\n\nsome stats\n\n## Corrections\n\n${correctionEntry}\n`);

    const withForce = await runVoiceProfile(storePath, PASSPHRASE, duoDir(), { force: true });
    expect(withForce.written).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("## Corrections");
    expect(content).toContain(correctionEntry);
    expect(content).toMatch(/^# Voice profile/); // the fresh statistical/register content still leads the file
  });

  it("uses a supplied register describer when given", async () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record({ text: "five days per quarter" })]);

    const result = await runVoiceProfile(storePath, PASSPHRASE, duoDir(), {
      describeRegister: async () => "Warm and informal.",
    });
    expect(result.register).toBe("Warm and informal.");
  });

  it("reports zero samples, not an error, on an empty store", async () => {
    const storePath = initStore();
    const result = await runVoiceProfile(storePath, PASSPHRASE, duoDir());
    expect(result.stats.sampleSize).toBe(0);
    expect(result.register).toBe(defaultRegisterDescription(result.stats));
  });
});
