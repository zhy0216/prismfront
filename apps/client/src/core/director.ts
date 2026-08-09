import type { ClientEvent } from "@prismfront/shared";

export type BeatKind =
  | "VolleyPrep"
  | "Volley"
  | "Deaths"
  | "CombatEnd"
  | "PlayCard"
  | "Move"
  | "RoundStart"
  | "Deploy"
  | "Effect";

export interface RenderContext {
  animate(
    kind: BeatKind,
    events: readonly ClientEvent[],
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void>;
  complete(kind: BeatKind, events: readonly ClientEvent[]): void;
  idle(): void;
}

export interface Beat {
  readonly kind: BeatKind;
  readonly events: readonly ClientEvent[];
  readonly durationMs: number;
  play(context: RenderContext): Promise<void>;
  complete(context: RenderContext): void;
}

class EventBeat implements Beat {
  readonly kind: BeatKind;
  readonly events: readonly ClientEvent[];
  readonly durationMs: number;

  constructor(kind: BeatKind, events: readonly ClientEvent[], durationMs: number) {
    this.kind = kind;
    this.events = events;
    this.durationMs = durationMs;
  }

  play(context: RenderContext, signal?: AbortSignal): Promise<void> {
    return context.animate(
      this.kind,
      this.events,
      this.durationMs,
      signal ?? new AbortController().signal,
    );
  }

  complete(context: RenderContext): void {
    context.complete(this.kind, this.events);
  }
}

function eventBeat(event: ClientEvent): Beat {
  switch (event.name) {
    case "card_played":
      return new EventBeat("PlayCard", [event], 400);
    case "unit_moved":
      return new EventBeat("Move", [event], 250);
    case "round_began":
      return new EventBeat("RoundStart", [event], 500);
    case "hero_deployed":
      return new EventBeat("Deploy", [event], 450);
    default:
      return new EventBeat("Effect", [event], 200);
  }
}

/** 只按事件边界分拍，不推演规则。齐射的 struck/damaged 合成一拍并行。 */
export function planBeats(events: readonly ClientEvent[]): Beat[] {
  const beats: Beat[] = [];
  let index = 0;
  while (index < events.length) {
    const event = events[index];
    if (event === undefined) break;
    if (event.name === "combat_began") {
      beats.push(new EventBeat("VolleyPrep", [event], 200));
      index += 1;
      const volley: ClientEvent[] = [];
      while (events[index]?.name === "struck" || events[index]?.name === "damaged") {
        const next = events[index];
        if (next !== undefined) volley.push(next);
        index += 1;
      }
      if (volley.length > 0) {
        beats.push(new EventBeat("Volley", volley, Math.min(900, 480 + volley.length * 40)));
      }
      const deaths: ClientEvent[] = [];
      while (events[index]?.name === "unit_died" || events[index]?.name === "hero_died") {
        const next = events[index];
        if (next !== undefined) deaths.push(next);
        index += 1;
      }
      if (deaths.length > 0) beats.push(new EventBeat("Deaths", deaths, 250));
      continue;
    }
    if (event.name === "combat_ended") {
      beats.push(new EventBeat("CombatEnd", [event], 200));
      index += 1;
      continue;
    }
    if (event.name === "unit_died" || event.name === "hero_died") {
      const deaths: ClientEvent[] = [];
      while (events[index]?.name === "unit_died" || events[index]?.name === "hero_died") {
        const next = events[index];
        if (next !== undefined) deaths.push(next);
        index += 1;
      }
      beats.push(new EventBeat("Deaths", deaths, 250));
      continue;
    }
    beats.push(eventBeat(event));
    index += 1;
  }
  return beats;
}

export class Director {
  private readonly queue: Beat[] = [];
  private playing = false;
  private current: Beat | null = null;
  private currentAbort: AbortController | null = null;
  private generation = 0;
  private readonly context: RenderContext;

  constructor(context: RenderContext) {
    this.context = context;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get pendingCount(): number {
    return this.queue.length + (this.current === null ? 0 : 1);
  }

  enqueue(events: readonly ClientEvent[]): void {
    this.queue.push(...planBeats(events));
    if (this.queue.length > 3) this.fastForward(1);
    void this.drain();
  }

  fastForward(leave = 0): void {
    this.generation += 1;
    if (this.current !== null) {
      this.currentAbort?.abort();
      this.current?.complete(this.context);
      this.current = null;
      this.currentAbort = null;
    }
    while (this.queue.length > leave) {
      this.queue.shift()?.complete(this.context);
    }
    this.context.idle();
  }

  private async drain(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    const startedGeneration = this.generation;
    while (this.queue.length > 0) {
      this.current = this.queue.shift() ?? null;
      this.currentAbort = new AbortController();
      if (this.current !== null) {
        await this.context.animate(
          this.current.kind,
          this.current.events,
          this.current.durationMs,
          this.currentAbort.signal,
        );
      }
      // fastForward already completed and nulled it; an old tween promise must not commit again.
      if (startedGeneration !== this.generation) {
        this.playing = false;
        if (this.queue.length > 0) void this.drain();
        return;
      }
      const completed = this.current;
      if (completed !== null) completed.complete(this.context);
      this.current = null;
      this.currentAbort = null;
    }
    this.playing = false;
    this.context.idle();
  }
}
