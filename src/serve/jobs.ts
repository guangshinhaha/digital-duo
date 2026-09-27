import { DeriveJob } from "./derive-job.js";
import { EmbedJob } from "./embed-job.js";
import type { ServeDeps } from "./server.js";

/** A duo's two long-running jobs. Each is one at a time, so the app and a connected Claude must share them, not each start their own. */
export interface DuoJobs {
  readonly embed: EmbedJob;
  readonly derive: DeriveJob;
}

const jobsByDeps = new WeakMap<ServeDeps, DuoJobs>();

/**
 * The jobs belonging to one duo, keyed by the deps object its app was built
 * from. The app's own routes and the MCP tools are both handed that same
 * object (hosted mode keeps it beside each mounted duo), so an embed the
 * owner starts in the app shows as running to Claude, and the other way
 * round, and a second start is refused instead of running twice.
 */
export function jobsFor(deps: ServeDeps): DuoJobs {
  let jobs = jobsByDeps.get(deps);
  if (!jobs) {
    jobs = { embed: new EmbedJob(), derive: new DeriveJob() };
    jobsByDeps.set(deps, jobs);
  }
  return jobs;
}
