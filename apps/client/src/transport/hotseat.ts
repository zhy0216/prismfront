import type { ClientIntent, PlayerId, ServerMsg, SnapshotMsg, Transport } from "@prismfront/shared";
import { ColyseusTransport } from "./colyseus.ts";

export interface HotseatAutomation {
  readonly seats: readonly PlayerId[];
  readonly fixedSeat?: PlayerId;
}

/** Two authenticated room connections presented as one same-screen transport. */
export class HotseatTransport implements Transport {
  private readonly peers: readonly [ColyseusTransport, ColyseusTransport];
  private readonly callbacks = new Set<(message: ServerMsg) => void>();
  private readonly seatByPeer: [PlayerId | null, PlayerId | null] = [null, null];
  private readonly snapshots: [SnapshotMsg | null, SnapshotMsg | null] = [null, null];
  private active: PlayerId = 0;
  private readonly autoSeats: ReadonlySet<PlayerId>;
  private readonly fixedSeat: PlayerId | null;
  private readonly concedeAfterFirstCard: boolean;
  private readonly autoSubmitted = new Set<string>();
  private autoTimer: ReturnType<typeof setInterval> | null = null;
  private autoSeq = -1;
  constructor(
    endpoint: string,
    options: Readonly<Record<string, unknown>> = {},
    automation: boolean | HotseatAutomation = false,
  ) {
    this.autoSeats = new Set(
      typeof automation === "boolean" ? (automation ? [0, 1] : []) : automation.seats,
    );
    this.fixedSeat = typeof automation === "boolean" ? null : (automation.fixedSeat ?? null);
    this.concedeAfterFirstCard = automation === true;
    this.peers = [
      new ColyseusTransport(endpoint, "match", options),
      new ColyseusTransport(endpoint, "match", options),
    ];
    this.peers.forEach((peer, index) => {
      peer.onMessage((message) => this.receive(index, message));
    });
  }

  async connect(): Promise<void> {
    // Join both seats concurrently.  Waiting for seat 0 before requesting seat 1
    // leaves the first room in a half-open mulligan when a browser tab is the
    // only driver of both local controllers.
    await Promise.all(this.peers.map((peer) => peer.connect()));
    // joinOrCreate may complete after the room's first broadcast. Ask both
    // projections again once their seat bindings are installed.
    for (const peer of this.peers) peer.requestResync();
    await new Promise((resolve) => setTimeout(resolve, 25));
    for (const peer of this.peers) peer.requestResync();
    setTimeout(() => {
      for (const peer of this.peers) peer.requestResync();
    }, 150);
    if (this.autoSeats.size > 0) {
      this.autoTimer = setInterval(() => {
        for (const [index, snapshot] of this.snapshots.entries()) {
          const seat = index as PlayerId;
          if (snapshot !== null && this.autoSeats.has(seat)) this.scheduleAuto(seat, snapshot);
        }
      }, 100);
    }
  }

  send(intent: ClientIntent): void {
    const peer = this.peerFor(this.active);
    peer?.send(intent);
  }

