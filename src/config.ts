const DEFAULT_STORE_PATH = "data/duo.db";
// The human-readable, git-versioned half of the derived output
// (v1-tech-design.md §1.3: `duo/topics.json`, `duo/rules/*.md`, `duo/voice.md`) —
// deliberately separate from `storePath`'s encrypted database directory.
const DEFAULT_DUO_DIR = "duo";
const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
// Embeddings run locally via Ollama unconditionally (v1-tech-design.md §1.2)
// — unlike the completion model, this doesn't wait on G1, so it gets a real
// default rather than requiring explicit configuration.
const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
// The classification ceiling is policy-set, not owner-set (#48 AC: "set by
// configuration under policy control, not by the owner in the UI"), and
// defaults to the most conservative real-world default rather than the
// most permissive (v1-tech-design.md §2: a pilot corpus is "probably ...
// Official (Open) only").
const DEFAULT_CLASSIFICATION_CEILING = "official_open";

export interface DuoConfig {
  /** Raw configured provider name, or undefined when DUO_PROVIDER is unset. */
  providerName: string | undefined;
  /** Path to the local store file. Defaults to "data/duo.db". */
  storePath: string;
  /** Raw configured classification ceiling (DUO_CLASSIFICATION_CEILING). Defaults to "official_open". Validated at the point of use (parseClassificationCeiling), same pattern as providerName — a bad value is a usage-time error, not a load-time one, so `duo status` can always report it raw. */
  classificationCeiling: string;
  /** Directory for human-readable, git-versioned derived output (topics.json, rules/*.md, voice.md). Defaults to "duo". Never encrypted, never purged by `duo purge`. */
  duoDir: string;
  ollama: {
    /** Ollama HTTP host. Defaults to "http://localhost:11434". */
    host: string;
    /** Ollama model name, or undefined when DUO_OLLAMA_MODEL is unset. */
    model: string | undefined;
    /** Ollama embedding model name. Defaults to "nomic-embed-text". */
    embeddingModel: string;
  };
}

/**
 * Reads configuration from environment variables. This is a pure read: it
 * applies only the two documented defaults (store path, Ollama host) and
 * never validates or rejects a provider name or model — that validation
 * belongs to `resolveProvider` (see src/provider/registry.ts), so `duo
 * status` can report raw configuration without ever throwing.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): DuoConfig {
  return {
    providerName: env.DUO_PROVIDER || undefined,
    storePath: env.DUO_STORE_PATH || DEFAULT_STORE_PATH,
    classificationCeiling: env.DUO_CLASSIFICATION_CEILING || DEFAULT_CLASSIFICATION_CEILING,
    duoDir: env.DUO_DIR || DEFAULT_DUO_DIR,
    ollama: {
      host: env.DUO_OLLAMA_HOST || DEFAULT_OLLAMA_HOST,
      model: env.DUO_OLLAMA_MODEL || undefined,
      embeddingModel: env.DUO_OLLAMA_EMBEDDING_MODEL || DEFAULT_OLLAMA_EMBEDDING_MODEL,
    },
  };
}
