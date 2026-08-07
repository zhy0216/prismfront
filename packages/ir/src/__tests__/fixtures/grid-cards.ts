// 《格子战斗卡牌 DSL 规范 v2》§8 的六张示例卡 —— **M1 的验收夹具**。
//
// 每张卡两份东西：
//   1. `GRID_00X`      —— 用 builder 把文档里的 TS 源码**照抄**一遍（照抄程度见每张卡的注释）
//   2. `DOC_8_X_*`     —— 文档里手写的 JSON，**逐字符抄录**，并用 T1 的权威类型 `satisfies`
//                         过一遍（表达不出来即为类型层面的失败）
// 比对在 `../spec-cards.test.ts`：两边都过同一套 `canonicalize*`，再比 `JSON.stringify`。
//
// ── 照抄时不得不做的偏离（每一条都是文档自身的问题，不是为了迁就代码）──────────
//
// A. **`colors` 必填**（v2.1 §11.4 用 `data.colors` 取代了 v1 的 `data.faction`）。
//    §8 的源码写于 v2.1 之前，六张卡都没写颜色。这里按《红蓝绿卡牌数值基准》§1.2
//    机制归属表补上（推拉=蓝主/红副、换位=蓝主、伤害=红主、决斗与增益=绿主…），
//    补的是 `data` 段，**不影响任何一段被比对的 JSON**（文档给的都是 script/auras 段）。
//
// B. **文档 §8.2 与 §8.4 的源码有笔误**：`health = 3`、`cost = 1` 写成了赋值号，
//    在对象字面量里是语法错误。这里按显然的意图写成 `health: 3` / `cost: 1`。
//
// C. **§8.4-8.6 文档没有给 JSON**，只有 TS 源码。这三张的 `DOC_*` 常量是**按规范推导**
//    的期望值（依据在各自注释里逐条注明），测试里也如实标注为"推导"，不冒充文档原文。
//
// D. §8.1 的 JSON 片段外面套了 `{"script": {...}}`，§8.2 套了 `{"auras": [...]}`，
//    §8.3 直接是 `{"play": [...]}`。抄录时保留各自的层级，测试里说明比的是哪一段。

import {
  Aura,
  Buff,
  CHOSEN,
  CombatBegan,
  defineCard,
  defineEnchantment,
  ENEMY_MINIONS,
  EVENT,
  FRIENDLY_MINIONS,
  Hit,
  Not,
  Occupied,
  on,
  Push,
  SELF,
  SelectTarget,
  SlotOf,
  Struck,
  Swap,
  TARGET,
} from "../../builder/index.ts";
import type { Act, Aura as AuraNode, Card, Enchantment, Trigger } from "../../types/index.ts";

// ── 8.1 斜刺长枪兵 —— direction 即 Tag ──────────────────────────────────────

/**
 * v2 §8.1 原文：
 * ```ts
 * defineCard({
 *   id: "GRID_001", name: "斜刺长枪兵", kind: "minion", cost: 3, atk: 3, health: 2,
 *   text: "战吼：战斗方向变为斜左。",
 *   play: Buff(SELF, "GRID_001e"),
 * });
 * ```
 * 注意 `play` 写的是**单个动作**（没有中括号）—— 规范形式里必须是数组，这正是原则 1。
 */
export const GRID_001: Card = defineCard({
  id: "GRID_001",
  name: "斜刺长枪兵",
  kind: "minion",
  cost: 3,
  atk: 3,
  health: 2,
  colors: "red",
  text: "战吼：战斗方向变为斜左。",
  play: Buff(SELF, "GRID_001e"),
});

/** v2 §8.1：`defineEnchantment({ id: "GRID_001e", direction: -1 })`。沉默它 → 方向自动回 0。 */
export const GRID_001E: Enchantment = defineEnchantment({ id: "GRID_001e", direction: -1 });

/** v2 §8.1 的 JSON（原文只给了 `script.play` 这一段）。 */
export const DOC_8_1_SCRIPT_PLAY = [
  { op: "act.buff", target: { op: "sel.self" }, ench: "GRID_001e" },
] as const satisfies readonly Act[];

// ── 8.2 空袭猎手 —— 位置条件光环 ────────────────────────────────────────────

/**
 * v2 §8.2 原文（`health = 3` 系笔误，见偏离 B）：
 * ```ts
 * defineCard({
 *   id: "GRID_002", name: "空袭猎手", kind: "minion", cost: 2, atk: 2, health = 3,
 *   text: "对面格子没有单位时，攻击力 +2。",
 *   aura: Aura(SELF, { atk: +2 }, Not(Occupied(SlotOf(SELF).opposite()))),
 * });
 * ```
 */
