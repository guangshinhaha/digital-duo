import type { DuoConfig } from "../config.js";
import type { WorkspaceBacklogPolicy } from "./read-state.js";

/**
 * #186: whether `duo serve` dials out to the org workspace at all. The three
 * credential-shaped values (`docs/workspace-platform.md` §6: the duo's own
 * Matrix account) are all-or-nothing on purpose — a homeserver with no token,
 * or a token with no homeserver, is a pairing that half-happened, and
 * silently ignoring it would read to the owner as "my duo is in the
 * workspace" while it answers nothing. So partial configuration refuses to
 * boot (before any socket opens, the same place `assertServableHost` refuses),
 * and only a fully-absent configuration means "no workspace" — the zero-
 * behavior-change case for every non-workspace user.
 */
export class WorkspaceConfigError extends Error {
  constructor(reason: string) {
    super(`Refusing to start the workspace connection: ${reason}`);
    this.name = "WorkspaceConfigError";
  }
}

/**
 * Whether a hostname is on Railway's private network (`<service>.railway.internal`).
 * Traffic to it never leaves the project, so plain http is acceptable there
 * (docs/deploy/hosted-workspace.md §5); every other host still needs https.
 */
export function isRailwayInternalHost(hostname: string): boolean {
  return hostname.toLowerCase().endsWith(".railway.internal");
}

/** The validated shape the transport and service are built from. */
export interface WorkspaceSettings {
  /** The org homeserver's base URL (https, or http on a `*.railway.internal` host — the access token rides this URL). */
  readonly homeserverUrl: string;
  /**
   * The duo's own Matrix access token. Env-sourced (`DUO_WORKSPACE_ACCESS_TOKEN`)
   * exactly like `DUO_PASSPHRASE` and `DUO_JEV_API_KEY`: it exists in the
   * process environment and in this value, and this code never writes it
   * anywhere else — no file, no log line, no payload field.
   */
  readonly accessToken: string;
  /** The duo's own Matrix user id, e.g. `@duo-alice:workspace`. */
  readonly userId: string;
  readonly reconnect: {
    readonly initialDelayMs: number;
    readonly maxDelayMs: number;
  };
  readonly presenceIntervalMs: number;
  /**
   * #189's backlog policy knobs (read-state.ts documents the semantics):
   * how old an event may be and still be answered on a restart/sync
   * catch-up, and how many answers per rolling minute the pipeline will
   * give a flood. Defaults come from config.ts (1h / 30 per minute); #188
   * retunes them without a code change, the same stance the timing knobs
   * above take.
   */
  readonly backlog: WorkspaceBacklogPolicy;
  /** W-S4-5: the ack threshold (`DUO_WORKSPACE_ACK_AFTER_MS`, default 2000) — docs/workspace/cards.md §8. */
  readonly ackAfterMs: number;
}

/**
 * Turns config's raw workspace section into either `null` (no workspace —
 * serve behaves exactly as before #186) or fully-validated settings. Throws
 * `WorkspaceConfigError` for anything in between: a partially-set
 * configuration, a non-https homeserver (the Jev gateway's own rule — the
 * token must never ride a plaintext URL), a userId that isn't a Matrix
 * user id, or a reconnect/presence timing knob that isn't a positive number
 * of milliseconds (the service arms those verbatim — see the check below).
 */
