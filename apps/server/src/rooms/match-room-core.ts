// MatchRoom 的纯业务核心。
//
// 这里没有 Colyseus 类型：它只把不透明 playerId 映射成引擎的 PlayerId，并把引擎
// 的快照/事件投影成 shared 协议。真正的 WebSocket 生命周期在 MatchRoom 适配器里。

import {
  apply,
  createGame,
  DEFAULT_DEPS,
  DEFAULT_RULES,
  defaultInputChoice,
  deployCountFor,
  type GameEvent,
  type GameState,
  getEntity,
  type IllegalReason,
  type Intent,
  isSlotEmpty,
  isValidSlot,
  legalActions,
  type PlayerId,
  project,
  projectEvent,
  ResolutionLoopError,
  type ResolveDeps,
  zoneKey,
} from "@prismfront/engine";
import type { Card, CardId, Enchantment, EntityId, RulesConfig } from "@prismfront/ir";
import type {
  EndReason,
  OverMsg,
  RejectedMsg,
  ServerMsg,
  SnapshotMsg,
  IllegalReason as WireIllegalReason,
} from "@prismfront/shared";
import type { TimerHandle, TransportClient } from "../transport/index.ts";

export interface MatchRoomCardRegistry {
  readonly cards?: readonly Card[];
  readonly enchantments?: readonly Enchantment[];
}

export interface MatchRoomOptions {
  readonly roomId?: string;
  readonly rules?: RulesConfig;
  readonly decks?: readonly [readonly CardId[], readonly CardId[]];
  readonly heroes?: readonly [readonly CardId[], readonly CardId[]];
  readonly seed?: number;
  readonly firstPlayer?: PlayerId;
  readonly deps?: ResolveDeps;
  readonly cardRegistry?: MatchRoomCardRegistry;
  /** actionSeconds is in RulesConfig; this override is useful for fake-clock tests. */
  readonly actionTimeoutMs?: number;
  readonly reconnectSeconds?: number;
  readonly schedule?: (delayMs: number, callback: () => void) => TimerHandle;
  readonly persistResult?: (result: MatchResultRecord) => void | Promise<void>;
  /** 测试故障策略的注入口；生产恒用 engine.apply。 */
  readonly applyGame?: typeof apply;
}

export interface MatchResultRecord {
  readonly roomId?: string;
  readonly seed: number;
  readonly winner: PlayerId | "draw" | null;
  readonly reason: EndReason;
  readonly seq: number;
  readonly state: GameState;
}

interface Seat {
  readonly playerId: string;
  readonly seat: PlayerId;
  client: TransportClient | null;
  connected: boolean;
}

interface TimerState {
  readonly token: number;
  readonly handle: TimerHandle;
}

const EMPTY_DECKS: readonly [readonly CardId[], readonly CardId[]] = [[], []];

function cardMap(registry: MatchRoomCardRegistry | undefined): ReadonlyMap<CardId, Card> {
  return new Map((registry?.cards ?? []).map((card) => [card.id, card]));
}

function enchantmentMap(
  registry: MatchRoomCardRegistry | undefined,
): ReadonlyMap<string, Enchantment> {
  return new Map((registry?.enchantments ?? []).map((ench) => [ench.id, ench]));
}

function buildDeps(
  deps: ResolveDeps | undefined,
  registry: MatchRoomCardRegistry | undefined,
): ResolveDeps {
  const cards = cardMap(registry);
  const enchantments = enchantmentMap(registry);
  const scripts = cards;
  if (deps !== undefined) {
    return {
      ...deps,
      cards: deps.cards ?? ((id) => cards.get(id)?.data),
      scripts: deps.scripts ?? ((id) => cards.get(id)?.script),
      enchantments: deps.enchantments ?? ((id) => enchantments.get(id)),
    };
  }
  return {
    ...DEFAULT_DEPS,
    cards: (id) => cards.get(id)?.data,
    scripts: (id) => scripts.get(id)?.script,
    enchantments: (id) => enchantments.get(id),
  };
}

