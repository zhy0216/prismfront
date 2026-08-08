// 《卡牌 DSL 的 JSON IR 规范》§10「完整示例：TS 源码 → IR」的六个例子。
//
// 作用：v2 §8 的六张卡验收的是**格子战斗**那一半糖，§10 的六个例子验收的是**v1 基座**那一半
// （具名常量、`.where()`、`.negate()`、`.gte()`、`.random(n)`、亡语、费用修正、
//  发现与挂起点、拦截器）。两边合起来才是完整的糖面。
//
// ── §10 的 JSON 写于 v1，与今天的规范有四处**实质**差异（全部来自后续定案，不是笔误）──
//
// 1. **`"hero"` 区域已改名 `"base"`**（v2.1 §11.2、架构 §10 第 3 项）。
//    §10.1 / §10.2 的 `zone: ["board","hero"]` 今天写作 `["board","base"]`。
//    抄录时按改名回写，并在测试里点名这一处。
// 2. **`act.summon.at` 现在必填**（v2 §3.4；builder 省略时补 `slot.random_empty(friendly)`，v2 §7）。
//    §10.4 亡语里的 summon 没有 `at`，抄录时补上。
// 3. **`data.faction` 已废弃**（v2.1 §11.4 → `data.colors`）。
//    §10.5 的 `HasFaction("mage")` 在 v1 编译成 `cond.has_tag(it, "faction_mage")`，
//    而 `"faction_mage"` 不是 `TagKey`（T1 的权威类型只有 atk/health/cost/direction/armor）。
//    **M4 / 决策 #9 补上了 `cond.has_color`**（irVersion 2.2.0），阵营筛选于是有了对应物：
//    `HasFaction("mage")` → `IsBlue()`（《数值基准》§1.1：蓝 = 魔法）。
//    §10.5 因此恢复成文档原样的**两个子句**，只剩"阵营词汇 → 颜色词汇"这一层翻译。
// 4. **`FRIENDLY_MINIONS` 的含义变了**（v2.1 §11.2）：v1 那时没有占格英雄，
//    "友方随从" = 友方 board 全部；今天该语义的常量叫 `FRIENDLY_UNITS`。
//    §10.3 / §10.4 照抄时用 `*_UNITS`，这样与文档 JSON 逐字节一致；
//    v2.1 的 `FRIENDLY_MINIONS`（多一层 `where(is_kind(it,"minion"))`）另有测试覆盖。
//
// 另有一处**文档自身前后不一致**（§10.3，见 `DOC_10_3_AURAS` 的注释）：
// TS 源码与 JSON 的 `minus` / `where` 嵌套顺序相反。这里按 TS 源码的字面语义实现，
// 不改 builder 去迁就 JSON。

import {
  AddToHand,
  ALL_CHARACTERS,
  ANY_CHARACTER,
  And,
  Attr,
  Aura,
  Buff,
  Cancel,
  CardPool,
  CHOSEN,
  CONTROLLER,
  Count,
  Discover,
  Draw,
  defineCard,
  defineEnchantment,
  ENEMY_UNITS,
  Field,
  FRIENDLY_UNITS,
  HasFlag,
  HasTribe,
  Healed,
  Hit,
  IsBlue,
  IsSpell,
  IT,
  intercept,
  on,
  SELF,
  SetFlag,
  Summon,
  TARGET,
  when,
} from "../../builder/index.ts";
import type {
  Act,
  Aura as AuraNode,
  Card,
  CardScript,
  Enchantment,
  Intercept,
  Trigger,
} from "../../types/index.ts";

// ── 10.1 火球术 ─────────────────────────────────────────────────────────────

/**
 * IR §10.1 原文：
 * ```ts
 * defineCard({
 *   id: "CORE_001", name: "火球术", kind: "spell", cost: 4,
 *   target: ANY_CHARACTER,
 *   play: Hit(TARGET, 6),
 * });
 * ```
 * `colors` 是 v2.1 §11.4 之后的必填项，文档写于此前；火球 = 红（伤害是红主色）。
 */
export const CORE_001: Card = defineCard({
  id: "CORE_001",
  set: "core",
  name: { zh: "火球术", en: "Fireball" },
  kind: "spell",
  cost: 4,
  colors: "red",
  text: { zh: "造成 6 点伤害。", en: "Deal 6 damage." },
  target: ANY_CHARACTER,
  play: Hit(TARGET, 6),
});

/** IR §10.1 的 `script` 段。`zone` 的 `"hero"` 已按差异 1 改成 `"base"`。 */
export const DOC_10_1_SCRIPT = {
  target: { op: "sel.zone", side: "both", zone: ["board", "base"] },
  play: [{ op: "act.hit", target: { op: "sel.target" }, amount: 6 }],
} as const satisfies CardScript;

// ── 10.2 光明守护者（触发 + 附魔）──────────────────────────────────────────

/**
 * IR §10.2 原文：
 * ```ts
 * defineCard({
 *   id: "CORE_020", name: "光明守护者", kind: "minion", cost: 1, atk: 1, health: 2,
 *   triggers: [ on(Healed(ALL_CHARACTERS), Buff(SELF, "CORE_020e")) ],
 * });
 * defineEnchantment({ id: "CORE_020e", atk: +1 });
 * ```
 */
