// ★★★ 字段声明顺序即求值顺序（IR v1 §5.4 规则 1）—— 动作层的对照测试 ★★★
//
// 规范原文：一个动作的字段按签名中的**声明顺序**求值，`act.hit(target, amount)`
// → 先 target 后 amount。`ir/src/types/act.ts` 的文件头把这条钉成了硬约束：
// 「下面每个成员的字段顺序与规范签名逐字对齐，**不许重排**」。
//
// ═══════════════════════════════════════════════════════════════════════════
// 为什么这条必须由测试守，而不是由"读一遍 handler"守
// ═══════════════════════════════════════════════════════════════════════════
// 顺序错了**不会**红任何一条常规断言：目标打对了、单位召出来了、事件条数也对 ——
// 唯一的症状是**同一颗种子跑出另一份对局**。而回放对不上时，人第一反应是怀疑 RNG
// 算法或洗牌，不会怀疑某个 handler 里两行代码的先后。所以判据只能是
// `engine.random_picked`（`rollInt` 与它一一对应，见 `events/event.ts`）：
//   - **条数**  —— 前面的字段判出「整个动作跳过」时，后面的字段一次都不该求值；
//   - **origin 序列** —— 两个字段都推进 RNG 时，谁先谁后。
//
// ═══════════════════════════════════════════════════════════════════════════
// 两个被钉住的 handler
// ═══════════════════════════════════════════════════════════════════════════
//   act.hit{target, amount}              damage.ts —— 空目标 ⇒ `amount` 连求都不求
//   act.summon{player, card, at, count?} summon.ts —— 四个字段逐个排队
//
// `act.summon.at` 是**位置参数**，由 `resolve/act-slots.ts` 的惰性解析器提供 ——
// 它做成惰性的全部理由就是这一条规则（那个文件头有完整论证）。
// 解析器自己的性质（惰性、记忆化、无效槽跳过）在 `resolve/__tests__/act-slots.test.ts`。
//
// 盘面一律走 `testkit`，本文件**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1）。

import { expect, test } from "bun:test";
import type { Act, CardData, CardId, EntityId, Sel, SlotRef } from "@prismfront/ir";
import type { CardLookup } from "../../eval/index.ts";
import type { GameEvent } from "../../events/index.ts";
import { isEngineEvent } from "../../events/index.ts";
import type { ResolveDeps } from "../../resolve/index.ts";
import type { GameState } from "../../state/index.ts";
import { openGame, putUnit, runActs } from "../../testkit/index.ts";
import { ACT_HANDLERS } from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════════════════

const CONTROLLER: Sel = { op: "sel.controller" };
const ENEMY_BOARD: Sel = { op: "sel.zone", side: "enemy", zone: "board" };
const FRIENDLY_BOARD: Sel = { op: "sel.zone", side: "friendly", zone: "board" };

/** 必定推进一次 RNG 的数值（lo === hi 也照抽，`rollInt` 与事件一一对应）。 */
const RANDOM_NUM = { op: "num.random", lo: 2, hi: 2 } as const;
/** 必定推进一次 RNG 的位置（战线上有空格时）。 */
const RANDOM_SLOT: SlotRef = { op: "slot.random_empty", side: "friendly" };

/**
 * 一张认得**任何** cardId 的卡表。
 *
 * `act.summon` 查不到卡面就在 `card` 的位置上返回（`summon.ts` 文件头），
 * 那样 `at` 根本轮不到求值 —— 本文件要测的是字段顺序，不是"卡表缺不缺"，
 * 所以这里让卡表永远命中，把那条无关的短路彻底排除掉。
 */
const ANY_CARD: CardLookup = (cardId: CardId): CardData | undefined => ({
  name: { zh: `测试卡 ${cardId}` },
  kind: "minion",
  colors: ["green"],
  tags: { atk: 1, health: 2 },
});

const BUNDLE_DEPS: ResolveDeps = { handlers: ACT_HANDLERS, cards: ANY_CARD };

/** 开局 + p0 的 0 号格一个 2/9 当 SELF；`enemies` 个敌方 1/9 摆在对面。 */
function board(enemies = 0): { state: GameState; self: EntityId } {
  const state = openGame();
  const self = putUnit(state, 0, 0, { atk: 2, health: 9 });
  for (let slot = 0; slot < enemies; slot += 1) {
    putUnit(state, 1, slot, { atk: 1, health: 9 });
  }
  return { state, self };
}

/** 这一段事件流里每一次 RNG 推进的来源，**按发生顺序**。 */
function rngOrigins(events: readonly GameEvent[]): string[] {
  return events.filter(isEngineEvent).map((event) => event.origin);
}

