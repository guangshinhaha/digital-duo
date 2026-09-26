import type { DuoConfig } from "../config.js";
import { attachmentGroundingDoor } from "../drafting/attachment-grounding.js";
import { parseClassificationCeiling } from "../permissions/classification.js";
import { answerPublicly } from "../permissions/public-answer.js";
import { createOllamaEmbeddingProvider } from "../provider/ollama-embedding-provider.js";
import { tryResolveProvider } from "../provider/registry.js";
import { assertServableHost } from "../serve/bind.js";
import { resolvePassphraseForServing } from "../serve/passphrase.js";
import { createServer, type ServeDeps } from "../serve/server.js";
import {
  createAskToken,
  createConnectorToken,
  createDeviceToken,
  listAskTokens,
  listDeviceTokens,
  revokeAskToken,
  revokeDeviceToken,
  type AskToken,
  type DeviceToken,
  type MintedAskLink,
  type MintedConnectorToken,
  type PairedDevice,
} from "../serve/tokens.js";
import { DecryptionError } from "../store/crypto.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists, withDatabase } from "../store/store.js";
import { durableDuoReadState } from "../serve/workspace-read-state.js";
import { askerContextForSender } from "../workspace/asker.js";
import { workspaceSettingsFrom, type WorkspaceSettings } from "../workspace/settings.js";
import { WorkspaceService } from "../workspace/service.js";
import type { WorkspaceTransport, WorkspaceTransportFactory } from "../workspace/transport.js";

/** Thrown by `runServe` when the resolved passphrase doesn't decrypt the store — checked once at boot, before binding, so a typo'd `DUO_PASSPHRASE` fails loudly here instead of the daemon reporting "listening" and then 500ing every request forever (every route's first real store access would otherwise be the first place this surfaces). */
export class ServePassphraseMismatchError extends Error {
  constructor(storePath: string, cause: DecryptionError) {
    super(`The passphrase for "${storePath}" is wrong: ${cause.message}`);
    this.name = "ServePassphraseMismatchError";
  }
}

export interface ServeOptions {
  readonly host: string | undefined;
  readonly port: number;
  /** Allows a wildcard host — only for a container behind a TLS-terminating front (see assertServableHost). */
  readonly behindProxy?: boolean;
}

/**
 * The default workspace transport factory: lazily imports the matrix-js-sdk
 * adapter so a daemon with no workspace configured (and every test of the
 * non-workspace surface) never loads the SDK at all. Dynamic on purpose —
 * `matrix-js-sdk` is the repo's largest dependency and nothing else in the
 * serve path needs it.
 */
async function defaultWorkspaceTransportFactory(settings: WorkspaceSettings): Promise<WorkspaceTransport> {
  const { createMatrixTransport } = await import("../workspace/matrix-transport.js");
  return createMatrixTransport(settings);
}

/**
 * Implements `duo serve` (`client-tech-design.md` §1.3): resolves the
 * passphrase and providers once, refuses an unsafe bind host, and starts
 * listening. Returns the bound address and a `close` function rather than
 * blocking forever itself, so a test (or a wrapping process) controls the
 * daemon's lifetime rather than this function owning `process` directly.
 *
 * #186: alongside the inbound listener, a configured workspace starts the
 * OUTBOUND Matrix connection (docs/workspace-platform.md §5 — the boundary
 * held by connection direction). No workspace config means none of this
 * runs: serve is byte-for-byte its pre-#186 self.
 */
