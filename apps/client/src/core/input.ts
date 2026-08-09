import type {
  ClientIntent,
  DeployPick,
  LegalMoves,
  PlayerId,
  ProjectedInputRequest,
} from "@prismfront/shared";

export type InputMode =
  | { readonly kind: "idle" }
  | { readonly kind: "targeting"; readonly card: number }
  | { readonly kind: "mulligan"; readonly selected: readonly number[] }
  | { readonly kind: "deploy"; readonly picks: readonly DeployPick[] }
  | { readonly kind: "prompt"; readonly request: ProjectedInputRequest }
  | { readonly kind: "committed" };

export interface IntentSink {
  send(intent: ClientIntent): void;
}

export class IntentController {
  private state: InputMode = { kind: "idle" };
  private readonly sink: IntentSink;
  private readonly seat: PlayerId;
  private seq: number;
  private legal: LegalMoves | null;

  constructor(sink: IntentSink, seat: PlayerId, seq = 0, legal: LegalMoves | null = null) {
    this.sink = sink;
    this.seat = seat;
    this.seq = seq;
    this.legal = legal;
  }

  get mode(): InputMode {
    return this.state;
  }

  sync(seq: number, legal: LegalMoves): void {
    this.seq = seq;
    this.legal = legal;
    if (this.state.kind === "committed") this.state = { kind: "idle" };
  }

  beginMulligan(): void {
    this.state = { kind: "mulligan", selected: [] };
  }

  toggleMulligan(card: number): void {
    if (this.state.kind !== "mulligan") return;
    const selected = this.state.selected.includes(card)
      ? this.state.selected.filter((id) => id !== card)
      : [...this.state.selected, card];
    this.state = { kind: "mulligan", selected };
  }

  commitMulligan(): void {
    if (this.state.kind !== "mulligan") return;
    this.commit({ t: "mulligan", version: 1, seq: this.seq, toss: this.state.selected });
  }

  beginDeploy(): void {
    this.state = { kind: "deploy", picks: [] };
  }

  placeHero(hero: number, slot: number): void {
    if (this.state.kind !== "deploy") return;
    this.state = {
      kind: "deploy",
      picks: [
        ...this.state.picks.filter((pick) => pick.hero !== hero && pick.slot !== slot),
        { hero, slot },
      ],
    };
  }

  commitDeploy(): void {
    if (this.state.kind !== "deploy") return;
    this.commit({ t: "deploy", version: 1, seq: this.seq, picks: this.state.picks });
  }

  beginCard(card: number): void {
    if (this.state.kind !== "idle") return;
    this.state = { kind: "targeting", card };
  }

  playAt(slot: number): boolean {
    if (this.state.kind !== "targeting") return false;
    const card = this.state.card;
    const action = this.legal?.playCard.find(
      (move) => move.card === card && move.legal && move.slots.includes(slot),
    );
    if (action === undefined) {
      this.state = { kind: "idle" };
      return false;
    }
    this.commit({ t: "play_card", version: 1, seq: this.seq, card, slot });
    return true;
  }

  pass(): boolean {
    if (this.state.kind !== "idle" || this.legal?.pass.legal !== true) return false;
    this.commit({ t: "pass", version: 1, seq: this.seq });
    return true;
  }

  prompt(request: ProjectedInputRequest): void {
    if (request.player === this.seat) this.state = { kind: "prompt", request };
  }

  respond(chosen: number | string | null): boolean {
    if (this.state.kind !== "prompt") return false;
    if (chosen !== null && !this.state.request.options.includes(chosen)) return false;
    this.commit({ t: "respond", version: 1, seq: this.seq, chosen });
    return true;
  }

  reject(): void {
    this.state = { kind: "idle" };
  }

  private commit(intent: ClientIntent): void {
    this.sink.send(intent);
    this.state = { kind: "committed" };
  }
}
