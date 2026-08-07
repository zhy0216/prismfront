// IR 节点 → 编写层名字的对照表。**反编译器的词汇表**。
//
// 每张表都用 `satisfies Record<XxxOp | XxxName, string>` 与权威类型**双向钉死**：
// v2 §5 的事件表加一行、`GlobalTag` 加一个取值而这里漏写 → 缺少属性，编译不过。
// 这是 `ir:print` 不会悄悄漏掉新 op 的第一道保险（第二道是 print-node.ts 里
// switch 的穷尽检查）。
//
// ── 还原策略（printer 全局适用，三档，越界的一律不还原）────────────────────
//
// 1. **具名常量整表还原**：`SELF` / `FRIENDLY_MINIONS` / `ENEMY_BASE` / `ROUND` /
//    `EVENT.source` / `FRIENDLY`。它们与一棵**完全确定**的节点树一一对应
//    （IR §3.1 的"TS 常量 → IR"对照表、v2.1 §11.2 的词汇分化就是这张表本身），
//    还原不可能有歧义，而可读性收益最大。
// 2. **标量字段决定的别名还原**：`Push` / `Pull`（`act.shift.delta` 的正负字面量）、
//    `Direction` / `SetDirection` / `ModDirection`（`tag === "direction"`）、
//    `IsMinion` / `IsSpell` / `IsHero` / `IsToken`（`cond.is_kind.kind` 单值）。
//    别名由**单个节点的一个标量字段**唯一决定，是可逆重命名。
// 3. **结构改写型的糖不还原**：`Any(of, cond)` = `Exists(Where(of, cond))`、
//    `All` = `Not(Exists(Where(of, Not(c))))`、`AddToHand(p, sel)` = `Give(p, CardOf(sel))`。
//    这类糖会**多造出节点**，还原它等于做子树模式匹配 —— 漏匹配与错匹配都不易察觉，
//    而 `Exists(X.where(C))`、`Give(CONTROLLER, CardOf(CHOSEN))` 本身已经读得懂。
//    同理，**摊平型链式方法**（`.and()` / `.or()` / `.plus()` / `.times()`）也不还原：
//    `{op:"cond.and", of:[a,b,c]}` 无从知道原文是连写还是变参，一律打成
//    `And(a, b, c)`。非摊平的 1:1 链式方法（`.where()` / `.not()` / `.negate()` /
//    `.random()` / `.limit()` / `.sort()` / `.opposite()` / `.shift()` / `.gte()`）照常还原。

import type {
  CardKind,
  EventEntityField,
  EventName,
  GlobalTag,
  SelSide,
  SlotSide,
  ZoneName,
} from "../types/index.ts";

// ── 侧别 ────────────────────────────────────────────────────────────────────

/**
 * `side` 的具名常量（builder/constants.ts）。
 * {@link SlotSide} 是 {@link SelSide} 的子集（架构 §10 第 4 项），故一张表够用。
 */
export const SIDE_CONSTANTS = {
  friendly: "FRIENDLY",
  enemy: "ENEMY",
  both: "BOTH",
} as const satisfies Record<SelSide, string>;

/** `slot.*` / `sel.zone` 的 side → `FRIENDLY` / `ENEMY` / `BOTH`。 */
export function sideConstant(side: SelSide | SlotSide): string {
  return SIDE_CONSTANTS[side];
}

// ── 上下文叶子 ──────────────────────────────────────────────────────────────

/** `sel.*` 无参上下文叶子的具名常量。`sel.event` / `sel.entity` 带字段，另行处理。 */
export const SEL_LEAF_CONSTANTS = {
  "sel.self": "SELF",
  "sel.target": "TARGET",
  "sel.controller": "CONTROLLER",
  "sel.opponent": "OPPONENT",
  "sel.chosen": "CHOSEN",
  "sel.it": "IT",
} as const;

/** `sel.event.field` → `EVENT.source` / `EVENT.target` / `EVENT.player`（builder/sel.ts）。 */
export const EVENT_ENTITY_CONSTANTS = {
  source: "EVENT.source",
  target: "EVENT.target",
  player: "EVENT.player",
} as const satisfies Record<EventEntityField, string>;

/** `num.tag.tag` → `ROUND` / `CRYSTALS` / `CRYSTAL_CAP` / `FATIGUE`（builder/num.ts）。 */
export const GLOBAL_NUM_CONSTANTS = {
  round: "ROUND",
  crystals: "CRYSTALS",
  crystal_cap: "CRYSTAL_CAP",
  fatigue: "FATIGUE",
} as const satisfies Record<GlobalTag, string>;

// ── 区域常量（IR §3.1 的"TS 常量 → IR"对照表）───────────────────────────────

interface ZoneConstant {
  readonly name: string;
  readonly side: SelSide;
  readonly zone: ZoneName | readonly ZoneName[];
}

/**
 * `sel.zone` 的具名常量表，逐条对应 builder/constants.ts。
 *
 * 顺序即匹配优先级：`ALL_CHARACTERS` 排在前面，所以
 * `zone(both, ["board","base"])` 打成 `ALL_CHARACTERS` 而不是它的同义词 `ANY_CHARACTER`
 * （builder 里两者是同一个常量，IR §10.1 火球术用的是后者）。
 */