export const CORE_020: Card = defineCard({
  id: "CORE_020",
  set: "core",
  name: "光明守护者",
  kind: "minion",
  cost: 1,
  atk: 1,
  health: 2,
  colors: "green",
  triggers: [on(Healed(ALL_CHARACTERS), Buff(SELF, "CORE_020e"))],
});

/** IR §10.2 的附魔。`duration` 未写 → 默认 `"permanent"`。 */
export const CORE_020E: Enchantment = defineEnchantment({ id: "CORE_020e", atk: 1 });

/**
 * IR §10.2 的 `script.triggers` 段（`"hero"` → `"base"`，差异 1）。
 * 注意文档在这里**显式写了 `"zone": "board"`**（默认值），却没写 `cond` / `once` ——
 * 规范化因此照做：`zone` 补默认，`cond` / `once` 缺省不写。
 */
export const DOC_10_2_TRIGGERS = [
  {
    on: "healed",
    filter: { target: { op: "sel.zone", side: "both", zone: ["board", "base"] } },
    zone: "board",
    do: [{ op: "act.buff", target: { op: "sel.self" }, ench: "CORE_020e" }],
  },
] as const satisfies readonly Trigger[];

// ── 10.3 野猪王（光环）─────────────────────────────────────────────────────

/**
 * IR §10.3 原文（只给了 `aura` 一行）：
 * ```ts
 * aura: Aura(FRIENDLY_MINIONS.not(SELF).where(HasTribe(IT, "beast")), { atk: +1 })
 * ```
 * 按差异 4 用 `FRIENDLY_UNITS`。链式从左往右求值，所以它的语义是
 * `where(minus(FRIENDLY_UNITS, SELF), has_tribe(it,"beast"))`。
 */
export const CORE_030_AURA: AuraNode = Aura(FRIENDLY_UNITS.not(SELF).where(HasTribe(IT, "beast")), {
  atk: 1,
});

/**
 * 与 §10.3 的 TS 源码等价、但**嵌套顺序与文档 JSON 一致**的写法：先 where 再 minus。
 * `minus` 与 `where` 可交换，两种写法语义相同、IR 结构不同 —— 见 `DOC_10_3_AURAS` 的说明。
 */
export const CORE_030_AURA_AS_DOCUMENTED_JSON: AuraNode = Aura(
  FRIENDLY_UNITS.where(HasTribe(IT, "beast")).not(SELF),
  { atk: 1 },
);

/**
 * IR §10.3 的 `auras` 段，**逐字符抄录**。
 *
 * ⚠ 文档在这里自相矛盾：TS 源码是 `FRIENDLY_MINIONS.not(SELF).where(...)`
 * （从左往右 = where 包在 minus 外面），JSON 却是 `minus` 包在 `where` 外面。
 * 两者语义等价（差集与过滤可交换），但结构不同，不可能同时逐字节一致。
 * 本仓库按**链式方法从左往右**实现（唯一自洽的读法），
 * 因此与这份 JSON 对上的是 `CORE_030_AURA_AS_DOCUMENTED_JSON`。
 */
export const DOC_10_3_AURAS = [
  {
    affects: {
      op: "sel.minus",
      of: {
        op: "sel.where",
        of: { op: "sel.zone", side: "friendly", zone: "board" },
        cond: { op: "cond.has_tribe", of: { op: "sel.it" }, tribe: "beast" },
      },
      exclude: { op: "sel.self" },
    },
    mods: { atk: 1 },
    zone: "board",
  },
] as const satisfies readonly AuraNode[];

// ── 10.4 谜之勇士（费用修正 + 亡语 + 条件）─────────────────────────────────

/**
 * IR §10.4 原文：
 * ```ts
 * defineCard({
 *   id: "CORE_040", kind: "minion", cost: 5, atk: 4, health: 4,
 *   costMod: Count(FRIENDLY_MINIONS).negate(),
 *   deathrattle: Summon(CONTROLLER, "CORE_TOKEN_01"),
 *   play: when(
 *     Attr(SELF, "atk").gte(3),
 *     Hit(ENEMY_MINIONS.random(2), Count(FRIENDLY_MINIONS).times(2)),
 *     Draw(CONTROLLER),
 *   ),
 * });
 * ```
 * 按差异 4 用 `*_UNITS`；`name` 是 `defineCard` 的必填项（文档这例省了）。
 * `deathrattle` 与 `play` 都写的是**单个动作**，规范形式里必须是数组。
 */
export const CORE_040: Card = defineCard({
  id: "CORE_040",
  set: "core",
  name: "谜之勇士",
  kind: "minion",
  cost: 5,
  atk: 4,
  health: 4,
  colors: "red",
  costMod: Count(FRIENDLY_UNITS).negate(),
  deathrattle: Summon(CONTROLLER, "CORE_TOKEN_01"),
  play: when(
    Attr(SELF, "atk").gte(3),
    Hit(ENEMY_UNITS.random(2), Count(FRIENDLY_UNITS).times(2)),
    Draw(CONTROLLER),
  ),
});

