const DEFAULT_STORE_PATH = "data/duo.db";
const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
// Embeddings run locally via Ollama unconditionally (v1-tech-design.md §1.2)
// — unlike the completion model, this doesn't wait on G1, so it gets a real
// default rather than requiring explicit configuration.
const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";

export interface DuoConfig {
  /** Raw configured provider name, or undefined when DUO_PROVIDER is unset. */
  providerName: string | undefined;
  /** Path to the local store file. Defaults to "data/duo.db". */
  storePath: string;
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
    ollama: {
      host: env.DUO_OLLAMA_HOST || DEFAULT_OLLAMA_HOST,
      model: env.DUO_OLLAMA_MODEL || undefined,
      embeddingModel: env.DUO_OLLAMA_EMBEDDING_MODEL || DEFAULT_OLLAMA_EMBEDDING_MODEL,
    },
  };
}
