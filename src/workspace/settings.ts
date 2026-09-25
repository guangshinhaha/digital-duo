import type { DuoConfig } from "../config.js";

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

/** The validated shape the transport and service are built from. */
export interface WorkspaceSettings {
  /** The org homeserver's base URL (https only — the access token rides this URL). */
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
  if (parsed.protocol !== "https:") {
    throw new WorkspaceConfigError(
      `DUO_WORKSPACE_HOMESERVER must be https (got ${JSON.stringify(parsed.protocol)}) — the duo's access token rides this URL and must never be sent in plaintext`,
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
  ];
  for (const knob of timingKnobs) {
    if (!Number.isFinite(knob.value) || knob.value <= 0) {
      throw new WorkspaceConfigError(
        `${knob.envVar} must be a positive number of milliseconds (got ${JSON.stringify(knob.value)}) — a zero or negative value would hot-loop the daemon against the homeserver`,
      );
    }
  }

  return {
    // All three are set — `missing` is empty here — but the filter above
    // doesn't narrow the destructured bindings, hence the assertions.
    homeserverUrl: homeserverUrl!,
    accessToken: accessToken!,
    userId: userId!,
    reconnect: config.workspace.reconnect,
    presenceIntervalMs: config.workspace.presenceIntervalMs,
  };
}
