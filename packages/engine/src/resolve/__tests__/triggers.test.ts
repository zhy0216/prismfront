// 触发器匹配的单元测试（M5/T1：`resolve/triggers.ts` 的 `collectTriggerSubscriptions`）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 测的是 IR v1 §4.1 的五个字段，一个都不能少
// ═══════════════════════════════════════════════════════════════════════════
//   on      事件名相等
//   filter  键是事件负载的**实体字段**，值是 Sel；★ **SELF 绑订阅者**（不是事件源）
//   cond    额外条件，可访问 `sel.event.*`
//   once    触发一次后自动移除 —— ★ 记账在实体上，必须能 JSON 往返（框架 §4.2）
//   zone    订阅者不在那个区就不订阅；亡语的 `"graveyard"` 正是它死后还能触发的原因
// 外加三条结构性的：`deathrattle` 的糖展开、**附魔自带的 `script.triggers`**、
// 以及相位机那条接缝（不经 handler 的事件也要能触发）。
//
// 排序（时序规则 1）与入栈（规则 2）的**单元**测试不在这里：那是 M2 做的，
// 在 `resolve.test.ts`（`sortTriggers` / `enqueueTriggers` 两条）。这里补一条
// **端到端**的顺序断言 —— 用真触发器走一遍，确认匹配出来的东西真的按规则 1 排。
//
// ═══════════════════════════════════════════════════════════════════════════
// 每条测试都要有**判别力**：不只断言"响了"，还要断言"不该响的没响"
// ═══════════════════════════════════════════════════════════════════════════
// 触发器测试最容易写成空壳：摆一张卡、断言它触发了 —— 而"filter 整个被忽略"
// 同样能让它触发。所以本文件的盘面一律**成对**摆：一个该响的 + 一个不该响的，
// 且尽量用**同一张卡**（于是差别只可能出在匹配上，不可能出在卡的写法上）。
// 每条断言旁边都写明「写错了会读到什么」。
//
// 注：本文件**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1）。

import { expect, test } from "bun:test";
import type { Act, Card, Enchantment, EntityId, Sel } from "@prismfront/ir";
import type { GameEvent, RuleEvent } from "../../events/index.ts";
import type { GameState } from "../../state/index.ts";
import { cloneState, getEntity } from "../../state/index.ts";
import {
  baseIdOf,
  cardDeps,
  damageOf,
  eventNames,
  handOf,
  openGame,
  playCard,
  putCard,
  putCardInHand,
  putUnit,
  runActs,
  scriptCard,
  strikeNow,
  tagOf,
} from "../../testkit/index.ts";
import type { ResolveDeps } from "../index.ts";
import { queueTriggers, resolve } from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 直接把一条事件喂给流水线第 ④ 步，然后开闸跑完。**原地改 `state`**。
 *
 * 走的是**生产路径**（`queueTriggers` → `resolve`，与 `resolve.ts` 第 ④ 步逐字相同），
 * 只是绕开了"谁发出这条事件"—— 相位事件（`round_began`）与战斗事件（`combat_began`）
 * 要摆出来代价很高，而本文件测的是**匹配**，不是"哪一步会发这条事件"。
 * 那条接缝另有一条端到端测试（本文件末尾的 `card_played`）。
 */
function fireEvent(state: GameState, event: RuleEvent, deps: ResolveDeps): GameEvent[] {
  queueTriggers(state, [event], deps);
  return resolve(state, deps);
}

/** 某方手牌张数 —— 本文件多数触发器的可观测面是"抽了几张牌"。 */
function handSize(state: GameState, player: 0 | 1): number {
  return handOf(state, player).length;
}

/** 一批事件里 `damaged` 的施动者序列（`damaged.source` 取 `ctx.self` ⇒ 就是触发器宿主）。 */
function damageSources(events: readonly GameEvent[]): (EntityId | null)[] {
  return events
    .filter((event) => event.name === "damaged")
    .map((event) => (event.name === "damaged" ? event.source : null));
}

/**
 * 一批事件里 `damaged` 的**伤害数值**序列 —— 数组顺序即结算顺序。
 *
 * 用它读"先后"时，各条动作的 `amount` 要**刻意取不同的数**：同形的两条事件调换过来
 * 读不出差别，那样的断言对顺序零判别力（同 `rules/__tests__/combat.test.ts` 的规矩）。
 */
function damageAmounts(events: readonly GameEvent[]): number[] {
  return events
    .filter((event) => event.name === "damaged")
    .map((event) => (event.name === "damaged" ? event.amount : 0));
}

/** 打一个具体实体 `amount` 点（`sel.entity` 是 IR v1 §5.6 的运行时超集，测试可用）。 */
function hitAct(target: EntityId, amount = 1): Act {
  return { op: "act.hit", target: { op: "sel.entity", id: target }, amount };
}

