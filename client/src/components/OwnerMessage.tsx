import type { ReactNode } from "react";

/**
 * Renders the owner's own words — a sent reply, a typed question. The only
 * component in this codebase that may carry the owner's identity
 * (`DuoMessage`'s doc comment explains why that split exists).
 */
export function OwnerMessage({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="owner-message"
      className="rounded-[var(--r-lg)] border border-[var(--edge)] bg-[var(--surface)] px-4 py-3 text-[var(--text)]"
    >
      <div className="mb-1 text-xs font-medium tracking-wide text-[var(--muted)]">You</div>
      <div>{children}</div>
    </div>
  );
}