export const ZONE_CONSTANTS: readonly ZoneConstant[] = [
  { name: "FRIENDLY_UNITS", side: "friendly", zone: "board" },
  { name: "ENEMY_UNITS", side: "enemy", zone: "board" },
  { name: "ALL_UNITS", side: "both", zone: "board" },
  { name: "FRIENDLY_BASE", side: "friendly", zone: "base" },
  { name: "ENEMY_BASE", side: "enemy", zone: "base" },
  { name: "ALL_CHARACTERS", side: "both", zone: ["board", "base"] },
  { name: "FRIENDLY_HAND", side: "friendly", zone: "hand" },
  { name: "ENEMY_HAND", side: "enemy", zone: "hand" },
  { name: "FRIENDLY_DECK", side: "friendly", zone: "deck" },
  { name: "ENEMY_DECK", side: "enemy", zone: "deck" },
  { name: "FRIENDLY_GRAVEYARD", side: "friendly", zone: "graveyard" },
  { name: "ENEMY_GRAVEYARD", side: "enemy", zone: "graveyard" },
  { name: "FRIENDLY_FOUNTAIN", side: "friendly", zone: "fountain" },
];

function zonesEqual(a: ZoneName | readonly ZoneName[], b: ZoneName | readonly ZoneName[]): boolean {
  if (typeof a === "string" || typeof b === "string") {
    return a === b;
  }
  return a.length === b.length && a.every((zone, index) => zone === b[index]);
}

/** 查 `sel.zone` 对应的具名常量；没有就返回 `undefined`（调用方打 `Zone(side, zone)`）。 */
export function zoneConstantName(
  side: SelSide,
  zone: ZoneName | readonly ZoneName[],
): string | undefined {
  return ZONE_CONSTANTS.find((entry) => entry.side === side && zonesEqual(entry.zone, zone))?.name;
}

// ── 「board + is_kind」派生常量（v2.1 §11.2 的词汇分化）─────────────────────

interface BoardKindConstant {
  readonly name: string;
  readonly side: SelSide;
  readonly kind: CardKind;
}

/**
 * `zone(side,"board").where(is_kind(it, kind))` 的具名常量。
 *
 * v2.1 §11.2 起英雄占格参战，于是 `*_UNITS`（含英雄）与 `*_MINIONS`（排除英雄）分化，
 * 后者在 IR 里多一层 `sel.where`。不还原它的话，v2 §8.3 的 `target: ENEMY_MINIONS`
 * 会打成三层嵌套 —— 那正是"可读性由工具解决"要避免的东西。
 */
export const BOARD_KIND_CONSTANTS: readonly BoardKindConstant[] = [
  { name: "FRIENDLY_MINIONS", side: "friendly", kind: "minion" },
  { name: "ENEMY_MINIONS", side: "enemy", kind: "minion" },
  { name: "ALL_MINIONS", side: "both", kind: "minion" },
  { name: "FRIENDLY_HEROES", side: "friendly", kind: "hero" },
  { name: "ENEMY_HEROES", side: "enemy", kind: "hero" },
];

/** 查 `board + is_kind` 派生常量。 */
export function boardKindConstantName(side: SelSide, kind: CardKind): string | undefined {
  return BOARD_KIND_CONSTANTS.find((entry) => entry.side === side && entry.kind === kind)?.name;
}

// ── 种类谓词（IR §10.5 的 `IsSpell()`）──────────────────────────────────────

/**
 * `cond.is_kind` 单值时的谓词别名（builder/cond.ts）。
 * `weapon` / `hero_power` 是 v1 遗留取值，builder 没给谓词 —— 它们打成 `IsKind(of, "weapon")`。
 */
export const KIND_PREDICATE_NAMES: Partial<Record<CardKind, string>> = {
  minion: "IsMinion",
  spell: "IsSpell",
  hero: "IsHero",
  token: "IsToken",
};

// ── 事件助手（v2 §5 事件表 + v2.1 §11.3）────────────────────────────────────

/**
 * `trigger.on` → 事件助手名，逐行对应 builder/trigger.ts 的 `EVENT_HELPERS`。
 * `satisfies Record<EventName, string>` 把它与 {@link EventName} 双向钉死。
 */
export const EVENT_HELPER_NAMES = {
  round_began: "RoundBegan",
  round_ended: "RoundEnded",
  crystal_gained: "CrystalGained",
  action_taken: "ActionTaken",
  player_passed: "PlayerPassed",
  combat_began: "CombatBegan",
  struck: "Struck",
  combat_ended: "CombatEnded",
  card_played: "CardPlayed",
  card_drawn: "CardDrawn",
  card_discarded: "CardDiscarded",
  card_added_to_hand: "CardAddedToHand",
  unit_summoned: "UnitSummoned",
  unit_died: "UnitDied",
  unit_moved: "UnitMoved",
  direction_changed: "DirectionChanged",
  damaged: "Damaged",
  healed: "Healed",
  buffed: "Buffed",
  silenced: "Silenced",
  transformed: "Transformed",
  hero_deployed: "HeroDeployed",
  hero_died: "HeroDied",
  secret_revealed: "SecretRevealed",
  hero_power_used: "HeroPowerUsed",
} as const satisfies Record<EventName, string>;

/** 事件名 → 事件助手名。 */
export function eventHelperName(event: EventName): string {
  return EVENT_HELPER_NAMES[event];
}
