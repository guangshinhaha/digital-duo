import { listAvailableDuos, type DuoSummary } from "../duo/registry.js";

/** Implements `duo list`: every duo this process can currently reach — see `listAvailableDuos` for why this is at most two entries, never a general registry. */
export function runList(env: NodeJS.ProcessEnv = process.env): DuoSummary[] {
  return listAvailableDuos(env);
}
