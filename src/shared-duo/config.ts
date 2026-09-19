// Where the shared duo's persona file lives (concept.md §12, phase 1.5;
// v1-spec.md §3's "model it as an entity" deferral). Deliberately its own
// tiny config, not a field on the personal duo's DuoConfig (src/config.ts):
// the shared duo isn't scoped to one owner's data directory, and #67's own
// out-of-scope list rules out more than one shared duo existing in this
// phase, so there is nothing here that needs to vary per-duo yet.
const DEFAULT_SHARED_PERSONA_PATH = "shared-duo/persona.json";

/**
 * Reads the shared duo's persona file path from the environment. A pure
 * read, same shape as src/config.ts's loadConfig — never validates or
 * loads the file itself, so callers that only need the path (or want to
 * report it) never pay for a load they didn't ask for.
 */
export function loadSharedDuoConfig(env: NodeJS.ProcessEnv = process.env): { personaPath: string } {
  return { personaPath: env.DUO_SHARED_PERSONA_PATH || DEFAULT_SHARED_PERSONA_PATH };
}
