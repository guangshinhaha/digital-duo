import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { putRule } from "../src/derivation/rules.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { appendDraft } from "../src/drafting/draft-log.js";
import { embedRecords } from "../src/ingest/embeddings.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { grantAutonomy } from "../src/trust/grants.js";
import type { InferenceProvider } from "../src/provider/types.js";
import { jobsFor } from "../src/serve/jobs.js";
import { buildMcpServer, saveNotesToDuo } from "../src/serve/mcp.js";
import { LEGACY_SCOPES, SCOPES, type Scope } from "../src/serve/scopes.js";
import type { ServeDeps } from "../src/serve/server.js";
import type { EmbeddingProvider } from "../src/provider/types.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";
const open: Client[] = [];
const READ: readonly Scope[] = ["duo:read"];
const NOT_A_QUESTION_ANYONE_HAS_ANSWERED = "What is the airspeed velocity of an unladen swallow?";

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
});

function makeDeps(embeddingProvider: EmbeddingProvider = createFakeEmbeddingProvider()): ServeDeps {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  const config = loadConfig({});
  return {
    storePath,
    passphrase: PASSPHRASE,
    duoDir: join(tempDir(), "duo"),
    lifecycleLogPath: join(tempDir(), "lifecycle", "events.json"),
    embeddingProvider,
    inferenceProvider: undefined,
    confidenceConfig: config.confidence,
    classificationCeiling: config.classificationCeiling,
    ownerName: "Sam",
    env: {},
  };
}

/** A connected Claude holding exactly these scopes, served in memory. */
async function connectWith(deps: ServeDeps, scopes: readonly Scope[]): Promise<Client> {
  const server = buildMcpServer(deps, scopes);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-claude", version: "1.0.0" });
  await client.connect(clientSide);
  open.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0].text;
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: result.isError === true, text, json };
}

/** An escalated draft: the duo has nothing to answer this from, so it passes it to the owner. */
async function escalatedDraft(claude: Client): Promise<string> {
  const drafted = await call(claude, "draft_reply", { question: NOT_A_QUESTION_ANYONE_HAS_ANSWERED });
  expect(drafted.json.kind).toBe("escalation");
  return drafted.json.draftId as string;
}

describe("what a connection may do is what the owner granted (#256)", () => {
  it("offers every duo tool, and the ones that can reach outside say so", async () => {
    const claude = await connectWith(makeDeps(), SCOPES);
    const tools = (await claude.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    for (const expected of [
      "save_to_duo", "save_notes_to_duo", "search_my_duo", "ask_my_duo", "what_my_duo_knows", "my_duo_rules", "my_duo_voice", "duo_status",
      "list_public_answers", "list_drafts", "get_draft", "list_escalations", "list_review_queue", "embed_my_duo", "derive_my_duo",
      "draft_reply", "discard_draft", "answer_escalation", "edit_draft", "mark_draft_sent", "correct_public_answer",
    ]) {
      expect(names).toContain(expected);
    }
    for (const name of ["edit_draft", "mark_draft_sent"]) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      expect(tool.annotations?.openWorldHint, `${name} is open-world`).toBe(true);
    }
    expect(tools.find((tool) => tool.name === "edit_draft")!.description).toMatch(/to that channel as the user/);
    expect(tools.find((tool) => tool.name === "mark_draft_sent")!.description).toMatch(/to that channel as the user/);
    expect(tools.find((tool) => tool.name === "search_my_duo")!.annotations?.readOnlyHint).toBe(true);
  });

  it("refuses a tool outside the granted scopes, names the missing permission, and changes nothing", async () => {
    const deps = makeDeps();
    const full = await connectWith(deps, SCOPES);
    const draftId = await escalatedDraft(full);
    const readOnly = await connectWith(deps, READ);

    const save = await call(readOnly, "save_to_duo", { text: "A note." });
    expect(save.isError).toBe(true);
    expect(save.text).toMatch(/Save \(duo:save\) permission/);
    const embed = await call(readOnly, "embed_my_duo");
    expect(embed.isError).toBe(true);
    expect(embed.text).toMatch(/Operate \(duo:operate\) permission/);
    expect(jobsFor(deps).embed.current().state).toBe("idle");
    const edit = await call(readOnly, "edit_draft", { id: draftId, text: "Different." });
    expect(edit.isError).toBe(true);
    expect(edit.text).toMatch(/Send \(duo:send\) permission/);
    expect((await call(readOnly, "get_draft", { id: draftId })).json.outcome).toBeNull();
  });

  it("keeps a secret-URL connection save-only, however it is served", async () => {
    const claude = await connectWith(makeDeps(), LEGACY_SCOPES);
    expect((await call(claude, "save_to_duo", { text: "A note." })).isError).toBe(false);
    expect((await call(claude, "search_my_duo", { query: "note" })).isError).toBe(true);
    expect((await call(claude, "what_my_duo_knows")).text).toMatch(/Read \(duo:read\) permission/);
  });
});

