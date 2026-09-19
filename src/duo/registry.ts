import { existsSync } from "node:fs";
import { loadSharedDuoConfig } from "../shared-duo/config.js";
import { loadSharedDuo } from "../shared-duo/loader.js";

/**
 * A duo the owner running this CLI can currently reach — the sidebar's
 * data source (`client-tech-design.md` G-c). This is deliberately not a
 * general multi-duo registry: there is no file anywhere that enumerates
 * role duos (each is addressed by an explicit definition path passed to
 * `duo role-duo`), so listing them here would be the daemon inventing a
 * behaviour the CLI itself doesn't have — exactly what
 * `client-tech-design.md` Part 0 forbids. What genuinely always exists is
 * at most two: the personal duo this process is configured against, and
 * the one shared duo, if `shared-duo/persona.json` (or
 * `DUO_SHARED_PERSONA_PATH`) is present and well-formed.
 */
export type DuoSummary =
  | { readonly kind: "personal" }
  | { readonly kind: "shared"; readonly ownerId: string; readonly ownerName: string };

/**
 * The personal duo is always listed — this process *is* its personal duo,
 * the same way `duo ask`/`duo draft` never take a duo id. The shared duo
 * is included only when its persona file exists and loads cleanly;
 * anything else (not configured, malformed, names no human owner) is
 * treated as "no shared duo yet" rather than an error, so a sidebar never
 * fails to render because of a config file it doesn't strictly need.
 */
export function listAvailableDuos(env: NodeJS.ProcessEnv = process.env): DuoSummary[] {
  const summaries: DuoSummary[] = [{ kind: "personal" }];
  const { personaPath } = loadSharedDuoConfig(env);
  if (!existsSync(personaPath)) {
    return summaries;
  }
  try {
    const shared = loadSharedDuo(personaPath);
    if (shared.owner.kind === "person") {
      summaries.push({ kind: "shared", ownerId: shared.owner.id, ownerName: shared.owner.name });
    }
  } catch {
    // Malformed persona file, or one whose owner isn't a person (loadSharedDuo
    // already enforces that and would have thrown) — best-effort, omit it.
  }
  return summaries;
}
