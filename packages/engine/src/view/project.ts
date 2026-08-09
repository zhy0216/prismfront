// 视图投影 —— 把引擎的完整真相裁成一个座位可见的快照/事件流。
//
// 来源：框架设计 §6 / Prismfront 架构 §6.2。
// 关键安全性质：
//   - 手牌保留实体 id，但对手只能看到 `cardId: null`；
//   - 牌库不下发任何实体 id（包括自己的牌库），只下发数量；
//   - 对手的奥秘同样只保留 id + 空 cardId；
//   - RNG、结算栈、事件日志和下一个 id 计数器不属于客户端视图。
//
// 投影层只做白名单式的视图构造，不改入参，也不依赖卡表/脚本。

import type { CardId, EntityId } from "@prismfront/ir";
import type { GameEvent } from "../events/index.ts";
import type { EntityData, GameState, PlayerId } from "../state/index.ts";
import { getEntity, parseZoneKey } from "../state/index.ts";
import type { InputRequest } from "../state/input.ts";
import type { ZoneKey } from "../state/zone.ts";

/** 可见实体：公开区域的实体与完整实体字段保持同形。 */
export type VisibleEntity = EntityData;

/** 隐藏实体：id 是动画/协议身份，卡面身份被刻意抹掉。 */
export interface HiddenEntity {
  readonly id: EntityId;
  readonly cardId: null;
}

export type ProjectedEntity = VisibleEntity | HiddenEntity;

/** 投影后的挂起请求。非当前玩家的卡牌候选项会被逐项抹掉，但数量仍保留。 */
export interface ProjectedInputRequest extends Omit<InputRequest, "options"> {
  readonly options: readonly (EntityId | CardId | null)[];
}

/**
 * 发给一个座位的完整快照。
 *
 * 这是一个客户端协议形状，不是 `GameState` 的子类型：`rng`、`stack`、`eventLog`
 * 与内部计数器有意不在这里出现；牌库区域也被替换成空数组并配套 `zoneCounts`。
 */
export interface PlayerView {
  readonly bundleId: GameState["bundleId"];
  readonly rules: GameState["rules"];
  readonly seq: number;
  readonly round: number;
  readonly phase: GameState["phase"];
  readonly priority: PlayerId;
  readonly initiative: PlayerId;
  readonly firstPasser: PlayerId | null;
  readonly consecutivePasses: number;
  readonly players: GameState["players"];
  readonly entities: Record<EntityId, ProjectedEntity>;
  readonly zones: Record<ZoneKey, readonly EntityId[]>;
  readonly zoneCounts: Record<ZoneKey, number>;
  readonly slots: GameState["slots"];
  readonly pendingInput: ProjectedInputRequest | null;
  readonly winner: GameState["winner"];
}

function isHiddenZone(zone: ZoneKey, viewer: PlayerId): boolean {
  const parts = parseZoneKey(zone);
  // A player's own hand is visible; the opponent's hand and secrets are not.
  return (
    (parts.zone === "hand" && parts.player !== viewer) ||
    (parts.zone === "secret" && parts.player !== viewer) ||
    parts.zone === "deck"
  );
}

function isDeckZone(zone: ZoneKey): boolean {
  return parseZoneKey(zone).zone === "deck";
}

function visibleEntity(entity: EntityData, viewer: PlayerId): ProjectedEntity {
  if (isHiddenZone(entity.zone, viewer)) {
    return { id: entity.id, cardId: null };
  }
  // Keep the returned PlayerView independent from the authoritative state.
  return JSON.parse(JSON.stringify(entity)) as EntityData;
}

function projectInput(input: InputRequest | null, viewer: PlayerId): ProjectedInputRequest | null {
  if (input === null) {
    return null;
  }
  return {
    player: input.player,
    kind: input.kind,
    options:
      input.player === viewer
        ? [...input.options]
        : input.options.map((option) => (typeof option === "number" ? option : null)),
    optional: input.optional,
    deadline: input.deadline,
  };
}

/**
 * 按座位投影一个状态。返回的新对象与输入完全独立，调用方可以安全缓存/序列化。
 */
