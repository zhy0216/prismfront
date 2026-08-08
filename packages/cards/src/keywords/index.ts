// DSL v2 §8.7 的四条 Artifact 关键词 —— **范式**，不是 PF1 的卡（M5/T6 的完成判据）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 这是什么
// ═══════════════════════════════════════════════════════════════════════════
// v2 §8.7 是整份规范的**表达力验收点**：既然玩法 ≈ 单路 Artifact，Artifact 的核心
// 关键词就应当**全部可写、且无需新 op**。四条逐字照抄规范的「DSL 写法」那一列：
//
//   Retaliate X  `on(Struck({target: SELF}), Hit(EVENT.source, X))`
//   Cleave X     `on(Struck({source: SELF}), Hit(Adjacent(EVENT.target), X))`
//   Siege X      `on(Struck({source: SELF}), when(IsMinion(EVENT.target), Hit(ENEMY_BASE, X)))`
//   改箭头       `Buff(TARGET, ench)`，ench 带 `direction` mod（v2 §2.3）
//
// ⚠ 规范原文第三条写的是 `Hit(ENEMY_HERO, X)`。v2.1 §11.2 把承接空格伤害的实体
//   更名为**基地**，`ENEMY_HERO` → `ENEMY_BASE`（`builder/constants.ts` 的第 1 条）。
//   这里用改名后的名字，语义一字未变。
//
// ═══════════════════════════════════════════════════════════════════════════
// 为什么放在 packages/cards 而不是 packages/engine
// ═══════════════════════════════════════════════════════════════════════════
// 验收要求是「用 **builder** 真的写出来、跑起来、断言效果」，而 builder 是
// `@prismfront/ir` 的**值**。架构 §2.2 禁令 1 说 engine 的 `dependencies` 必须是空对象
// ——`@prismfront/ir` 在那边只是 devDependency，全包一律 `import type`，值不行
// （`engine/src/testkit/index.ts` 的文件头就是这么写的）。于是 engine 的测试里
// **写不出** `on(Struck(...), Hit(...))` 这一行，只能手抄等价的 IR 字面量；
// 手抄的那一份验的是**引擎认不认这段 IR**，验不了「编写层写不写得出来」，
// 而 §8.7 问的恰恰是后者。所以四条范式落在 cards 这一侧
// （engine 是本包的 devDependency，测试可以反过来把它们喂进引擎跑一局）。
//
// 引擎侧那几条同形的测试**没有重复**，两边钉的是不同的东西，各自都要留着：
//   `engine/src/resolve/__tests__/triggers.test.ts`  filter 的 `target`/`source` 两个键
//     各自的匹配语义（盘面里摆着"用同一张卡但不该响"的对照单位）；
//   `engine/src/resolve/__tests__/auras.test.ts`     `mods.direction` 走 Σ 管线；
//   本目录的测试                                     §8.7 四条**关键词**成不成立。
//
// ═══════════════════════════════════════════════════════════════════════════
// 这些卡**不进** CARD_SOURCES，也不进 bundle
// ═══════════════════════════════════════════════════════════════════════════
// 它们不是 PF1 的卡：《数值基准》§6 里真正用到这三条关键词的是
// **G06 Retaliate 2 / R05 全额 Cleave / R06 Siege 1**，那三张（连同其余 30 张）
// 归 M11 写，带各自的费用、身板与预算核算。本文件只回答「这个写法成不成立」，
// 所以：
//   - `set: "kw"`（不是 `"pf1"`），id 前缀 `KW_` —— 与卡号 `PF1_xNN` 一眼分得开；
//   - `collectible: false` —— 不进卡组，于是 v2.1 §11.4b 的「专属卡必须写 `hero`」
//     那条 lint 天然免除（原文明写 token / `collectible:false` 免除此项）；
//   - 不从 `src/index.ts` 导出、不出现在 `PF1_CARDS` 里 ⇒ `buildBundle` 看不到它们。
// 想在 CI 里也过一遍 L1/L2 是可以的（校验器是纯函数），测试里就有那么一条。
//
// `colors` 只是必填项的一个诚实取值，按《数值基准》§6 的卡表填成对应那三张的颜色
// （G06 Retaliate → 绿，R05 Cleave / R06 Siege → 红），改箭头按 §1.2 机制归属表
// 「方向操作 = 红主色」填红。这里不参与任何定价或归属判断。

