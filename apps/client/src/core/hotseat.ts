import type { PlayerId, SnapshotMsg, Transport } from "@prismfront/shared";
import { IntentController } from "./input.ts";

/** One screen, two intent builders. The authoritative priority/prompt selects whose hand is active. */
export class HotseatSession {
  private active: PlayerId = 0;
  private readonly controllers: readonly [IntentController, IntentController];

  constructor(transport: Transport) {
    this.controllers = [new IntentController(transport, 0), new IntentController(transport, 1)];
  }

  get viewer(): PlayerId {
    return this.active;
  }

  get input(): IntentController {
    return this.controllers[this.active];
  }

  sync(message: SnapshotMsg): void {
    this.active = message.view.pendingInput?.player ?? message.view.priority;
    this.controllers[0].sync(message.seq, message.legal.player === 0 ? message.legal : noMoves(0));
    this.controllers[1].sync(message.seq, message.legal.player === 1 ? message.legal : noMoves(1));
  }
}

function noMoves(player: PlayerId): SnapshotMsg["legal"] {
  const pass = {
    intent: { t: "pass", player },
    t: "pass",
    card: null,
    slot: null,
    legal: false,
    reason: "wrong_player",
    illegalReason: "wrong_player",
    missingColors: [],
    slots: [],
  } as const;
  return { player, actions: [pass], playCard: [], pass };
}
