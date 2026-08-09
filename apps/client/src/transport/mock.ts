import type {
  ClientEvent,
  ClientIntent,
  LegalAction,
  LegalMoves,
  PlayerId,
  PlayerView,
  ServerMsg,
  Transport,
} from "@prismfront/shared";

export interface GoldenReplay {
  readonly name: string;
  readonly scenario: string;
  readonly rules: PlayerView["rules"];
  readonly intents: readonly Record<string, unknown>[];
  readonly expectedEventSequence?: readonly ClientEvent[];
  readonly expectedEvents?: readonly string[];
  readonly expectedEventCounts?: Readonly<Record<string, number>>;
  readonly messagesPerSeat?: readonly [readonly ServerMsg[], readonly ServerMsg[]];
}

function emptyLegal(player: PlayerId): LegalMoves {
  const intent = { t: "pass", player } as const;
  const pass: LegalAction = {
    intent,
    t: "pass",
    card: null,
    slot: null,
    legal: true,
    reason: null,
    illegalReason: null,
    missingColors: [],
    slots: [],
  };
  return { player, actions: [pass], playCard: [], pass };
}

function syntheticView(replay: GoldenReplay, _seat: PlayerId, seq: number): PlayerView {
  const slots = replay.rules.board.slots;
  return {
    bundleId: `golden:${replay.name}`,
    rules: replay.rules,
    seq,
    round: 1,
    phase: "actions",
    priority: 0,
    initiative: 0,
    firstPasser: null,
    consecutivePasses: 0,
    players: [
      { crystals: 5, crystalCap: 5, baseId: 1, fatigue: 0 },
      { crystals: 5, crystalCap: 5, baseId: 2, fatigue: 0 },
    ],
    entities: {
      1: {
        id: 1,
        cardId: "__BASE__",
        owner: 0,
        zone: "p0:base",
        slot: null,
        tags: { atk: 0, health: replay.rules.baseHp, cost: 0, armor: 0, direction: 0 },
        damage: 0,
        respawnAt: null,
      },
      2: {
        id: 2,
        cardId: "__BASE__",
        owner: 1,
        zone: "p1:base",
        slot: null,
        tags: { atk: 0, health: replay.rules.baseHp, cost: 0, armor: 0, direction: 0 },
        damage: 0,
        respawnAt: null,
      },
    },
    zones: {
      "p0:base": [1],
      "p1:base": [2],
      "p0:board": [],
      "p1:board": [],
      "p0:hand": [],
      "p1:hand": [],
      "p0:fountain": [],
      "p1:fountain": [],
    },
    zoneCounts: {},
    slots: [Array.from({ length: slots }, () => null), Array.from({ length: slots }, () => null)],
    pendingInput: null,
    winner: null,
  };
}

/**
 * M8's messagesPerSeat may be empty in legacy fixtures. We never iterate an empty array:
 * build a real protocol timeline from replay evidence (snapshot + causal event sequence).
 */
export function replayTimeline(replay: GoldenReplay, seat: PlayerId): ServerMsg[] {
  const captured = replay.messagesPerSeat?.[seat] ?? [];
  if (captured.length > 0) return [...captured];
  const events: ClientEvent[] =
    replay.expectedEventSequence?.length === 0 || replay.expectedEventSequence === undefined
      ? (replay.expectedEvents ?? []).map((name) => ({ name }))
      : [...replay.expectedEventSequence];
  for (const [name, count] of Object.entries(replay.expectedEventCounts ?? {})) {
    const missing = Math.max(0, count - events.filter((event) => event.name === name).length);
    for (let index = 0; index < missing; index += 1) events.push({ name });
  }
  const view0 = syntheticView(replay, seat, 0);
  const view1 = syntheticView(replay, seat, 1);
  return [
    { t: "seat", version: 1, seq: 0, playerId: `mock-${seat}`, seat },
    {
      t: "snapshot",
      version: 1,
      seq: 0,
      playerId: `mock-${seat}`,
      view: view0,
      legal: emptyLegal(seat),
    },
    { t: "events", version: 1, seq: 1, events },
    {
      t: "snapshot",
      version: 1,
      seq: 1,
      playerId: `mock-${seat}`,
      view: view1,
      legal: emptyLegal(seat),
    },
  ];
}

export class MockTransport implements Transport {
  private readonly callbacks = new Set<(message: ServerMsg) => void>();
  private cursor = 0;
  readonly sent: ClientIntent[] = [];

  readonly seat: PlayerId;
  private readonly timeline: readonly ServerMsg[];

  constructor(replay: GoldenReplay, seat: PlayerId = 0, timeline = replayTimeline(replay, seat)) {
    this.seat = seat;
    this.timeline = timeline;
  }

  send(intent: ClientIntent): void {
    this.sent.push(intent);
  }

  onMessage(callback: (message: ServerMsg) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  start(): void {
    while (this.cursor < this.timeline.length) this.step();
  }

  async play(intervalMs = 180): Promise<void> {
    while (this.cursor < this.timeline.length) {
      this.step();
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  step(): ServerMsg | null {
    const message = this.timeline[this.cursor];
    if (message === undefined) return null;
    this.cursor += 1;
    for (const callback of this.callbacks) callback(message);
    return message;
  }
}
