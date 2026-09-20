---
title: "Use console.error for server-side logging in duo serve: request.log and app.log are nullLogger no-ops under Fastify logger:false"
date: 2026-09-20
category: docs/solutions/logic-errors/
module: "src/serve/server.ts (createServer with logger:false, POST /ask catch block, askerRefFor directory-load fallback)"
problem_type: logic_error
component: logging
severity: medium
symptoms:
  - 'a failing POST /ask returns the generic 500 body (errorBody("internal_error", "Something went wrong answering that.")) to the asker with zero server-side trace - no stderr output, no log line, nothing to grep'
  - "provider outage, store corruption, and code defects are indistinguishable to the owner: every answering failure surfaces as the same opaque 500"
  - "every request.log.* / app.log.* call anywhere in the daemon (routes and hooks) is silently discarded, because fastify 5.12.5's logger-factory installs abstract-logging's nullLogger whenever no logger/loggerInstance option is supplied"
  - "nothing fails loudly: build, tests, and lint all pass; the defect is invisible until a real ask fails in production or a code review catches it (review run 20260920-181418-5f89d72d, finding #3)"
root_cause: wrong_api
resolution_type: code_fix
framework_version: fastify 5.12.5
related_components:
  - api_layer
  - cli
tags:
  - serve-layer
  - fastify
  - null-logger
  - request-log
  - console-error
  - error-handling
  - observability
  - issue-159
---

# Use console.error for server-side logging in duo serve: request.log and app.log are nullLogger no-ops under Fastify logger:false

## Problem

The `duo serve` daemon constructs Fastify with `logger: false` (`src/serve/server.ts:402`, in `createServer`), which under Fastify 5 installs abstract-logging's nullLogger — every log method a no-op — so the POST /ask route's failure handler, which reported answering failures via `request.log.error(...)`, was silently discarded: a failing ask returned the generic 500 to the asker while leaving zero server-side trace for the owner.

## Symptoms

The asker always received the intended generic body — `{"error":{"code":"internal_error","message":"Something went wrong answering that."}}` (asserted at `test/serve-server.test.ts:784`) — but on the server side nothing appeared at all: no stderr line, no log file entry, no console output from the daemon, whatever the failure's nature (provider outage, store error, code defect). The owner could not distinguish a transient provider outage from store corruption from a code defect; the only evidence a failure had even happened was the asker's report. Crucially, there was no compile error, no type error, no test failure, and no runtime warning — the code looked idiomatic Fastify and passed the full suite, because the route's observable HTTP behavior was correct and nothing in the test run observed logging.

## What Didn't Work

The original line looked correct by every signal available inside the repo. `request.log` is a standard, fully-typed Fastify request property, and the nullLogger that backs it defines every method (`fatal`, `error`, `warn`, `info`, `debug`, `trace` — `node_modules/abstract-logging/index.js:5-12`), so the call typechecked and did nothing. The existing 500-path test (`test/serve-server.test.ts:773-787`) passed because it asserts only the status code, the generic body, and the absence of leaked internals — all of which held. Running the daemon and hitting the failing path showed no anomaly either, since a no-op produces exactly as much output as nothing being wrong. In other words, no investigation grounded in the repo's own source, types, or tests could surface the bug: the failure only became visible when code-review run 20260920-181418-5f89d72d (finding #3) traced the option through the installed framework — `node_modules/fastify/lib/logger-factory.js:87-92`, which takes the nullLogger branch whenever `!options.loggerInstance && !options.logger` (and `logger: false` is falsy, so `logger: false` behaves exactly like supplying no logger) — and that reading was then independently validator-confirmed against the fastify 5.12.5 source (the installed version, per `node_modules/fastify/package.json`). The lesson from the failed investigation is that "the framework's logger" is a dependency behavior, not an invariant of this repo, and must be verified in `node_modules`, not assumed from the call site's appearance.

## Solution

