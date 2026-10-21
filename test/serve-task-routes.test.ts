import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { createServer, type ServeDeps } from "../src/serve/server.js";
import { createAskToken, createDeviceToken } from "../src/serve/tokens.js";
import { createCard, createTask, updateTaskState } from "../src/tasks/store.js";
import { createEncryptedStore } from "../src/store/store.js";

// W-S4-6: GET /tasks, GET /tasks/:id, GET /cards/:id, GET /cards — the
// owner's read surface over the task/card store (cards.md §7's "owner's
// task view... daemon HTTP + /ws only" row). Every route here is owner-only
// by the same construction `registerOwnerRoutes` already relies on: the
// bearer-auth hook (serve/auth.ts) only ever verifies an ask token on the
// literal `/ask` route, so an ask-link token reaching any route here always
// falls through to device verification and fails it — refused with no
// route-local check needed, the same structural guarantee every other
// owner-only route in this codebase already has. This file also asserts
// that guarantee directly (never trust a boundary silently).

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function setup(overrides: Partial<ServeDeps> = {}) {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  const config = loadConfig();
  const deps: ServeDeps = {
    storePath,
    passphrase: PASSPHRASE,
    duoDir: join(tempDir(), "duo"),
    lifecycleLogPath: join(tempDir(), "lifecycle-runtime", "events.json"),
    embeddingProvider: createFakeEmbeddingProvider(),
    inferenceProvider: undefined,
    confidenceConfig: config.confidence,
    classificationCeiling: config.classificationCeiling,
    ownerName: "Owner",
    env: {},
    ...overrides,
  };
  const device = createDeviceToken(storePath, PASSPHRASE, "laptop");
  const app = createServer(deps);
  const auth = { authorization: `Bearer ${device.token}` };
  return { app, auth, storePath };
}