/**
 * **动作自己的**事件名序列（断言"动作到底做没做成"用）。
 *
 * 滤掉 `engine.*`：那是随机审计事件，与"这个动作发生了什么"不是一回事
 * （IR v1 §5.2 说的「不产生事件」指的也是前者，见 `resolve/act-slots.ts` 文件头）。
 * 它们由 {@link rngOrigins} 单独断言。
 */
function names(events: readonly GameEvent[]): string[] {
  return events.filter((event) => !isEngineEvent(event)).map((event) => event.name);
}

function run(state: GameState, act: Act, self: EntityId, deps = BUNDLE_DEPS) {
  return runActs(state, [act], self, deps);
}

// ═══════════════════════════════════════════════════════════════════════════
// ★ act.hit{target, amount}：空目标 ⇒ amount 连求都不求
// ═══════════════════════════════════════════════════════════════════════════

test("★ act.hit：target 求值为空 ⇒ 整个动作跳过，且 amount 一次 RNG 都不抽", () => {
  // `damage.ts` 与 `targets.ts` 都明文写着这件事（「打空气」不该平白推进一次 RNG），
  // 但在这条测试之前**没有任何断言守着它** —— 把 `evalNum` 挪到空目标判断之前，
  // 整个测试套件照样全绿。这就是它存在的理由。
  const { state, self } = board(0); // 敌方战线空着 ⇒ target 为空集

  const step = run(state, { op: "act.hit", target: ENEMY_BOARD, amount: RANDOM_NUM }, self);

  expect(names(step.events)).toEqual([]);
  expect(rngOrigins(step.events)).toEqual([]);
});

