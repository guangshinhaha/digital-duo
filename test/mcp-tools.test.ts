import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { jobsFor } from "../src/serve/jobs.js";
import { buildMcpServer, saveNotesToDuo } from "../src/serve/mcp.js";
import { LEGACY_SCOPES, SCOPES, type Scope } from "../src/serve/scopes.js";
import type { ServeDeps } from "../src/serve/server.js";
import type { EmbeddingProvider } from "../src/provider/types.js";
import { createEncryptedStore } from "../src/store/store.js";

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
    for (const name of ["edit_draft", "mark_draft_sent", "correct_public_answer"]) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      expect(tool.annotations?.openWorldHint, `${name} is open-world`).toBe(true);
    }
    expect(tools.find((tool) => tool.name === "edit_draft")!.description).toMatch(/deliver/i);
    expect(tools.find((tool) => tool.name === "mark_draft_sent")!.description).toMatch(/deliver/i);
    expect(tools.find((tool) => tool.name === "search_my_duo")!.annotations?.readOnlyHint).toBe(true);
  });

  it("refuses a tool outside the granted scopes, names the missing permission, and changes nothing", async () => {
    const deps = makeDeps();
    const full = await connectWith(deps, SCOPES);
    const draftId = await escalatedDraft(full);
    const readOnly = await connectWith(deps, READ);

    const save = await call(readOnly, "save_to_duo", { text: "A note." });
    expect(save.isError).toBe(true);
    expect(save.text).toMatch(/Save permission \(duo:save\)/);
    const embed = await call(readOnly, "embed_my_duo");
    expect(embed.isError).toBe(true);
    expect(embed.text).toMatch(/Operate permission \(duo:operate\)/);
    expect(jobsFor(deps).embed.current().state).toBe("idle");
    const edit = await call(readOnly, "edit_draft", { id: draftId, text: "Different." });
    expect(edit.isError).toBe(true);
    expect(edit.text).toMatch(/Send permission \(duo:send\)/);
    expect((await call(readOnly, "get_draft", { id: draftId })).json.outcome).toBeNull();
  });

  it("keeps a secret-URL connection save-only, however it is served", async () => {
    const claude = await connectWith(makeDeps(), LEGACY_SCOPES);
    expect((await call(claude, "save_to_duo", { text: "A note." })).isError).toBe(false);
    expect((await call(claude, "search_my_duo", { query: "note" })).isError).toBe(true);
    expect((await call(claude, "what_my_duo_knows")).text).toMatch(/Read permission/);
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
    const claude = await connectWith(makeDeps(), READ);
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
    expect(edited.json.note).toMatch(/directly delivers nothing/);
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