export const GRID_002: Card = defineCard({
  id: "GRID_002",
  name: "空袭猎手",
  kind: "minion",
  cost: 2,
  atk: 2,
  health: 3,
  colors: "green",
  text: "对面格子没有单位时，攻击力 +2。",
  aura: Aura(SELF, { atk: 2 }, Not(Occupied(SlotOf(SELF).opposite()))),
});

/** v2 §8.2 的 JSON（原文给的是 `auras` 这一段）。 */
export const DOC_8_2_AURAS = [
  {
    affects: { op: "sel.self" },
    mods: { atk: 2 },
    cond: {
      op: "cond.not",
      of: {
        op: "cond.occupied",
        slot: { op: "slot.opposite", of: { op: "slot.of", of: { op: "sel.self" } } },
      },
    },
    zone: "board",
  },
] as const satisfies readonly AuraNode[];

// ── 8.3 裂地冲锋 —— 位移 + 伤害 ─────────────────────────────────────────────

/**
 * v2 §8.3 原文：
 * ```ts
 * defineCard({
 *   id: "GRID_003", name: "裂地冲锋", kind: "spell", cost: 2,
 *   text: "对一个敌方单位造成 2 点伤害，并将其推移一格。",
 *   target: ENEMY_MINIONS,
 *   play: [Hit(TARGET, 2), Push(TARGET, 1)],
 * });
 * ```
 * `target` 照抄成 `ENEMY_MINIONS`（v2.1 §11.2 之后它比 `ENEMY_UNITS` 多一层
 * `where(is_kind(it,"minion"))`）。文档给出的 JSON 只有 `play` 段，不受影响。
 */
export const GRID_003: Card = defineCard({
  id: "GRID_003",
  name: "裂地冲锋",
  kind: "spell",
  cost: 2,
  colors: "red",
  text: "对一个敌方单位造成 2 点伤害，并将其推移一格。",
  target: ENEMY_MINIONS,
  play: [Hit(TARGET, 2), Push(TARGET, 1)],
});

/** v2 §8.3 的 JSON（原文给的是 `play` 这一段）。 */
export const DOC_8_3_PLAY = [
  { op: "act.hit", target: { op: "sel.target" }, amount: 2 },
  { op: "act.shift", target: { op: "sel.target" }, delta: 1 },
] as const satisfies readonly Act[];

// ── 8.4 换位术 —— 双目标 = target + 挂起点 ──────────────────────────────────

/**
 * v2 §8.4 原文（`cost = 1` 系笔误，见偏离 B）：
 * ```ts
 * defineCard({
 *   id: "GRID_004", name: "换位术", kind: "spell", cost = 1,
 *   text: "选择两个友方单位，交换它们的位置。",
 *   target: FRIENDLY_MINIONS,
 *   play: [
 *     SelectTarget(FRIENDLY_MINIONS.not(TARGET)),   // 第二目标 → 挂起等输入 → CHOSEN
 *     Swap(TARGET, CHOSEN),
 *   ],
 * });
 * ```
 */
export const GRID_004: Card = defineCard({
  id: "GRID_004",
  name: "换位术",
  kind: "spell",
  cost: 1,
  colors: "blue",
  text: "选择两个友方单位，交换它们的位置。",
  target: FRIENDLY_MINIONS,
  play: [SelectTarget(FRIENDLY_MINIONS.not(TARGET)), Swap(TARGET, CHOSEN)],
});

/**
 * §8.4 **文档未给 JSON**，这是按规范推导的期望值（偏离 C）：
 * - `SelectTarget(from)` → `act.select_target`，`optional` 未给 → 不写（IR §3.4）
 * - `FRIENDLY_MINIONS.not(TARGET)` → `sel.minus{of: FRIENDLY_MINIONS, exclude: sel.target}`
 * - `FRIENDLY_MINIONS` → `sel.where(sel.zone(friendly,board), is_kind(it,"minion"))`（v2.1 §11.2）
 * - `Swap(a, b)` → `act.swap{a, b}`（v2 §7）
 */
export const DOC_8_4_PLAY = [
  {
    op: "act.select_target",
    from: {
      op: "sel.minus",
      of: {
        op: "sel.where",
        of: { op: "sel.zone", side: "friendly", zone: "board" },
        cond: { op: "cond.is_kind", of: { op: "sel.it" }, kind: "minion" },
      },
      exclude: { op: "sel.target" },
    },
  },
  { op: "act.swap", a: { op: "sel.target" }, b: { op: "sel.chosen" } },
] as const satisfies readonly Act[];