function hydrateCardData(state: GameState, registry: MatchRoomCardRegistry | undefined): void {
  const cards = cardMap(registry);
  for (const entity of Object.values(state.entities)) {
    const data = cards.get(entity.cardId)?.data;
    if (data === undefined) {
      continue;
    }
    const tags = data.tags ?? {};
    for (const key of Object.keys(entity.base) as Array<keyof typeof entity.base>) {
      const fromCard = tags[key];
      if (fromCard !== undefined) {
        entity.base[key] = fromCard;
        entity.tags[key] = fromCard;
      }
    }
    if (data.cost !== undefined) {
      entity.base.cost = data.cost;
      entity.tags.cost = data.cost;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function ids(value: unknown): readonly EntityId[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(integer);
}

function picks(value: unknown): readonly { readonly hero: EntityId; readonly slot: number }[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (pick): pick is { readonly hero: EntityId; readonly slot: number } =>
      isRecord(pick) && integer(pick.hero) && integer(pick.slot),
  );
}

function chosen(value: unknown): EntityId | CardId | null {
  return value === null || integer(value) || typeof value === "string" ? value : null;
}

function validIdArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(integer);
}

function validPickArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((pick) => isRecord(pick) && integer(pick.hero) && integer(pick.slot))
  );
}

/** 严格校验 wire shape；不能把坏字段过滤成空选择后当成合法动作。 */
function isClientIntentShape(wire: Record<string, unknown>): boolean {
  switch (wire.t) {
    case "mulligan":
      return (
        !(wire.toss !== undefined && wire.keep !== undefined) &&
        (wire.toss === undefined || validIdArray(wire.toss)) &&
        (wire.keep === undefined || validIdArray(wire.keep))
      );
    case "deploy":
      return (
        !(wire.picks !== undefined && wire.placements !== undefined) &&
        (wire.picks === undefined || validPickArray(wire.picks)) &&
        (wire.placements === undefined || validPickArray(wire.placements))
      );
    case "play_card":
      return (
        integer(wire.card) &&
        !(wire.slot !== undefined && wire.at !== undefined) &&
        (integer(wire.slot) || integer(wire.at))
      );
    case "pass":
    case "concede":
      return true;
    case "respond":
      return wire.chosen === null || integer(wire.chosen) || typeof wire.chosen === "string";
    default:
      return false;
  }
}

/** 将没有 player 的 wire intent 绑定到 opaque playerId 对应的引擎座位。 */
export function bindClientIntent(wire: unknown, player: PlayerId, state: GameState): Intent | null {
  if (!isRecord(wire) || typeof wire.t !== "string") {
    return null;
  }
  switch (wire.t) {
    case "mulligan": {
      const toss = wire.toss !== undefined ? ids(wire.toss) : [];
      // 早期协议写作 keep；服务端统一转换成引擎的 toss。
      if (wire.toss === undefined && wire.keep !== undefined) {
        const kept = new Set(ids(wire.keep));
        const hand = state.zones[`p${player}:hand`];
        return {
          t: "mulligan",
          player,
          toss: [
            player === 0 ? hand.filter((id) => !kept.has(id)) : [],
            player === 1 ? hand.filter((id) => !kept.has(id)) : [],
          ],
        };
      }
      return {
        t: "mulligan",
        player,
        toss: [player === 0 ? toss : [], player === 1 ? toss : []],
      };
    }
    case "deploy": {
      const value = wire.picks ?? wire.placements;
      const chosenPicks = picks(value);
      return {
        t: "deploy",
        player,
        picks: [player === 0 ? chosenPicks : [], player === 1 ? chosenPicks : []],
      };
    }
    case "play_card": {
      const slot = wire.slot ?? wire.at;
      return {
        t: "play_card",
        player,
        card: integer(wire.card) ? wire.card : -1,
        slot: integer(slot) ? slot : -1,
      };
    }
    case "pass":
      return { t: "pass", player };
    case "concede":
      return { t: "concede", player };
    case "respond":
      return { t: "respond", player, chosen: chosen(wire.chosen) };
    default:
      return null;
  }
}

function illegalMessage(seq: number, code: WireIllegalReason): RejectedMsg {
  return { t: "rejected", version: 1, seq, code };
}

/**
 * Colyseus 无关的权威房间状态机。
 *
 * 所有来自客户端的动作最终都经过 `apply()`，即使客户端先前拿到的 legalActions 说它
 * 合法。聚合的 mulligan/deploy 只在双方的秘密选择齐全后产生一条引擎 intent。
 */