export function workspaceSettingsFrom(config: DuoConfig): WorkspaceSettings | null {
  const { homeserverUrl, accessToken, userId } = config.workspace;
  // Which of the three env vars is unset, in a fixed order for the error
  // message: all three unset is "no workspace", none unset is "configure",
  // and anything between is the half-paired state the doc comment above
  // refuses to boot on.
  const missing = [
    homeserverUrl === undefined ? "DUO_WORKSPACE_HOMESERVER" : null,
    accessToken === undefined ? "DUO_WORKSPACE_ACCESS_TOKEN" : null,
    userId === undefined ? "DUO_WORKSPACE_USER_ID" : null,
  ].filter((name): name is string => name !== null);
  if (missing.length === 3) {
    return null;
  }
  if (missing.length > 0) {
    throw new WorkspaceConfigError(
      `the workspace configuration is incomplete — set ${missing.join(", ")} too, or unset all three to serve without a workspace`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(homeserverUrl!);
  } catch {
    throw new WorkspaceConfigError(`DUO_WORKSPACE_HOMESERVER is not a parseable URL (got ${JSON.stringify(homeserverUrl)})`);
  }
  // http is allowed only on Railway's private network, where the token never leaves the project.
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isRailwayInternalHost(parsed.hostname))) {
    throw new WorkspaceConfigError(
      `DUO_WORKSPACE_HOMESERVER must be https (got ${JSON.stringify(parsed.protocol)}) — the duo's access token rides this URL and must never be sent in plaintext (plain http is accepted only for a *.railway.internal host)`,
    );
  }
  if (!userId!.startsWith("@") || !userId!.includes(":")) {
    throw new WorkspaceConfigError(
      `DUO_WORKSPACE_USER_ID must be a Matrix user id like "@duo-alice:workspace" (got ${JSON.stringify(userId)})`,
    );
  }

  // The timing knobs reach setInterval/setTimeout verbatim (the service arms
  // them directly), so a zero or negative value is not a cosmetic problem:
  // Node clamps a 0 presence interval to ~1ms (a presence PUT per event-loop
  // turn) and a 0 reconnect delay re-dials immediately after every failure.
  // All three have positive defaults, so a non-positive value always means a
  // bad env var — refused here, the same all-or-nothing boot stance as the
  // string checks above.
  const timingKnobs: { envVar: string; value: number }[] = [
    { envVar: "DUO_WORKSPACE_RECONNECT_INITIAL_MS", value: config.workspace.reconnect.initialDelayMs },
    { envVar: "DUO_WORKSPACE_RECONNECT_MAX_MS", value: config.workspace.reconnect.maxDelayMs },
    { envVar: "DUO_WORKSPACE_PRESENCE_INTERVAL_MS", value: config.workspace.presenceIntervalMs },
    // W-S4-5: the ack threshold is armed verbatim as a setTimeout delay
    // (the service's own ack timer) — the same hot-loop risk a zero or
    // negative reconnect/presence knob has, so it is validated the same
    // all-or-nothing way.
    { envVar: "DUO_WORKSPACE_ACK_AFTER_MS", value: config.workspace.ackAfterMs },
  ];
  for (const knob of timingKnobs) {
    if (!Number.isFinite(knob.value) || knob.value <= 0) {
      throw new WorkspaceConfigError(
        `${knob.envVar} must be a positive number of milliseconds (got ${JSON.stringify(knob.value)}) — a zero or negative value would hot-loop the daemon against the homeserver`,
      );
    }
  }

  // #189's backlog knobs are validated with the same all-or-nothing stance:
  // a zero/negative age window or rate bound is not a "skip the policy"
  // setting but a broken one — the age window is also the durable
  // read-state table's retention, and a rate bound of zero would refuse
  // every question. The count must additionally be a whole number: half an
  // answer per minute has no meaning the sliding window could apply.
  if (!Number.isFinite(config.workspace.backlog.maxAgeMs) || config.workspace.backlog.maxAgeMs <= 0) {
    throw new WorkspaceConfigError(
      `DUO_WORKSPACE_BACKLOG_MAX_AGE_MS must be a positive number of milliseconds (got ${JSON.stringify(config.workspace.backlog.maxAgeMs)}) — the backlog window doubles as the durable read state's retention, and a zero or negative value would prune or refuse everything`,
    );
  }
  if (!Number.isInteger(config.workspace.backlog.maxAnswersPerMinute) || config.workspace.backlog.maxAnswersPerMinute < 1) {
    throw new WorkspaceConfigError(
      `DUO_WORKSPACE_MAX_ANSWERS_PER_MINUTE must be a whole number of at least 1 (got ${JSON.stringify(config.workspace.backlog.maxAnswersPerMinute)}) — zero would refuse every question`,
    );
  }

  return {
    // All three are set — `missing` is empty here — but the filter above
    // doesn't narrow the destructured bindings, hence the assertions.
    homeserverUrl: homeserverUrl!,
    accessToken: accessToken!,
    userId: userId!,
    reconnect: config.workspace.reconnect,
    presenceIntervalMs: config.workspace.presenceIntervalMs,
    backlog: config.workspace.backlog,
    ackAfterMs: config.workspace.ackAfterMs,
  };
}
