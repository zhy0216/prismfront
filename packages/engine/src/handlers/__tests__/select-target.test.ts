// `act.select_target` 的测试（M4/E6 —— 本目录第一个会**挂起**的 handler）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 被钉的四条性质
// ═══════════════════════════════════════════════════════════════════════════
// 1. 候选集非空 ⇒ 置上 `pendingInput`，结算**当场停住**，后面的动作一条都没跑；
// 2. 玩家回应之后，选择写进**栈顶条目**的 `ctx.chosen`（IR v1 §6.1）——
//    可观测形态就是"后面那条 `act.swap(TARGET, CHOSEN)` 真的换成了"；
// 3. 候选集为空 ⇒ **静默跳过、不挂起**（IR v1 §5.2）。这条是最要紧的一条：
//    挂一个没有候选项的选择点会把房间卡在一个谁都答不出的问题上；
// 4. 不在候选集里的回答被拒（`apply` 回 `invalid_choice`，不是抛异常）。
//
// 第 1、2 条合起来正是 PF1_B01 换位术能成立的全部前提，单卡测试在
// `packages/cards/src/pf1/B/blue.test.ts`；这里测的是**引擎侧的机制**，
// 与具体哪张卡无关（本文件一张真卡都不认识）。
//
// 盘面一律走 `testkit`，本文件**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1）。

import { expect, test } from "bun:test";
import type { Act, Card, Sel } from "@prismfront/ir";
import { apply } from "../../rules/index.ts";
import type { GameState } from "../../state/index.ts";
import {
  castCard,
  eventNames,
  openGame,
  putUnit,
  respondNow,
  runActs,
} from "../../testkit/index.ts";

/** 「没有实体」的哨兵 id（`state/create.ts`：实体 id 从 1 起，0 空出来当哨兵）。 */
const NO_ENTITY = 0;

// ═══════════════════════════════════════════════════════════════════════════
// 夹具：一张"换两个友方单位的位置"的法术（形状同 v2 §8.4，但不是任何一张真卡）
// ═══════════════════════════════════════════════════════════════════════════

const TARGET: Sel = { op: "sel.target" };
const CHOSEN: Sel = { op: "sel.chosen" };
const FRIENDLY_BOARD: Sel = { op: "sel.zone", side: "friendly", zone: "board" };
/** 第二目标的候选域：友方战线**减去**第一目标（同一个不能选两次）。 */
const OTHER_FRIENDLY: Sel = { op: "sel.minus", of: FRIENDLY_BOARD, exclude: TARGET };

/** `target` 声明成友方战线；`play` 是「再选一个 → 交换」。 */
const SWAP_SPELL: Card = {
  id: "TEST_SWAP",
  set: "pf1",
  data: { name: { zh: "试换" }, kind: "spell", cost: 1, colors: ["blue"], tags: {} },
  script: {
    target: FRIENDLY_BOARD,
    play: [
      { op: "act.select_target", from: OTHER_FRIENDLY },
      { op: "act.swap", a: TARGET, b: CHOSEN },
    ],
  },
};

/** 一张只有挂起点、后面什么都不接的法术（候选集为空时的对照）。 */
const LONELY_SPELL: Card = {
  ...SWAP_SPELL,
  id: "TEST_LONELY",
  script: { play: [{ op: "act.select_target", from: OTHER_FRIENDLY }] },
};

/** 开局 + 在 p0 的 0 / 4 号格各摆一个 1/1，返回两个 id。 */
function twoFriendlies(): { state: GameState; a: number; b: number } {
  const state = openGame();
  return {
    state,
    a: putUnit(state, 0, 0, { atk: 1, health: 1 }),
    b: putUnit(state, 0, 4, { atk: 1, health: 1 }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 挂起：候选集非空
// ═══════════════════════════════════════════════════════════════════════════

test("候选集非空 → 置上 pendingInput，后面的动作一条都没跑", () => {
  const { state, a, b } = twoFriendlies();
  const cast = castCard(state, SWAP_SPELL, { target: a });

  expect(cast.state.pendingInput).toEqual({
    player: 0,
    kind: "select_target",
    // 候选域是「友方战线减去第一目标」⇒ 只剩 b（`sel.zone` 按格序 0→8 枚举）。
    options: [b],
    optional: false,
    deadline: null,
  });
  // 挂起时 `act.swap` 还压在栈上，一次 `unit_moved` 都不该有。
  expect(eventNames(cast.events)).toEqual([]);
});

test("★ 回应之后栈顶接着跑 —— 选择写进 ctx.chosen，换位真的发生了", () => {
  const { state, a, b } = twoFriendlies();
  const cast = castCard(state, SWAP_SPELL, { target: a });
  const done = respondNow(cast.state, b);

  expect(done.state.pendingInput).toBeNull();
  expect(done.events.filter((event) => event.name === "unit_moved")).toEqual([
    { name: "unit_moved", target: a, fromSlot: 0, toSlot: 4 },
    { name: "unit_moved", target: b, fromSlot: 4, toSlot: 0 },
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. 静默跳过：候选集为空（IR v1 §5.2）
// ═══════════════════════════════════════════════════════════════════════════

test("★ 候选集为空 → 不挂起、不报错、什么都不发生", () => {
  // 场上只有第一目标自己，`sel.minus` 之后一个候选都不剩。
  const state = openGame();
  const only = putUnit(state, 0, 0, { atk: 1, health: 1 });
  const cast = castCard(state, LONELY_SPELL, { target: only });

  expect(cast.state.pendingInput).toBeNull();
  expect(cast.state.stack).toEqual([]);
  expect(eventNames(cast.events)).toEqual([]);
});

test("★ SELF 悬空（取不到控制者）→ 候选集非空也不挂起：没人可问", () => {
  // 悬空 SELF 是常态而不是错误（`eval/context.ts`：亡语里引用自己、实体入栈后离场都会走到）。
  // 候选域写成 `sel.entity`（运行时超集，不经侧别换算）才能在 SELF 悬空时仍然选出人来 ——
  // 于是这条路径唯一能停下的地方就是"该问谁"这一步。
  const state = openGame();
  const unit = putUnit(state, 0, 0, { atk: 1, health: 1 });
  const act: Act = { op: "act.select_target", from: { op: "sel.entity", id: unit } };

  const step = runActs(state, [act], NO_ENTITY);
  expect(step.state.pendingInput).toBeNull();
  expect(eventNames(step.events)).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. 回应的合法性（IR v1 §6.1，由 `resolve/suspend.ts` 校验）
// ═══════════════════════════════════════════════════════════════════════════

test("回一个不在候选集里的选择 → invalid_choice（是非法意图，不是引擎故障）", () => {
  const { state, a } = twoFriendlies();
  const cast = castCard(state, SWAP_SPELL, { target: a });

  // a 是第一目标，已经被 `sel.minus` 排除在候选集之外。
  const rejected = apply(cast.state, { t: "respond", player: 0, chosen: a });
  expect(rejected).toEqual({ ok: false, code: "invalid_choice" });
});

test("optional 缺省是 false ⇒ 不许放弃（放弃即 invalid_choice）", () => {
  const { state, a } = twoFriendlies();
  const cast = castCard(state, SWAP_SPELL, { target: a });

  expect(apply(cast.state, { t: "respond", player: 0, chosen: null })).toEqual({
    ok: false,
    code: "invalid_choice",
  });
});