export class MatchRoomCore {
  readonly roomId: string | undefined;
  readonly seed: number;
  readonly rules: RulesConfig;
  readonly deps: ResolveDeps;
  private readonly seats = new Map<string, Seat>();
  private readonly bySeat: [Seat | null, Seat | null] = [null, null];
  private readonly pendingMulligans = new Map<PlayerId, readonly EntityId[]>();
  private readonly pendingDeploys = new Map<
    PlayerId,
    readonly { readonly hero: EntityId; readonly slot: number }[]
  >();
  private readonly schedule: (delayMs: number, callback: () => void) => TimerHandle;
  private readonly persistResult: ((result: MatchResultRecord) => void | Promise<void>) | undefined;
  private readonly actionTimeoutMs: number;
  private readonly reconnectSeconds: number;
  private readonly applyGame: typeof apply;
  private actionTimer: TimerState | null = null;
  private timerToken = 0;
  private result: MatchResultRecord | null = null;
  private currentState: GameState;

  constructor(options: MatchRoomOptions = {}) {
    this.roomId = options.roomId;
    this.seed = options.seed ?? 0x9f1;
    this.rules = options.rules ?? DEFAULT_RULES;
    this.deps = buildDeps(options.deps, options.cardRegistry);
    this.actionTimeoutMs = options.actionTimeoutMs ?? this.rules.actionSeconds * 1000;
    this.reconnectSeconds = options.reconnectSeconds ?? this.rules.reconnectSeconds;
    this.schedule =
      options.schedule ??
      ((delayMs, callback) => {
        const handle = setTimeout(callback, delayMs);
        return { clear: () => clearTimeout(handle) };
      });
    this.persistResult = options.persistResult;
    this.applyGame = options.applyGame ?? apply;
    const decks = options.decks ?? EMPTY_DECKS;
    const gameOptions = {
      shuffle: false,
      ...(options.firstPlayer === undefined ? {} : { firstPlayer: options.firstPlayer }),
      ...(options.heroes === undefined ? {} : { heroes: options.heroes }),
    };
    this.currentState = createGame(this.rules, decks, this.seed, gameOptions);
    hydrateCardData(this.currentState, options.cardRegistry);
  }

  get state(): GameState {
    return this.currentState;
  }

  get over(): boolean {
    return this.result !== null || this.currentState.winner !== null;
  }

  get outcome(): MatchResultRecord | null {
    return this.result;
  }

  get timeoutMs(): number {
    return this.actionTimeoutMs;
  }

  get reconnectWindowSeconds(): number {
    return this.reconnectSeconds;
  }

  getSeat(playerId: string): PlayerId | undefined {
    return this.seats.get(playerId)?.seat;
  }

  getPlayerId(seat: PlayerId): string | undefined {
    return this.bySeat[seat]?.playerId;
  }

  /** 分配固定座位。已有 identity 只能走 markReconnected，普通 join 绝不接管。 */
  join(playerId: string, client: TransportClient): PlayerId {
    const existing = this.seats.get(playerId);
    if (existing !== undefined) {
      throw new Error(
        existing.connected ? "playerId already connected" : "playerId requires reconnection proof",
      );
    }
    const seat = this.bySeat[0] === null ? 0 : this.bySeat[1] === null ? 1 : null;
    if (seat === null) {
      throw new Error("match room is full");
    }
    const record: Seat = { playerId, seat, client, connected: true };
    this.seats.set(playerId, record);
    this.bySeat[seat] = record;
    this.sendSeat(record);
    this.sendSnapshot(record);
    this.armActionTimer();
    return seat;
  }

  markDisconnected(playerId: string): void {
    const seat = this.seats.get(playerId);
    if (seat === undefined) {
      return;
    }
    seat.connected = false;
    seat.client = null;
    this.cancelActionTimer();
  }

  markReconnected(playerId: string, client: TransportClient): void {
    const seat = this.seats.get(playerId);
    if (seat === undefined) {
      throw new Error("unknown playerId for reconnection");
    }
    seat.connected = true;
    seat.client = client;
    this.sendSnapshot(seat);
    this.armActionTimer();
  }

  resync(playerId: string): void {
    const seat = this.seats.get(playerId);
    if (seat?.connected) {
      this.sendSnapshot(seat);
    }
  }

  /** 断线窗口耗尽：走同一条 concede/apply 路径，不直接篡改 GameState。 */
  disconnectTimeout(playerId: string): void {
    const seat = this.seats.get(playerId);
    if (seat === undefined || seat.connected || this.over) {
      return;
    }
    this.forfeit(seat.seat, "disconnect_timeout");
  }

