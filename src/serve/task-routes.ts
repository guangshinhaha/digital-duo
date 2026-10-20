import type { FastifyInstance } from "fastify";
import { getCard, getTask, listCards, listTasks } from "../tasks/store.js";
import type { TaskState } from "../tasks/state.js";
import type { ServeDeps } from "./server.js";

function errorBody(code: string, message: string): { readonly error: { readonly code: string; readonly message: string } } {
  return { error: { code, message } };
}

const TASK_STATES: readonly TaskState[] = ["acknowledged", "working", "needs_decision", "done", "failed"];

function isTaskState(value: string): value is TaskState {
  return (TASK_STATES as readonly string[]).includes(value);
}

/**
 * W-S4-6: the owner's read surface over the task/card store — `GET
 * /tasks?state=`, `GET /tasks/:id`, `GET /cards/:id`, `GET
 * /cards?roomId=&audience=`. Mirrors `registerOwnerRoutes`'s own stance:
 * every route here is owner-only by construction, not by a route-local
 * check — the bearer-auth hook (`serve/auth.ts`) verifies an ask token on
 * the literal `/ask` route only, so an ask-link token reaching any route
 * registered here always falls through to device verification and fails
 * it with a 401 before the handler ever runs. The explicit
 * `principal?.kind !== "device"` guard below is defense in depth, the same
 * belt-and-braces stance `registerWorkspaceSessionRoutes` already takes on
 * its own owner-only routes, not the primary enforcement.
 *
 * `GET /tasks/:id` is the one place `draftId` crosses this surface
 * (cards.md §7: "Owner's task view (draftId, confidence, gate
 * reasons)... daemon HTTP + /ws only") — it never rides a `duo.card` or a
 * `/ws` push, both of which carry ids and state only.
 */
export function registerTaskRoutes(app: FastifyInstance, deps: ServeDeps): void {
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions?.url?.startsWith("/tasks") || request.routeOptions?.url?.startsWith("/cards")) {
      if (request.principal?.kind !== "device") {
        reply.code(401).send(errorBody("unauthorized", "Sign in as the owner to read tasks."));
      }
    }
  });

  app.get<{ Querystring: { state?: string } }>("/tasks", async (request, reply) => {
    const { state } = request.query;
    if (state !== undefined && !isTaskState(state)) {
      reply.code(400).send(errorBody("bad_request", `state must be one of ${TASK_STATES.join(", ")} (got ${JSON.stringify(state)})`));
      return;
    }
    const tasks = listTasks(deps.storePath, deps.passphrase, state);
    return { tasks };
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const task = getTask(deps.storePath, deps.passphrase, request.params.id);
    if (!task) {
      reply.code(404).send(errorBody("not_found", `No task with id ${JSON.stringify(request.params.id)}.`));
      return;
    }
    return task;
  });

  app.get<{ Params: { id: string } }>("/cards/:id", async (request, reply) => {
    const card = getCard(deps.storePath, deps.passphrase, request.params.id);
    if (!card) {
      reply.code(404).send(errorBody("not_found", `No card with id ${JSON.stringify(request.params.id)}.`));
      return;
    }
    return card;
  });

  app.get<{ Querystring: { roomId?: string; audience?: string; taskId?: string } }>("/cards", async (request) => {
    const { roomId, audience, taskId } = request.query;
    const cards = listCards(deps.storePath, deps.passphrase, {
      ...(roomId !== undefined ? { roomId } : {}),
      ...(audience !== undefined ? { audience } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
    });
    return { cards };
  });
}
