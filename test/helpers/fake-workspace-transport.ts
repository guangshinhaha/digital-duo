import type { RoomInvite } from "../../src/workspace/messages.js";
import type {
  AnswerEventContent,
  WorkspaceCandidateMessage,
  WorkspaceFileBody,
  WorkspaceMemberIdentityListing,
  WorkspaceMemberListing,
  WorkspaceTransport,
} from "../../src/workspace/transport.js";

/**
 * The in-memory stand-in for the Matrix homeserver + SDK adapter. Records
 * every call the service makes, and plays the two roles a test needs:
 *
 * - the *network*: `failNextConnects` makes `connect()` reject (an
 *   unreachable homeserver), `dropConnection` fires the disconnect handler
 *   the SDK would fire when its retries give up, and `deliver` hands the
 *   service a message exactly as sync would;
 * - the *server-side hold*: `hold` queues messages while the transport is
 *   disconnected and `deliverHeld` replays them on the next successful
 *   connect — the behavior a real homeserver gives us for free (it holds
 *   events for an offline user; sync replays them), simulated here so the
 *   reconnect contract is testable without a homeserver.
 *
 * The directory role (#187): `setMembers` is what the homeserver's user
 * directory + presence would answer, and `listMembers()` serves it — only
 * while connected, like every other call that rides the held connection.
 *
 * The invite role (#192): `deliverInvite` is the sync delivery of an
 * invitation (live or replayed-by-catch-up — a still-live invite replays
 * on every sync until it is joined or left, so tests may deliver the same
 * one repeatedly the way sync would), and the join/leave calls are
 * recorded server-style — `joinedRooms` is the membership the homeserver
 * now holds, `leaveCalls` the exits it accepted. `rejectNextLeave`
 * simulates a homeserver refusing an exit, the failure whose retry on the
 * next connect `settleRoomExits` owns.
 */
export class FakeWorkspaceTransport implements WorkspaceTransport {
  connectCalls = 0;
  stopCalls = 0;
  markAliveCalls = 0;
  listMembersCalls = 0;
  listMemberIdentitiesCalls = 0;
  /** How many invite deliveries reached the handlers (#192) — the observable half of deliverInvite. */
  inviteDeliveries = 0;
  joinCalls: string[] = [];
  leaveCalls: string[] = [];
  /** The reason each accepted leave carried (guangshinhaha/duo#315), index-aligned with leaveCalls — undefined for a bare leave. */
  leaveReasons: (string | undefined)[] = [];
  /** Every invite the duo issued (guangshinhaha/duo#314). */
  inviteCalls: { roomId: string; userId: string }[] = [];
  readonly sentAnswers: { roomId: string; content: AnswerEventContent }[] = [];
  /** The membership the fake homeserver holds — what a join added and a leave removed. */
  readonly joinedRooms = new Set<string>();
  /** Every fetchFile call, in order — the door's "was the body read at all" evidence (#190). */
  readonly fetchFileCalls: { reference: string; maxBytes: number }[] = [];

  private failNextConnects = 0;
  private connected = false;
  private messageHandlers: ((message: WorkspaceCandidateMessage) => void)[] = [];
  private inviteHandlers: ((invite: RoomInvite) => void)[] = [];
  private disconnectHandlers: (() => void)[] = [];
  private held: WorkspaceCandidateMessage[] = [];
  private membersListing: WorkspaceMemberListing = { members: [], truncated: false };
  private listMembersError: Error | undefined;
  private nextConnectError: Error | undefined;
  private nextLeaveError: Error | undefined;
  private readonly fileBodies = new Map<string, Uint8Array>();
  private readonly fileErrors = new Map<string, Error>();

  /** Makes the next `n` connect() calls reject, like an unreachable homeserver. */
  failNextNConnects(n: number): void {
    this.failNextConnects = n;
  }

  /** Makes the next connect() reject with this specific error — e.g. a revoked token (#187's terminal path). */
  rejectNextConnectWith(error: Error): void {
    this.nextConnectError = error;
  }

  /** What the homeserver's user directory + presence answer to a member read (#187). */
  setMembers(listing: WorkspaceMemberListing): void {
    this.membersListing = listing;
  }

  /** Makes listMembers() reject, like a homeserver refusing the directory query. */
  failListMembers(error: Error): void {
    this.listMembersError = error;
  }

  /**
   * The media store's answer for one content reference (#190): the bytes a
   * `GET /…/download` would serve. Text in, bytes out — the encoding the
   * door's TextDecoder undoes.
   */
  setFile(reference: string, body: string): void {
    this.fileBodies.set(reference, new TextEncoder().encode(body));
  }

  /** The media store's answer for a reference it no longer has — a deleted file. */
  failFileFetch(reference: string, error: Error): void {
    this.fileErrors.set(reference, error);
  }

