import { describe, expect, it } from "vitest";
import {
  availabilityFrom,
  DUO_LOCALPART_PREFIX,
  duoOwnerUserIdOf,
  duoUserIdFor,
  isDuoUserId,
  workspaceDirectoryFrom,
  type WorkspaceDirectoryEntry,
} from "../src/workspace/directory.js";
import type { WorkspaceMember, WorkspaceMemberListing } from "../src/workspace/transport.js";
import { memberOf, presenceOf } from "./helpers/workspace-member.js";

function listing(members: readonly WorkspaceMember[], truncated = false): WorkspaceMemberListing {
  return { members, truncated };
}

/** A fixed clock, so last-seen conversions are exact: 2026-09-25T12:00:00Z. */
const NOW = () => new Date("2026-09-25T12:00:00.000Z");

describe("the @duo-<name> convention — attribution derived, not registered (#187 AC2)", () => {
  it("derives a person's duo id beside them on the same server", () => {
    expect(duoUserIdFor("@alice:workspace")).toBe("@duo-alice:workspace");
    expect(duoUserIdFor("@bob.matrix:workspace.example")).toBe("@duo-bob.matrix:workspace.example");
  });

  it("inverts exactly: a duo-shaped id points at its one owner", () => {
    expect(duoOwnerUserIdOf("@duo-alice:workspace")).toBe("@alice:workspace");
    expect(duoOwnerUserIdOf(duoUserIdFor("@carol:workspace")!)).toBe("@carol:workspace");
  });

  it("returns null rather than guessing for unshapely ids, either direction", () => {
    expect(duoUserIdFor("alice")).toBeNull();
    expect(duoUserIdFor("")).toBeNull();
    expect(duoUserIdFor("@nosever")).toBeNull();
    expect(duoOwnerUserIdOf("@alice:workspace")).toBeNull();
    expect(duoOwnerUserIdOf("duo-alice")).toBeNull();
  });

  it("recognizes duo-shaped ids by the prefix the platform record reserves", () => {
    expect(DUO_LOCALPART_PREFIX).toBe("duo-");
    expect(isDuoUserId("@duo-alice:workspace")).toBe(true);
    // The hyphen is load-bearing: a person named Duong is not a duo.
    expect(isDuoUserId("@duong:workspace")).toBe(false);
    expect(isDuoUserId("@duo:workspace")).toBe(false);
    expect(isDuoUserId("@alice:workspace")).toBe(false);
    expect(isDuoUserId("duo-alice")).toBe(false);
  });
});

describe("availabilityFrom — server-side presence into asleep-duo.md §6's shape (#187 AC1)", () => {
  it("online is the whole fact: no last-seen is stated alongside a live connection", () => {
    expect(availabilityFrom(presenceOf(true, 120_000), NOW)).toEqual({ online: true, lastSeenAt: null });
  });

  it("offline carries the last-seen instant, derived from the server's relative ago at the given now", () => {
    expect(availabilityFrom(presenceOf(false, 90_000), NOW)).toEqual({
      online: false,
      lastSeenAt: "2026-09-25T11:58:30.000Z",
    });
  });

  it("a user the server has never seen active is offline with a stated absence of last-seen — not a guess", () => {
    expect(availabilityFrom(presenceOf(false, null), NOW)).toEqual({ online: false, lastSeenAt: null });
  });
});

