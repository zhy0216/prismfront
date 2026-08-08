// 动作的 SlotRef 参数与**无效槽语义**（DSL v2 §3.1）的验收测试 —— M4 任务书 E3。
//
// 被钉的性质有四条，都不是"函数返回了什么"，而是会随时间腐化的语义：
//   1. ★ **无效槽 ⇒ 该动作静默跳过**：handler 不落地、不发事件、流水线照常继续下一条。
//      六种无效来源逐条测：`slot.at` 越界 / `slot.of` 非单实体 / `slot.of` 不在场 /
//      `slot.shift` 出界 / `slot.random_empty` 无空格 / `slot.first_empty` 无空格。
//   2. ★ **位置参数是惰性的**：handler 不拉就不求值 —— 这是「字段按签名声明顺序求值」
//      （IR v1 §5.4 规则 1）的兑现方式，被跳过的动作因此不会白烧一次 RNG。
//      动作层的顺序断言在 `handlers/__tests__/field-order.test.ts`。
//   3. ★ **拉了也只求值一次**（记忆化，`act-slots.ts` 文件头 (b)）。判据不是"落在哪一格"，
//      而是 `engine.random_picked` 的**条数** —— 拉两次结果照样可能"看起来对"，
//      但 RNG 多推进了一格，回放从此失真。
//   4. **格子数量读 `RulesConfig.board.slots`**，不是写死的 9。
//
// 盘面一律走 `testkit`（`openGame` / `putUnit` / `runActs`），不写状态字面量。

import { expect, test } from "bun:test";
import type { Act, ActOp, EntityId, Num, RulesConfig, Sel, SlotRef } from "@prismfront/ir";
import type { EvalEnv, SlotAddr } from "../../eval/index.ts";
import { createEvalEnv, evalCond } from "../../eval/index.ts";
import type { GameEvent } from "../../events/index.ts";
import { isEngineEvent } from "../../events/index.ts";
import { NO_DEPS, NO_HANDLERS } from "../../handlers/index.ts";
import { DEFAULT_RULES } from "../../rules/index.ts";
import type { GameState, PlayerId } from "../../state/index.ts";
import { createCtx } from "../../state/index.ts";
import { handOf, openGame, putUnit, runActs } from "../../testkit/index.ts";
import type { HandlerTable, ResolveDeps } from "../index.ts";
import { isActSkipped, NO_ACT_SLOTS, resolveActSlots } from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════════════════

const SELF: Sel = { op: "sel.self" };
const CONTROLLER: Sel = { op: "sel.controller" };
const FRIENDLY_BOARD: Sel = { op: "sel.zone", side: "friendly", zone: "board" };

const at = (side: "friendly" | "enemy", index: Num): SlotRef => ({ op: "slot.at", side, index });

/** 一条 `act.summon`：位置参数是 `at`，`card` / `player` 与本文件的断言无关。 */
const summon = (to: SlotRef): Act => ({
  op: "act.summon",
  player: CONTROLLER,
  card: "TOKEN_01",
  at: to,
});

/** 一条 `act.move_to`：位置参数是 `to`。 */
const moveTo = (to: SlotRef): Act => ({ op: "act.move_to", target: SELF, to });

/** handler 真的跑起来时记下的落点（`op` 一起记，免得两条动作串味）。 */
interface Landing {
  readonly op: ActOp;
  readonly player: PlayerId;
  readonly index: number;
}

/**
 * 一张只认两个带位置参数的 op 的 handler 表：把拿到的坐标记进 `landed`。
 *
 * ★ 第三个参数 `slots` 是位置参数的**惰性解析器**：字段非可选（一定取得到），
 * 但取出来可能是 `null` = 无效槽。所以两个 handler 各写**一行**
 * `if (isActSkipped(...)) return;` —— 判据本身来自 `act-slots.ts`，
 * handler 侧不重新发明"什么算无效"，也不自己缓存（记忆化在解析器里）。
 * 真 handler 长什么样见 `handlers/summon.ts`。
 */