  /** Simulates the held outbound connection dropping (the SDK's own retries exhausted). */
  dropConnection(): void {
    this.connected = false;
    for (const handler of this.disconnectHandlers) {
      handler();
    }
  }

  /** A live message arriving over the connection. */
  deliver(message: WorkspaceCandidateMessage): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  /** The homeserver holds a message for us while we're offline. */
  hold(message: WorkspaceCandidateMessage): void {
    this.held.push(message);
  }

  /** An invitation reaching this account, live or replayed by sync's catch-up (#192). */
  deliverInvite(invite: RoomInvite): void {
    this.inviteDeliveries += 1;
    for (const handler of this.inviteHandlers) {
      handler(invite);
    }
  }

  /** Makes the next leaveRoom() reject, like a homeserver refusing the exit — the settleRoomExits retry window. */
  rejectNextLeave(error: Error): void {
    this.nextLeaveError = error;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.nextConnectError) {
      const error = this.nextConnectError;
      this.nextConnectError = undefined;
      throw error;
    }
    if (this.failNextConnects > 0) {
      this.failNextConnects -= 1;
      throw new Error("fake: homeserver unreachable");
    }
    this.connected = true;
    // Sync catch-up: everything the homeserver held while we were away is
    // replayed through the message handlers, exactly like live events.
    const replay = this.held;
    this.held = [];
    for (const message of replay) {
      this.deliver(message);
    }
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.connected = false;
  }

  async sendAnswer(roomId: string, content: AnswerEventContent): Promise<void> {
    if (!this.connected) {
      throw new Error("fake: not connected");
    }
    this.sentAnswers.push({ roomId, content });
  }

  async markAlive(): Promise<void> {
    this.markAliveCalls += 1;
  }

  async fetchFile(reference: string, options: { readonly maxBytes: number }): Promise<WorkspaceFileBody> {
    // The media-download role (#190), with the real adapter's semantics:
    // only over the held connection, one recorded call per dereference,
    // and the Range cut honored the way a compliant homeserver honors it —
    // an inclusive `bytes=0-maxBytes` serves at most maxBytes+1 bytes,
    // which is exactly enough for the caller to tell "at most maxBytes"
    // from "more than maxBytes".
    this.fetchFileCalls.push({ reference, maxBytes: options.maxBytes });
    if (!this.connected) {
      throw new Error("fake: not connected");
    }
    const error = this.fileErrors.get(reference);
    if (error) {
      throw error;
    }
    const body = this.fileBodies.get(reference);
    if (body === undefined) {
      throw new Error(`fake: no such file ${reference}`);
    }
    const bytes = body.byteLength > options.maxBytes ? body.slice(0, options.maxBytes + 1) : body;
    return { bytes, exceededMaxBytes: bytes.byteLength > options.maxBytes };
  }

  async listMembers(): Promise<WorkspaceMemberListing> {
    this.listMembersCalls += 1;
    if (!this.connected) {
      throw new Error("fake: not connected");
    }
    if (this.listMembersError) {
      throw this.listMembersError;
    }
    return this.membersListing;
  }

  async listMemberIdentities(): Promise<WorkspaceMemberIdentityListing> {
    // What the real adapter does: the same directory read without the
    // per-user presence fan-out — identities only, from the listing
    // setMembers holds.
    this.listMemberIdentitiesCalls += 1;
    if (!this.connected) {
      throw new Error("fake: not connected");
    }
    if (this.listMembersError) {
      throw this.listMembersError;
    }
    return { members: this.membersListing.members.map(({ presence: _presence, ...identity }) => identity), truncated: this.membersListing.truncated };
  }

  onMessage(handler: (message: WorkspaceCandidateMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onDisconnected(handler: () => void): void {
    this.disconnectHandlers.push(handler);
  }

  onInvite(handler: (invite: RoomInvite) => void): void {
    this.inviteHandlers.push(handler);
  }

  async joinRoom(roomId: string): Promise<void> {
    if (!this.connected) {
      throw new Error("fake: not connected");
    }
    this.joinCalls.push(roomId);
    this.joinedRooms.add(roomId);
  }

  async leaveRoom(roomId: string, reason?: string): Promise<void> {
    if (!this.connected) {
      throw new Error("fake: not connected");
    }
    if (this.nextLeaveError) {
      const error = this.nextLeaveError;
      this.nextLeaveError = undefined;
      throw error;
    }
    this.leaveCalls.push(roomId);
    this.leaveReasons.push(reason);
    this.joinedRooms.delete(roomId);
  }

  async inviteToRoom(roomId: string, userId: string): Promise<void> {
    if (!this.connected) {
      throw new Error("fake: not connected");
    }
    this.inviteCalls.push({ roomId, userId });
  }
}