test("对照：target 非空时 amount 照求，恰好抽一次（打 3 个也只抽一次 —— 规则 1）", () => {
  const { state, self } = board(3);

  const step = run(state, { op: "act.hit", target: ENEMY_BOARD, amount: RANDOM_NUM }, self);

  expect(names(step.events)).toEqual(["damaged", "damaged", "damaged"]);
  expect(rngOrigins(step.events)).toEqual(["num.random"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ act.summon{player, card, at, count?}：四个字段逐个排队
// ═══════════════════════════════════════════════════════════════════════════

test("★ act.summon：player 求值为空 ⇒ 整个动作跳过，at 一次 RNG 都不抽", () => {
  // 这是本轮 review 抓到的那个缺陷的最小复现：`at` 曾经由派发层抢在 handler 之前求值，
  // 于是这里会出现 0 条 `unit_summoned` + **1 条** `engine.random_picked` ——
  // 同一个引擎里 `act.hit` 打空气一次都不抽，`act.summon` 却抽了，自相矛盾。
  const { state, self } = board(0); // 敌方战线空着 ⇒ player 为空集

  const step = run(
    state,
    { op: "act.summon", player: ENEMY_BOARD, card: "ANY", at: RANDOM_SLOT },
    self,
  );

  expect(names(step.events)).toEqual([]);
  expect(rngOrigins(step.events)).toEqual([]);
});

test("对照：player 非空时 at 照求，恰好抽一次并真的召唤出来", () => {
  const { state, self } = board(0);

  const step = run(
    state,
    { op: "act.summon", player: CONTROLLER, card: "ANY", at: RANDOM_SLOT },
    self,
  );

  expect(names(step.events)).toEqual(["unit_summoned"]);
  expect(rngOrigins(step.events)).toEqual(["slot.random_empty"]);
});

test("★ act.summon：card 排在 at 前面 ⇒ 先抽牌、后抽格子", () => {
  // 「召唤一张随机牌到随机空格」——`card.random` 与 `slot.random_empty` 都推进 RNG，
  // 于是这两条 `engine.random_picked` 的**先后**就是签名顺序的可观测形态。
  // 旧实现（派发层预先求 `at`）在这里给出的是反过来的序列。
  const { state, self } = board(2); // 敌方两个单位 ⇒ card.random 的候选池有两张不同的卡

  const step = run(
    state,
    {
      op: "act.summon",
      player: CONTROLLER,
      card: { op: "card.random", from: ENEMY_BOARD },
      at: RANDOM_SLOT,
    },
    self,
  );

  expect(names(step.events)).toEqual(["unit_summoned"]);
  expect(rngOrigins(step.events)).toEqual(["card.random", "slot.random_empty"]);
});

test("★ act.summon：count 排在 at 后面 ⇒ 先抽格子、再抽轮数（后续单位各自再抽一次）", () => {
  // `count` 在签名里是最后一个字段（`{player, card, at, count?}`），所以它最后求值。
  // 尾巴上那一条 `slot.random_empty` 是 v2 §3.4 的「**每个后续单位重新求值 `at`**」——
  // 第 1 个用刚拉到的那一份，第 2 个自己再抽一次，两件事在同一条序列里都看得见。
  const { state, self } = board(0);

  const step = run(
    state,
    { op: "act.summon", player: CONTROLLER, card: "ANY", at: RANDOM_SLOT, count: RANDOM_NUM },
    self,
  );

  expect(names(step.events)).toEqual(["unit_summoned", "unit_summoned"]);
  expect(rngOrigins(step.events)).toEqual(["slot.random_empty", "num.random", "slot.random_empty"]);
});

test("★ act.summon：「后续单位」跨玩家连续计数，第 2 个玩家的第 1 个单位照样重求 at", () => {
  // v2 §3.4 的「每个**后续单位**重新求值 `at`」按**召唤出的单位**计数，不按 `count` 下标。
  // `player` 解析出两个玩家（`side:"both"` 的战线 → 两个控制者）时，总共召唤 2 个单位，
  // 于是必须抽 **2** 次：第 1 个用拉到的那一份，第 2 个（= 下一个玩家的第 1 个）自己再抽。
  //
  // 这条钉的是 `summon.ts` 里那个开关放在**双层循环之外**。写成内层的 `i === 0`
  // 会让每个玩家的第 1 个单位都复用同一份记忆化的 `at` ⇒ 这里只剩 1 条 origin，
  // 两个单位还会落到同一个 index 上。
  const { state, self } = board(1);

  const step = run(
    state,
    {
      op: "act.summon",
      player: { op: "sel.zone", side: "both", zone: "board" },
      card: "ANY",
      at: RANDOM_SLOT,
    },
    self,
  );

  expect(names(step.events)).toEqual(["unit_summoned", "unit_summoned"]);
  expect(rngOrigins(step.events)).toEqual(["slot.random_empty", "slot.random_empty"]);
});

test("★ act.summon：card 求值为空 ⇒ 后面的 at / count 一个都不求", () => {
  // `card.of(空集)` → `null` → 整个动作跳过（IR v1 §5.2 末行）。它排在 `at` 前面，
  // 所以后两个字段连求值的机会都没有 —— 与 `player` 为空是同一条规则的另一个位置。
  const { state, self } = board(0);

  const step = run(
    state,
    {
      op: "act.summon",
      player: CONTROLLER,
      card: { op: "card.of", of: ENEMY_BOARD },
      at: RANDOM_SLOT,
      count: RANDOM_NUM,
    },
    self,
  );

  expect(names(step.events)).toEqual([]);
  expect(rngOrigins(step.events)).toEqual([]);
});

test("act.summon：at 解析为无效槽 ⇒ 动作跳过，排在它后面的 count 不再求值", () => {
  // 战线站满 ⇒ `slot.random_empty` 无空格 ⇒ 无效槽（且它自己一次都不抽，`eval/slot.ts`）。
  // 承重的是 `count`：它排在 `at` 之后，所以这里必须是**零**条随机。
  const state = openGame();
  const self = putUnit(state, 0, 0, { atk: 2, health: 9 });
  for (let slot = 1; slot < state.rules.board.slots; slot += 1) {
    putUnit(state, 0, slot, { atk: 1, health: 1 });
  }

  const step = run(
    state,
    { op: "act.summon", player: CONTROLLER, card: "ANY", at: RANDOM_SLOT, count: RANDOM_NUM },
    self,
  );

  expect(names(step.events)).toEqual([]);
  expect(rngOrigins(step.events)).toEqual([]);
  // 对照：同一条动作在有空格的盘面上会抽到随机（所以上面的"零条"不是夹具写坏了）。
  const roomy = board(0);
  const ok = run(
    roomy.state,
    { op: "act.summon", player: CONTROLLER, card: "ANY", at: RANDOM_SLOT, count: RANDOM_NUM },
    roomy.self,
  );
  expect(rngOrigins(ok.events)).toEqual(["slot.random_empty", "num.random", "slot.random_empty"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 夹具自检
// ═══════════════════════════════════════════════════════════════════════════

test("夹具自检：卡表命中任何 cardId（不然上面几条会在 card 那一步就提前退出）", () => {
  const { state, self } = board(0);
  const step = run(
    state,
    {
      op: "act.summon",
      player: CONTROLLER,
      card: { op: "card.of", of: FRIENDLY_BOARD },
      at: RANDOM_SLOT,
    },
    self,
  );
  expect(names(step.events)).toEqual(["unit_summoned"]);
});