/**
 * IR §10.4 的 `script` 段，**逐字符抄录，只补差异 2 的 `at`**：
 * 文档的 `act.summon` 没有 `at`（v1 没这个字段），v2 §3.4 起规范形式必填，
 * builder 补 `slot.random_empty(friendly)`。
 */
export const DOC_10_4_SCRIPT = {
  costMod: {
    op: "num.neg",
    of: { op: "num.count", of: { op: "sel.zone", side: "friendly", zone: "board" } },
  },
  deathrattle: [
    {
      op: "act.summon",
      player: { op: "sel.controller" },
      card: "CORE_TOKEN_01",
      at: { op: "slot.random_empty", side: "friendly" },
    },
  ],
  play: [
    {
      op: "act.when",
      cond: {
        op: "cond.gte",
        l: { op: "num.attr", of: { op: "sel.self" }, tag: "atk" },
        r: 3,
      },
      then: [
        {
          op: "act.hit",
          target: {
            op: "sel.random",
            of: { op: "sel.zone", side: "enemy", zone: "board" },
            n: 2,
          },
          amount: {
            op: "num.mul",
            of: [{ op: "num.count", of: { op: "sel.zone", side: "friendly", zone: "board" } }, 2],
          },
        },
      ],
      else: [{ op: "act.draw", player: { op: "sel.controller" } }],
    },
  ],
} as const satisfies CardScript;

// ── 10.5 发现（挂起点）─────────────────────────────────────────────────────

/**
 * IR §10.5 原文：
 * ```ts
 * play: [
 *   Discover(CardPool(IsSpell().and(HasFaction("mage")))),
 *   AddToHand(CONTROLLER, CHOSEN),
 * ]
 * ```
 * `HasFaction("mage")` 按差异 3 翻译成 `IsBlue()`（`cond.has_color`，决策 #9）。
 * 其余原样：`Discover` 补默认 `show: 3, pick: 1`（文档 JSON 就是这么写的），
 * `AddToHand(CONTROLLER, CHOSEN)` 把选择器包成 `card.of`。
 */
export const CORE_050_PLAY: readonly Act[] = [
  Discover(CardPool(IsSpell().and(IsBlue()))),
  AddToHand(CONTROLLER, CHOSEN),
];

/**
 * IR §10.5 的 `play` 段，**逐字符抄录，只把阵营子句换成颜色子句**（差异 3）：
 * `cond.has_tag(it,"faction_mage")` → `cond.has_color(it,"blue")`。
 * `cond.and` 的两个子句、`show` / `pick`、`card.of` 都与文档 JSON 一致。
 */
export const DOC_10_5_PLAY = [
  {
    op: "act.discover",
    from: {
      op: "card.pool",
      filter: {
        op: "cond.and",
        of: [
          { op: "cond.is_kind", of: { op: "sel.it" }, kind: "spell" },
          { op: "cond.has_color", of: { op: "sel.it" }, color: "blue" },
        ],
      },
    },
    show: 3,
    pick: 1,
  },
  {
    op: "act.give",
    player: { op: "sel.controller" },
    card: { op: "card.of", of: { op: "sel.chosen" } },
  },
] as const satisfies readonly Act[];

/** §10.5 里 `IsSpell().and(...)` 用到的链式 `.and()`，单独留一份用于验证摊平行为。 */
export const CORE_050_POOL_FILTER_TWO_CLAUSES = And(IsSpell(), HasTribe(IT, "beast"));

// ── 10.6 圣盾（拦截器）─────────────────────────────────────────────────────

/**
 * IR §10.6 只给了 JSON，没给 TS 源码。这是用 builder 反推的写法：
 * `intercept: "act.hit"` + `filter: {target: SELF}` + `cond` 读被拦截动作的 `amount`
 * + `effect: cancel` + `then` 清掉自己的标志位 + `priority: 100`。
 */
export const DIVINE_SHIELD_INTERCEPT: Intercept = intercept({
  intercept: "act.hit",
  filter: { target: SELF },
  cond: And(HasFlag(SELF, "divine_shield"), Field("amount").gt(0)),
  effect: Cancel(),
  then: SetFlag(SELF, "divine_shield", false),
  priority: 100,
});

/** IR §10.6 的 `intercepts` 段，逐字符抄录（这一段与今天的规范无差异）。 */
export const DOC_10_6_INTERCEPTS = [
  {
    intercept: "act.hit",
    filter: { target: { op: "sel.self" } },
    cond: {
      op: "cond.and",
      of: [
        { op: "cond.has_flag", of: { op: "sel.self" }, flag: "divine_shield" },
        { op: "cond.gt", l: { op: "num.field", field: "amount" }, r: 0 },
      ],
    },
    effect: { kind: "cancel" },
    then: [{ op: "act.set_flag", target: { op: "sel.self" }, flag: "divine_shield", value: false }],
    priority: 100,
  },
] as const satisfies readonly Intercept[];