  /** 主动离开也走引擎的 concede，而不是在协议层直接改 winner。 */
  forfeitPlayer(playerId: string, reason: EndReason = "concede"): void {
    const seat = this.seats.get(playerId);
    if (seat === undefined || this.over) {
      return;
    }
    this.forfeit(seat.seat, reason);
  }

  receive(playerId: string, wire: unknown): void {
    const seat = this.seats.get(playerId);
    if (seat === undefined || !seat.connected || this.over) {
      return;
    }
    if (!isRecord(wire) || wire.version !== 1) {
      this.send(seat, illegalMessage(this.currentState.seq, "protocol_mismatch"));
      return;
    }
    if (!integer(wire.seq) || wire.seq !== this.currentState.seq) {
      this.send(seat, illegalMessage(this.currentState.seq, "stale_seq"));
      return;
    }
    if (this.isPaused() && wire.t !== "concede") {
      this.send(seat, illegalMessage(this.currentState.seq, "match_paused"));
      return;
    }
    if (!isClientIntentShape(wire)) {
      this.send(seat, illegalMessage(this.currentState.seq, "unknown_intent"));
      return;
    }
    const bound = bindClientIntent(wire, seat.seat, this.currentState);
    if (bound === null) {
      this.send(seat, illegalMessage(this.currentState.seq, "unknown_intent"));
      return;
    }
    if (bound.t === "mulligan") {
      this.aggregateMulligan(seat, bound.toss[seat.seat] ?? []);
      return;
    }
    if (bound.t === "deploy") {
      this.aggregateDeploy(seat, bound.picks[seat.seat] ?? []);
      return;
    }
    this.applyIntent(bound, seat.seat, bound.t === "concede" ? "concede" : undefined);
  }

  timeoutAction(): void {
    if (this.over || this.isPaused()) {
      return;
    }
    if (this.currentState.pendingInput !== null) {
      const player = this.currentState.pendingInput.player;
      this.applyIntent(
        { t: "respond", player, chosen: defaultInputChoice(this.currentState.pendingInput) },
        player,
        "timeout",
      );
      return;
    }
    if (this.currentState.phase === "mulligan") {
      for (const player of [0, 1] as const) {
        if (!this.pendingMulligans.has(player)) this.pendingMulligans.set(player, []);
      }
      this.flushMulligans(0);
      return;
    }
    if (this.currentState.phase === "deploy") {
      for (const player of [0, 1] as const) {
        if (!this.pendingDeploys.has(player)) {
          this.pendingDeploys.set(player, this.defaultDeployPicks(player));
        }
      }
      this.flushDeploys(0);
      return;
    }
    if (this.currentState.phase === "actions") {
      this.applyIntent(
        { t: "pass", player: this.currentState.priority },
        this.currentState.priority,
        "timeout",
      );
    }
  }

  private aggregateMulligan(seat: Seat, toss: readonly EntityId[]): void {
    if (this.currentState.phase !== "mulligan") {
      this.send(seat, illegalMessage(this.currentState.seq, "wrong_phase"));
      return;
    }
    const invalid = this.validateMulliganForSeat(seat.seat, toss);
    if (invalid !== null) {
      this.send(seat, illegalMessage(this.currentState.seq, invalid));
      return;
    }
    this.pendingMulligans.set(seat.seat, [...toss]);
    this.flushMulligans(seat.seat);
  }

  private flushMulligans(submittingSeat: PlayerId): void {
    if (!this.pendingMulligans.has(0) || !this.pendingMulligans.has(1)) return;
    const intent: Intent = {
      t: "mulligan",
      player: submittingSeat,
      toss: [this.pendingMulligans.get(0) ?? [], this.pendingMulligans.get(1) ?? []],
    };
    this.pendingMulligans.clear();
    this.applyIntent(intent, submittingSeat);
  }

  private aggregateDeploy(
    seat: Seat,
    picksForSeat: readonly { readonly hero: EntityId; readonly slot: number }[],
  ): void {
    if (this.currentState.phase !== "deploy") {
      this.send(seat, illegalMessage(this.currentState.seq, "wrong_phase"));
      return;
    }
    const invalid = this.validateDeployForSeat(seat.seat, picksForSeat);
    if (invalid !== null) {
      this.send(seat, illegalMessage(this.currentState.seq, invalid));
      return;
    }
    // Store a copy so a caller cannot mutate a choice while the opponent is deciding.
    this.pendingDeploys.set(
      seat.seat,
      picksForSeat.map((pick) => ({ ...pick })),
    );
    this.flushDeploys(seat.seat);
  }

