// 建局：createInitialState。
// 来源：框架 §3.1（状态形状）、DSL v2 §4.1（回合状态机的起点）、
//       DSL v2.1 §11.1/§11.2/§11.3（卡组外 3 张英雄、base、复燃泉）。
//
// 本函数**不消耗 RNG、不读时间、不认识任何具体卡**：
// 它只是把「双方的牌库列表」摊成实体表 + 区域表 + 空战线。
// 洗牌、发起始手牌、第一个 round_start 的水晶与抽牌，全部是回合状态机（M3）的事 ——
// 那些都要推进 `state.rng`，混进建局会让「同 seed 同意图序列 ⇒ 同终局」难以推理。

import type { BundleId, CardId, EntityId, RulesConfig, ZoneName } from "@prismfront/ir";
import { createEventLog } from "../events/index.ts";
import type { RngState } from "../rng/index.ts";
import type { EntityData, TagValues } from "./entity.ts";
import { BASE_CARD_ID, createTagValues, NO_FLAGS } from "./entity.ts";
import type { GameState } from "./game-state.ts";
import type { PlayerId } from "./player.ts";
import { PLAYER_IDS } from "./player.ts";
import type { ZoneKey } from "./zone.ts";
import { createEmptyZones, zoneKey } from "./zone.ts";

/** 第一个实体 id。从 1 起，于是 0 可以当「没有实体」的哨兵值用。 */
export const FIRST_ENTITY_ID = 1;

/** 第一个上场序号。 */
export const FIRST_PLAY_ORDER = 1;

/** 第一个回合的编号（v2 §4.1：`crystalCap = min(5 + (round-1) * growth, capMax)` 从 round=1 起算）。 */
export const FIRST_ROUND = 1;

/** {@link createInitialState} 的入参。 */
export interface CreateInitialStateOptions {
  /** 本局规则（DSL v2 §6）。调用方可用 ir 的 `DEFAULT_RULES_CONFIG`。 */
  rules: RulesConfig;
  /** 初始随机状态。由 `../rng` 的 `createRngState(seed)` 产出（框架 §4.3）。 */
  rng: RngState;
  /**
   * 双方牌库，**按已洗好的顺序**，下标 0 = 牌堆顶。
   *
   * 建局不洗牌：洗牌要推进 RNG，属于 M3 的 round_start / `createGame`。
   * 这里只负责把卡 id 列表变成实体。
   */
  decks: readonly [readonly CardId[], readonly CardId[]];
  /**
   * 卡组外的英雄卡（v2.1 §11.1：3 名互不相同的英雄 + 30 张卡组，
   * 30 张只能来自这 3 名英雄的专属卡池）。卡组构成的合法性由 lint / 建局前校验负责，
   * engine 只收已经合法的 id 列表。
   *
   * 落在 `fountain`（复燃泉）区，`respawnAt = 1` ⇒ 从 r1 起可在 deploy 阶段部署。
   * 「一回合部署几名」由 `rules.heroes.deploySchedule` 决定（M6 实现）。
   */
  heroes?: readonly [readonly CardId[], readonly CardId[]];
  /** 本局钉住的 bundle 标识（IR v1 §2.1 / §6.2）。M2 无卡表，默认空串。 */
  bundleId?: BundleId;
  /** 先手方。同时初始化 `priority` 与 `initiative`，默认 p0。 */
  firstPlayer?: PlayerId;
}

/** 建实体时的可选初值。 */
interface EntityInit {
  tags?: Partial<TagValues>;
  respawnAt?: number | null;
}

/**
 * 建一局的初始状态。
 *
 * 产出：
 * - 每方一个 **base 实体**（`tags.health = rules.baseHp`，v2.1 §11.2），在 `p{n}:base` 区；
 * - 每方的牌库实体，按传入顺序排在 `p{n}:deck`；
 * - 每方的英雄实体，在 `p{n}:fountain`，`respawnAt = 1`；
 * - 两行空战线，长度 `rules.board.slots`；
 * - `phase = "mulligan"`、`round = 0`、空栈、无挂起点、空事件日志。
 *
 * 实体 id 的分配顺序是**写死的**（p0 base → p1 base → p0 牌库 → p1 牌库 →
 * p0 英雄 → p1 英雄），因为 id 会进回放；换了顺序，历史回放就对不上。
 */
export function createInitialState(options: CreateInitialStateOptions): GameState {
  const { rules, rng, decks } = options;
  const firstPlayer: PlayerId = options.firstPlayer ?? 0;

  const entities: Record<EntityId, EntityData> = {};
  const zones: Record<ZoneKey, EntityId[]> = createEmptyZones();
  let nextEntityId = FIRST_ENTITY_ID;
  let nextPlayOrder = FIRST_PLAY_ORDER;

  const addEntity = (
    cardId: CardId,
    owner: PlayerId,
    zone: ZoneName,
    init: EntityInit,
  ): EntityData => {
    const id = nextEntityId;
    nextEntityId += 1;
    const key = zoneKey(owner, zone);
    // 只有「在场」的实体需要上场序号（框架 §4.1 时序规则 1 按它排触发）；
    // 牌库/手牌里的实体统一为 0，等真正上场时再从 state.nextPlayOrder 取号。
    const inPlay = zone === "board" || zone === "base";
    const playOrder = inPlay ? nextPlayOrder : 0;
    if (inPlay) {
      nextPlayOrder += 1;
    }
    const entity: EntityData = {
      id,
      cardId,
      owner,
      zone: key,
      slot: null,
      playOrder,
      base: createTagValues(init.tags),
      tags: createTagValues(init.tags),
      baseFlags: NO_FLAGS,
      flags: NO_FLAGS,
      enchantments: [],
      damage: 0,
      respawnAt: init.respawnAt ?? null,
    };
    entities[id] = entity;
    zones[key].push(id);
    return entity;
  };

  const baseIds: [EntityId, EntityId] = [0, 0];
  for (const player of PLAYER_IDS) {
    baseIds[player] = addEntity(BASE_CARD_ID, player, "base", {
      tags: { health: rules.baseHp },
    }).id;
  }
  for (const player of PLAYER_IDS) {
    for (const cardId of player === 0 ? decks[0] : decks[1]) {
      addEntity(cardId, player, "deck", {});
    }
  }
  const heroes = options.heroes;
  if (heroes !== undefined) {
    for (const player of PLAYER_IDS) {
      for (const cardId of player === 0 ? heroes[0] : heroes[1]) {
        addEntity(cardId, player, "fountain", { respawnAt: FIRST_ROUND });
      }
    }
  }

  return {
    bundleId: options.bundleId ?? "",
    rules,
    seq: 0,
    rng,
    round: 0,
    phase: "mulligan",
    priority: firstPlayer,
    initiative: firstPlayer,
    firstPasser: null,
    consecutivePasses: 0,
    players: [
      { crystals: 0, crystalCap: 0, baseId: baseIds[0], fatigue: 0 },
      { crystals: 0, crystalCap: 0, baseId: baseIds[1], fatigue: 0 },
    ],
    entities,
    zones,
    slots: [createEmptySlots(rules.board.slots), createEmptySlots(rules.board.slots)],
    stack: [],
    pendingInput: null,
    eventLog: createEventLog(),
    winner: null,
    nextEntityId,
    nextPlayOrder,
  };
}

/** 建一行长度为 `slots` 的空战线。 */
export function createEmptySlots(slots: number): (EntityId | null)[] {
  const row: (EntityId | null)[] = [];
  for (let i = 0; i < slots; i += 1) {
    row.push(null);
  }
  return row;
}
