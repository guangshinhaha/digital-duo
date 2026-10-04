import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { EndDuoRootRefusedError, endDuo } from "../src/hosted/end-duo.js";
import { DEFAULT_ORG_ID, ROOT_DUO_ID } from "../src/hosted/orgs.js";
import { HostedRegistry } from "../src/hosted/registry.js";
import { SynapseAdminError } from "../src/hosted/synapse-admin.js";

const tempDir = useTempDir();
const MASTER = "master-key-for-tests";

/** A registry with one tenant, its Matrix accounts recorded, optionally in a freshly created (non-default) org. */
function registryWithTenant(orgName?: string): { registry: HostedRegistry; duoId: string; orgId: string } {
  const registry = new HostedRegistry(join(tempDir(), `registry-${Math.random()}.json`), MASTER);
  const orgId = orgName ? registry.createOrg(orgName).id : DEFAULT_ORG_ID;
  const { invite } = registry.createInvite("Sam", new Date(Date.now() + 3_600_000).toISOString(), null, orgId);
  const tenant = registry.addTenant(invite.id, "Sam", "tenant-passphrase");
  registry.setMatrixAccounts(tenant.id, { personUserId: `@${orgId}.${tenant.id}:duo.test`, duoUserId: `@duo-${orgId}.${tenant.id}:duo.test` }, "syt_the_duos_token");
  return { registry, duoId: tenant.id, orgId };
}

/** A minimal admin stub: records every deactivate call and answers from a scripted map, defaulting to success. */
function adminStub(answers: Record<string, "ok" | "404" | "500"> = {}) {
  const calls: Array<{ userId: string; erase: boolean }> = [];
  return {
    calls,
    deactivateUser: async (userId: string, options: { erase: boolean }) => {
      calls.push({ userId, erase: options.erase });
      const answer = answers[userId] ?? "ok";
      if (answer === "404") {
        throw new SynapseAdminError("not found", 404, "M_NOT_FOUND", false);
      }
      if (answer === "500") {
        throw new SynapseAdminError("Synapse admin API POST /_synapse/admin/v1/deactivate/<id> failed: HTTP 500 M_UNKNOWN", 500, "M_UNKNOWN", true);
      }
    },
  };
}

function connectionsStub() {
  const detached: string[] = [];
  return { detached, detach: async (duoId: string) => void detached.push(duoId) };
}

