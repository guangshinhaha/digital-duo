import { existsSync } from "node:fs";
import type { DuoConfig } from "../config.js";
import { createHostedServer, hostedSettingsFrom, rootEnvFrom } from "../hosted/server.js";
import { createOllamaEmbeddingProvider } from "../provider/ollama-embedding-provider.js";
import { tryResolveProvider } from "../provider/registry.js";
import { assertServableHost } from "../serve/bind.js";
import type { ServeDeps } from "../serve/server.js";
import { DecryptionError } from "../store/crypto.js";
import { withDatabase } from "../store/store.js";
import { ServePassphraseMismatchError, type ServeOptions } from "./serve.js";

/**
 * Implements `duo serve --hosted` (docs/deploy/hosted-mode.md): many duos in
 * one process, invite-only sign-up, the server holding every duo's key.
 *
 * A pre-existing single-owner store at DUO_STORE_PATH, with DUO_PASSPHRASE
 * set, keeps being served at the bare origin — the deployment this mode
 * replaced keeps its pairings and ask links. Matrix accounts are provisioned
 * when DUO_WORKSPACE_PRIVATE_URL and DUO_WORKSPACE_ADMIN_TOKEN are set (docs/deploy/hosted-workspace.md),
 * and each provisioned duo then holds its own outbound workspace connection (#236, src/hosted/duo-workspace.ts).
 */
export async function runHostedServe(
  options: ServeOptions,
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ address: string; close: () => Promise<void> }> {
  assertServableHost(options.host, { behindProxy: options.behindProxy });
  const settings = hostedSettingsFrom(env);
  const embeddingProvider = createOllamaEmbeddingProvider(config);
  const inferenceProvider = tryResolveProvider(config);
  const trustProxy = options.behindProxy ?? false;

  let root: ServeDeps | undefined;
  const rootPassphrase = env.DUO_PASSPHRASE;
  if (rootPassphrase && existsSync(config.storePath)) {
    try {
      withDatabase(config.storePath, rootPassphrase, false, () => {});
    } catch (error) {
      if (error instanceof DecryptionError) {
        throw new ServePassphraseMismatchError(config.storePath, error);
      }
      throw error;
    }
    root = {
      storePath: config.storePath,
      passphrase: rootPassphrase,
      duoDir: config.duoDir,
      lifecycleLogPath: config.lifecycleLogPath,
      embeddingProvider,
      inferenceProvider,
      confidenceConfig: config.confidence,
      classificationCeiling: config.classificationCeiling,
      ownerName: config.ownerName,
      // The root duo keeps its process env, minus the hosted secrets (master key, admin tokens).
      env: rootEnvFrom(env),
      trustProxy,
    };
  }

  const hosted = await createHostedServer({ config, env, embeddingProvider, inferenceProvider, trustProxy }, settings, root);
  await new Promise<void>((resolve, reject) => {
    hosted.server.once("error", reject);
    hosted.server.listen({ host: options.host, port: options.port }, () => resolve());
  });
  const bound = hosted.server.address();
  const address =
    typeof bound === "object" && bound !== null
      ? `http://${bound.family === "IPv6" ? `[${bound.address}]` : bound.address}:${bound.port}`
      : String(bound);
  return { address, close: hosted.close };
}

export { runHostedInvite, runHostedProvision, runHostedRemint, runHostedOrgCreate, runHostedOrgList, runHostedOrgMembers, runHostedOrgRename, runHostedOrgAdminGrant, runHostedOrgAdminRevoke, formatOrgMemberLine } from "../hosted/invite.js";