  private flushDeploys(submittingSeat: PlayerId): void {
    if (!this.pendingDeploys.has(0) || !this.pendingDeploys.has(1)) return;
    const intent: Intent = {
      t: "deploy",
      player: submittingSeat,
      picks: [this.pendingDeploys.get(0) ?? [], this.pendingDeploys.get(1) ?? []],
    };
    this.pendingDeploys.clear();
    this.applyIntent(intent, submittingSeat);
  }

  private applyIntent(intent: Intent, submittingSeat: PlayerId, forcedReason?: EndReason): void {
    let result: ReturnType<typeof apply>;
    try {
      result = this.applyGame(this.currentState, intent, this.deps);
    } catch (error) {
      if (error instanceof ResolutionLoopError) {
        // 结算环是数据/引擎故障，不把无辜玩家判负；作废这局并保留入参快照。
        this.finish("engine_fault", null);
        return;
      }
      throw error;
    }
    if (!result.ok) {
      this.send(this.bySeat[submittingSeat], illegalMessage(this.currentState.seq, result.code));
      return;
    }
    // 非法意图不得刷新当前 action 的截止时间；只有权威状态真正前进后才换计时器。
    this.cancelActionTimer();
    this.currentState = result.state;
    this.broadcastEvents(result.events);
    for (const seat of this.bySeat) {
      if (seat?.connected) {
        this.sendSnapshot(seat);
      }
    }
    if (this.currentState.winner !== null) {
      this.finish(forcedReason ?? "base_destroyed", this.currentState.winner);
      return;
    }
    this.armActionTimer();
  }

  private forfeit(seat: PlayerId, reason: EndReason): void {
    if (this.over) {
      return;
    }
    this.applyIntent({ t: "concede", player: seat }, seat, reason);
  }

  private finish(reason: EndReason, winner: PlayerId | "draw" | null): void {
    if (this.result !== null) {
      return;
    }
    this.cancelActionTimer();
    this.result = {
      ...(this.roomId === undefined ? {} : { roomId: this.roomId }),
      seed: this.seed,
      winner,
      reason,
      seq: this.currentState.seq,
      state: this.currentState,
    };
    const message: OverMsg = {
      t: "over",
      version: 1,
      seq: this.currentState.seq,
      winner: winner === "draw" ? null : winner,
      reason,
    };
    for (const seat of this.bySeat) {
      this.send(seat, message);
    }
    const persist = this.persistResult;
    if (persist !== undefined) {
      void Promise.resolve(persist(this.result)).catch(() => {
        // Persistence is best effort and must never block room disposal.
      });
    }
  }

  private sendSeat(seat: Seat): void {
    const message: ServerMsg = {
      t: "seat",
      version: 1,
      seq: this.currentState.seq,
      playerId: seat.playerId,
      seat: seat.seat,
    };
    this.send(seat, message);
  }

  private sendSnapshot(seat: Seat): void {
    const view = project(this.currentState, seat.seat);
    const message: SnapshotMsg = {
      t: "snapshot",
      version: 1,
      seq: this.currentState.seq,
      playerId: seat.playerId,
      view,
      legal: legalActions(this.currentState, seat.seat, this.deps),
    };
    this.send(seat, message);
    if (this.currentState.pendingInput?.player === seat.seat) {
      this.sendPrompt(seat.seat);
    }
  }

  private sendPrompt(player: PlayerId): void {
    const seat = this.bySeat[player];
    const request = project(this.currentState, player).pendingInput;
    if (seat === null || request === null || request === undefined) {
      return;
    }
    this.send(seat, {
      t: "prompt",
      version: 1,
      seq: this.currentState.seq,
      request,
    });
  }

  private broadcastEvents(events: readonly GameEvent[]): void {
    for (const seat of this.bySeat) {
      if (seat === null || !seat.connected || seat.client === null) {
        continue;
      }
      const projected = events
        .map((event) => projectEvent(this.currentState, event, seat.seat))
        .filter((event): event is NonNullable<typeof event> => event !== null);
      this.send(seat, {
        t: "events",
        version: 1,
        seq: this.currentState.seq,
        events: projected,
      });
    }
  }

  private send(seat: Seat | null | undefined, message: ServerMsg): void {
    if (seat?.connected && seat.client !== null) {
      seat.client.send(message);
    }
  }