/** 最常见的站位动作：控制者抽一张牌。事件名 `card_drawn` 与伤害类事件一眼分得开。 */
const DRAW_ONE: Act = { op: "act.draw", player: { op: "sel.controller" } };

/** 一条只带 `target` 的伤害事件，用来驱动 `on: "damaged"` 的订阅者。 */
function damagedTo(target: EntityId): RuleEvent {
  return { name: "damaged", source: null, target, amount: 1 };
}

// ═══════════════════════════════════════════════════════════════════════════
// `on`：事件名相等
// ═══════════════════════════════════════════════════════════════════════════

const ON_HEALED: Card = scriptCard("T_ON_HEALED", {
  triggers: [{ on: "healed", do: [DRAW_ONE] }],
});

test("on：只对同名事件响应", () => {
  const deps = cardDeps([ON_HEALED]);
  const state = openGame();
  const watcher = putCard(state, 0, 0, ON_HEALED, { atk: 0, health: 9 });

  // `damaged` ≠ `healed` ⇒ 一条都不排。少了 `on` 的比较，这里会抽到一张。
  expect(eventNames(fireEvent(cloneState(state), damagedTo(watcher), deps))).toEqual([]);
  // 同名事件才响 —— 否则上面那条单独看还能靠"整条链根本没跑起来"蒙对。
  expect(
    eventNames(
      fireEvent(
        cloneState(state),
        { name: "healed", source: null, target: watcher, amount: 1 },
        deps,
      ),
    ),
  ).toEqual(["card_drawn"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// `filter`：★ SELF 绑的是**订阅者**，不是事件源
// ═══════════════════════════════════════════════════════════════════════════
// v2 §8.7 的 Retaliate 与 Cleave 只差一个键（`target` vs `source`），
// 而两者都成立的**前提**就是 SELF = 挂着这条触发器的那个实体。
// 下面两条各钉一个键，盘面里都放着"用同一张卡、但不该响"的对照单位。

/** Retaliate 1（荆棘卫士，IR v1 §4.1 的例子）：**我**被出手命中时，打回去 1 点。 */
const THORNS: Card = scriptCard("T_THORNS", {
  triggers: [
    {
      on: "struck",
      filter: { target: { op: "sel.self" } },
      do: [{ op: "act.hit", target: { op: "sel.event", field: "source" }, amount: 1 }],
    },
  ],
});

test("filter：Retaliate —— 只有「被打的那一个」反击（SELF = 订阅者）", () => {
  const deps = cardDeps([THORNS]);
  const state = openGame();
  const attacker = putUnit(state, 0, 0, { atk: 3, health: 9 });
  const struck = putCard(state, 1, 0, THORNS, { atk: 0, health: 9 });
  // 对照：同一张卡、同一侧、就在隔壁 —— 它**没有**被打，所以不该反击。
  const bystander = putCard(state, 1, 1, THORNS, { atk: 0, health: 9 });

  const step = strikeNow(state, attacker, struck, deps);

  // ★ 恰好 1 点反伤。三种典型写错各有不同的读数：
  //   filter 被忽略        → 2 点（两个都反击）
  //   SELF 绑成了事件源    → 0 点（`event.target ∈ {attacker}` 恒假，谁都不反击）
  //   filter 键取成 source → 0 点（`struck.source` 是 attacker，不是这两个）
  expect(damageOf(step.state, attacker)).toBe(1);
  expect(damageOf(step.state, struck)).toBe(3);
  expect(damageOf(step.state, bystander)).toBe(0);
  // 反伤的施动者是**被打的那一个**（`damaged.source` 取 `ctx.self`）。
  expect(damageSources(step.events)).toEqual([struck, attacker]);
});

/** Cleave 1（v2 §8.7）：**我**命中一个单位时，它的相邻单位各挨 1 点。 */
const CLEAVE: Card = scriptCard("T_CLEAVE", {
  triggers: [
    {
      on: "struck",
      filter: { source: { op: "sel.self" } },
      do: [
        {
          op: "act.hit",
          target: { op: "sel.adjacent", of: { op: "sel.event", field: "target" } },
          amount: 1,
        },
      ],
    },
  ],
});

test("filter：Cleave —— 键取 source ⇒ 只有「出手的那一个」溅射", () => {
  const deps = cardDeps([CLEAVE]);
  const state = openGame();
  const cleaver = putCard(state, 0, 0, CLEAVE, { atk: 2, health: 9 });
  // ★ 挨打的那一个**也挂着同一张卡**：filter 若被忽略，它会再溅射一次，
  //   邻居就吃到 2 点而不是 1 点 —— 这是本条的判别力所在。
  const victim = putCard(state, 1, 0, CLEAVE, { atk: 0, health: 9 });
  const neighbour = putUnit(state, 1, 1, { atk: 0, health: 9 });
  const far = putUnit(state, 1, 3, { atk: 0, health: 9 });

  const step = strikeNow(state, cleaver, victim, deps);

  expect(damageOf(step.state, victim)).toBe(2); // 只挨了出手那一下
  expect(damageOf(step.state, neighbour)).toBe(1); // 溅射恰好一次
  expect(damageOf(step.state, far)).toBe(0); // 不相邻（`sel.adjacent` 默认 dist=1）
  expect(damageOf(step.state, cleaver)).toBe(0);
});

/**
 * 「相邻友军被打时」（v2 §5 点名的位置选择器用法）。
 *
 * ★ 它**不需要任何新机制** —— `sel.adjacent` 只是又一个 `Sel`，走的是同一条
 *   「事件字段上的实体是否落在这个 Sel 内」。为它写特判就说明接错了。
 */
const AVENGER: Card = scriptCard("T_AVENGER", {
  triggers: [
    {
      on: "damaged",
      filter: { target: { op: "sel.adjacent", of: { op: "sel.self" } } },
      do: [DRAW_ONE],
    },
  ],
});

test("filter：位置选择器免费可用（相邻友军被打时）", () => {
  const deps = cardDeps([AVENGER]);
  const state = openGame();
  const avenger = putCard(state, 0, 1, AVENGER, { atk: 0, health: 9 });
  const ally = putUnit(state, 0, 0, { atk: 0, health: 9 }); // 相邻
  const distant = putUnit(state, 0, 4, { atk: 0, health: 9 }); // 不相邻
  const before = handSize(state, 0);

  expect(handSize(runActs(state, [hitAct(ally)], ally, deps).state, 0)).toBe(before + 1);
  // 不相邻 ⇒ 不响。`sel.adjacent` 退化成"整条战线"的实现会在这里多抽一张。
  expect(handSize(runActs(state, [hitAct(distant)], distant, deps).state, 0)).toBe(before);
  // 自己被打 ⇒ 也不响（`sel.adjacent` 不含自己，v2 §3.2）。
  expect(handSize(runActs(state, [hitAct(avenger)], avenger, deps).state, 0)).toBe(before);
});

/** 事件负载上根本没有这个字段时的行为（`unit_died` 没有 `source`，见 `events/event.ts`）。 */
const ON_DIED_BY_SOURCE: Card = scriptCard("T_DIED_BY_SOURCE", {
  triggers: [
    { on: "unit_died", filter: { source: { op: "sel.self" } }, zone: "board", do: [DRAW_ONE] },
  ],
});
const ON_ANY_DEATH: Card = scriptCard("T_ANY_DEATH", {
  triggers: [{ on: "unit_died", zone: "board", do: [DRAW_ONE] }],
});

test("filter：事件负载没有这个实体字段 ⇒ 不匹配（不是「当作通过」）", () => {
  const deps = cardDeps([ON_DIED_BY_SOURCE, ON_ANY_DEATH]);
  const state = openGame();
  putCard(state, 0, 0, ON_DIED_BY_SOURCE, { atk: 0, health: 9 });
  putCard(state, 0, 1, ON_ANY_DEATH, { atk: 0, health: 9 });
  const doomed = putUnit(state, 1, 0, { atk: 0, health: 1 });
  const before = handSize(state, 0);

  const step = runActs(state, [hitAct(doomed, 5)], doomed, deps);

  // ★ 只有**不带 filter** 的那一张响了：带 `{source: SELF}` 的那张永远响不了 ——
  //   `unit_died` 没有 `source` 字段（死亡是批量结算，凶手不可靠归因）。
  //   把"字段缺失"当成通过的实现会在这里抽到 2 张。
  expect(handSize(step.state, 0)).toBe(before + 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// `cond`：额外条件，可访问 `sel.event.*`
// ═══════════════════════════════════════════════════════════════════════════

/** 「每当一个 atk ≥ 3 的单位受伤，抽一张牌」—— `cond` 读的是**事件负载**上的实体。 */
const PICKY: Card = scriptCard("T_PICKY", {
  triggers: [
    {
      on: "damaged",
      cond: {
        op: "cond.gte",
        l: { op: "num.attr", of: { op: "sel.event", field: "target" }, tag: "atk" },
        r: 3,
      },
      do: [DRAW_ONE],
    },
  ],
});

test("cond：能读 sel.event.*，不满足就不触发", () => {
  const deps = cardDeps([PICKY]);
  const state = openGame();
  putCard(state, 0, 0, PICKY, { atk: 0, health: 9 });
  const big = putUnit(state, 1, 0, { atk: 3, health: 9 });
  const small = putUnit(state, 1, 1, { atk: 2, health: 9 });
  const before = handSize(state, 0);

  expect(handSize(runActs(state, [hitAct(big)], big, deps).state, 0)).toBe(before + 1);
  // `cond` 被忽略、或 `ctx.event` 没绑（`sel.event` 退化成空集 ⇒ `num.attr` 给 0）
  // 的实现会在这两行之一读错：前者多抽一张，后者一张都不抽。
  expect(handSize(runActs(state, [hitAct(small)], small, deps).state, 0)).toBe(before);
});

// ═══════════════════════════════════════════════════════════════════════════
// `once`：触发一次后自动移除 —— ★ 记账在实体上，必须能 JSON 往返
// ═══════════════════════════════════════════════════════════════════════════

const ONCE_ONLY: Card = scriptCard("T_ONCE", {
  triggers: [{ on: "damaged", once: true, do: [DRAW_ONE] }],
});
const ALWAYS: Card = scriptCard("T_ALWAYS", {
  triggers: [{ on: "damaged", do: [DRAW_ONE] }],
});

test("once：只触发一次，且「已经烧过」这件事进 JSON 往返（框架 §4.2）", () => {
  const deps = cardDeps([ONCE_ONLY, ALWAYS]);
  const start = openGame();
  const owner = putCard(start, 0, 0, ONCE_ONLY, { atk: 0, health: 20 });
  // 对照：不带 `once` 的同形触发器，每次都要响 —— 它保证下面的"没抽牌"不是
  // "整条链根本没跑起来"造成的假绿。
  putCard(start, 0, 1, ALWAYS, { atk: 0, health: 20 });

  const first = cloneState(start);
  expect(eventNames(fireEvent(first, damagedTo(owner), deps))).toEqual([
    "card_drawn",
    "card_drawn",
  ]);
  // 记账落在实体上（`state/entity.ts` 的 `firedOnce`），键带来源前缀。
  expect(getEntity(first, owner)?.firedOnce).toEqual(["triggers.0"]);

  // 同一份状态再来一次：`once` 那张不再响，`ALWAYS` 那张照响。
  expect(eventNames(fireEvent(first, damagedTo(owner), deps))).toEqual(["card_drawn"]);

  // ★ 整个状态 JSON 往返之后仍然记得 —— 记账若挂在闭包 / WeakMap（按实体**对象**索引）
  //   上，往返会造出全新的对象，这里就会多出一条 `card_drawn`。
  const revived = JSON.parse(JSON.stringify(first)) as GameState;
  expect(eventNames(fireEvent(revived, damagedTo(owner), deps))).toEqual(["card_drawn"]);

  // ★ 反向：从**烧之前**的状态克隆一份，它必须还能再烧一次 —— 记账若挂在模块级
  //   Set / 全局表（按实体 id 索引）上，这里会少一条。那种实现连 MCTS 都会串味
  //   （`resolve/deps.ts` 文件头反对模块级注册表的同一条理由）。
  const parallel = cloneState(start);
  expect(eventNames(fireEvent(parallel, damagedTo(owner), deps))).toEqual([
    "card_drawn",
    "card_drawn",
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// `zone`：订阅者不在那个区就不订阅
// ═══════════════════════════════════════════════════════════════════════════

const HAND_WATCHER: Card = scriptCard("T_HAND_WATCHER", {
  triggers: [{ on: "damaged", zone: "hand", do: [DRAW_ONE] }],
});
const BOARD_WATCHER: Card = scriptCard("T_BOARD_WATCHER", {
  // 不写 `zone` ⇒ 默认 `"board"`（IR v1 §4.1）。
  triggers: [{ on: "damaged", do: [DRAW_ONE] }],
});

test("zone：手牌触发器只在手里生效，board 触发器只在场上生效", () => {
  const deps = cardDeps([HAND_WATCHER, BOARD_WATCHER]);
  const state = openGame();
  // 四个订阅者 = 两张卡 × 两个区域，而且**该响的两个都在 p0、不该响的两个都在 p1**——
  // 于是"响了几条"与"是谁响的"由两个独立的读数（p0 / p1 各抽了几张）分别钉住。
  // 少了这层分侧，"zone 默认值取错"会与"zone 判对了"读出同样的条数。
  putCardInHand(state, 0, HAND_WATCHER, { atk: 0, health: 9 }); // 手牌里的手牌触发器 ⇒ 响
  putCard(state, 0, 0, BOARD_WATCHER, { atk: 0, health: 9 }); // 场上的 board 触发器 ⇒ 响
  const decoy = putCard(state, 1, 0, HAND_WATCHER, { atk: 0, health: 9 }); // 上了场 ⇒ 不响
  putCardInHand(state, 1, BOARD_WATCHER, { atk: 0, health: 9 }); // 还在手里 ⇒ 不响
  const before: [number, number] = [handSize(state, 0), handSize(state, 1)];

  // 事件本身与订阅者无关（这些触发器都没有 filter），随便打谁都行。
  const events = fireEvent(state, damagedTo(decoy), deps);

  // ★ 恰好 2 条，且**全部落在 p0**：
  //   zone 判定被跳过 → 4 条（p0 两张、p1 两张）；
  //   默认值取成 "hand" → 仍然 2 条，但换成了另外两个宿主 ⇒ p1 也会抽到。
  expect(eventNames(events)).toEqual(["card_drawn", "card_drawn"]);
  expect(handSize(state, 0)).toBe(before[0] + 2);
  expect(handSize(state, 1)).toBe(before[1]);
});

test("zone：默认值是 board —— 只待在手里的 board 触发器不响", () => {
  const deps = cardDeps([BOARD_WATCHER]);
  const state = openGame();
  const inHand = putCardInHand(state, 0, BOARD_WATCHER, { atk: 0, health: 9 });

  // 场上一个订阅者都没有 ⇒ 一条都不排。默认值若取成 `"hand"`（或干脆不判 zone），
  // 这里会抽到一张。
  expect(eventNames(fireEvent(state, damagedTo(inHand), deps))).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// `deathrattle`：`{on:"unit_died", filter:{target:SELF}, zone:"graveyard"}` 的糖
// ═══════════════════════════════════════════════════════════════════════════

const LOOTER: Card = scriptCard("T_LOOTER", { deathrattle: [DRAW_ONE] });
/** 与 {@link LOOTER} 同形但**写成 board 触发器**：它证明 `zone:"graveyard"` 是必要的。 */
const BOARD_DEATHRATTLE: Card = scriptCard("T_BOARD_DR", {
  triggers: [
    { on: "unit_died", filter: { target: { op: "sel.self" } }, zone: "board", do: [DRAW_ONE] },
  ],
});

test("deathrattle：展开成 unit_died + target:SELF + graveyard，别人死不算数", () => {
  const deps = cardDeps([LOOTER]);
  const state = openGame();
  const looter = putCard(state, 0, 0, LOOTER, { atk: 0, health: 1 });
  const other = putUnit(state, 0, 1, { atk: 0, health: 1 });
  const third = putUnit(state, 0, 2, { atk: 0, health: 1 });
  const before = handSize(state, 0);

  // 先杀别人（looter 还在场上）：`zone:"graveyard"` 就已经把它挡住了 ⇒ 不该响。
  expect(handSize(runActs(state, [hitAct(other, 5)], other, deps).state, 0)).toBe(before);

  // 杀它自己：亡语响，而且排在 `unit_died` **之后**（触发只入栈，时序规则 2）。
  const own = runActs(state, [hitAct(looter, 5)], looter, deps);
  expect(eventNames(own.events)).toEqual(["damaged", "unit_died", "card_drawn"]);
  expect(getEntity(own.state, looter)?.zone).toBe("p0:graveyard");

  // ★ 关键的一条：looter **已经躺在墓地里**，此时再死一个别人。
  //   展开时漏掉 `filter:{target:SELF}` 的实现在这里会再抽一张 ——
  //   而上面那两条都拦不住它（它们分别被 zone 与"target 恰好就是自己"掩盖了）。
  const afterOwn = handSize(own.state, 0);
  const stranger = runActs(own.state, [hitAct(third, 5)], third, deps);
  expect(eventNames(stranger.events)).toEqual(["damaged", "unit_died"]);
  expect(handSize(stranger.state, 0)).toBe(afterOwn);
});

test("deathrattle：同形但写成 zone:board 的触发器不会响（死后已经不在场上）", () => {
  const deps = cardDeps([BOARD_DEATHRATTLE]);
  const state = openGame();
  const unit = putCard(state, 0, 0, BOARD_DEATHRATTLE, { atk: 0, health: 1 });
  const before = handSize(state, 0);

  const step = runActs(state, [hitAct(unit, 5)], unit, deps);

  // `deaths.ts` 先搬墓地、后发 `unit_died`，所以匹配时它已经在 graveyard ——
  // 一条 `zone:"board"` 的触发器于是落空。这正是亡语必须写 `"graveyard"` 的原因，
  // 也说明区域判定读的是**当下**的区域，而不是"事件发生时它在哪"。
  expect(handSize(step.state, 0)).toBe(before);
  expect(eventNames(step.events)).toEqual(["damaged", "unit_died"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 第二个订阅来源：附魔自带的 `script.triggers`（IR v1 §2.3）
// ═══════════════════════════════════════════════════════════════════════════

const WATCHFUL_ENCH: Enchantment = {
  id: "T_WATCHFUL_e",
  attachesTo: "minion",
  duration: "permanent",
  script: { triggers: [{ on: "damaged", do: [DRAW_ONE] }] },
};
/** 一张**自己没有任何触发器**的卡：附魔挂上去之后它才开始订阅。 */
const BLANK: Card = scriptCard("T_BLANK", {});

test("附魔自带的 script.triggers 也是订阅来源", () => {
  const deps = cardDeps([BLANK], [WATCHFUL_ENCH]);
  const state = openGame();
  const host = putCard(state, 0, 0, BLANK, { atk: 0, health: 9 });
  const bare = putCard(state, 0, 1, BLANK, { atk: 0, health: 9 });

  // 挂附魔之前：卡本身没有触发器 ⇒ 一条都不排。
  expect(eventNames(fireEvent(cloneState(state), damagedTo(bare), deps))).toEqual([]);

  // 走真 `act.buff`（与匹配读的是**同一张** `deps.enchantments` 表），
  // 而不是手写 `entity.enchantments` —— 那样就绕开了"附魔是怎么挂上去的"这一半。
  const buffed = runActs(
    state,
    [{ op: "act.buff", target: { op: "sel.entity", id: host }, ench: WATCHFUL_ENCH.id }],
    host,
    deps,
  );
  expect(getEntity(buffed.state, host)?.enchantments).toHaveLength(1);

  // ★ 挂上之后同一条事件就有订阅者了，而且只有挂着的那一个响（`bare` 没挂）。
  //   漏掉附魔这一支的实现在这里读到 0 条。
  expect(eventNames(fireEvent(buffed.state, damagedTo(bare), deps))).toEqual(["card_drawn"]);
});

/** 卡与附魔**各有一条下标 0 的 `once` 触发器** —— 用来钉住 `firedOnce` 的键不会撞。 */
const ONCE_CARD: Card = scriptCard("T_ONCE_CARD", {
  triggers: [{ on: "damaged", once: true, do: [DRAW_ONE] }],
});
const ONCE_ENCH: Enchantment = {
  id: "T_ONCE_e",
  attachesTo: "minion",
  duration: "permanent",
  script: { triggers: [{ on: "damaged", once: true, do: [DRAW_ONE] }] },
};

test("once 的记账键带来源前缀：卡与附魔的第 0 条互不干扰", () => {
  const deps = cardDeps([ONCE_CARD], [ONCE_ENCH]);
  const state = openGame();
  const host = putCard(state, 0, 0, ONCE_CARD, { atk: 0, health: 9 });
  const buffed = runActs(
    state,
    [{ op: "act.buff", target: { op: "sel.entity", id: host }, ench: ONCE_ENCH.id }],
    host,
    deps,
  );

  // ★ 第一次两条都要响。键若只用"声明下标"（两条都是 0），先记账的那条会把另一条
  //   一起烧掉，这里就只有 1 条 —— 而两条 `once` 恰好同下标是很容易撞上的形态。
  expect(eventNames(fireEvent(buffed.state, damagedTo(host), deps))).toEqual([
    "card_drawn",
    "card_drawn",
  ]);
  expect(getEntity(buffed.state, host)?.firedOnce).toEqual([
    "triggers.0",
    `${ONCE_ENCH.id}.triggers.0`,
  ]);
  // 第二次两条都不再响。
  expect(eventNames(fireEvent(buffed.state, damagedTo(host), deps))).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// `do` 是 `Act[]`：按数组下标升序执行（IR v1 §5.4 规则 2）
// ═══════════════════════════════════════════════════════════════════════════

const TWO_STEP: Card = scriptCard("T_TWO_STEP", {
  triggers: [
    {
      on: "healed",
      do: [
        { op: "act.hit", target: { op: "sel.opponent" }, amount: 1 },
        { op: "act.hit", target: { op: "sel.opponent" }, amount: 2 },
      ],
    },
  ],
});

test("do 的多条动作按数组下标升序执行", () => {
  const deps = cardDeps([TWO_STEP]);
  const state = openGame();
  const watcher = putCard(state, 0, 0, TWO_STEP, { atk: 0, health: 9 });

  const events = fireEvent(
    state,
    { name: "healed", source: null, target: watcher, amount: 1 },
    deps,
  );

  // 顺序写反（少了 `push.ts` 那次 LIFO 反转）的实现会读到 [2, 1]。
  expect(damageAmounts(events)).toEqual([1, 2]);
  expect(damageOf(state, baseIdOf(state, 1))).toBe(3);
});

// ═══════════════════════════════════════════════════════════════════════════
// 端到端的时序规则 1：当前回合玩家优先，同方按 playOrder 升序
// ═══════════════════════════════════════════════════════════════════════════

/** 每当有出手发生，就往自己对面的基地上敲 1 点 —— `damaged.source` 因此就是宿主 id。 */
const ECHO: Card = scriptCard("T_ECHO", {
  triggers: [{ on: "struck", do: [{ op: "act.hit", target: { op: "sel.opponent" }, amount: 1 }] }],
});

test("规则 1 端到端：真触发器按「当前回合玩家优先 → playOrder 升序」排队", () => {
  const deps = cardDeps([ECHO]);
  const state = openGame(); // p0 先手且持有 priority
  // 摆放顺序即 playOrder 升序：mine1 → theirs → mine2（故意交错，好把两级键分开）。
  const mine1 = putCard(state, 0, 0, ECHO, { atk: 0, health: 9 });
  const theirs = putCard(state, 1, 0, ECHO, { atk: 0, health: 9 });
  const mine2 = putCard(state, 0, 1, ECHO, { atk: 0, health: 9 });
  const attacker = putUnit(state, 0, 4, { atk: 2, health: 9 });
  const dummy = putUnit(state, 1, 4, { atk: 0, health: 20 });

  const echoesOf = (events: readonly GameEvent[]): (EntityId | null)[] =>
    damageSources(events).filter((id) => id !== attacker);

  // ★ p0 持有 priority ⇒ p0 的两个排在前面，同方按 playOrder 升序（mine1 先上场）。
  //   排序被跳过的实现会读到枚举顺序 [mine1, theirs, mine2] —— 一眼可辨。
  expect(echoesOf(strikeNow(state, attacker, dummy, deps).events)).toEqual([mine1, mine2, theirs]);

  // 换手之后整体翻面：同一批触发器，只是 `priority` 变了（`activePlayer` 的口径）。
  const flipped = cloneState(state);
  flipped.priority = 1;
  expect(echoesOf(strikeNow(flipped, attacker, dummy, deps).events)).toEqual([
    theirs,
    mine1,
    mine2,
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 字典序的**外层键**：一次调用之内按「事件发出序」排（内层键才是时序规则 1）
// ═══════════════════════════════════════════════════════════════════════════
// `queueTriggers` 声明的不变量是「外层键 = `events` 的数组顺序、内层键 = 时序规则 1」。
// 上面那条端到端只喂**一条**事件，钉的全是内层键；外层键要靠这里。
//
// ⚠ 判别力靠的是「一次调用喂多条事件」+「两条事件各自匹配出**不同**的动作」：
//   `collectOrderedTriggers` 的事件遍历若被反过来写，这里读到的两个数字会对调。

/** 两条订阅**不同事件**的触发器，动作数值刻意不同 —— 于是"谁先跑"是可区分的读数。 */
const TWO_EVENT_WATCHER: Card = scriptCard("T_TWO_EVENTS", {
  triggers: [
    { on: "healed", do: [{ op: "act.hit", target: { op: "sel.opponent" }, amount: 7 }] },
    { on: "card_drawn", do: [{ op: "act.hit", target: { op: "sel.opponent" }, amount: 3 }] },
  ],
});

test("★ 一次调用喂多条事件：触发顺序跟着**事件发出序**（外层键）", () => {
  const deps = cardDeps([TWO_EVENT_WATCHER]);
  const start = openGame();
  const watcher = putCard(start, 0, 0, TWO_EVENT_WATCHER, { atk: 0, health: 9 });
  const healed: RuleEvent = { name: "healed", source: null, target: watcher, amount: 1 };
  const drawn: RuleEvent = {
    name: "card_drawn",
    player: baseIdOf(start, 0),
    target: watcher,
    cardId: "A1",
  };

  // 两条事件在**同一次** `queueTriggers` 里，于是先后完全由外层键决定。
  const forward = cloneState(start);
  queueTriggers(forward, [healed, drawn], deps);
  // ★ 事件遍历被反过来写的实现会读到 [3, 7]。
  expect(damageAmounts(resolve(forward, deps))).toEqual([7, 3]);

  // ★ 反向喂同样两条：读数必须跟着对调。少了这一半，任何**与喂入顺序无关的固定顺序**
  //   都能让上面那行绿（按事件名排、按触发器的声明下标排…，`healed` 恰好都排在前面）。
  //   实测：把事件按名字倒序排一遍（"healed" > "card_drawn"）只红下面这一行。
  const backward = cloneState(start);
  queueTriggers(backward, [drawn, healed], deps);
  expect(damageAmounts(resolve(backward, deps))).toEqual([3, 7]);
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 跨**波**的触发顺序：`processDeaths` 的不动点循环同样只入栈一次
// ═══════════════════════════════════════════════════════════════════════════
// 与 `rules/__tests__/combat.test.ts` 的「跨批次」那一节是**同一个**缺陷的另一处实例：
// 死亡结算要跑到不动点，期间会经历多**波**，而结算栈是 LIFO —— 逐波入栈让第 2 波的亡语
// 跑在第 1 波之前。`resolve/deaths.ts` 因此逐波只匹配 + 排序（`collectOrderedTriggers`），
// 循环结束后才 `enqueueTriggers` 一次。
//
// 造出第 2 波的手段是**掉光环致死**（这条机制本身由 `__tests__/auras.test.ts` 钉住）：
// 光环源阵亡 ⇒ 下一轮开头那次重算把它撑起来的血量上限掉回去 ⇒ 跟班在第 2 波被判死。
// 两条亡语的伤害数值刻意不同，"谁先结算"于是是一个可区分的读数。

/** 友方战线（不含自己）—— 光环的受影响集合（`sel.zone` 的 side 相对 SELF，IR v1 §3.1）。 */
const OTHER_FRIENDLIES: Sel = {
  op: "sel.minus",
  of: { op: "sel.zone", side: "friendly", zone: "board" },
  exclude: { op: "sel.self" },
};

/** 第 1 波的死者：活着时给友军 +2 血量上限；亡语往对面基地敲 3 点。 */
const WARDEN: Card = scriptCard("T_WARDEN", {
  auras: [{ affects: OTHER_FRIENDLIES, mods: { health: 2 } }],
  deathrattle: [{ op: "act.hit", target: { op: "sel.opponent" }, amount: 3 }],
});

/** 第 2 波的死者：它扛得住那 2 点伤害全靠 WARDEN 撑着；亡语敲 7 点。 */
const FOLLOWER: Card = scriptCard("T_FOLLOWER", {
  deathrattle: [{ op: "act.hit", target: { op: "sel.opponent" }, amount: 7 }],
});

test("★ 跨波的触发顺序：第 1 波的亡语先于第 2 波（不是「后排队的先跑」）", () => {
  const deps = cardDeps([WARDEN, FOLLOWER]);
  const state = openGame();
  const warden = putCard(state, 0, 0, WARDEN, { atk: 0, health: 2 });
  const follower = putCard(state, 0, 1, FOLLOWER, { atk: 0, health: 1 });

  // 先给 follower 吃满 2 点：生效血量 1+2=3，光环还在就扛得住。
  const softened = runActs(state, [hitAct(follower, 2)], warden, deps).state;
  expect(tagOf(softened, follower, "health")).toBe(3);
  expect(damageOf(softened, follower)).toBe(2);

  // 一步打死 warden：第 1 波它自己走，第 2 波 follower 掉了 +2 上限跟着走。
  const step = runActs(softened, [hitAct(warden, 2)], follower, deps);

  // 两波的 `unit_died` 都排在两条亡语之前（触发只入栈不执行，时序规则 2）。
  expect(eventNames(step.events)).toEqual([
    "damaged",
    "unit_died",
    "unit_died",
    "damaged",
    "damaged",
  ]);
  // ★ 本条的判别力：两条亡语必须是**第 1 波的在前**。
  //   逐波入栈（LIFO ⇒ 后压的先跑）会读到 [2, 7, 3]。
  expect(damageAmounts(step.events)).toEqual([2, 3, 7]);
  // 两条亡语真的落地了 —— 否则上面那串顺序断言可能是在验一组根本没发生的事。
  expect(damageOf(step.state, baseIdOf(step.state, 1))).toBe(3 + 7);
});

// ═══════════════════════════════════════════════════════════════════════════
// 相位机那条接缝：不经 handler 的事件也要能触发（`rules/phase.ts` 的 `runStep`）
// ═══════════════════════════════════════════════════════════════════════════

const ON_CARD_PLAYED: Card = scriptCard("T_ON_PLAY", {
  triggers: [{ on: "card_played", do: [DRAW_ONE] }],
});

test("相位机产的事件同样进触发器，且「排队在前、压栈在后」", () => {
  const deps = cardDeps([ON_CARD_PLAYED]);
  const state = openGame();
  putCard(state, 0, 0, ON_CARD_PLAYED, { atk: 0, health: 9 });
  const inHand = handOf(state, 0)[0];
  expect(inHand).toBeDefined();
  if (inHand === undefined) {
    return;
  }

  const step = playCard(state, inHand, 5, deps);

  // ★ 两件事一起钉住：
  //   1. `card_played` 由**相位机**（不是 handler）发出。`runStep` 里那次
  //      `queueTriggers` 不调、或忘了把 `deps` 传下去，就没有 `card_drawn` ——
  //      这条接缝没有任何编译期防线（`phase.ts` 的 `runStep` 文件注释点名说了）。
  //   2. `unit_summoned`（这一步**自己的**动作）排在 `card_drawn`（它引发的触发器）
  //      **之前** —— 即"排队在前、压栈在后"，LIFO 之下等价于时序规则 2。
  //      两行调换的实现会读到 `card_drawn` 在 `unit_summoned` 之前。
  expect(eventNames(step.events)).toEqual([
    "action_taken",
    "card_played",
    "unit_summoned",
    "card_drawn",
  ]);
});