describe("GET /tasks, GET /tasks/:id — the owner's task read surface (W-S4-6)", () => {
  it("lists tasks, newest facts included, with draftId for the owner", async () => {
    const { app, auth, storePath } = setup();
    const task = createTask(storePath, PASSPHRASE, {
      roomId: "!room:workspace.example",
      questionEventId: "$q1",
      requester: "@alice:workspace.example",
      draftId: "d-123",
    });

    const list = await app.inject({ method: "GET", url: "/tasks", headers: auth });
    expect(list.statusCode).toBe(200);
    const listBody = list.json();
    expect(listBody.tasks).toHaveLength(1);
    expect(listBody.tasks[0].id).toBe(task.id);
    expect(listBody.tasks[0].draftId).toBe("d-123");

    const one = await app.inject({ method: "GET", url: `/tasks/${task.id}`, headers: auth });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ id: task.id, state: "acknowledged", draftId: "d-123", roomId: "!room:workspace.example" });
  });

  it("filters by state", async () => {
    const { app, auth, storePath } = setup();
    const acked = createTask(storePath, PASSPHRASE, { roomId: "!r:w", questionEventId: "$1", requester: "@a:w" });
    const working = createTask(storePath, PASSPHRASE, { roomId: "!r:w", questionEventId: "$2", requester: "@b:w" });
    updateTaskState(storePath, PASSPHRASE, working.id, "start_working");

    const response = await app.inject({ method: "GET", url: "/tasks?state=working", headers: auth });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe(working.id);
    expect(body.tasks.map((t: { id: string }) => t.id)).not.toContain(acked.id);
  });

  it("404s a task id that does not exist", async () => {
    const { app, auth } = setup();
    const response = await app.inject({ method: "GET", url: "/tasks/not-a-real-id", headers: auth });
    expect(response.statusCode).toBe(404);
  });

  it("refuses an ask-link token on every task route — an ask token is never an owner (W-S4-6 AC)", async () => {
    const { app, storePath } = setup();
    const task = createTask(storePath, PASSPHRASE, { roomId: "!r:w", questionEventId: "$1", requester: "@a:w" });
    const ask = createAskToken(storePath, PASSPHRASE, "visitor link", new Date(Date.now() + 86_400_000).toISOString());
    const askAuth = { authorization: `Bearer ${ask.token}` };

    const list = await app.inject({ method: "GET", url: "/tasks", headers: askAuth });
    expect(list.statusCode).toBe(401);

    const one = await app.inject({ method: "GET", url: `/tasks/${task.id}`, headers: askAuth });
    expect(one.statusCode).toBe(401);
  });

  it("refuses any request with no bearer token at all", async () => {
    const { app } = setup();
    const response = await app.inject({ method: "GET", url: "/tasks" });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /cards/:id, GET /cards — the owner's card read surface (W-S4-6)", () => {
  it("reads one card by id", async () => {
    const { app, auth, storePath } = setup();
    const task = createTask(storePath, PASSPHRASE, { roomId: "!r:w", questionEventId: "$1", requester: "@a:w" });
    const card = createCard(storePath, PASSPHRASE, {
      id: "card-1",
      taskId: task.id,
      roomId: "!r:w",
      eventId: "$card1",
      kind: "task",
      audience: "visitor",
      state: "acknowledged",
      payloadJson: "{}",
      requester: "@a:w",
    });

    const response = await app.inject({ method: "GET", url: `/cards/${card.id}`, headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: card.id, taskId: task.id, kind: "task", state: "acknowledged" });
  });

  it("404s a card id that does not exist", async () => {
    const { app, auth } = setup();
    const response = await app.inject({ method: "GET", url: "/cards/not-a-real-id", headers: auth });
    expect(response.statusCode).toBe(404);
  });

  it("lists cards filtered by roomId and audience", async () => {
    const { app, auth, storePath } = setup();
    const task = createTask(storePath, PASSPHRASE, { roomId: "!r1:w", questionEventId: "$1", requester: "@a:w" });
    const other = createTask(storePath, PASSPHRASE, { roomId: "!r2:w", questionEventId: "$2", requester: "@b:w" });
    createCard(storePath, PASSPHRASE, { id: "card-1", taskId: task.id, roomId: "!r1:w", eventId: "$c1", kind: "task", audience: "visitor", state: "acknowledged", payloadJson: "{}", requester: "@a:w" });
    createCard(storePath, PASSPHRASE, { id: "card-2", taskId: other.id, roomId: "!r2:w", eventId: "$c2", kind: "task", audience: "visitor", state: "acknowledged", payloadJson: "{}", requester: "@b:w" });

    const response = await app.inject({ method: "GET", url: "/cards?roomId=!r1:w", headers: auth });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.cards).toHaveLength(1);
    expect(body.cards[0].roomId).toBe("!r1:w");

    // No card in this store is ever built with audience "owner" in Phase 1
    // (every S4 card is "visitor" — the owner-only kinds are S7's), so this
    // filter is exercised for shape, not for a non-empty result.
    const ownerOnly = await app.inject({ method: "GET", url: "/cards?roomId=!r1:w&audience=owner", headers: auth });
    expect(ownerOnly.statusCode).toBe(200);
    expect(ownerOnly.json().cards).toHaveLength(0);
  });

  it("refuses an ask-link token on every card route", async () => {
    const { app, storePath } = setup();
    const task = createTask(storePath, PASSPHRASE, { roomId: "!r:w", questionEventId: "$1", requester: "@a:w" });
    const card = createCard(storePath, PASSPHRASE, { id: "card-1", taskId: task.id, roomId: "!r:w", eventId: "$c1", kind: "task", audience: "visitor", state: "acknowledged", payloadJson: "{}", requester: "@a:w" });
    const ask = createAskToken(storePath, PASSPHRASE, "visitor link", new Date(Date.now() + 86_400_000).toISOString());
    const askAuth = { authorization: `Bearer ${ask.token}` };

    const one = await app.inject({ method: "GET", url: `/cards/${card.id}`, headers: askAuth });
    expect(one.statusCode).toBe(401);

    const list = await app.inject({ method: "GET", url: "/cards", headers: askAuth });
    expect(list.statusCode).toBe(401);
  });
});
