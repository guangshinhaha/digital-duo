/**
 * The role-duo definition — a checked-in, hand-authored file (same
 * "hand-edited, proposed as a reviewable diff" convention `shared-duo/
 * persona.json` and `duo/directory.json` use) naming every officer who has
 * held a post, each holder's own personal duo (storePath/duoDir), and
 * whether they have consented to their material seeding the role duo (#72
 * AC3: consent is the one thing seeding must never skip). There is no
 * "current holder" flag beyond `heldUntil === null` — exactly one holder is
 * expected to have it, checked at seed time (see seed.ts).
 */
export const ROLE_HOLDER_CONSENT_VALUES = ["given", "withheld", "unreachable", "withdrawn"] as const;
export type RoleHolderConsent = (typeof ROLE_HOLDER_CONSENT_VALUES)[number];

export interface RoleHolder {
  readonly holderId: string;
  readonly holderName: string;
  /** This holder's own personal duo's encrypted store — read-only from here; seeding never writes to it. */
  readonly storePath: string;
  /** This holder's own personal duo's derived-output directory (topics.json, rules/*.md). */
  readonly duoDir: string;
  readonly heldFrom: string;
  /** null means this holder currently holds the post. At most one holder should have this null (checked at seed time). */
  readonly heldUntil: string | null;
  /** #72 AC3: only "given" material is ever read into the role duo. */
  readonly consent: RoleHolderConsent;
}

export interface RoleDuoDefinition {
  readonly roleId: string;
  readonly roleName: string;
  readonly holders: readonly RoleHolder[];
}
