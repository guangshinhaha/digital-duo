import type { DuoConfig } from "../config.js";
import { cutHandoverItem, regenerateHandoverDraft, shareHandoverPack, type HandoverPack, type SharedHandoverSummary } from "../continuity/handover.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

/** Implements `duo continuity handover generate` (#62 AC1/AC3): assembles the pack fresh from current derived data and writes the review draft, carrying forward any earlier cuts. */
export function runHandoverGenerate(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): HandoverPack {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return regenerateHandoverDraft(config.storePath, passphrase, config.duoDir);
}

/** Implements `duo continuity handover cut <itemId>` (#62 AC2). */
export function runHandoverCut(itemId: string, config: DuoConfig): HandoverPack {
  return cutHandoverItem(config.storePath, itemId);
}

/** Implements `duo continuity handover share <outputPath>` (#62 AC2's one explicit act). */
export function runHandoverShare(outputPath: string, config: DuoConfig): SharedHandoverSummary {
  return shareHandoverPack(config.storePath, outputPath);
}
