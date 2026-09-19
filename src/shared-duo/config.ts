// Where the shared duo's persona file lives (concept.md §12, phase 1.5;
// v1-spec.md §3's "model it as an entity" deferral). Deliberately its own
// tiny config, not a field on the personal duo's DuoConfig (src/config.ts):
// the shared duo isn't scoped to one owner's data directory, and #67's own
// out-of-scope list rules out more than one shared duo existing in this
// phase, so there is nothing here that needs to vary per-duo yet.
const DEFAULT_SHARED_PERSONA_PATH = "shared-duo/persona.json";
// Every question asked, and whether it was answered — #69's log. Deliberately
// its own top-level directory, not `data/` (the *personal* duo's encrypted
// store directory — `duo purge` deletes that whole directory, and the shared
// duo's usage history must survive a personal `duo purge` untouched, same as
// it must survive the personal store being unreadable at all) and not
// `shared-duo/` (the reviewed, versioned persona) since usage is runtime
// data, not configuration, and must never be committed alongside it.
const DEFAULT_USAGE_LOG_PATH = "shared-duo-runtime/usage.json";

export interface SharedDuoConfig {
  readonly personaPath: string;
  readonly usageLogPath: string;
}

/**
 * Reads the shared duo's persona and usage-log paths from the
 * environment. A pure read, same shape as src/config.ts's loadConfig —
 * never validates or loads either file itself, so a caller that only
 * needs a path (or wants to report it) never pays for a load it didn't
 * ask for.
 */
export function loadSharedDuoConfig(env: NodeJS.ProcessEnv = process.env): SharedDuoConfig {
  return {
    personaPath: env.DUO_SHARED_PERSONA_PATH || DEFAULT_SHARED_PERSONA_PATH,
    usageLogPath: env.DUO_SHARED_USAGE_LOG_PATH || DEFAULT_USAGE_LOG_PATH,
  };
}