describe("reading (#256)", () => {
  it("searches the duo's records", async () => {
    const deps = makeDeps();
    await saveNotesToDuo(deps, ["The printer on the second floor is broken.", "The budget deadline moved to Friday."]);
    const claude = await connectWith(deps, READ);
    const found = await call(claude, "search_my_duo", { query: "printer" });
    expect(found.json.results[0].record.text).toBe("The printer on the second floor is broken.");
    expect(found.json.usedEmbeddings).toBe(true);
  });

  it("says what it knows, its rules, its voice and its status, and says so when there is nothing yet", async () => {
    const deps = makeDeps();
    await saveNotesToDuo(deps, ["A note about budgets."]);
    const claude = await connectWith(deps, READ);
    expect((await call(claude, "what_my_duo_knows")).json.records.total).toBe(1);
    expect((await call(claude, "my_duo_rules")).json.refusals.decided).toBe(false);
    expect((await call(claude, "my_duo_voice")).json).toMatchObject({ voice: null });
    const status = (await call(claude, "duo_status")).json;
    expect(status.embed.state).toBe("idle");
    expect(status.providers.embedding).toBe("fake:fake-embed");
    expect((await call(claude, "list_escalations")).json).toEqual({ waiting: [], note: "Nothing is waiting." });
    expect((await call(claude, "list_review_queue")).json).toEqual({ candidates: [], note: "Nothing is waiting for review." });
    expect((await call(claude, "list_drafts")).json).toEqual([]);
    expect((await call(claude, "list_public_answers")).json).toEqual([]);
  });

  it("searches an empty duo without an error", async () => {
    const claude = await connectWith(makeDeps(), READ);
    const found = await call(claude, "search_my_duo", { query: "anything" });
    expect(found.isError).toBe(false);
    expect(found.json.results).toEqual([]);
  });

  it("answers as the duo would, passing on what it cannot answer instead of guessing", async () => {
    const claude = await connectWith(makeDeps(), ["duo:read", "duo:operate"]);
    const asked = await call(claude, "ask_my_duo", { question: NOT_A_QUESTION_ANYONE_HAS_ANSWERED });
    expect(asked.json.kind).toBe("passed_on");
    expect(asked.json.text).toMatch(/passed it on/);
    expect(asked.json.draftId).toBeTruthy();
  });

  it("reports an unknown draft as an error, not a crash", async () => {
    const claude = await connectWith(makeDeps(), READ);
    const missing = await call(claude, "get_draft", { id: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/No draft with id "nope"/);
  });
});

describe("embedding and deriving (#256)", () => {
  it("starts an embed, refuses a second while it runs, and reports progress to every connection", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: EmbeddingProvider = { name: "slow", model: "slow", async embed() { await gate; return [1, 0, 0]; } };
    const deps = makeDeps(slow);
    await saveNotesToDuo({ ...deps, embeddingProvider: createFakeEmbeddingProvider() }, ["One note to embed."]);
    const claude = await connectWith(deps, SCOPES);

    const first = await call(claude, "embed_my_duo");
    expect(first.json).toMatchObject({ started: true, alreadyRunning: false });
    const second = await call(claude, "embed_my_duo");
    expect(second.json).toMatchObject({ started: false, alreadyRunning: true });
    // A different connection to the same duo sees the same job.
    const other = await connectWith(deps, READ);
    expect((await call(other, "duo_status")).json.embed.state).toBe("running");

    release();
    for (let i = 0; i < 100 && (await call(other, "duo_status")).json.embed.state === "running"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect((await call(other, "duo_status")).json.embed.state).toBe("done");
  });

  it("starts a derive and reports it", async () => {
    const claude = await connectWith(makeDeps(), SCOPES);
    const started = await call(claude, "derive_my_duo");
    expect(started.json.started).toBe(true);
    expect(["running", "done", "error"]).toContain(started.json.derive.state);
  });
});

describe("drafting (#257)", () => {
  it("drafts a reply, lists it as pending, and passes a question it cannot answer to the owner without inventing an answer", async () => {
    const claude = await connectWith(makeDeps(), SCOPES);
    const draftId = await escalatedDraft(claude);
    const pending = (await call(claude, "list_drafts", { status: "pending" })).json;
    expect(pending.map((draft: { id: string }) => draft.id)).toContain(draftId);
    const draft = (await call(claude, "get_draft", { id: draftId })).json;
    expect(draft.escalated).toBe(true);
    expect(draft.draft).toBeNull();
  });

  it("discards a draft once, and refuses to settle it again", async () => {
    const claude = await connectWith(makeDeps(), SCOPES);
    const draftId = await escalatedDraft(claude);
    const discarded = await call(claude, "discard_draft", { id: draftId });
    expect(discarded.json.recorded).toBe("discarded");
    expect(discarded.json.note).toBe("Nothing was sent.");

    const again = await call(claude, "discard_draft", { id: draftId });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already recorded as discarded/);
    const sent = await call(claude, "mark_draft_sent", { id: draftId });
    expect(sent.isError).toBe(true);
    expect(sent.text).toMatch(/already recorded as discarded/);
  });

  it("records an edit with the owner's text, and says what delivery will and will not do", async () => {
    const claude = await connectWith(makeDeps(), SCOPES);
    const draftId = await escalatedDraft(claude);
    const edited = await call(claude, "edit_draft", { id: draftId, text: "It is about 11 metres per second." });
    expect(edited.isError).toBe(false);
    expect(edited.json.recorded).toBe("edited");
    expect(edited.json.note).toMatch(/did not come from a channel, so nothing was delivered anywhere/);
    const after = (await call(claude, "get_draft", { id: draftId })).json;
    expect(after.outcome).toBe("edited");
    expect(after.sentText).toBe("It is about 11 metres per second.");
  });

  it("marks a draft sent, and refuses an unknown draft", async () => {
    const claude = await connectWith(makeDeps(), SCOPES);
    const draftId = await escalatedDraft(claude);
    expect((await call(claude, "mark_draft_sent", { id: draftId })).json.recorded).toBe("sent");
    const missing = await call(claude, "mark_draft_sent", { id: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/No draft with id/);
  });

  it("refuses to correct a public answer that does not exist", async () => {
    const claude = await connectWith(makeDeps(), SCOPES);
    const corrected = await call(claude, "correct_public_answer", { entryId: "nope", correctedText: "The right answer." });
    expect(corrected.isError).toBe(true);
  });
});

describe("what my duo passed to me (#258)", () => {
  it("lists what is waiting, queues an answer as a rule candidate without applying it, and refuses to answer twice", async () => {
    const claude = await connectWith(makeDeps(), SCOPES);
    const draftId = await escalatedDraft(claude);
    const waiting = (await call(claude, "list_escalations")).json.waiting;
    expect(waiting.map((draft: { id: string }) => draft.id)).toEqual([draftId]);

    const answered = await call(claude, "answer_escalation", { id: draftId, answer: "About 11 metres per second." });
    expect(answered.json.status).toBe("pending");
    expect(answered.json.note).toMatch(/until then/);
    expect((await call(claude, "my_duo_rules")).json.rules.approved).toEqual([]);

    const queue = (await call(claude, "list_review_queue")).json.candidates;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: answered.json.candidateId, source: "escalation", status: "pending" });
    expect((await call(claude, "list_escalations")).json.note).toBe("Nothing is waiting.");

    const again = await call(claude, "answer_escalation", { id: draftId, answer: "Something else." });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already answered/);
    expect((await call(claude, "list_review_queue")).json.candidates).toHaveLength(1);
  });

  it("has no tool that approves or rejects a rule candidate", async () => {
    const claude = await connectWith(makeDeps(), SCOPES);
    const names = (await claude.listTools()).tools.map((tool) => tool.name);
    expect(names.filter((name) => /approve|reject|grant|confirm|revoke|purge|end_duo|ask_link|devices?|promot/i.test(name))).toEqual([]);
  });

  it("refuses an answer to a question that was not passed on", async () => {
    const claude = await connectWith(makeDeps(), SCOPES);
    const refused = await call(claude, "answer_escalation", { id: "nope", answer: "Whatever." });
    expect(refused.isError).toBe(true);
  });
});

