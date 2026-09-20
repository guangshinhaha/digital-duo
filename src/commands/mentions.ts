import type { DuoConfig } from "../config.js";
import { createOllamaEmbeddingProvider } from "../provider/ollama-embedding-provider.js";
import { tryResolveProvider } from "../provider/registry.js";
import { muteChannel, muteThread, readMutedChannels, unmuteChannel, unmuteThread } from "../drafting/channel-mutes.js";
import type { Mention } from "../drafting/gate.js";
import { offerDraftForMention, type ProactiveOfferOutcome } from "../drafting/proactive-offer.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

/**
 * Implements `duo mentions offer <text> [--from <name>] [--channel <channel>] [--thread-id <threadId>]`
 * (#47): the hand-supplied stand-in for a live Slack mention (epic `e8`
 * stays blocked) — everything downstream of receiving one is real.
 */
export async function runMentionsOffer(
  text: string,
  options: { from?: string; channel?: string; threadId?: string; threadContext?: string | null },
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProactiveOfferOutcome> {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const embeddingProvider = createOllamaEmbeddingProvider(config);
  const inferenceProvider = tryResolveProvider(config);
  const mention: Mention = { text, from: options.from, channel: options.channel, threadId: options.threadId, threadContext: options.threadContext };
  return offerDraftForMention(config.storePath, passphrase, config.duoDir, mention, embeddingProvider, inferenceProvider, config.confidence);
}

/** Implements `duo mentions mute <channel> [--thread <threadId>]` (#47 AC3; #172 grows the scope below channel level). */
export function runMentionsMute(channel: string, config: DuoConfig, threadId?: string): string[] {
  return threadId === undefined ? muteChannel(config.duoDir, channel) : muteThread(config.duoDir, channel, threadId);
}

/** Implements `duo mentions unmute <channel> [--thread <threadId>]` (#47 AC3: "reversible"; #172 adds the thread scope). */
export function runMentionsUnmute(
  channel: string,
  config: DuoConfig,
  threadId?: string,
): { wasMuted: boolean; channels: string[] } {
  return threadId === undefined ? unmuteChannel(config.duoDir, channel) : unmuteThread(config.duoDir, channel, threadId);
}

/** Implements `duo mentions muted` (#47 AC3: "the setting is visible"). */
export function runMentionsListMuted(config: DuoConfig): string[] {
  return readMutedChannels(config.duoDir);
}