function tracingDeps(): { deps: ResolveDeps; landed: Landing[] } {
  const landed: Landing[] = [];
  const record = (op: ActOp, addr: SlotAddr): void => {
    landed.push({ op, player: addr.player, index: addr.index });
  };
  const handlers: HandlerTable = {
    ...NO_HANDLERS,
    "act.summon": (_env, _act, slots) => {
      const at = slots.at();
      if (isActSkipped(at)) {
        return;
      }
      record("act.summon", at);
    },
    "act.move_to": (_env, _act, slots) => {
      const to = slots.to();
      if (isActSkipped(to)) {
        return;
      }
      record("act.move_to", to);
    },
  };
  return { deps: { handlers }, landed };
}

/** 这一段事件流里 `engine.random_picked` 的条数 = RNG 推进了几次（见文件头第 2 条）。 */
function rngDraws(events: readonly GameEvent[]): number {
  return events.filter(isEngineEvent).length;
}

/** 开局 + 在 p0 的第 `slot` 格摆一个 1/1 当 SELF，返回状态与它的 id。 */
function opened(slot = 0, rules?: RulesConfig): { state: GameState; self: EntityId } {
  const state = openGame(rules === undefined ? {} : { rules });
  return { state, self: putUnit(state, 0, slot, { atk: 1, health: 1 }) };
}

/** 把 p0 的 `[from, to)` 这几格填满（造"没有空格"与"只剩某几格"的盘面）。 */
function fill(state: GameState, from: number, to: number): void {
  for (let slot = from; slot < to; slot += 1) {
    putUnit(state, 0, slot, { atk: 1, health: 1 });
  }
}

/** 求值环境：SELF = `self`，卡表缺省（本文件的位置表达式一个都不读卡面）。 */
function envOf(state: GameState, self: EntityId): EvalEnv {
  return createEvalEnv(state, createCtx(self));
}

// ═══════════════════════════════════════════════════════════════════════════
// 有位置参数 / 没位置参数
// ═══════════════════════════════════════════════════════════════════════════

test("没有位置参数的动作照常执行（30 个 act op 里的 28 个走这一支）", () => {
  const { state, self } = opened();
  const env = envOf(state, self);

  expect(resolveActSlots(env, { op: "act.nothing" }).slots).toBe(NO_ACT_SLOTS);
  expect(resolveActSlots(env, { op: "act.draw", player: CONTROLLER }).slots).toEqual({});
  // ⚠ `act.steal.to` 是 Sel 而不是 SlotRef（`ir/types/act.ts` 点过名），不该被误认成位置参数。
  expect(resolveActSlots(env, { op: "act.steal", target: SELF, to: CONTROLLER }).slots).toBe(
    NO_ACT_SLOTS,
  );
});

test("resolveActSlots 的三态返回值（有效 / 无效 / 无位置参数）", () => {
  const { state, self } = opened(2);
  const env = envOf(state, self);

  expect(resolveActSlots(env, summon(at("friendly", 2))).slots.at?.()).toEqual({
    player: 0,
    index: 2,
  });
  expect(resolveActSlots(env, moveTo(at("enemy", 2))).slots.to?.()).toEqual({
    player: 1,
    index: 2,
  });
  // ★ 无效槽的取值是 `null`（空集合语义统一表的 `actSkipped`），不是 -1、不是哨兵对象。
  expect(resolveActSlots(env, summon(at("friendly", 9))).slots.at?.()).toBeNull();
});

test("★ skipped() 是**事后**回读：没拉过恒 false，拉到无效槽才 true", () => {
  const { state, self } = opened(2);
  const env = envOf(state, self);

  // 位置参数是惰性的 —— handler 还没跑（没人拉）时问「跳过了吗」，答案只能是"没有"。
  const invalid = resolveActSlots(env, summon(at("friendly", 9)));
  expect(invalid.skipped()).toBe(false);
  expect(invalid.slots.at?.()).toBeNull();
  expect(invalid.skipped()).toBe(true);

  const valid = resolveActSlots(env, summon(at("friendly", 2)));
  valid.slots.at?.();
  expect(valid.skipped()).toBe(false);
  // 没有位置参数的动作永远不算"被无效槽掐掉"。
  expect(resolveActSlots(env, { op: "act.nothing" }).skipped()).toBe(false);
});