export function project(state: GameState, viewer: PlayerId): PlayerView {
  const entities: Record<EntityId, ProjectedEntity> = {};
  const zones = {} as Record<ZoneKey, readonly EntityId[]>;
  const zoneCounts = {} as Record<ZoneKey, number>;

  for (const key of Object.keys(state.zones) as ZoneKey[]) {
    const ids = state.zones[key];
    zoneCounts[key] = ids.length;
    // Deck order is hidden from everyone, including its owner.  Returning no ids
    // also prevents an id -> card table join from revealing future draws.
    zones[key] = isDeckZone(key) ? [] : [...ids];
  }

  // Deliberately iterate the entity table, not the zones: this gives every
  // visible in-play entity a copy while deck entities never cross the wire.
  for (const entity of Object.values(state.entities)) {
    if (isDeckZone(entity.zone)) {
      continue;
    }
    entities[entity.id] = visibleEntity(entity, viewer);
  }

  return {
    bundleId: state.bundleId,
    rules: JSON.parse(JSON.stringify(state.rules)) as GameState["rules"],
    seq: state.seq,
    round: state.round,
    phase: state.phase,
    priority: state.priority,
    initiative: state.initiative,
    firstPasser: state.firstPasser,
    consecutivePasses: state.consecutivePasses,
    players: JSON.parse(JSON.stringify(state.players)) as GameState["players"],
    entities,
    zones,
    zoneCounts,
    slots: JSON.parse(JSON.stringify(state.slots)) as GameState["slots"],
    pendingInput: projectInput(state.pendingInput, viewer),
    winner: state.winner,
  };
}

type NullableCardFields<E> = E extends { readonly cardId: infer Id }
  ? Omit<E, "cardId"> & { readonly cardId: Id | null }
  : E extends { readonly fromCardId: infer From; readonly toCardId: infer To }
    ? Omit<E, "fromCardId" | "toCardId"> & {
        readonly fromCardId: From | null;
        readonly toCardId: To | null;
      }
    : E;

/** 事件投影后的客户端事件联合。牌面字段允许在隐藏事件中变为 null。 */
export type ClientEvent = NullableCardFields<GameEvent>;

function entityIsVisibleTo(state: GameState, id: EntityId, viewer: PlayerId): boolean {
  const entity = getEntity(state, id);
  return entity !== undefined && !isHiddenZone(entity.zone, viewer);
}

function playerForEntity(state: GameState, id: EntityId): PlayerId | null {
  if (state.players[0].baseId === id) {
    return 0;
  }
  if (state.players[1].baseId === id) {
    return 1;
  }
  const entity = getEntity(state, id);
  if (entity === undefined) {
    return null;
  }
  return parseZoneKey(entity.zone).player;
}

function eventCardIsVisible(state: GameState, event: GameEvent, viewer: PlayerId): boolean {
  // These events are the reveal boundary: once a card is played, summoned,
  // deployed, or a secret is revealed, every seat must receive its identity.
  if (
    event.name === "card_played" ||
    event.name === "unit_summoned" ||
    event.name === "hero_deployed" ||
    event.name === "secret_revealed"
  ) {
    return true;
  }
  if (event.name === "card_drawn" || event.name === "card_added_to_hand") {
    // The drawing/receiving player sees their own card even when callers pass
    // the pre-event state (where the card is still in the hidden deck).
    return playerForEntity(state, event.player) === viewer;
  }
  if (event.name === "transformed") {
    return entityIsVisibleTo(state, event.target, viewer);
  }
  if (!("cardId" in event)) {
    return true;
  }
  return entityIsVisibleTo(state, event.target, viewer);
}

/**
 * 投影一个事件。隐藏区里的 cardId 被替换成 null，但事件本身不丢弃：
 * 客户端仍需要稳定 target id 播放「抽牌→飞入手牌」等动画。
 */
export function projectEvent(
  state: GameState,
  event: GameEvent,
  viewer: PlayerId,
): ClientEvent | null {
  if (eventCardIsVisible(state, event, viewer)) {
    return { ...event } as ClientEvent;
  }

  if (event.name === "transformed") {
    return { ...event, fromCardId: null, toCardId: null } as ClientEvent;
  }
  if ("cardId" in event) {
    return { ...event, cardId: null } as ClientEvent;
  }
  return { ...event } as ClientEvent;
}
