import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useApiConfig } from "./api/config.js";
import type { DuoApiConfig } from "./api/client.js";
import { Setup } from "./routes/Setup.js";
import { Review } from "./routes/Review.js";

const queryClient = new QueryClient();

function AppShell() {
  const [api, setApiRaw] = useApiConfig();

  // Wraps the raw setter so the cache is cleared *before* the next
  // render, not reactively after it in a useEffect: React Query's
  // useQuery reads from cache synchronously during render, so an
  // effect-based clear would still let one render slip through showing
  // whichever daemon's drafts happened to be cached under the same query
  // keys — a real risk when reconnecting to a different daemon (or
  // duo/owner) without a full page reload in between.
  function setApi(next: DuoApiConfig | null): void {
    queryClient.clear();
    setApiRaw(next);
  }

  if (!api) {
    return <Setup onConnect={setApi} />;
  }

  return (
    <div className="flex h-screen bg-[var(--bg)] text-[var(--text)]">
      <nav className="flex w-56 flex-col gap-1 border-r border-[var(--edge)] p-3">
        <div className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-[var(--faint)]">Duo</div>
        <a className="rounded-[var(--r-sm)] bg-[var(--surface)] px-2 py-1.5 text-sm" href="#review">
          Review
        </a>
        <button className="mt-auto px-2 py-1 text-left text-xs text-[var(--faint)]" onClick={() => setApi(null)}>
          Disconnect
        </button>
      </nav>
      <main className="flex-1 overflow-y-auto">
        <Review api={api} />
      </main>
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}
