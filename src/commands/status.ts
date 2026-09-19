import { existsSync } from "node:fs";
import type { DuoConfig } from "../config.js";

/**
 * Implements `duo status` (R1). Reports the raw configured provider, store
 * location, and whether a file exists there. Never constructs a live
 * provider client (that would make this command capable of throwing) — it
 * always resolves without error, so `duo status` always exits 0 regardless
 * of provider misconfiguration.
 */
export function runStatus(config: DuoConfig): string {
  const providerLine = config.providerName ? `provider: ${config.providerName}` : "provider: (not configured)";
  const storeExists = existsSync(config.storePath);
  return [providerLine, `store: ${config.storePath}`, `store exists: ${storeExists}`].join("\n");
}
