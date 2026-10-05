import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MatrixProvisioner } from "../src/hosted/matrix-accounts.js";
import { OrgSpaceProvisioner } from "../src/hosted/org-spaces.js";
import { HostedRegistry } from "../src/hosted/registry.js";
import { SynapseAdmin, SynapseAdminError } from "../src/hosted/synapse-admin.js";
import { useTempDir } from "./helpers/temp-dir.js";

// Opt in with DUO_TEST_SYNAPSE_PYTHON (see synapse-org-wall.test.ts): the daemon's own
// provisioning (accounts, Spaces, the admin-API joins of #232 and #234) run against a REAL
// Synapse with the org wall loaded. The fake Synapse in test/helpers implements the wall
// itself; this is the check that the real module accepts what the daemon sends.
const synapsePython = process.env.DUO_TEST_SYNAPSE_PYTHON;
const tempDir = useTempDir();
const script = join(__dirname, "..", "deploy", "synapse", "modules", "duo_org_wall", "tests", "real_synapse.py");

describe.skipIf(!synapsePython)("daemon provisioning against a real Synapse with the org wall (opt-in)", () => {
  let child: ChildProcess;
  let base = "";
  let adminToken = "";

  beforeAll(async () => {
    child = spawn(synapsePython!, [script, "--serve"], { stdio: ["ignore", "pipe", "inherit"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    const file = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Synapse did not report READY")), 150_000);
      let seen = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        seen += chunk.toString();
        const match = /READY (\S+)/.exec(seen);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
      child.on("exit", () => reject(new Error("Synapse exited early")));
    });
    ({ base, adminToken } = JSON.parse(readFileSync(file, "utf8")));
  }, 180_000);

  afterAll(() => {
    child?.kill("SIGTERM");
  });

  it("provisions two orgs, joins each member into their own org's rooms, and cannot join across orgs", async () => {
    // SynapseAdmin insists on https; point that address at the local Synapse.
    const fetchLocal: typeof fetch = (input, init) => fetch(String(input).replace("https://synapse.test", base), init);
    const admin = new SynapseAdmin({ baseUrl: "https://synapse.test", adminToken, fetch: fetchLocal });
    const registry = new HostedRegistry(join(tempDir(), "registry.json"), "master-key-for-tests");
    const logs: string[] = [];
    const accounts = new MatrixProvisioner({ registry, admin, serverName: "duo", log: (line) => logs.push(line) });
    const spaces = new OrgSpaceProvisioner({ registry, admin, serverName: "duo", log: (line) => logs.push(line) });

    const addDuo = (name: string, orgId: string) => {
      const { invite } = registry.createInvite(name, new Date(Date.now() + 3_600_000).toISOString(), null, orgId);
      return registry.addTenant(invite.id, name, "passphrase").id;
    };
    const alpha = registry.createOrg("Alpha");
    const beta = registry.createOrg("Beta");
    const sam = addDuo("Sam", alpha.id);
    const kim = addDuo("Kim", alpha.id);
    const lee = addDuo("Lee", beta.id);

    for (const id of [sam, kim, lee]) {
      expect((await accounts.provision(id)).status, logs.join("\n")).toBe("provisioned");
    }
    for (const org of [alpha, beta]) {
      expect((await spaces.ensureOrg(org.id)).status, logs.join("\n")).toBe("provisioned");
    }
    for (const id of [sam, kim, lee]) {
      expect((await spaces.syncMember(id)).status, logs.join("\n")).toBe("provisioned");
    }

    const idsOf = (id: string) => {
      const matrix = registry.matrixAccounts(id)!;
      return [matrix.personUserId, matrix.duoUserId];
    };
    const alphaRooms = registry.org(alpha.id)!;
    const betaRooms = registry.org(beta.id)!;
    for (const room of [alphaRooms.spaceRoomId!, alphaRooms.generalRoomId!]) {
      expect((await admin.roomMembers(room)).sort()).toEqual(["@workspace-admin:duo", ...idsOf(sam), ...idsOf(kim)].sort());
    }
    for (const room of [betaRooms.spaceRoomId!, betaRooms.generalRoomId!]) {
      expect((await admin.roomMembers(room)).sort()).toEqual(["@workspace-admin:duo", ...idsOf(lee)].sort());
    }

    // #274: in a Space the daemon provisioned, a member lists a room open to the org; a colleague finds and joins it
    // uninvited; the other org neither sees nor joins it; and #general's listing is not a member's to remove. Done before
    // the cross-org joins below: a refused admin-API join leaves the admin's invite pending in the room, and an org Space
    // holding another org's invitee is, rightly (fails closed), no longer a room anything can be restricted to.
    const matrix = async (method: string, path: string, token: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    };
    const tokenOf = async (userId: string) =>
      (await matrix("POST", `/_synapse/admin/v1/users/${encodeURIComponent(userId)}/login`, adminToken, {})).json.access_token as string;
    const [samPerson] = idsOf(sam);
    const [kimPerson] = idsOf(kim);
    const [leePerson] = idsOf(lee);
    const samToken = await tokenOf(samPerson!);
    const kimToken = await tokenOf(kimPerson!);
    const leeToken = await tokenOf(leePerson!);
    const space = alphaRooms.spaceRoomId!;
    const created = await matrix("POST", "/_matrix/client/v3/createRoom", samToken, {
      preset: "private_chat",
      name: "alpha channel",
      initial_state: [{ type: "m.room.join_rules", state_key: "", content: { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: space }] } }],
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const channel = created.json.room_id as string;
    const linked = await matrix("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(space)}/state/m.space.child/${encodeURIComponent(channel)}`, samToken, { via: ["duo"] });
    expect(linked.status, JSON.stringify(linked.json)).toBe(200);
    const hierarchy = async (token: string) => matrix("GET", `/_matrix/client/v1/rooms/${encodeURIComponent(space)}/hierarchy`, token);
    const seenByKim = await hierarchy(kimToken);
    expect(seenByKim.status).toBe(200);
    expect((seenByKim.json.rooms as Array<{ room_id: string }>).map((room) => room.room_id)).toContain(channel);
    expect((await matrix("POST", `/_matrix/client/v3/join/${encodeURIComponent(channel)}`, kimToken, {})).status).toBe(200);
    expect((await hierarchy(leeToken)).status).toBe(403);
    expect((await matrix("POST", `/_matrix/client/v3/join/${encodeURIComponent(channel)}`, leeToken, {})).status).toBe(403);
    const unlinkGeneral = await matrix("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(space)}/state/m.space.child/${encodeURIComponent(alphaRooms.generalRoomId!)}`, samToken, {});
    expect(unlinkGeneral.status).toBe(403);
    // Beta's Space was provisioned the same way, but holds none of it.
    const betaHierarchy = await matrix("GET", `/_matrix/client/v1/rooms/${encodeURIComponent(betaRooms.spaceRoomId!)}/hierarchy`, leeToken);
    expect((betaHierarchy.json.rooms as Array<{ room_id: string }>).map((room) => room.room_id)).not.toContain(channel);

    // The wall: the real module refuses an org B account in an org A room, person or duo, Space or #general.
    for (const target of idsOf(lee)) {
      for (const room of [alphaRooms.spaceRoomId!, alphaRooms.generalRoomId!]) {
        const error = await admin.joinUser(room, target).then(
          () => null,
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(SynapseAdminError);
        expect((error as SynapseAdminError).status).toBe(403);
      }
    }
    expect((await admin.roomMembers(registry.org(alpha.id)!.generalRoomId!)).some((id) => idsOf(lee).includes(id))).toBe(false);
    // A repeat of the whole run is a no-op, not an error (the daemon's retry timer does this).
    expect((await accounts.provision(sam)).status).toBe("already");
    expect((await spaces.syncMember(sam)).status).toBe("already");
  }, 120_000);
});
