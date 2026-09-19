import { readRefusalsFile as readCanonicalRefusalsFile } from "../trust/refusals.js";

/**
 * `duo/refusals.md` has exactly one real format — `##`-headed sections
 * with a reason body — established by `../trust/refusals.ts` (#53) and
 * now written for real by #29 (`duo mirror refusals`, docs/concept.md
 * §10). This module used to parse its own, different shape (`- subject`
 * bullet lines); that was never wrong on its own terms, but it meant a
 * refusal the owner actually recorded through the Mirror would be
 * silently invisible to this gate. Delegating to the canonical reader and
 * using each refusal's `heading` as "the subject" (the short phrase this
 * module's own keyword-containment check, matchesRefusedSubject, was
 * always designed around) fixes that without touching anything this
 * module's own callers rely on: the return shape here stays `string[]`.
 */
export function readRefusalsFile(duoDir: string): string[] {
  return readCanonicalRefusalsFile(duoDir).map((refusal) => refusal.heading);
}
