// 触发器的编写层构造器（IR §4.1、DSL v2 §5 事件表、v2.1 §11.3）。
//
// 写法（IR §10.2 / v2 §8.5 / §8.6）：
//   on(Healed(ALL_CHARACTERS), Buff(SELF, "CORE_020e"))
//   on(CombatBegan(),          Buff(FRIENDLY_MINIONS, "GRID_005e"))
//   on(Struck(SELF),           Hit(EVENT.source, 1))          // filter: target = SELF
//   on(Struck({ source: SELF }), Hit(Adjacent(EVENT.target), 1))  // v2 §8.7 Cleave
//
// 事件助手接受两种参数：
// - 一个 `Sel`  → 简写，等价于 `{ target: 那个 Sel }`（"这件事发生在谁身上"是最常见的过滤）
// - 一个过滤器  → `{ source?, target?, player? }`，要按出手者过滤时用它（Cleave / Siege）
//
// 需要 `cond` / `once` / `zone` 时用 {@link trigger} 的完整形式。

import type {
  Act,
  Cond,
  EventName,
  Sel,
  Trigger,
  TriggerFilter,
  ZoneName,
} from "../types/index.ts";
import { type ActLike, toActs } from "./act.ts";

/** 事件助手的产物：事件名 + 可选过滤器。它不是 IR 节点，只是 `on(...)` 的入参。 */
export interface EventSpec {
  on: EventName;
  filter?: TriggerFilter;
}

/** 事件助手的入参：选择器简写（→ `{target: sel}`）或完整过滤器。 */
export type EventScope = Sel | TriggerFilter;

function toFilter(scope: EventScope): TriggerFilter {
  return "op" in scope ? { target: scope } : scope;
}

/** 由事件名生成一个事件助手。`EVENT_SPECS` 用它把 v2 §5 的事件表逐行铺开。 */
function eventHelper(name: EventName): (scope?: EventScope) => EventSpec {
  return (scope) => {
    if (scope === undefined) {
      return { on: name };
    }
    return { on: name, filter: toFilter(scope) };
  };
}

// ── 事件助手：DSL v2 §5 事件表 + v2.1 §11.3，逐行对应 ───────────────────────

/** 回合开始（v1 的 `turn_began` 已改名）。 */
export const RoundBegan = eventHelper("round_began");
/** 回合结束。 */
export const RoundEnded = eventHelper("round_ended");
/** 获得水晶。 */
export const CrystalGained = eventHelper("crystal_gained");
/** 玩家执行了一个 action。 */
export const ActionTaken = eventHelper("action_taken");
/** 玩家 pass。 */
export const PlayerPassed = eventHelper("player_passed");
/** 战斗阶段开始。**先于战斗快照结算完毕**（v2 §4.2 第 1 步），v2 §8.5 战地号手靠的就是这个。 */
export const CombatBegan = eventHelper("combat_began");
/** 出手这件事（负载 `{source, target, amount}`）。战斗出手与 `Strike(...)` 都发它。 */
export const Struck = eventHelper("struck");
/** 战斗阶段结束。 */
export const CombatEnded = eventHelper("combat_ended");
/** 打出卡牌。 */
export const CardPlayed = eventHelper("card_played");
/** 抽到卡牌。 */
export const CardDrawn = eventHelper("card_drawn");
/** 弃牌。 */
export const CardDiscarded = eventHelper("card_discarded");
/** 卡牌进入手牌（生成，非抽牌）。 */
export const CardAddedToHand = eventHelper("card_added_to_hand");
/** 单位入场（v1 的 `minion_summoned` 已改名）。 */
export const UnitSummoned = eventHelper("unit_summoned");
/** 单位死亡（v1 的 `minion_died` 已改名）。英雄阵亡发 `hero_died`，不发这个。 */
export const UnitDied = eventHelper("unit_died");
/** 单位移动（负载 `{target, fromSlot, toSlot}`），move_to / shift / swap 都发。 */
export const UnitMoved = eventHelper("unit_moved");
/** 战斗方向改变。 */
export const DirectionChanged = eventHelper("direction_changed");
/** 伤害结果（打基地也是它，target 是基地实体）。 */
export const Damaged = eventHelper("damaged");
/** 治疗结果。IR §10.2 光明守护者：`on(Healed(ALL_CHARACTERS), ...)`。 */
export const Healed = eventHelper("healed");
/** 获得附魔。 */
export const Buffed = eventHelper("buffed");
/** 被沉默。 */
export const Silenced = eventHelper("silenced");
/** 被变形。 */
export const Transformed = eventHelper("transformed");
/** 英雄部署（v2.1 §11.3）。 */
export const HeroDeployed = eventHelper("hero_deployed");
/** 英雄阵亡（v2.1 §11.3）。**不发 `unit_died`**，触发器需明确区分。 */
export const HeroDied = eventHelper("hero_died");
/** 奥秘揭示（v1 遗留，PF1 无奥秘卡）。 */
export const SecretRevealed = eventHelper("secret_revealed");
/** 英雄技能使用（v1 遗留，玩法可能用不上）。 */
export const HeroPowerUsed = eventHelper("hero_power_used");