  onMessage(callback: (message: ServerMsg) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  close(): void {
    if (this.autoTimer !== null) clearInterval(this.autoTimer);
    for (const peer of this.peers) peer.close();
  }

  simulateDisconnect(): void {
    document.body.dataset.disconnectRequested = "true";
    for (const peer of this.peers) peer.simulateDisconnect();
  }

  private receive(index: number, message: ServerMsg): void {
    if (message.t === "seat") {
      this.seatByPeer[index] = message.seat;
      return;
    }
    const seat = this.seatByPeer[index];
    if (seat === null || seat === undefined) return;
    if (message.t === "snapshot") {
      this.snapshots[seat] = message;
      this.autoSeq = Math.max(this.autoSeq, message.seq);
      if (this.autoSeats.has(seat)) this.scheduleAuto(seat, message);
      if (this.fixedSeat !== null) {
        if (seat === this.fixedSeat) this.activate(seat, message);
        return;
      }
      if (
        (message.view.phase === "mulligan" || message.view.phase === "deploy") &&
        seat !== this.active &&
        this.snapshots[this.active] !== null
      ) {
        this.activate(seat, message);
        return;
      }
      const requested = message.view.pendingInput?.player ?? message.view.priority;
      if (requested === seat) this.activate(seat, message);
      return;
    }
    // Terminal is room-wide, not seat-private. It must not be lost when the
    // active presentation seat changed on the final snapshot.
    if (message.t === "rejected" && this.autoSeats.has(seat)) {
      for (const key of this.autoSubmitted) {
        if (key.includes(`:${message.seq}:`)) this.autoSubmitted.delete(key);
      }
      for (const [index, snapshot] of this.snapshots.entries()) {
        const autoSeat = index as PlayerId;
        if (snapshot !== null && this.autoSeats.has(autoSeat)) {
          this.scheduleAuto(autoSeat, snapshot);
        }
      }
    }
    if (message.t === "events" && this.autoSeats.size > 0) {
      if (
        this.concedeAfterFirstCard &&
        message.events.some((event) => event.name === "card_played")
      ) {
        const seat = this.active;
        const key = `${seat}:${message.seq}:concede`;
        if (!this.autoSubmitted.has(key)) {
          this.autoSubmitted.add(key);
          setTimeout(
            () => this.peerFor(seat)?.send({ t: "concede", version: 1, seq: message.seq }),
            0,
          );
        }
      }
      for (const [index, snapshot] of this.snapshots.entries()) {
        const autoSeat = index as PlayerId;
        if (snapshot !== null && this.autoSeats.has(autoSeat)) {
          this.scheduleAuto(autoSeat, snapshot);
        }
      }
    }
    if (this.fixedSeat !== null) {
      if (seat === this.fixedSeat) this.emit(message);
      return;
    }
    if (message.t === "over" || message.t === "events" || seat === this.active) this.emit(message);
  }

  private activate(seat: PlayerId, snapshot: SnapshotMsg): void {
    this.active = seat;
    this.emit({ t: "seat", version: 1, seq: snapshot.seq, playerId: `hotseat-${seat}`, seat });
    this.emit(snapshot);
  }

  private scheduleAuto(seat: PlayerId, message: SnapshotMsg): void {
    if (
      message.view.phase === "mulligan" &&
      this.snapshots[0] !== null &&
      this.snapshots[1] !== null
    ) {
      const seq = message.seq;
      const key = `${seat}:${seq}:mulligan`;
      if (!this.autoSubmitted.has(key)) {
        this.autoSubmitted.add(key);
        setTimeout(() => this.peerFor(seat)?.send({ t: "mulligan", version: 1, seq, toss: [] }), 0);
      }
      return;
    }
    const phase = message.view.phase;
    const pending = message.view.pendingInput?.player === seat ? "respond" : null;
    const kind = pending ?? (phase === "actions" ? "action" : phase);
    if (kind !== "respond" && kind !== "mulligan" && kind !== "deploy" && kind !== "action") return;
    if (kind === "action" && message.view.priority !== seat) return;
    const seq = Math.max(message.seq, this.autoSeq);
    const key = `${seat}:${seq}:${kind}`;
    if (this.autoSubmitted.has(key)) return;
    this.autoSubmitted.add(key);
    document.body.dataset.hotseatAuto = String(Number(document.body.dataset.hotseatAuto ?? 0) + 1);
    // Do not write to Colyseus from inside its message callback. A macrotask lets
    // both seat projections settle first and prevents same-seq re-entrancy.
    setTimeout(() => {
      const peer = this.peerFor(seat);
      if (kind === "respond") {
        peer?.send({
          t: "respond",
          version: 1,
          seq,
          chosen: message.view.pendingInput?.options[0] ?? null,
        });
      } else if (kind === "mulligan") {
        peer?.send({ t: "mulligan", version: 1, seq, toss: [] });
      } else if (kind === "deploy") {
        const count = message.view.rules.heroes.deploySchedule[message.view.round - 1] ?? 0;
        const picks = (message.view.zones[`p${seat}:fountain`] ?? [])
          .slice(0, count)
          .map((hero, slot) => ({ hero, slot }));
        peer?.send({ t: "deploy", version: 1, seq, picks });
      } else {
        const action = message.legal.playCard.find(
          (move) => move.legal && move.card !== null && move.slot !== null,
        );
        if (action?.card !== null && action?.card !== undefined && action.slot !== null) {
          peer?.send({
            t: "play_card",
            version: 1,
            seq,
            card: action.card,
            slot: action.slot,
          });
        } else {
          peer?.send({ t: "pass", version: 1, seq });
        }
      }
    }, 0);
  }

  private peerFor(seat: PlayerId): ColyseusTransport | undefined {
    const index = this.seatByPeer.indexOf(seat);
    return index < 0 ? undefined : this.peers[index];
  }

  private emit(message: ServerMsg): void {
    for (const callback of this.callbacks) callback(message);
  }
}
