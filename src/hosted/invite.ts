import { hostedSettingsFrom } from "./server.js";

/**
 * Implements `duo hosted invite <name>`: asks the running hosted daemon on
 * this machine to mint an invite. Goes through the daemon rather than
 * writing the registry itself, so the daemon stays the registry's only
 * writer.
 */
export async function runHostedInvite(
  name: string,
  expiresInHours: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ name: string; expiresAt: string; code: string; link: string | null }> {
  const settings = hostedSettingsFrom(env);
  const port = env.PORT || "7717";
  const response = await fetch(`http://127.0.0.1:${port}/hosted/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${settings.adminToken}` },
    body: JSON.stringify({ name, expiresInHours }),
  });
  const body = (await response.json()) as { name: string; expiresAt: string; code: string; link: string | null; error?: { message: string } };
  if (!response.ok) {
    throw new Error(body.error?.message ?? `invite failed: HTTP ${response.status}`);
  }
  return body;
}
