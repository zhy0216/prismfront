// 每个事件名一个样本 + 纯数据检查器。两个测试文件共用。
//
// `RULE_EVENT_SAMPLES` 的类型注解是 `{ [N in EventName]: GameEventOf<N> }` ——
// 映射类型套在**对象字面量**上，于是 TS 强制「25 个名字一个不少、一个不多，
// 且每个键的值必须是同名的那个事件」。
// IR 加一个事件名 → 这里编译不过；键写错名字 → 这里编译不过。
// 运行时的 `expect(sample.name).toBe(key)` 只是把这条编译期约束顺手也测一遍。

import type { EventName } from "@prismfront/ir";
import type { EngineEvent, GameEvent, GameEventOf } from "../event.ts";

/** 样本里用到的实体 id。取值随意，只要彼此可区分。 */
const P0 = 1;
const P1 = 2;
const UNIT = 11;
const FOE = 21;
const CARD = 31;
const BASE = 41;

export const RULE_EVENT_SAMPLES: { readonly [N in EventName]: GameEventOf<N> } = {
  // 回合与资源
  round_began: { name: "round_began", round: 3 },
  round_ended: { name: "round_ended", round: 3 },
  crystal_gained: { name: "crystal_gained", player: P0, amount: 2 },
  // 行动阶段
  action_taken: { name: "action_taken", player: P0, kind: "play_card" },
  player_passed: { name: "player_passed", player: P1 },
  // 战斗阶段
  combat_began: { name: "combat_began", round: 3 },
  struck: { name: "struck", source: UNIT, target: FOE, amount: 4 },
  combat_ended: { name: "combat_ended", round: 3 },
  // 牌
  card_played: { name: "card_played", player: P0, target: CARD, cardId: "GRID_001" },
  card_drawn: { name: "card_drawn", player: P0, target: CARD, cardId: "GRID_002" },
  card_discarded: { name: "card_discarded", player: P1, target: CARD, cardId: "GRID_003" },
  card_added_to_hand: {
    name: "card_added_to_hand",
    player: P1,
    target: CARD,
    cardId: "GRID_004",
  },
  // 场面
  unit_summoned: {
    name: "unit_summoned",
    player: P0,
    source: null,
    target: UNIT,
    cardId: "GRID_001",
    slot: 4,
  },
  unit_died: { name: "unit_died", target: FOE, slot: 4 },
  unit_moved: { name: "unit_moved", target: UNIT, fromSlot: 4, toSlot: 5 },
  direction_changed: { name: "direction_changed", target: UNIT, from: 0, to: -1 },
  // 效果
  damaged: { name: "damaged", source: UNIT, target: BASE, amount: 4 },
  healed: { name: "healed", source: null, target: UNIT, amount: 2 },
  buffed: { name: "buffed", source: UNIT, target: UNIT, ench: "GRID_001e" },
  silenced: { name: "silenced", source: null, target: FOE },
  transformed: {
    name: "transformed",
    target: UNIT,
    fromCardId: "GRID_001",
    toCardId: "GRID_009",
  },
  // 英雄（v2.1 §11.3）
  hero_deployed: {
    name: "hero_deployed",
    player: P0,
    target: UNIT,
    cardId: "HERO_R01",
    slot: 0,
  },
  hero_died: { name: "hero_died", target: UNIT, slot: 0, respawnAt: 5 },
  // 保留
  secret_revealed: { name: "secret_revealed", player: P1, target: CARD, cardId: "GRID_010" },
  hero_power_used: { name: "hero_power_used", player: P0, source: UNIT, target: null },
};

export const ENGINE_EVENT_SAMPLES: readonly EngineEvent[] = [
  { name: "engine.random_picked", origin: "sel.random", max: 5, result: 3 },
  { name: "engine.random_picked", origin: "shuffle", max: 30, result: 0 },
];

/** 25 个规则事件 + 引擎事件，顺序稳定（键的声明序）。 */
export const ALL_SAMPLES: readonly GameEvent[] = [
  ...Object.values(RULE_EVENT_SAMPLES),
  ...ENGINE_EVENT_SAMPLES,
];

/**
 * 找出所有**不能 JSON 往返**的值，返回它们的路径描述。
 *
 * 框架 §3.1 + §13 坑 3 的探针：不许函数 / class 实例 / Map / Set / Symbol，
 * 外加两个同样过不了 JSON 的东西——`undefined`（`JSON.stringify` 会**丢键**）
 * 与非有限数（`NaN` / `Infinity` 会变成 `null`）。
 *
 * 判定 class 实例不用 `instanceof`：engine 的 biome 禁了 `Date` 等全局
 * （架构 §6.1），而「原型不是 `Object.prototype`」这一条本来就更严更全——
 * Date / Map / Set / 自定义 class 全都被它逮到。
 */
export function findImpurities(value: unknown, path = "$"): string[] {
  const found: string[] = [];
  const type = typeof value;

  if (value === null || type === "string" || type === "boolean") return found;
  if (type === "number") {
    if (!Number.isFinite(value)) found.push(`${path}: 非有限数`);
    return found;
  }
  if (type !== "object") {
    found.push(`${path}: ${type}`);
    return found;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      found.push(...findImpurities(item, `${path}[${index}]`));
    }
    return found;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    found.push(`${path}: 非纯对象（class 实例 / Map / Set / Date …）`);
    return found;
  }
  for (const [key, item] of Object.entries(value as object)) {
    found.push(...findImpurities(item, `${path}.${key}`));
  }
  return found;
}