describe("endDuo — the business logic (#275)", () => {
  it("refuses the root duo and touches nothing", async () => {
    const { registry } = registryWithTenant();
    const admin = adminStub();
    const connections = connectionsStub();
    await expect(endDuo(ROOT_DUO_ID, { registry, admin, connections })).rejects.toThrow(EndDuoRootRefusedError);
    expect(admin.calls).toHaveLength(0);
    expect(connections.detached).toHaveLength(0);
  });

  it("ending a duo that does not exist is a clean no-op, not an error", async () => {
    const { registry } = registryWithTenant();
    const admin = adminStub();
    const connections = connectionsStub();
    const outcome = await endDuo("nosuchduo1", { registry, admin, connections });
    expect(outcome).toEqual({ duoId: "nosuchduo1", found: false, deactivated: { person: false, duo: false }, errors: [] });
    expect(admin.calls).toHaveLength(0);
    expect(connections.detached).toHaveLength(0);
  });

  it("ending a tenant deactivates both Matrix accounts, drops its connection, and removes its registry entry", async () => {
    const { registry, duoId, orgId } = registryWithTenant();
    const admin = adminStub();
    const connections = connectionsStub();

    const outcome = await endDuo(duoId, { registry, admin, connections });

    expect(outcome).toEqual({ duoId, found: true, deactivated: { person: true, duo: true }, errors: [] });
    expect(admin.calls.map((call) => call.userId)).toEqual([`@${orgId}.${duoId}:duo.test`, `@duo-${orgId}.${duoId}:duo.test`]);
    expect(admin.calls.every((call) => call.erase)).toBe(true);
    expect(connections.detached).toEqual([duoId]);
    expect(registry.tenants().some((tenant) => tenant.id === duoId)).toBe(false);
    expect(registry.matrixAccounts(duoId)).toBeUndefined();
    expect(registry.listOrgMembers(orgId).some((member) => member.duoId === duoId)).toBe(false);
  });

  it("removes the duo from its own (non-default) org's membership", async () => {
    const { registry, duoId, orgId } = registryWithTenant("otherteam");
    await endDuo(duoId, { registry, admin: adminStub(), connections: connectionsStub() });
    expect(registry.listOrgMembers(orgId)).toHaveLength(0);
  });

  it("a Matrix account Synapse has never heard of (404) is read as already gone, not an error", async () => {
    const { registry, duoId, orgId } = registryWithTenant();
    const admin = adminStub({ [`@${orgId}.${duoId}:duo.test`]: "404" });
    const outcome = await endDuo(duoId, { registry, admin, connections: connectionsStub() });
    expect(outcome.found).toBe(true);
    expect(outcome.deactivated).toEqual({ person: false, duo: true });
    expect(outcome.errors).toEqual([]);
    // The registry entry is still removed: a 404 is not a reason to leave the duo on the roster.
    expect(registry.tenants()).toHaveLength(0);
  });

  it("a genuine Synapse failure is reported in `errors` but does not block removing the registry entry", async () => {
    const { registry, duoId, orgId } = registryWithTenant();
    const admin = adminStub({ [`@duo-${orgId}.${duoId}:duo.test`]: "500" });
    const logs: string[] = [];
    const outcome = await endDuo(duoId, { registry, admin, connections: connectionsStub(), log: (line) => logs.push(line) });
    expect(outcome.deactivated).toEqual({ person: true, duo: false });
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toContain("duo account");
    expect(registry.tenants()).toHaveLength(0);
    expect(logs.some((line) => line.includes(duoId))).toBe(true);
  });

  it("ending is idempotent: a second call on the same id is a clean no-op", async () => {
    const { registry, duoId } = registryWithTenant();
    const admin = adminStub();
    const connections = connectionsStub();
    await endDuo(duoId, { registry, admin, connections });
    const second = await endDuo(duoId, { registry, admin, connections });
    expect(second).toEqual({ duoId, found: false, deactivated: { person: false, duo: false }, errors: [] });
    // No further Synapse calls or connection teardowns for a duo already gone.
    expect(admin.calls).toHaveLength(2);
    expect(connections.detached).toEqual([duoId]);
  });

  it("works with no Synapse admin or workspace connections configured (removes only the registry entry)", async () => {
    const { registry, duoId } = registryWithTenant();
    const outcome = await endDuo(duoId, { registry });
    expect(outcome).toEqual({ duoId, found: true, deactivated: { person: false, duo: false }, errors: [] });
    expect(registry.tenants()).toHaveLength(0);
  });

  it("never deactivates anything for a duo that was never given Matrix accounts", async () => {
    const registry = new HostedRegistry(join(tempDir(), `registry-${Math.random()}.json`), MASTER);
    const { invite } = registry.createInvite("Sam", new Date(Date.now() + 3_600_000).toISOString());
    const tenant = registry.addTenant(invite.id, "Sam", "pw");
    const admin = adminStub();
    const outcome = await endDuo(tenant.id, { registry, admin });
    expect(outcome).toEqual({ duoId: tenant.id, found: true, deactivated: { person: false, duo: false }, errors: [] });
    expect(admin.calls).toHaveLength(0);
  });
});

describe("HostedRegistry.removeTenant (#275)", () => {
  it("removes the tenant entirely: gone from tenants(), matrixAccounts(), and its org's members", () => {
    const { registry, duoId } = registryWithTenant();
    expect(registry.removeTenant(duoId)).toBe(true);
    expect(registry.tenants()).toHaveLength(0);
    expect(registry.matrixAccounts(duoId)).toBeUndefined();
    expect(registry.listOrgMembers("default")).toHaveLength(0);
  });

  it("is idempotent: removing an id twice, or one never there, writes nothing and answers false", () => {
    const { registry, duoId } = registryWithTenant();
    registry.removeTenant(duoId);
    expect(registry.removeTenant(duoId)).toBe(false);
    expect(registry.removeTenant("never-existed")).toBe(false);
  });

  it("leaves the duo's redeemed invite as historical record, pointing at an id that no longer resolves to anyone", () => {
    const { registry, duoId } = registryWithTenant();
    const [redeemed] = registry.invites();
    expect(redeemed!.tenantId).toBe(duoId);
    registry.removeTenant(duoId);
    expect(registry.invites()[0]!.tenantId).toBe(duoId);
    expect(registry.orgOf(duoId)).toBeUndefined();
  });

  it("does not touch the root duo or other tenants", () => {
    const registry = new HostedRegistry(join(tempDir(), `registry-${Math.random()}.json`), MASTER);
    registry.declareRootDuo("Shin");
    const first = registry.addTenant(registry.createInvite("A", new Date(Date.now() + 3_600_000).toISOString()).invite.id, "A", "pw-a");
    const second = registry.addTenant(registry.createInvite("B", new Date(Date.now() + 3_600_000).toISOString()).invite.id, "B", "pw-b");
    registry.removeTenant(first.id);
    expect(registry.tenants().map((tenant) => tenant.id)).toEqual([second.id]);
    expect(registry.listOrgMembers("default").map((member) => member.duoId).sort()).toEqual([ROOT_DUO_ID, second.id].sort());
  });
});