/**
 * 事件助手全表。`satisfies Record<EventName, ...>` 把它与 {@link EventName} **双向钉死**：
 * v2 §5 的事件表加了一行而这里漏写 → 缺少属性，编译不过。
 */
export const EVENT_HELPERS = {
  round_began: RoundBegan,
  round_ended: RoundEnded,
  crystal_gained: CrystalGained,
  action_taken: ActionTaken,
  player_passed: PlayerPassed,
  combat_began: CombatBegan,
  struck: Struck,
  combat_ended: CombatEnded,
  card_played: CardPlayed,
  card_drawn: CardDrawn,
  card_discarded: CardDiscarded,
  card_added_to_hand: CardAddedToHand,
  unit_summoned: UnitSummoned,
  unit_died: UnitDied,
  unit_moved: UnitMoved,
  direction_changed: DirectionChanged,
  damaged: Damaged,
  healed: Healed,
  buffed: Buffed,
  silenced: Silenced,
  transformed: Transformed,
  hero_deployed: HeroDeployed,
  hero_died: HeroDied,
  secret_revealed: SecretRevealed,
  hero_power_used: HeroPowerUsed,
} as const satisfies Record<EventName, (scope?: EventScope) => EventSpec>;

// ── 触发器本体 ──────────────────────────────────────────────────────────────

/** {@link trigger} 的完整入参。`do` 收单个动作或数组。 */
export interface TriggerSpec {
  on: EventName | EventSpec;
  filter?: TriggerFilter;
  cond?: Cond;
  once?: boolean;
  /** 本触发器在哪个区域生效。省略 → 规范形式补 `"board"`（IR §4.1 默认值）。 */
  zone?: ZoneName;
  do: ActLike;
}

/**
 * 完整形式的触发器构造器。字段顺序即规范键序：`on, filter, cond, once, zone, do`。
 *
 * `zone` 缺省时**写死 `"board"`** —— IR §10.2 的规范 JSON 就是这么产出的
 * （而 `cond` / `once` 缺省时不写）。手牌触发写 `"hand"`，亡语相关写 `"graveyard"`。
 */
export function trigger(spec: TriggerSpec): Trigger {
  const base: EventSpec = typeof spec.on === "string" ? { on: spec.on } : spec.on;
  const filter = spec.filter ?? base.filter;
  const node: { on: EventName; filter?: TriggerFilter; cond?: Cond; once?: boolean } = {
    on: base.on,
  };
  if (filter !== undefined) {
    node.filter = filter;
  }
  if (spec.cond !== undefined) {
    node.cond = spec.cond;
  }
  if (spec.once !== undefined) {
    node.once = spec.once;
  }
  const acts: readonly Act[] = toActs(spec.do);
  return { ...node, zone: spec.zone ?? "board", do: acts };
}

/**
 * `on(事件, 动作...)`（IR §10.2 / v2 §8.5 / §8.6 用的就是这个形式）。
 * 动作可以写多个，也可以直接给数组；等价于 `trigger({ on, do })`。
 */
export function on(event: EventName | EventSpec, ...acts: readonly ActLike[]): Trigger {
  return trigger({ on: event, do: acts.flatMap((a) => toActs(a)) });
}
