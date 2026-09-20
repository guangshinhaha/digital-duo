/**
 * CORS origin allowlist for browser-origin clients (issue #167).
 *
 * The client architecture is deliberately cross-origin: the web client (Vite
 * dev server, then Tauri's `http://tauri.localhost` WKWebView) talks to the
 * daemon with absolute `${baseUrl}` URLs and no dev proxy. The Same-Origin
 * Policy blocks every such response unless the daemon answers CORS.
 *
 * The allowlist is explicit, never a wildcard: `DUO_CORS_ORIGINS` is a
 * comma-separated list of exact origins (scheme + host + port). Unset or
 * empty means no browser-origin client is allowed at all — default-deny, so
 * forgetting the flag cannot silently open the daemon to every page a browser
 * can reach. CORS decides which *pages* may read responses; device-token auth
 * stays exactly as strict either way.
 */

/** The headers every client sends: the bearer (`apiRequest` always attaches it) and JSON bodies. */
export const CORS_ALLOWED_HEADERS = ["Authorization", "Content-Type"] as const;

/**
 * Parses `DUO_CORS_ORIGINS` into an exact-match allowlist. Returns `false`
 * (CORS fully off — no headers, preflights unanswered) when unset/empty,
 * which is `@fastify/cors`'s own "disabled" value, so the register call in
 * `server.ts` never branches.
 */
export function resolveCorsOrigins(env: NodeJS.ProcessEnv): string[] | false {
  const raw = env.DUO_CORS_ORIGINS;
  if (!raw || !raw.trim()) {
    return false;
  }
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
