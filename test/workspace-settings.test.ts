import { describe, expect, it } from "vitest";
import { loadConfig, type DuoConfig } from "../src/config.js";
import { workspaceSettingsFrom, WorkspaceConfigError } from "../src/workspace/settings.js";

function configWithWorkspace(env: Record<string, string>): DuoConfig {
  return loadConfig(env as NodeJS.ProcessEnv);
}

const FULL = {
  DUO_WORKSPACE_HOMESERVER: "https://matrix.workspace.example",
  DUO_WORKSPACE_ACCESS_TOKEN: "syt_a_real_secret",
  DUO_WORKSPACE_USER_ID: "@duo-alice:workspace",
};

describe("workspaceSettingsFrom — no workspace is a supported state, half a workspace is a boot error (#186 AC1)", () => {
  it("returns null when nothing is set — serve stays exactly as it was", () => {
    expect(workspaceSettingsFrom(loadConfig({}))).toBeNull();
  });

  it("returns validated settings when all three values are present", () => {
    const settings = workspaceSettingsFrom(configWithWorkspace(FULL));
    expect(settings).toEqual({
      homeserverUrl: "https://matrix.workspace.example",
      accessToken: "syt_a_real_secret",
      userId: "@duo-alice:workspace",
      reconnect: { initialDelayMs: 1000, maxDelayMs: 60000 },
      presenceIntervalMs: 240000,
      backlog: { maxAgeMs: 3_600_000, maxAnswersPerMinute: 30 },
      ackAfterMs: 2000,
    });
  });

  it("refuses a homeserver without a token, naming the missing env var", () => {
    expect(() => workspaceSettingsFrom(configWithWorkspace({ DUO_WORKSPACE_HOMESERVER: FULL.DUO_WORKSPACE_HOMESERVER }))).toThrow(
      WorkspaceConfigError,
    );
    expect(() => workspaceSettingsFrom(configWithWorkspace({ DUO_WORKSPACE_HOMESERVER: FULL.DUO_WORKSPACE_HOMESERVER }))).toThrow(
      /DUO_WORKSPACE_ACCESS_TOKEN/,
    );
  });

  it("refuses a token without a homeserver or user id, naming both", () => {
    expect(() => workspaceSettingsFrom(configWithWorkspace({ DUO_WORKSPACE_ACCESS_TOKEN: "t" }))).toThrow(
      /DUO_WORKSPACE_HOMESERVER, DUO_WORKSPACE_USER_ID/,
    );
  });

  it("refuses a user id alone, naming the other two", () => {
    expect(() => workspaceSettingsFrom(configWithWorkspace({ DUO_WORKSPACE_USER_ID: "@duo-a:w" }))).toThrow(
      /DUO_WORKSPACE_HOMESERVER, DUO_WORKSPACE_ACCESS_TOKEN/,
    );
  });

  it("mentions that unsetting all three serves without a workspace", () => {
    expect(() => workspaceSettingsFrom(configWithWorkspace({ DUO_WORKSPACE_HOMESERVER: FULL.DUO_WORKSPACE_HOMESERVER }))).toThrow(
      /unset all three to serve without a workspace/,
    );
  });

  it("refuses a non-https homeserver — the access token must never ride a plaintext URL", () => {
    expect(() =>
      workspaceSettingsFrom(configWithWorkspace({ ...FULL, DUO_WORKSPACE_HOMESERVER: "http://matrix.workspace.example" })),
    ).toThrow(/must be https/);
  });

  it("accepts plain http only on Railway's private network (*.railway.internal)", () => {
    const settings = workspaceSettingsFrom(
      configWithWorkspace({ ...FULL, DUO_WORKSPACE_HOMESERVER: "http://synapse.railway.internal:8008" }),
    );
    expect(settings?.homeserverUrl).toBe("http://synapse.railway.internal:8008");
    // Lookalikes are not the private network.
    for (const host of ["http://railway.internal", "http://synapse.railway.internal.evil.example", "http://evilrailway.internal"]) {
      expect(() => workspaceSettingsFrom(configWithWorkspace({ ...FULL, DUO_WORKSPACE_HOMESERVER: host }))).toThrow(/must be https/);
    }
  });

  it("refuses an unparseable homeserver URL", () => {
    expect(() => workspaceSettingsFrom(configWithWorkspace({ ...FULL, DUO_WORKSPACE_HOMESERVER: "not a url" }))).toThrow(
      /not a parseable URL/,
    );
  });

  it("refuses a user id that is not a Matrix user id", () => {
    expect(() => workspaceSettingsFrom(configWithWorkspace({ ...FULL, DUO_WORKSPACE_USER_ID: "alice" }))).toThrow(
      /Matrix user id/,
    );
    expect(() => workspaceSettingsFrom(configWithWorkspace({ ...FULL, DUO_WORKSPACE_USER_ID: "@alice" }))).toThrow(
      /Matrix user id/,
    );
  });

  it("refuses a zero or negative timing knob, naming the env var — a 0 interval or delay would hot-loop the daemon", () => {
    expect(() => workspaceSettingsFrom(configWithWorkspace({ ...FULL, DUO_WORKSPACE_RECONNECT_INITIAL_MS: "0" }))).toThrow(
      /DUO_WORKSPACE_RECONNECT_INITIAL_MS must be a positive number/,
    );
    expect(() => workspaceSettingsFrom(configWithWorkspace({ ...FULL, DUO_WORKSPACE_RECONNECT_MAX_MS: "-60000" }))).toThrow(
      /DUO_WORKSPACE_RECONNECT_MAX_MS must be a positive number/,
    );
    expect(() => workspaceSettingsFrom(configWithWorkspace({ ...FULL, DUO_WORKSPACE_PRESENCE_INTERVAL_MS: "0" }))).toThrow(
      /DUO_WORKSPACE_PRESENCE_INTERVAL_MS must be a positive number/,
    );
    expect(() => workspaceSettingsFrom(configWithWorkspace({ ...FULL, DUO_WORKSPACE_ACK_AFTER_MS: "0" }))).toThrow(
      /DUO_WORKSPACE_ACK_AFTER_MS must be a positive number/,
    );
    expect(() => workspaceSettingsFrom(configWithWorkspace({ ...FULL, DUO_WORKSPACE_ACK_AFTER_MS: "-500" }))).toThrow(
      /DUO_WORKSPACE_ACK_AFTER_MS must be a positive number/,
    );
  });

  it("defaults ackAfterMs to 2000 (PRD v0.4 Q2) and honors DUO_WORKSPACE_ACK_AFTER_MS from env", () => {
    expect(workspaceSettingsFrom(configWithWorkspace(FULL))?.ackAfterMs).toBe(2000);
    expect(workspaceSettingsFrom(configWithWorkspace({ ...FULL, DUO_WORKSPACE_ACK_AFTER_MS: "500" }))?.ackAfterMs).toBe(500);
  });

  it("honors the reconnect and presence knobs from env — #188 retunes hold behavior without a code change", () => {
    const settings = workspaceSettingsFrom(
      configWithWorkspace({ ...FULL, DUO_WORKSPACE_RECONNECT_INITIAL_MS: "250", DUO_WORKSPACE_RECONNECT_MAX_MS: "30000", DUO_WORKSPACE_PRESENCE_INTERVAL_MS: "5000" }),
    );
    expect(settings?.reconnect).toEqual({ initialDelayMs: 250, maxDelayMs: 30000 });
    expect(settings?.presenceIntervalMs).toBe(5000);
  });

  it("refuses a broken backlog knob — the age window is also the read-state retention, and a zero rate bound would refuse every question (#189)", () => {
    expect(() => workspaceSettingsFrom(configWithWorkspace({ ...FULL, DUO_WORKSPACE_BACKLOG_MAX_AGE_MS: "0" }))).toThrow(
      /DUO_WORKSPACE_BACKLOG_MAX_AGE_MS must be a positive number of milliseconds/,
    );
    expect(() => workspaceSettingsFrom(configWithWorkspace({ ...FULL, DUO_WORKSPACE_MAX_ANSWERS_PER_MINUTE: "0" }))).toThrow(
      /DUO_WORKSPACE_MAX_ANSWERS_PER_MINUTE must be a whole number of at least 1/,
    );
    expect(() => workspaceSettingsFrom(configWithWorkspace({ ...FULL, DUO_WORKSPACE_MAX_ANSWERS_PER_MINUTE: "2.5" }))).toThrow(
      /DUO_WORKSPACE_MAX_ANSWERS_PER_MINUTE must be a whole number of at least 1/,
    );
  });

  it("honors the backlog knobs from env — #188 retunes the wake-up replay policy without a code change", () => {
    const settings = workspaceSettingsFrom(
      configWithWorkspace({ ...FULL, DUO_WORKSPACE_BACKLOG_MAX_AGE_MS: "900000", DUO_WORKSPACE_MAX_ANSWERS_PER_MINUTE: "5" }),
    );
    expect(settings?.backlog).toEqual({ maxAgeMs: 900000, maxAnswersPerMinute: 5 });
  });
});