test("act.summon / act.move_to：at 与 to 有效 ⇒ handler 拿到**绝对**坐标（相对侧别已换算）", () => {
  const { state, self } = opened();
  const { deps, landed } = tracingDeps();

  runActs(
    state,
    [summon(at("friendly", 3)), summon(at("enemy", 3)), moveTo(at("enemy", 7))],
    self,
    deps,
  );

  expect(landed).toEqual([
    { op: "act.summon", player: 0, index: 3 },
    { op: "act.summon", player: 1, index: 3 },
    { op: "act.move_to", player: 1, index: 7 },
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 无效槽 ⇒ 该动作静默跳过（v2 §3.1），六种来源逐条
// ═══════════════════════════════════════════════════════════════════════════

test("★ slot.at 越界 ⇒ 动作静默跳过：handler 不跑、不发事件，前后两条照常执行", () => {
  const { state, self } = opened();
  const { deps, landed } = tracingDeps();

  const step = runActs(
    state,
    [summon(at("friendly", 1)), summon(at("friendly", 9)), summon(at("friendly", 2))],
    self,
    deps,
  );

  // 中间那条被吞掉，且**不影响**它前后的动作 —— 跳过的是这一条，不是整条链。
  expect(landed).toEqual([
    { op: "act.summon", player: 0, index: 1 },
    { op: "act.summon", player: 0, index: 2 },
  ]);
  // 「不报错，不产生事件」（IR v1 §5.2 那张表的第一行）。
  expect(step.events).toEqual([]);
});

test("★ 格子数量读 RulesConfig.board.slots，不是写死的 9", () => {
  const rules: RulesConfig = { ...DEFAULT_RULES, board: { slots: 5 } };
  const { state, self } = opened(0, rules);
  const { deps, landed } = tracingDeps();

  // 第 5 格在默认规则下合法、在这局里越界 —— 分辨"读规则"与"写死 9"的判据就在这里。
  runActs(state, [summon(at("friendly", 4)), summon(at("friendly", 5))], self, deps);

  expect(landed).toEqual([{ op: "act.summon", player: 0, index: 4 }]);
});

test("★ slot.of：非单实体 / 不在场 ⇒ 动作静默跳过", () => {
  const { state, self } = opened();
  putUnit(state, 0, 1, { atk: 1, health: 1 });
  const { deps, landed } = tracingDeps();

  // 战线上两个单位 ⇒ 非单实体
  runActs(state, [moveTo({ op: "slot.of", of: FRIENDLY_BOARD })], self, deps);
  expect(landed).toEqual([]);

  // 手牌里的实体在场外（`entity.slot === null`）⇒ 无效槽
  const inHand = handOf(state, 0)[0] ?? -1;
  runActs(state, [moveTo({ op: "slot.of", of: { op: "sel.entity", id: inHand } })], self, deps);
  expect(landed).toEqual([]);

  // 对照：恰好一个在场实体 ⇒ 有效
  runActs(state, [moveTo({ op: "slot.of", of: SELF })], self, deps);
  expect(landed).toEqual([{ op: "act.move_to", player: 0, index: 0 }]);
});

test("★ slot.shift 出界 ⇒ 动作静默跳过（不 clamp、不回绕）", () => {
  const { state, self } = opened(8);
  const own: SlotRef = { op: "slot.of", of: SELF };
  const { deps, landed } = tracingDeps();

  // 8 + 1 = 9 ⇒ 出界。clamp 的话这里会落在第 8 格，"推到边缘"与"推出边界"就混成一件事了。
  runActs(state, [summon({ op: "slot.shift", of: own, delta: 1 })], self, deps);
  expect(landed).toEqual([]);

  runActs(state, [summon({ op: "slot.shift", of: own, delta: -1 })], self, deps);
  expect(landed).toEqual([{ op: "act.summon", player: 0, index: 7 }]);
});

test("★ slot.first_empty 无空格 ⇒ 动作静默跳过", () => {
  const { state, self } = opened();
  fill(state, 1, state.rules.board.slots);
  const { deps, landed } = tracingDeps();

  runActs(state, [summon({ op: "slot.first_empty", side: "friendly" })], self, deps);
  expect(landed).toEqual([]);

  // 对照：敌方整行空着 ⇒ 最左那格
  runActs(state, [summon({ op: "slot.first_empty", side: "enemy" })], self, deps);
  expect(landed).toEqual([{ op: "act.summon", player: 1, index: 0 }]);
});

test("★ slot.random_empty 无空格 ⇒ 动作静默跳过，且**一次 RNG 都不抽**", () => {
  const { state, self } = opened();
  fill(state, 1, state.rules.board.slots);
  const { deps, landed } = tracingDeps();

  const step = runActs(state, [summon({ op: "slot.random_empty", side: "friendly" })], self, deps);

  expect(landed).toEqual([]);
  // 空集不消耗随机：抽了的话同一颗种子在"战线满没满"上会分叉，回放对不上。
  expect(rngDraws(step.events)).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 惰性 + 记忆化：拉了才求，拉几次都只求一次（RNG 条数是判据）
// ═══════════════════════════════════════════════════════════════════════════

test("★ slot.random_empty 拉一次求一次：恰好一条 engine.random_picked，落点就是抽中的那一格", () => {
  const { state, self } = opened();
  fill(state, 1, 6); // 0~5 占满 ⇒ 空格是 6 / 7 / 8
  const { deps, landed } = tracingDeps();

  const step = runActs(state, [summon({ op: "slot.random_empty", side: "friendly" })], self, deps);

  // ★ 谁再多求一次值这里就会是 2 —— 而且两次抽到的格子不同，
  //   单位落在跟第一次不一样的位置上。整条链最容易静默错掉的就是这一处。
  const picks = step.events.filter(isEngineEvent);
  expect(picks).toHaveLength(1);
  expect(picks[0]?.origin).toBe("slot.random_empty");
  // 落点必须是**这一次**抽样的结果（候选集是升序的空格索引）。
  expect(landed).toEqual([
    { op: "act.summon", player: 0, index: [6, 7, 8][picks[0]?.result ?? -1] ?? -1 },
  ]);
});

test("★ 记忆化：同一个 handler 里拉两次，只抽一次随机、两次拿到同一格", () => {
  // 真 handler 只拉一次（`handlers/summon.ts`），但"拉两次"必须是安全的 ——
  // 否则将来某个 handler 顺手多写一行 `slots.at()` 就会让单位落到别的格上，
  // 而它多半只在事件流里表现为多一条 `engine.random_picked`，不会有人当场发现。
  const { state, self } = opened();
  fill(state, 1, 6); // 空格是 6 / 7 / 8，抽中哪一格随种子而定
  const twice: SlotAddr[] = [];
  const handlers: HandlerTable = {
    ...NO_HANDLERS,
    "act.summon": (_env, _act, slots) => {
      const first = slots.at();
      const second = slots.at();
      if (isActSkipped(first) || isActSkipped(second)) {
        return;
      }
      twice.push(first, second);
    },
  };

  const step = runActs(state, [summon({ op: "slot.random_empty", side: "friendly" })], self, {
    handlers,
  });

  expect(rngDraws(step.events)).toBe(1);
  expect(twice).toHaveLength(2);
  expect(twice[0]).toEqual(twice[1] as SlotAddr);
});

test("★ 记忆化的**无效槽**那一支：拉两次也只抽一次随机（memo 三态，缺一不可）", () => {
  // 上一条钉的是 memo 的「有效」分支，这一条钉「求过了，是无效槽」那一支。
  // 两条缺一不可：`lazySlot` 的 memo 若把「还没求过」与「求出来是 null」混成一个值
  // （`if (memo === undefined || memo === null)`），有效那支照样只求一次、上一条依然绿，
  // 而无效那支会**每拉一次重求一次**。
  // `slot.shift(slot.random_empty, +9)` 正是「先抽一次随机、再算出界 ⇒ 无效槽」：
  // 状态合并之后第二次拉会再抽一次，rngDraws 变成 2。
  const { state, self } = opened();
  const pulls: (SlotAddr | null)[] = [];
  const handlers: HandlerTable = {
    ...NO_HANDLERS,
    "act.summon": (_env, _act, slots) => {
      pulls.push(slots.at(), slots.at());
    },
  };

  const step = runActs(
    state,
    [summon({ op: "slot.shift", of: { op: "slot.random_empty", side: "friendly" }, delta: 9 })],
    self,
    { handlers },
  );

  expect(pulls).toEqual([null, null]);
  expect(rngDraws(step.events)).toBe(1);
});

test("★ 位置参数是**惰性**的：handler 不拉就一次随机都不抽", () => {
  // 这条与 IR v1 §5.4 规则 1（字段按签名声明顺序求值）是同一件事的两面：
  // handler 在 `at` 之前的字段上判出「整个动作跳过」时，`at` 根本轮不到求值。
  // 动作层的完整断言在 `handlers/__tests__/field-order.test.ts`，这里只钉机制本身。
  //
  // ⚠ 代价：`NO_DEPS` 那种什么都不拉的占位 handler 于是**不再**与真 handler 抽一样多的
  //   随机 —— 「实现进度不改变随机流」这条 M4 的自我承诺随本次改动作废。
  //   它躲不掉（真 handler 抽几次本来就取决于它前面的字段），兜底是架构 §5.1 的
  //   「载入 bundle 时用 opsUsed 比对并拒载」，而那个检查**目前还没有实现** ——
  //   完整论证见 `resolve/act-slots.ts` 文件头「代价」一节。
  const act = summon({ op: "slot.random_empty", side: "friendly" });
  const quiet = opened();
  const silent = runActs(quiet.state, [act], quiet.self, NO_DEPS);
  const loud = opened();
  const real = runActs(loud.state, [act], loud.self, tracingDeps().deps);

  expect(rngDraws(silent.events)).toBe(0);
  expect(rngDraws(real.events)).toBe(1);
});

test("判出无效槽之前已经消耗的 RNG 不回滚：动作照跳，random_picked 照发", () => {
  const { state, self } = opened();
  fill(state, 1, 8); // 只剩第 8 格空 ⇒ 必抽中 8，再 +1 出界 ⇒ 无效槽
  const { deps, landed } = tracingDeps();

  const step = runActs(
    state,
    [summon({ op: "slot.shift", of: { op: "slot.random_empty", side: "friendly" }, delta: 1 })],
    self,
    deps,
  );

  expect(landed).toEqual([]);
  // 那一次 nextInt 是真的发生了：「一次 nextInt = 一条事件，一一对应」不能因为
  // 动作最终被跳过就破例，否则"随机流从哪一步开始错位"再也查不出来。
  expect(rngDraws(step.events)).toBe(1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 与 evalCond 的接线
// ═══════════════════════════════════════════════════════════════════════════

test("cond.occupied(无效槽) → false（v2 §3.1，判空要用 cond.not 包一层）", () => {
  const { state, self } = opened();
  const env = envOf(state, self);

  expect(evalCond(env, { op: "cond.occupied", slot: at("friendly", 9) })).toBe(false);
  // 「空格」与「无效槽」在这个谓词下同为 false —— 所以它俩只有合起来的补集才是"有人"。
  expect(evalCond(env, { op: "cond.occupied", slot: at("friendly", 1) })).toBe(false);
  expect(evalCond(env, { op: "cond.occupied", slot: at("friendly", 0) })).toBe(true);
});