  private isPaused(): boolean {
    return this.bySeat.some((seat) => seat !== null && !seat.connected);
  }

  private isReady(): boolean {
    return this.bySeat.every((seat) => seat?.connected === true);
  }

  private validateMulliganForSeat(
    player: PlayerId,
    toss: readonly EntityId[],
  ): IllegalReason | null {
    const hand = zoneKey(player, "hand");
    for (let index = 0; index < toss.length; index += 1) {
      const id = toss[index];
      if (id === undefined) continue;
      const card = getEntity(this.currentState, id);
      if (card === undefined) return "unknown_entity";
      if (card.zone !== hand) return "wrong_zone";
      if (toss.indexOf(id) !== index) return "invalid_choice";
    }
    return null;
  }

  private validateDeployForSeat(
    player: PlayerId,
    choices: readonly { readonly hero: EntityId; readonly slot: number }[],
  ): IllegalReason | null {
    if (choices.length !== deployCountFor(this.currentState, player)) return "invalid_choice";
    const fountain = zoneKey(player, "fountain");
    for (let index = 0; index < choices.length; index += 1) {
      const choice = choices[index];
      if (choice === undefined) continue;
      const hero = getEntity(this.currentState, choice.hero);
      if (hero === undefined) return "unknown_entity";
      if (
        hero.zone !== fountain ||
        hero.respawnAt === null ||
        hero.respawnAt > this.currentState.round
      ) {
        return "wrong_zone";
      }
      if (!isValidSlot(this.currentState, choice.slot)) return "invalid_slot";
      if (!isSlotEmpty(this.currentState, player, choice.slot)) return "slot_occupied";
      if (
        choices.findIndex(
          (other, earlier) =>
            earlier < index && (other.hero === choice.hero || other.slot === choice.slot),
        ) >= 0
      ) {
        return "slot_occupied";
      }
    }
    return null;
  }

  private defaultDeployPicks(player: PlayerId): readonly {
    readonly hero: EntityId;
    readonly slot: number;
  }[] {
    const heroes = this.currentState.zones[zoneKey(player, "fountain")].filter((id) => {
      const hero = getEntity(this.currentState, id);
      return (
        hero?.respawnAt !== null &&
        hero?.respawnAt !== undefined &&
        hero.respawnAt <= this.currentState.round
      );
    });
    const slots: number[] = [];
    for (let slot = 0; slot < this.currentState.rules.board.slots; slot += 1) {
      if (isSlotEmpty(this.currentState, player, slot)) slots.push(slot);
    }
    return heroes.slice(0, deployCountFor(this.currentState, player)).flatMap((hero, index) => {
      const slot = slots[index];
      return slot === undefined ? [] : [{ hero, slot }];
    });
  }

  private cancelActionTimer(): void {
    this.timerToken += 1;
    this.actionTimer?.handle.clear();
    this.actionTimer = null;
  }

  private armActionTimer(): void {
    this.cancelActionTimer();
    if (this.over || this.actionTimeoutMs <= 0 || this.isPaused() || !this.isReady()) {
      return;
    }
    if (
      this.currentState.pendingInput === null &&
      this.currentState.phase !== "actions" &&
      this.currentState.phase !== "mulligan" &&
      this.currentState.phase !== "deploy"
    ) {
      return;
    }
    const player = this.currentState.pendingInput?.player ?? this.currentState.priority;
    const seat = this.bySeat[player];
    if (seat === null || !seat.connected) {
      return;
    }
    const token = this.timerToken;
    const handle = this.schedule(this.actionTimeoutMs, () => {
      if (this.actionTimer?.token !== token) {
        return;
      }
      this.actionTimer = null;
      this.timeoutAction();
    });
    this.actionTimer = { token, handle };
  }
}

export function makeCardRegistry(
  cards: readonly Card[],
  enchantments: readonly Enchantment[] = [],
): MatchRoomCardRegistry {
  return { cards, enchantments };
}

/** 仅供服务端出口隐藏信息测试使用：消息必须由 project/projectEvent 产生。 */
export function snapshotFor(core: MatchRoomCore, playerId: string): SnapshotMsg | null {
  const seat = core.getSeat(playerId);
  if (seat === undefined) {
    return null;
  }
  const view = project(core.state, seat);
  return {
    t: "snapshot",
    version: 1,
    seq: core.state.seq,
    playerId,
    view,
    legal: legalActions(core.state, seat, core.deps),
  };
}
