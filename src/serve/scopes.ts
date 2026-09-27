/**
 * Issue #256: what a connected Claude may do with a duo, as OAuth scopes. The
 * owner chooses which to grant on the sign-in page, and the daemon checks the
 * granted set on every tool call, so a refusal does not depend on the tool
 * being hidden in claude.ai.
 */
export const SCOPES = ["duo:read", "duo:save", "duo:operate", "duo:send"] as const;
export type Scope = (typeof SCOPES)[number];

export interface ScopeInfo {
  /** What the sign-in page and the Settings card call it. */
  readonly label: string;
  /** One plain sentence on what it lets Claude do. */
  readonly description: string;
  /** Whether the sign-in page ticks it to start with. Sending is never on by default. */
  readonly defaultOn: boolean;
}

export const SCOPE_INFO: Readonly<Record<Scope, ScopeInfo>> = {
  "duo:read": {
    label: "Read",
    description: "Search your duo, and see what it knows, its rules, its voice, its drafts and what is waiting for you.",
    defaultOn: true,
  },
  "duo:save": {
    label: "Save",
    description: "Add notes to your duo.",
    defaultOn: true,
  },
  "duo:operate": {
    label: "Operate",
    description: "Ask your duo questions and have it draft replies (each needs Read too, and leaves a record), embed and derive it (deriving rewrites its voice file), discard drafts, correct a public answer, and queue your answers as rule candidates. Nothing here sends a message.",
    defaultOn: true,
  },
  "duo:send": {
    label: "Send",
    description: "Record a draft as sent or edited. For a question that came from a channel this hands the text to that channel as you, once a channel is connected; today none is.",
    defaultOn: false,
  },
};

/** What a connection is given when nothing narrower was chosen. */
export const DEFAULT_SCOPES: readonly Scope[] = SCOPES.filter((scope) => SCOPE_INFO[scope].defaultOn);

/** What a connection made before scopes existed, or through a secret URL (#227), can do: save, as it always could. */
export const LEGACY_SCOPES: readonly Scope[] = ["duo:save"];

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

/** The scopes named in a space-separated OAuth `scope` value, in canonical order, unknown names dropped; undefined when none is a known scope. */
export function parseScopes(raw: unknown): Scope[] | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const named = new Set(raw.split(/\s+/).filter(isScope));
  const scopes = SCOPES.filter((scope) => named.has(scope));
  return scopes.length > 0 ? scopes : undefined;
}