let recordCounter = 0;
function record(overrides: Partial<RecordInput> & { text: string }) {
  recordCounter += 1;
  return createRecord({
    source: "test",
    sourceRef: null,
    kind: "my_answer",
    author: "me",
    timestamp: `2026-01-01T00:00:${String(recordCounter).padStart(2, "0")}.000Z`,
    threadId: `t${recordCounter}`,
    audience: "channel",
    ...overrides,
  });
}

/** A duo that can answer "how much vacation leave do I get" with confidence, as the public-answer tests seed one. */
async function seedAnswerableDuo(): Promise<ServeDeps> {
  const agreeing: InferenceProvider = { name: "fake", async complete() { return "Five days per quarter, per policy."; } };
  const deps = { ...makeDeps(), inferenceProvider: agreeing };
  const question = record({ kind: "question_to_me", author: "other", text: "how much vacation leave do I get", threadId: "shared" });
  const answer = record({ text: "OFFICIAL (OPEN)\nfive days per quarter, per the vacation policy", threadId: "shared" });
  writeRecords(deps.storePath, PASSPHRASE, [question, answer]);
  await embedRecords(deps.storePath, PASSPHRASE, deps.embeddingProvider);
  const { pairs } = await extractQaPairs([question, answer]);
  writeQaPairs(deps.storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId: "topic-leave" })));
  withDatabase(deps.storePath, PASSPHRASE, true, (db) => {
    putRule(
      db,
      {
        id: "topic-leave",
        topicId: "topic-leave",
        text: "Standard leave is five days per quarter.",
        status: "confirmed",
        supportCount: 3,
        consistency: 0.95,
        createdAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
        reviewStatus: "approved",
        origin: "derived",
        supersededByRuleId: null,
        correctionDraftId: null,
        correctionQuestion: null,
      },
      pairs.map((pair) => pair.id),
    );
  });
  writeTopicsFile(deps.duoDir, [{ id: "topic-leave", label: "Vacation leave", createdAt: new Date().toISOString() }]);
  grantAutonomy(deps.storePath, PASSPHRASE, deps.duoDir, { scopeText: "vacation leave", tier: "T0", topicId: "topic-leave" });
  return deps;
}

