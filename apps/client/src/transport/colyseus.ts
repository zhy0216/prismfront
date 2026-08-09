import { Client, type Room } from "@colyseus/sdk";
import type { ClientIntent, ServerMsg, Transport } from "@prismfront/shared";
import { ProtocolSequencer } from "./sequence.ts";

export class ColyseusTransport implements Transport {
  private readonly callbacks = new Set<(message: ServerMsg) => void>();
  private readonly early: ServerMsg[] = [];
  private room: Room | null = null;
  private readonly sequencer = new ProtocolSequencer();
  private reconnecting = false;
  private intentionallyClosed = false;
  private readonly endpoint: string;
  private readonly roomName: string;
  private readonly options: Readonly<Record<string, unknown>>;
  private reconnectCount = 0;

  constructor(
    endpoint: string,
    roomName = "match",
    options: Readonly<Record<string, unknown>> = {},
  ) {
    this.endpoint = endpoint;
    this.roomName = roomName;
    this.options = options;
  }

  /** Registers the SDK message handler before returning, then resyncs to cover join-time messages. */
  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    try {
      const client = new Client(this.endpoint);
      const room = await client.joinOrCreate(this.roomName, this.options);
      this.attach(room);
      document.body.dataset.transportConnected = "true";
      this.requestResync();
    } catch (error) {
      document.body.dataset.transportError = String(error);
      throw error;
    }
  }

  send(intent: ClientIntent): void {
    document.body.dataset.transportSends = String(
      Number(document.body.dataset.transportSends ?? 0) + 1,
    );
    this.room?.send("intent", intent);
  }

  onMessage(callback: (message: ServerMsg) => void): () => void {
    this.callbacks.add(callback);
    for (const message of this.early.splice(0)) callback(message);
    return () => this.callbacks.delete(callback);
  }

  close(): void {
    this.intentionallyClosed = true;
    void this.room?.leave(true);
    this.room = null;
  }

  async reconnect(): Promise<void> {
    const old = this.room;
    if (old === null || this.reconnecting) return;
    this.reconnecting = true;
    try {
      const client = new Client(this.endpoint);
      const room = await client.reconnect(old.reconnectionToken);
      this.attach(room);
      this.reconnectCount += 1;
      document.body.dataset.reconnectCount = String(this.reconnectCount);
      document.body.dataset.reconnectPending = "false";
      this.requestResync();
    } finally {
      this.reconnecting = false;
    }
  }

  private attach(room: Room): void {
    this.room = room;
    room.onMessage<ServerMsg>("server", (message) => this.receive(message));
    room.onLeave(() => {
      if (!this.intentionallyClosed && this.room === room) {
        document.body.dataset.reconnectPending = "true";
        void this.reconnect();
      }
    });
  }

  private receive(message: ServerMsg): void {
    document.body.dataset.transportMessages = String(
      Number(document.body.dataset.transportMessages ?? 0) + 1,
    );
    const decision = this.sequencer.accept(message);
    if (decision === "ignore") return;
    if (decision === "resync") {
      this.requestResync();
      return;
    }
    if (this.callbacks.size === 0) this.early.push(message);
    else for (const callback of this.callbacks) callback(message);
  }

  requestResync(): void {
    this.room?.send("resync", { version: 1, seq: Math.max(0, this.sequencer.seq) });
  }

  /** Browser smoke hook: closes the socket abnormally, exercising the real reconnection token path. */
  simulateDisconnect(): void {
    this.room?.connection.close(4001, "browser-smoke-drop");
  }
}
