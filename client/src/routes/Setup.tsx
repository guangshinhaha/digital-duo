import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";

/**
 * Normalizes and validates a daemon address. A pasted tailnet address
 * missing its scheme (e.g. "100.64.1.5:7717", a plausible copy-paste
 * mistake off a terminal) is silently fatal otherwise: the browser
 * resolves it as a path relative to the client's own origin, and every
 * subsequent API call 404s or hits the wrong server with nothing telling
 * the owner what went wrong. Returns the normalized URL, or `null` for
 * anything the `URL` constructor itself can't parse.
 */
function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  // No manual trailing-slash strip: `URL.origin` (used below) is always
  // just `protocol://host[:port]` with no trailing slash by construction,
  // so there's nothing to strip after parsing — and stripping the raw
  // string *before* parsing is actively wrong for an input that's
  // nothing but a scheme, like "http://": removing one trailing "/"
  // turns it into "http:/", which no longer matches the scheme check
  // below, gets "http://" re-prepended, and silently parses as the valid
  // (but wrong) URL "http://http:/" — a real bug this shape hit in
  // testing, not a hypothetical one.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (!parsed.hostname) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/** First-run screen: paste the daemon's address and the token `duo pair new <name>` printed. No auth flow beyond this — a bearer token is the whole scheme (client-tech-design.md Part 2). */
export function Setup({ onConnect }: { onConnect: (config: DuoApiConfig) => void }) {
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex h-screen items-center justify-center bg-[var(--bg)] px-4">
      <form
        className="flex w-full max-w-sm flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--edge)] bg-[var(--surface)] p-6"
        onSubmit={(e) => {
          e.preventDefault();
          const normalized = normalizeBaseUrl(baseUrlInput);
          if (!normalized) {
            setError(`"${baseUrlInput}" doesn't look like a valid address — try something like 100.64.1.5:7717`);
            return;
          }
          setError(null);
          // Trimmed, unlike baseUrl was before this line existed to fix
          // exactly this: a token copy-pasted from a terminal commonly
          // picks up a trailing newline or space, which then silently
          // fails every request's Authorization header with no indication
          // whitespace was the cause.
          onConnect({ baseUrl: normalized, token: token.trim() });
        }}
      >
        <h1 className="text-lg font-medium">Connect to your duo</h1>
        <p className="text-sm text-[var(--muted)]">
          Run <code>duo pair new &quot;this device&apos;s name&quot;</code> on your Mac, then paste its address and token here.
        </p>
        <label className="flex flex-col gap-1 text-sm">
          Daemon address
          <input
            className="rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2 py-1"
            placeholder="100.64.1.5:7717"
            value={baseUrlInput}
            onChange={(e) => {
              setBaseUrlInput(e.target.value);
              setError(null);
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Token
          <input
            className="rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2 py-1"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        {error && (
          <p className="text-sm text-[var(--refused)]" data-testid="setup-error">
            {error}
          </p>
        )}
        <button className="mt-2 rounded-[var(--r-sm)] bg-[var(--accent)] px-3 py-2 text-white" type="submit" disabled={!token || !baseUrlInput}>
          Connect
        </button>
      </form>
    </div>
  );
}
