import type { AnswerEventContent, WorkspaceCandidateMessage, WorkspaceTransport } from "../../src/workspace/transport.js";

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
 */
export class FakeWorkspaceTransport implements WorkspaceTransport {
  connectCalls = 0;
  stopCalls = 0;
  markAliveCalls = 0;
  readonly sentAnswers: { roomId: string; content: AnswerEventContent }[] = [];

  private failNextConnects = 0;
  private connected = false;
  private messageHandlers: ((message: WorkspaceCandidateMessage) => void)[] = [];
  private disconnectHandlers: (() => void)[] = [];
  private held: WorkspaceCandidateMessage[] = [];

  /** Makes the next `n` connect() calls reject, like an unreachable homeserver. */
  failNextNConnects(n: number): void {
    this.failNextConnects = n;
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

  async connect(): Promise<void> {
    this.connectCalls += 1;
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

  onMessage(handler: (message: WorkspaceCandidateMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onDisconnected(handler: () => void): void {
    this.disconnectHandlers.push(handler);
  }
}
