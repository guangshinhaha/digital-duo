import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";

/** First-run screen: paste the daemon's address and the token `duo pair new <name>` printed. No auth flow beyond this — a bearer token is the whole scheme (client-tech-design.md Part 2). */
export function Setup({ onConnect }: { onConnect: (config: DuoApiConfig) => void }) {
  const [baseUrl, setBaseUrl] = useState("http://");
  const [token, setToken] = useState("");

  return (
    <div className="flex h-screen items-center justify-center bg-[var(--bg)] px-4">
      <form
        className="flex w-full max-w-sm flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--edge)] bg-[var(--surface)] p-6"
        onSubmit={(e) => {
          e.preventDefault();
          onConnect({ baseUrl: baseUrl.replace(/\/$/, ""), token });
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
            placeholder="http://100.64.1.5:7717"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
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
        <button className="mt-2 rounded-[var(--r-sm)] bg-[var(--accent)] px-3 py-2 text-white" type="submit" disabled={!token || baseUrl === "http://"}>
          Connect
        </button>
      </form>
    </div>
  );
}