describe("permissions that need each other, and what a tool tells the truth about (#256 review)", () => {
  it("needs Read as well as Operate to ask the duo or have it draft, and names whichever is missing", async () => {
    const deps = makeDeps();
    const readOnly = await connectWith(deps, READ);
    const operateOnly = await connectWith(deps, ["duo:operate"]);
    for (const [name, args] of [["ask_my_duo", { question: "Anything?" }], ["draft_reply", { question: "Anything?" }]] as [string, Record<string, unknown>][]) {
      const noOperate = await call(readOnly, name, args);
      expect(noOperate.isError).toBe(true);
      expect(noOperate.text).toMatch(/Operate \(duo:operate\) permission/);
      const noRead = await call(operateOnly, name, args);
      expect(noRead.isError).toBe(true);
      expect(noRead.text).toMatch(/Read \(duo:read\) permission/);
    }
    // Neither left a record behind.
    expect((await call(await connectWith(deps, READ), "list_drafts")).json).toEqual([]);
  });

  it("does not read a settled draft back to a connection that may not read", async () => {
    const deps = makeDeps();
    const full = await connectWith(deps, SCOPES);
    const draftId = await escalatedDraft(full);
    const operateOnly = await connectWith(deps, ["duo:operate"]);
    const discarded = await call(operateOnly, "discard_draft", { id: draftId });
    expect(discarded.json.recorded).toBe("discarded");
    expect(discarded.json.draft).toBeUndefined();

    const another = await escalatedDraft(full);
    const discardedWithRead = await call(full, "discard_draft", { id: another });
    expect(discardedWithRead.json.draft.id).toBe(another);
  });

  it("lists what is waiting newest first", async () => {
    const claude = await connectWith(makeDeps(), SCOPES);
    const first = (await call(claude, "draft_reply", { question: "First unanswerable question?" })).json.draftId;
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = (await call(claude, "draft_reply", { question: "Second unanswerable question?" })).json.draftId;
    const waiting = (await call(claude, "list_escalations")).json.waiting;
    expect(waiting.map((draft: { id: string }) => draft.id)).toEqual([second, first]);
  });

  it("reports a failed delivery as failed, not as handed over", async () => {
    const deps = makeDeps();
    const draftId = appendDraft(deps.storePath, PASSPHRASE, {
      question: "Can you send me the report?",
      threadContext: null,
      draftText: "Here it is.",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.9,
      sources: [],
      provenance: { origin: "channel", channelKind: "chat", askerRef: "colleague-1", threadId: "t1", permalink: null },
    });
    const claude = await connectWith(deps, SCOPES);
    const sent = await call(claude, "mark_draft_sent", { id: draftId });
    expect(sent.isError).toBe(false);
    expect(sent.json.recorded).toBe("sent");
    expect(sent.json.note).toMatch(/delivery failed: no connected adapter/);
    expect(sent.json.note).not.toMatch(/handed to/);
    expect(sent.json.draft.delivery.state).toBe("failed");
    expect(sent.json.draft.askedBy).toBe("colleague-1");
  });

  it("marks the tool that rewrites the voice as destructive, and the ones that reach outside as open-world", async () => {
    const claude = await connectWith(makeDeps(), SCOPES);
    const tools = (await claude.listTools()).tools;
    expect(tools.find((tool) => tool.name === "derive_my_duo")!.annotations?.destructiveHint).toBe(true);
    expect(tools.find((tool) => tool.name === "derive_my_duo")!.description).toMatch(/voice/);
    expect(tools.find((tool) => tool.name === "correct_public_answer")!.description).toMatch(/does not post/);
  });
});