export async function runServe(
  options: ServeOptions,
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
  workspaceTransportFactory: WorkspaceTransportFactory = defaultWorkspaceTransportFactory,
): Promise<{ address: string; close: () => Promise<void> }> {
  requireStoreExists(config.storePath);
  assertServableHost(options.host, { behindProxy: options.behindProxy });
  // Boot refusals in the assertServableHost family: a half-configured
  // workspace (or a plaintext homeserver URL) must fail loudly before any
  // socket opens, not surface later as a duo that silently isn't there.
  const workspaceSettings = workspaceSettingsFrom(config);

  const passphrase = await resolvePassphraseForServing(env);
  try {
    withDatabase(config.storePath, passphrase, false, () => {});
  } catch (error) {
    if (error instanceof DecryptionError) {
      throw new ServePassphraseMismatchError(config.storePath, error);
    }
    throw error;
  }

  const embeddingProvider = createOllamaEmbeddingProvider(config);
  const inferenceProvider = tryResolveProvider(config);

  // Annotated, not inferred: the answer closure below reaches back into
  // `workspace` for the member cache (the #187 feed), and a self-referencing
  // initializer is exactly the shape TS refuses to infer through.
  const workspace: WorkspaceService | undefined = workspaceSettings
    ? new WorkspaceService({
        settings: workspaceSettings,
        transportFactory: workspaceTransportFactory,
        // #189: durable read state in the same encrypted store the answers
        // themselves log to — which events previous processes handled, so a
        // restart no longer re-answers the sync window. The impl lives in
        // src/serve/ (the workspace boundary scan forbids the store import
        // there); its retention is the backlog age window, one concept.
        readState: durableDuoReadState(config.storePath, passphrase, workspaceSettings.backlog.maxAgeMs),
        // #192: the consent surface — held invitations, the shared-room
        // gate, allow/refuse/withdrawal — over the same `duo/` directory
        // every other owner policy lives in (consent.ts states why a file
        // and not the store). Wired whenever a workspace exists at all, so
        // the owner surface is never half-configured.
        consent: { duoDir: config.duoDir },
        // #190: the attachment grounding door, wired with the owner's own
        // classification ceiling — the same parsed value every ingest
        // boundary reads, because this is the same policy applied at a
        // different door. Parsed here, at wiring, in the boot-refusal
        // family: a workspace-configured daemon with an unparseable
        // DUO_CLASSIFICATION_CEILING must not come up guessing what a door
        // should admit (every other surface already fails the same value
        // at its own point of use).
        attachmentDoor: attachmentGroundingDoor(parseClassificationCeiling(config.classificationCeiling)),
        // THE answering pipeline, not a workspace twin: the identical
        // answerPublicly call POST /ask makes, argument for argument, with
        // the asking Matrix user resolved through the same directory
        // lookup. A question over the workspace connection and a question
        // over an ask link cannot diverge, because this is one call.
        answer: (question) =>
          answerPublicly(
            config.storePath,
            passphrase,
            config.duoDir,
            // POST /ask hands answerPublicly a trimmed question; a chat
            // client's body can carry trailing whitespace. The trim keeps
            // "argument for argument" true (the body itself is non-blank —
            // directQuestionFrom already rejected whitespace-only).
            question.body.trim(),
            // #187's feed: the sender's workspace member record when the
            // daemon's connect-time listing has one, through the same
            // resolver either way (asker.ts — the member is the mapping's
            // input, never a second resolution path).
            askerContextForSender(question.senderId, config.duoDir, workspace?.memberFor(question.senderId)),
            embeddingProvider,
            inferenceProvider,
            config.confidence,
            config.ownerName,
            // #190: what the door admitted — the asker's files, decoded
            // and marking-stripped, grounding this one draft call. The
            // door refused, or the question rode with nothing, and this is
            // undefined — the pre-#190 call shape, byte-identical.
            question.grounding,
          ),
      })
    : undefined;

  const deps: ServeDeps = {
    storePath: config.storePath,
    passphrase,
    duoDir: config.duoDir,
    lifecycleLogPath: config.lifecycleLogPath,
    embeddingProvider,
    inferenceProvider,
    confidenceConfig: config.confidence,
    classificationCeiling: config.classificationCeiling,
    ownerName: config.ownerName,
    env,
    // #192: the consent routes' service — present exactly when the workspace
    // is (the consent surface is wired with it, one configuration).
    workspace,
    trustProxy: options.behindProxy ?? false,
  };

  const app = createServer(deps);
  const address = await app.listen({ host: options.host, port: options.port });
  // start() returns without waiting on the workspace: an unreachable
  // homeserver must not delay the HTTP listener — the connection retries
  // in the background and its state is observable on the service.
  workspace?.start();
  return {
    address,
    close: async () => {
      // In parallel, not in series: the two shutdowns are independent, and
      // app.close() drains in-flight /ask requests (LLM drafting) while
      // workspace.stop() tears down its own connection — neither should
      // wait on the other, and a workspace.stop() rejection must not skip
      // closing the listener.
      await Promise.all([workspace ? workspace.stop() : Promise.resolve(), app.close()]);
    },
  };
}

// `duo pair`/`duo pair list`/`duo pair revoke` are management commands run
// interactively at a terminal, not the daemon itself — they use the
// ordinary CLI passphrase resolution (resolveOrCreatePassphrase, disk
// fallback included), the same as every other `duo mirror`/`duo trust`
// command. Only `duo serve` itself, which holds the passphrase in memory
// behind an open socket, is bound by the no-disk-fallback rule
// (serve/passphrase.ts's resolvePassphraseForServing, used above).

/** Implements `duo pair <name>` (`client-tech-design.md` Part 2): mints a device token and prints it exactly once — it is never persisted anywhere in recoverable form. */
export function runPair(name: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): PairedDevice {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return createDeviceToken(config.storePath, passphrase, name);
}

/**
 * Implements `duo connector new` (#227): mints this duo's claude.ai connector
 * secret, revoking any earlier one, and returns the MCP URL to paste. The
 * base is DUO_PUBLIC_URL, else Railway's RAILWAY_PUBLIC_DOMAIN, else only
 * the path is known and the caller prefixes the daemon's address itself.
 */
export function runConnectorNew(
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): MintedConnectorToken & { readonly url: string } {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const minted = createConnectorToken(config.storePath, passphrase);
  const base = env.DUO_PUBLIC_URL?.replace(/\/+$/, "") ?? (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : "");
  return { ...minted, url: `${base}/mcp/${minted.token}` };
}

/** Implements `duo pair list`. */
export function runPairList(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): DeviceToken[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listDeviceTokens(config.storePath, passphrase);
}

/** Implements `duo pair revoke <id>`. Immediate; closes that device's ability to authenticate on its very next request. */
export function runPairRevoke(id: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): void {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  revokeDeviceToken(config.storePath, passphrase, id);
}

// `duo ask-link` (issue #158) mints a second token kind, not a device token
// with a permission flag: an ask link is short-lived and ask-only, and lives
// in its own `ask_tokens` table so it is structurally never a PairedDevice
// (`duo pair list` reads `device_tokens` and cannot see these). The expiry
// arithmetic (default 24h, `--expires-in-hours`) is the CLI edge's job
// (KTD4) — this layer takes the ISO-8601 instant as given.

/** Implements `duo ask-link new <name>`: mints a short-lived, ask-only link and returns it exactly once — the raw token is never persisted anywhere in recoverable form. */
export function runAskLink(name: string, expiresAt: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): MintedAskLink {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return createAskToken(config.storePath, passphrase, name, expiresAt);
}

/** Implements `duo ask-link list` — oldest first, revoked and expired included; no token value is ever listed. */
export function runAskLinkList(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): AskToken[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listAskTokens(config.storePath, passphrase);
}

/** Implements `duo ask-link revoke <id>`. Immediate; revoking an already-revoked link is a no-op, not an error. */
export function runAskLinkRevoke(id: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): void {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  revokeAskToken(config.storePath, passphrase, id);
}