describe("workspaceDirectoryFrom — people, and whose duo is whose (#187 AC1/AC2)", () => {
  it("returns each person with a stable id, display name, and their own availability", () => {
    const directory = workspaceDirectoryFrom(
      listing([
        memberOf("@alice:workspace", "Alice", true, 1000),
        memberOf("@bob:workspace", "Bob", false, 3_600_000),
      ]),
      NOW,
    );
    expect(directory).toEqual([
      {
        userId: "@alice:workspace",
        displayName: "Alice",
        availability: { online: true, lastSeenAt: null },
        duo: null,
      },
      {
        userId: "@bob:workspace",
        displayName: "Bob",
        availability: { online: false, lastSeenAt: "2026-09-25T11:00:00.000Z" },
        duo: null,
      },
    ]);
  });

  it("attaches a member's duo when the convention's duo user is listed — its own id, name, and availability", () => {
    const directory = workspaceDirectoryFrom(
      listing([
        memberOf("@alice:workspace", "Alice", true, 1000),
        memberOf("@duo-alice:workspace", "Alice's duo", false, 7_200_000),
      ]),
      NOW,
    );
    expect(directory).toHaveLength(1);
    expect(directory[0]!.duo).toEqual({
      userId: "@duo-alice:workspace",
      displayName: "Alice's duo",
      availability: { online: false, lastSeenAt: "2026-09-25T10:00:00.000Z" },
    });
  });

  it("attributes each duo to exactly one person — never to a second, never as a person itself", () => {
    // Two people whose localparts would collide with one duo id is
    // unrepresentable (@duo-alice derives only from @alice), so the pin here
    // is the bijection's two visible properties: the duo appears on its
    // owner's entry alone, and never among the people.
    const directory = workspaceDirectoryFrom(
      listing([
        memberOf("@alice:workspace", "Alice"),
        memberOf("@duo-alice:workspace", "Alice's duo", true, 0),
        memberOf("@bob:workspace", "Bob"),
      ]),
      NOW,
    );
    expect(directory.map((entry: WorkspaceDirectoryEntry) => entry.userId)).toEqual(["@alice:workspace", "@bob:workspace"]);
    expect(directory[0]!.duo?.userId).toBe("@duo-alice:workspace");
    expect(directory[1]!.duo).toBeNull();
  });

  it("drops a duo-shaped user whose owner is not listed — attributable to no one is stated, not guessed", () => {
    const directory = workspaceDirectoryFrom(
      listing([
        memberOf("@alice:workspace", "Alice"),
        memberOf("@duo-ghost:workspace", "nobody's duo", true, 0),
      ]),
      NOW,
    );
    expect(directory.map((entry) => entry.userId)).toEqual(["@alice:workspace"]);
    expect(directory[0]!.duo).toBeNull();
  });

  it("keeps a person's availability and their duo's as separate facts — asleep duo beside an online person, and the reverse (#187 AC2, asleep-duo §6)", () => {
    const directory = workspaceDirectoryFrom(
      listing([
        memberOf("@alice:workspace", "Alice", true, 1000),
        memberOf("@duo-alice:workspace", "Alice's duo", false, 60_000),
        memberOf("@carol:workspace", "Carol", false, 60_000),
        memberOf("@duo-carol:workspace", "Carol's duo", true, 1000),
      ]),
      NOW,
    );
    // Alice is online while her duo is asleep...
    expect(directory[0]!.availability).toEqual({ online: true, lastSeenAt: null });
    expect(directory[0]!.duo!.availability).toEqual({ online: false, lastSeenAt: "2026-09-25T11:59:00.000Z" });
    // ...and Carol's duo is online while Carol is away. Neither implies the other.
    expect(directory[1]!.availability).toEqual({ online: false, lastSeenAt: "2026-09-25T11:59:00.000Z" });
    expect(directory[1]!.duo!.availability).toEqual({ online: true, lastSeenAt: null });
  });

  it("an empty listing is an empty directory — nobody to address, no error to throw", () => {
    expect(workspaceDirectoryFrom(listing([]), NOW)).toEqual([]);
  });

  it("ignores the truncation flag for composition — the read paths surface it, composition does not", () => {
    // The members present are correct; the members absent are unknown.
    // Composition says nothing about the absent — surfacing the cap is the
    // reader's job (the service logs truncation on both the cache refresh
    // and the directory read) — so the same members compose identically
    // either way.
    const members = [memberOf("@alice:workspace", "Alice")];
    expect(workspaceDirectoryFrom(listing(members, true), NOW)).toEqual(workspaceDirectoryFrom(listing(members, false), NOW));
  });
});