// ── 8.5 战地号手 —— 战斗阶段触发 + end_of_combat ────────────────────────────

/**
 * v2 §8.5 原文：
 * ```ts
 * defineCard({
 *   id: "GRID_005", name: "战地号手", kind: "minion", cost: 4, atk: 2, health: 4,
 *   text: "战斗开始时，所有友方单位本次战斗攻击力 +1。",
 *   triggers: [ on(CombatBegan(), Buff(FRIENDLY_MINIONS, "GRID_005e")) ],
 * });
 * defineEnchantment({ id: "GRID_005e", atk: +1, duration: "end_of_combat" });
 * ```
 */
export const GRID_005: Card = defineCard({
  id: "GRID_005",
  name: "战地号手",
  kind: "minion",
  cost: 4,
  atk: 2,
  health: 4,
  colors: "green",
  text: "战斗开始时，所有友方单位本次战斗攻击力 +1。",
  triggers: [on(CombatBegan(), Buff(FRIENDLY_MINIONS, "GRID_005e"))],
});

/** v2 §8.5 的附魔：`end_of_combat` 是 v2 新增的时长，"战斗号角"类必需。 */
export const GRID_005E: Enchantment = defineEnchantment({
  id: "GRID_005e",
  atk: 1,
  duration: "end_of_combat",
});

/**
 * §8.5 **文档未给 JSON**，按规范推导（偏离 C）：
 * - `CombatBegan()` 无过滤器 → `filter` 不写
 * - `zone` 未给 → 补默认 `"board"`（IR §4.1）
 */
export const DOC_8_5_TRIGGERS = [
  {
    on: "combat_began",
    zone: "board",
    do: [
      {
        op: "act.buff",
        target: {
          op: "sel.where",
          of: { op: "sel.zone", side: "friendly", zone: "board" },
          cond: { op: "cond.is_kind", of: { op: "sel.it" }, kind: "minion" },
        },
        ench: "GRID_005e",
      },
    ],
  },
] as const satisfies readonly Trigger[];

/** §8.5 附魔的期望 JSON（文档未给，按 IR §2.3 + v2 §3.5 推导）。 */
export const DOC_8_5_ENCHANTMENT = {
  id: "GRID_005e",
  attachesTo: "minion",
  mods: { atk: 1 },
  duration: "end_of_combat",
} as const satisfies Enchantment;

// ── 8.6 荆棘卫士 —— struck 触发反伤 ─────────────────────────────────────────

/**
 * v2 §8.6 原文：
 * ```ts
 * defineCard({
 *   id: "GRID_006", name: "荆棘卫士", kind: "minion", cost: 3, atk: 1, health: 6,
 *   text: "每当受到单位的出手伤害，对出手者造成 1 点伤害。",
 *   triggers: [ on(Struck(SELF), Hit(EVENT.source, 1)) ],   // filter: target=SELF
 * });
 * ```
 * 行末注释就是 `Struck(SELF)` 的语义定义：选择器简写 = `{ target: SELF }`。
 */
export const GRID_006: Card = defineCard({
  id: "GRID_006",
  name: "荆棘卫士",
  kind: "minion",
  cost: 3,
  atk: 1,
  health: 6,
  colors: "green",
  text: "每当受到单位的出手伤害，对出手者造成 1 点伤害。",
  triggers: [on(Struck(SELF), Hit(EVENT.source, 1))],
});

/**
 * §8.6 **文档未给 JSON**，按规范推导（偏离 C）：
 * `Struck(SELF)` → `on:"struck"` + `filter:{target: sel.self}`（源自原文行末注释），
 * `zone` 补默认 `"board"`，`EVENT.source` → `sel.event{field:"source"}`。
 */
export const DOC_8_6_TRIGGERS = [
  {
    on: "struck",
    filter: { target: { op: "sel.self" } },
    zone: "board",
    do: [{ op: "act.hit", target: { op: "sel.event", field: "source" }, amount: 1 }],
  },
] as const satisfies readonly Trigger[];

/** 六张卡的顺序集合，供"逐张过一遍"的测试用。 */
export const GRID_CARDS: readonly Card[] = [
  GRID_001,
  GRID_002,
  GRID_003,
  GRID_004,
  GRID_005,
  GRID_006,
];

/** 三个附魔（§8.1 / §8.5；§8.2-8.4、§8.6 不带附魔）。 */
export const GRID_ENCHANTMENTS: readonly Enchantment[] = [GRID_001E, GRID_005E];
