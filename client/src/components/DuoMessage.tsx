import type { ReactNode } from "react";

/**
 * Renders duo-generated text. `concept.md`: "always labelled … it never
 * poses as you." `client-tech-design.md` §3.4 promotes that from a
 * guideline to a structural rule: this component has no `avatar` prop —
 * there is nothing to pass — so a Slack-shaped chat bubble that puts the
 * owner's own avatar on generated text is impossible to build with it, not
 * merely discouraged.
 *
 * Never import an avatar/identity component inside this file's subtree.
 * (See client/eslint.config.js's no-restricted-imports rule, which
 * enforces this at lint time — this comment is the "why", that rule is
 * the "how it's kept true".)
 */
export function DuoMessage({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="duo-message"
      className="rounded-[var(--r-lg)] border border-[var(--edge)] bg-[var(--surface-2)] px-4 py-3 text-[var(--text)]"
    >
      <div className="mb-1 text-xs font-medium tracking-wide text-[var(--muted)]" data-testid="duo-message-attribution">
        Your duo
      </div>
      <div>{children}</div>
    </div>
  );
}