import type { Card, Enchantment, Num, Trigger } from "@prismfront/ir";
import {
  Adjacent,
  ALL_UNITS,
  Buff,
  defineCard,
  defineEnchantment,
  ENEMY_BASE,
  EVENT,
  Hit,
  IsMinion,
  on,
  SELF,
  Struck,
  TARGET,
  when,
} from "@prismfront/ir";

// ═══════════════════════════════════════════════════════════════════════════
// 三条 `struck` 触发器 —— 关键词里的 X 是参数，所以它们是**函数**
// ═══════════════════════════════════════════════════════════════════════════
// "Retaliate 2" 与 "Retaliate 3" 是同一条关键词的两个实例，写成工厂之后这件事在
// 类型上就成立了；M11 写 G06 时直接 `Retaliate(2)`，不必回来抄这一行。
//
// 三条都只是 `struck` 触发器 + 现有选择器的组合 —— v2 §8.7 开篇那句
// 「**均无需新 op**」的全部含义。它们在时序上也一致：按 v2 §4.2 第 ③/④ 步，
// 出手**全部应用完毕**之后才结算，所以本轮被打死的单位照样反伤 / 溅射（§8.6）。

/**
 * **Retaliate X** —— 被出手命中时，对出手者造成 X 点伤害（v2 §8.6 荆棘卫士）。
 *
 * `filter` 的键是 `target`：`struck.target` 是**挨打的那一个**，而 `SELF` 绑的是
 * 挂着这条触发器的实体（不是事件源）。两件事合起来才是"我被打了"。
 * 反击目标 `EVENT.source` = 这一击的出手者。
 *
 * ★ 反伤走 `Hit`（`act.hit`）而不是 `Strike`（`act.strike`）：`act.hit` **不发
 * `struck`**（`engine/src/handlers/damage.ts` 文件头点名的那条），于是两个
 * Retaliate 互相照面时不会连锁成无限反弹 —— 这是**事件/动作二分**在兜底，
 * 不是哪里写了一个"反伤不再触发反伤"的特判。
 */
export function Retaliate(x: Num): Trigger {
  return on(Struck({ target: SELF }), Hit(EVENT.source, x));
}

/**
 * **Cleave X** —— 我命中一个单位时，它**位置相邻**的单位各挨 X 点（v2 §8.7）。
 *
 * `filter` 的键换成 `source`（"我出的手"），只差这一个键就从 Retaliate 变成 Cleave。
 *
 * ★ `Adjacent` 的语义在 v2 §3.2 **变了**：v1 是"召唤顺序相邻"，v2 是**位置相邻**
 * —— 同侧 ±`dist` 格内的单位，`dist` 默认 1。于是"溅射到左右两边"是位置语义，
 * 与谁先上场无关。
 *
 * ★ 命中基地时 `Adjacent(基地)` 是**空集**（基地不占格），`act.hit` 于是静默跳过
 * （IR v1 §5.2 空集语义）。同样不需要特判。
 */
export function Cleave(x: Num): Trigger {
  return on(Struck({ source: SELF }), Hit(Adjacent(EVENT.target), x));
}

/**
 * **Siege X** —— 我命中一个**单位**时，额外对敌方基地打 X 点（v2 §8.7）。
 *
 * `when(IsMinion(...), ...)` 不是可有可无的装饰：方向指空格时伤害本来就直接进基地
 * （v2 §4.2 第 ② 步），那一击的 `EVENT.target` 就是基地本身，`IsMinion` 为假 ⇒
 * 不再额外打一次。**双重计算是被条件挡住的，不是被特判挡住的。**
 *
 * `IsMinion` 读的是**卡面** `data.kind`（`engine/src/eval/cond.ts`）；基地实体的
 * `cardId` 是引擎保留值 `__base`，卡表里查不到 ⇒ 无法确认满足 ⇒ 不满足。
 */
export function Siege(x: Num): Trigger {
  return on(Struck({ source: SELF }), when(IsMinion(EVENT.target), Hit(ENEMY_BASE, x)));
}

// ═══════════════════════════════════════════════════════════════════════════
// 四条关键词各自的最小载体
// ═══════════════════════════════════════════════════════════════════════════
// 数值取"能被一眼分辨"的值而不是《数值基准》里的定价值：测试要读出"这一下是谁打的"，
// 几个同为 1 的读数分不开谁是谁（同 `engine/src/rules/__tests__/combat.test.ts` 的规矩）。
// 攻血一律由摆盘夹具在测试里给，这里只写脚本那一半（同 `testkit` 的 `scriptCard`）。