describe("an answerable question, and correcting the answer (#256, #258)", () => {
  it("returns the answer with its confidence and sources, then records a correction that posts nothing", async () => {
    const deps = await seedAnswerableDuo();
    const claude = await connectWith(deps, ["duo:read", "duo:operate"]);

    const asked = await call(claude, "ask_my_duo", { question: "how much vacation leave do I get" });
    expect(asked.isError).toBe(false);
    expect(asked.json.kind).toBe("answered");
    expect(asked.json.text).toMatch(/Five days per quarter/);
    expect(asked.json.sources.length).toBeGreaterThan(0);
    expect(asked.json.confidence).toBeDefined();
    expect(asked.json.logEntryId).toBeTruthy();
    expect((await call(claude, "list_public_answers")).json[0].id).toBe(asked.json.logEntryId);

    // Operate alone is enough to correct: it records and lowers autonomy, and nothing is sent.
    const operateOnly = await connectWith(deps, ["duo:operate"]);
    const corrected = await call(operateOnly, "correct_public_answer", { entryId: asked.json.logEntryId, correctedText: "It is four days per quarter." });
    expect(corrected.isError).toBe(false);
    expect(corrected.json.correctionEntryId).toBeTruthy();
    expect(corrected.json.correctedTopicId).toBe("topic-leave");
    expect(corrected.json.demotion).toBeDefined();
    expect(corrected.json.note).toMatch(/Nothing was posted and no one was notified/);
    expect(corrected.json).not.toHaveProperty("postedInThread");
    expect(corrected.json).not.toHaveProperty("notifiedAskerRefs");
  });
});

