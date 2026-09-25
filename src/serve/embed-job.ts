import { embedRecords } from "../ingest/embeddings.js";
import type { EmbeddingProvider } from "../provider/types.js";

/**
 * How many records each embedRecords call embeds before the job publishes
 * progress. Purely a reporting granularity (#176's "progress is
 * observable"): smaller batches mean more store re-reads, larger ones mean
 * longer silent stretches. Ten keeps a real corpus's count climbing at a
 * human-visible pace at personal-corpus scale.
 */
const EMBED_BATCH_SIZE = 10;

export interface EmbedJobStatus {
  /** "idle" until the first start ever; "running" while batches proceed; "done"/"error" after the last one. */
  readonly state: "idle" | "running" | "done" | "error";
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** Cumulative records embedded by the current job — climbs by batch as it runs. */
  readonly embedded: number;
  /** Total records in the store — the same denominator `duo embed` prints. */
  readonly total: number;
  /** The failing error's own message, verbatim; null unless state is "error". */
  readonly error: string | null;
}

/**
 * The daemon's one embed job (#176). Embedding a real corpus is minutes of
 * provider round-trips — not a request-response shape — so POST
 * /corpus/embed starts this job and GET /corpus/embed reports it, exactly
 * one job at a time: an embed is a whole-corpus operation, and a second
 * concurrent job would race the first over the same store.
 *
 * This is process-bound runtime state, like the draft-ready hub — it has no
 * CLI twin because it *is* the daemon's own run of the same `embedRecords`
 * the `duo embed` command calls directly, driven in batches so the status
 * between batches reflects persisted work (each embedRecords call writes
 * before the next one reads).
 */
export class EmbedJob {
  private status: EmbedJobStatus = {
    state: "idle",
    startedAt: null,
    finishedAt: null,
    embedded: 0,
    total: 0,
    error: null,
  };

  current(): EmbedJobStatus {
    return this.status;
  }

  /**
   * Starts a job unless one is running; returns false when refused (the
   * route answers that as a 409). Never throws — the job's own failures
   * land in the status as state "error", because a client that just
   * received a 202 must be able to read *what* went wrong from GET.
   */
  start(storePath: string, passphrase: string, provider: EmbeddingProvider): boolean {
    if (this.status.state === "running") {
      return false;
    }
    this.status = { state: "running", startedAt: new Date().toISOString(), finishedAt: null, embedded: 0, total: 0, error: null };
    void this.run(storePath, passphrase, provider);
    return true;
  }

  private async run(storePath: string, passphrase: string, provider: EmbeddingProvider): Promise<void> {
    try {
      let cumulative = 0;
      let total = 0;
      // A batch that came back short means the pending set is exhausted
      // (the read pass only ever returns records still missing a vector
      // under this model), so a short batch is the stop condition — the
      // loop cannot spin on an empty set.
      for (;;) {
        const result = await embedRecords(storePath, passphrase, provider, { limit: EMBED_BATCH_SIZE });
        cumulative += result.embedded;
        total = result.total;
        this.status = { ...this.status, embedded: cumulative, total };
        if (result.embedded < EMBED_BATCH_SIZE) {
          break;
        }
      }
      this.status = { ...this.status, state: "done", finishedAt: new Date().toISOString() };
    } catch (error) {
      // The job dies where it died: already-embedded batches stay embedded
      // (each call persisted before the next), and the error is reported
      // verbatim for the owner reading GET /corpus/embed.
      this.status = {
        ...this.status,
        state: "error",
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
