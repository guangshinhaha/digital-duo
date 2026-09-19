import type { DuoApiConfig } from "../api/client.js";
import { usePendingDrafts } from "../api/queries.js";
import { DraftCard } from "../components/DraftCard.js";

/**
 * The default surface (`client-tech-design.md` §3.1) — the Send / Edit /
 * Ignore queue, badge count = pending drafts. This is the thing the app
 * exists to open, so it sits above the duo list rather than behind it
 * (client-design.md §1.5).
 */
export function Review({ api }: { api: DuoApiConfig }) {
  const { data: drafts, isLoading, error } = usePendingDrafts(api);

  if (isLoading) {
    return <div className="p-6 text-[var(--muted)]">Loading…</div>;
  }
  if (error) {
    return <div className="p-6 text-[var(--refused)]">{(error as Error).message}</div>;
  }
  if (!drafts || drafts.length === 0) {
    return <div className="p-6 text-[var(--muted)]">Nothing waiting on you.</div>;
  }

  return (
    <div className="flex flex-col gap-4 p-6" data-testid="review-list">
      {drafts.map((draft) => (
        <DraftCard key={draft.id} api={api} draft={draft} />
      ))}
    </div>
  );
}