/** Retaliate 2 的载体。《数值基准》§6 的 G06 是 2 费 1/4 Retaliate 2，那张归 M11。 */
export const KW_RETALIATE: Card = defineCard({
  id: "KW_RETALIATE",
  set: "kw",
  name: { zh: "范式 · 反击 2", en: "Paradigm · Retaliate 2" },
  text: "每当受到单位的出手伤害，对出手者造成 2 点伤害。",
  kind: "minion",
  cost: 2,
  colors: "green",
  collectible: false,
  triggers: Retaliate(2),
});

/** Cleave 1 的载体。《数值基准》§6 的 R05 是 3 费 3/1 全额 Cleave，那张归 M11。 */
export const KW_CLEAVE: Card = defineCard({
  id: "KW_CLEAVE",
  set: "kw",
  name: { zh: "范式 · 顺劈 1", en: "Paradigm · Cleave 1" },
  text: "每当此单位命中一个单位，对其相邻单位各造成 1 点伤害。",
  kind: "minion",
  cost: 3,
  colors: "red",
  collectible: false,
  triggers: Cleave(1),
});

/** Siege 1 的载体。《数值基准》§6 的 R06 是 4 费 5/3 Siege 1，那张归 M11。 */
export const KW_SIEGE: Card = defineCard({
  id: "KW_SIEGE",
  set: "kw",
  name: { zh: "范式 · 攻城 1", en: "Paradigm · Siege 1" },
  text: "每当此单位命中一个随从，对敌方基地造成 1 点伤害。",
  kind: "minion",
  cost: 4,
  colors: "red",
  collectible: false,
  triggers: Siege(1),
});

/**
 * 改箭头的附魔：`direction` 是**普通 Tag**（v2 §2.3），所以这条附魔与"+1 攻"同形。
 *
 * ★ 这一条**零额外代码**：`mods` 是 `Partial<Record<TagKey, number>>`，`direction`
 * 只是其中一个键，由 `refreshAuras` 与别的 tag 一样逐键相加 —— `resolve/auras.ts`
 * 的**代码里 `direction` 出现零次**（只有文件头的注释提到它，可以 grep 验）；
 * 而战斗快照（`rules/combat.ts` 的 `planStrikes`）读的是**生效值** `tags.direction`。
 * 两头都不认识"方向附魔"这件事，所以它是免费的。
 *
 * ⚠ v2 §2.3 还顺带许诺了"沉默自动重置方向"。那一条**今天验不了**：
 *   `act.silence` 在 `handlers/index.ts` 里还是 `notImplemented`。
 *   它兑现与否取决于将来那个 handler 怎么写，不是本条附魔的性质，所以不在这里断言。
 *
 * `-1` 而不是 `+1`：负方向能钉住"不限幅、可为负"（v2 §2.3），而 `+1` 在 0 号格上
 * 与"没生效"读不出差别的盘面更多。
 */
export const KW_COMPEL_ENCH: Enchantment = defineEnchantment({
  id: "KW_COMPEL_e",
  attachesTo: "minion",
  direction: -1,
  duration: "permanent",
});

/**
 * 改箭头（Compel 类）的载体：一张把 {@link KW_COMPEL_ENCH} 挂到目标身上的法术。
 *
 * 目标域取 `ALL_UNITS`（v2.1 §11.2：场上全部，含英雄；基地不在其中）——
 * 强制改的是**敌方**的箭头才有意义，所以域里必须有敌方单位。
 */
export const KW_COMPEL: Card = defineCard({
  id: "KW_COMPEL",
  set: "kw",
  name: { zh: "范式 · 改箭头", en: "Paradigm · Compel" },
  text: "使一个单位的出手方向 -1。",
  kind: "spell",
  cost: 1,
  colors: "red",
  collectible: false,
  target: ALL_UNITS,
  play: Buff(TARGET, KW_COMPEL_ENCH.id),
});

/** 四条范式的卡。喂 `cardDeps` / `buildBundle` 时整份给，免得漏接一张。 */
export const KEYWORD_CARDS: readonly Card[] = [KW_RETALIATE, KW_CLEAVE, KW_SIEGE, KW_COMPEL];

/** 四条范式引用的附魔。 */
export const KEYWORD_ENCHANTMENTS: readonly Enchantment[] = [KW_COMPEL_ENCH];
