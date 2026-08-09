import type { ServerMsg } from "@prismfront/shared";

export type SequenceDecision = "accept" | "resync" | "ignore";

/** Strict protocol/seq gate kept separate from the Colyseus SDK for deterministic tests. */
export class ProtocolSequencer {
  private lastSeq = -1;

  get seq(): number {
    return this.lastSeq;
  }

  accept(message: ServerMsg): SequenceDecision {
    if (message.version !== 1) return "ignore";
    if (message.t === "seat") return "accept";
    if (message.t === "snapshot") {
      if (message.seq < this.lastSeq) return "ignore";
      this.lastSeq = message.seq;
      return "accept";
    }
    // snapshot, prompt, rejected and over may share one authoritative state seq;
    // only a lower seq is stale. Events use strictly increasing state seqs.
    if (message.seq < this.lastSeq) return "ignore";
    if (this.lastSeq >= 0 && message.seq > this.lastSeq + 1) return "resync";
    this.lastSeq = message.seq;
    return "accept";
  }
}