The fix (on branch `feat-serve-post-ask`, the POST /ask work for issue #159, pending merge as of this writing) swaps the discarded `request.log.error` for a direct `console.error` on stderr, with a comment documenting the trap. Before:

```ts
// POST /ask catch block, before
request.log.error({ err: error }, "POST /ask: answering failed");
reply.code(500).send(errorBody("internal_error", "Something went wrong answering that."));
```

After, as it now stands at `src/serve/server.ts:299-311`:

```ts
} catch (error) {
  // The asker-visible surface must never echo an internal error —
  // provider details or filesystem paths are owner information (the
  // POST /drafts no-catch precedent passes Fastify's default error
  // body through, which is wrong for this audience).
  // The daemon runs Fastify with logger:false, so request.log.error
  // would be a no-op (U2 step 6: the real error reaches the owner
  // server-side via console.error, matching the CLI's reportError
  // stderr convention).
  console.error("POST /ask: answering failed:", error);
  reply.code(500).send(errorBody("internal_error", "Something went wrong answering that."));
  return;
}
```

The response body is unchanged — the generic 500 via the shared `errorBody` helper (`src/serve/server.ts:39-41`) was already correct, so only the logging half of the plan requirement was fixed. This is the plan's own prescribed wording: `docs/plans/2026-09-20-1649-feat-post-ask-route-plan.md:193` (U2, step 6) requires "the real error logged server-side (`app.log`/`console.error`) and never echoed." Verification was the existing suite — `test/serve-server.test.ts` is exactly 66 tests, all passing after the change (confirmed by running it; the full four-file serve set is 93 passing) — plus `tsc --noEmit`.

## Why This Works

The root cause is a three-link chain, each link verified in the installed tree. First, `createServer` passes `logger: false` (`src/serve/server.ts:402`), and fastify hands its options straight to `createLogger` (`node_modules/fastify/fastify.js:904`). Second, that factory's condition for installing the nullLogger is `if (!options.loggerInstance && !options.logger)` (`node_modules/fastify/lib/logger-factory.js:87-92`) — a falsy check, so the explicit `logger: false` lands in the same branch as no logger option at all, returning abstract-logging with `hasLogger: false`. Third, abstract-logging defines every level as `function noop () { }` (`node_modules/abstract-logging/index.js:3-12`), and fastify's route setup confirms the consequence: `if (hasLogger === false ...) { childLogger = logger }` (`node_modules/fastify/lib/route.js:465-468`) — every `request.log` in every route and hook is that same no-op object. `console.error` breaks the chain by writing straight to process.stderr with no framework indirection, which is also the daemon-side continuation of the codebase's existing convention: the CLI's `reportError` (`src/cli.ts:86-89`, documented as "Formats an unknown thrown value to stderr") is itself a `console.error` wrapper. The fix is minimal and invariants-preserving in both directions: the asker-visible surface is untouched (still generic, still leaking nothing), and no other route's behavior or test output changes — whereas enabling a real logger in `createServer` would flip `hasLogger` globally, giving every request a child logger and emitting per-request log lines during every `fastify.inject()` test run, a much larger blast radius than the plan's step called for.

## Prevention

**Rule for this daemon:** server-side logging in serve routes and hooks must use `console.*` (stderr) unless a real logger is first configured in `createServer`. A cheap review-checklist guard is a grep for the framework logger on the serve path — `grep -rn "request\.log\.\|app\.log" src/serve/` — which today still finds two live instances of the trap that the fix did not touch: `src/serve/auth.ts:117` (`request.log.warn({ ip }, "rate-limited: too many auth failures")`) and `src/serve/auth.ts:172-177` (`request.log.warn({ ip, limited }, "auth failed: ...")`). Both are currently no-ops under `logger: false`, so rate-limit and auth-failure events leave the same zero trace the /ask 500 did; migrating them to `console.warn` is the same one-line shape as this fix.

**The askerRefFor recurrence risk:** the directory-load fallback in `askerRefFor` (`src/serve/server.ts:61-68`) catches broadly and returns the raw asker name, currently with no logging at all. If a warning is ever added there so the owner can notice a malformed `directory.json`, it must be `console.warn(...)`, not `request.log.warn(...)` — the naive fix would silently repeat this exact trap:

```ts
} catch {
  // console.warn, NOT request.log.warn — logger:false makes request.log a no-op
  console.warn(`askerRefFor: directory at ${duoDir} unreadable; logging asks under raw names`);
  return principal.name;
}
```

**Close the testing gap:** nothing in the serve suite asserts the stderr write (no test file references `console` at all — verified by grep), which is exactly why the original no-op survived 66 passing tests. A stderr-capture assertion in the suite's existing `it` + `fastify.inject` style would pin the behavior:

```ts
it("logs the real answering failure to stderr while the asker gets the generic 500", async () => {
  const errors: unknown[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args); });
  try {
    const throwing: InferenceProvider = { name: "fake", async complete() { throw new Error("provider exploded"); } };
    const app = createServer(deps(storePath, { inferenceProvider: throwing }));
    const response = await ask({ question: "how much vacation leave do I get" }, askHeader, app);
    expect(response.statusCode).toBe(500);
    expect(errors.length).toBe(1);
    expect(String(errors[0][0])).toContain("POST /ask: answering failed");
  } finally {
    spy.mockRestore();
  }
});
```

**The enable-a-real-logger alternative and its tradeoff:** configuring Fastify's logger (e.g. `Fastify({ logger: true })` or a pino instance in `createServer`, `src/serve/server.ts:402`) would make every `request.log.*` call live — fixing the two dormant `auth.ts` warn calls for free and giving structured, leveled, redactable request logging. The cost: `hasLogger` flips globally (`node_modules/fastify/lib/logger-factory.js:87-129`), so every request gets logged, every test using `fastify.inject()` emits request/response log lines into test output (noise across the whole 66-test file), and log level/destination become new configuration surface for a single-owner daemon. That is why the console.error swap is the right minimal fix now — the plan itself (`docs/plans/2026-09-20-1649-feat-post-ask-route-plan.md:193`) names `app.log`/`console.error` as equivalents — while adopting a real logger remains a deliberate, separately-tested decision if the daemon ever needs more than owner-visible stderr diagnostics.

## Related Issues

- `docs/solutions/best-practices/ask-token-cache-policy-immediate-revocation.md` — sibling silent-failure learning on the same serve/auth surface (src/serve/auth.ts onRequest hook, POST /ask seam, the #157/#159 epic); distinct failure mode and fix.
- `docs/plans/2026-09-20-1649-feat-post-ask-route-plan.md` (U2 step 6, line 193) — the plan requirement this fix implements; note its `app.log` parenthetical option is itself a no-op under `logger:false`, so future plans should prescribe `console.error` (or a configured logger) only.
- Issue #157 (epic) and issue #159 (POST /ask) — the work this surfaced during.
