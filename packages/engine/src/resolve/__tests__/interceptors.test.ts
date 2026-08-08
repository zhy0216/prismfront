// 拦截器（替换效果）的单元测试（M5/T2：`resolve/interceptors.ts` 的 `applyInterceptors`）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 测的是 IR v1 §4.2 的六件事，一件都不能少
// ═══════════════════════════════════════════════════════════════════════════
//   intercept  拦哪个 op —— ★ 拦 `act.hit` 对**战斗**同样生效（v2 §3.4）；
//              ★ M5/T5 起拦 `act.strike` 也改得动数值（战斗那条路），见对应那条测试
//   filter     键是被拦**动作**的实体字段；★ SELF 绑**宿主**，不是动作的施动者
//   cond       可用 `num.field` 读被拦动作的字段值
//   effect     cancel / set_field / mod_field / retarget
//   then       ★ 取消了也照样执行，而且是**入栈**（时序规则 2），不是就地执行
//   priority   降序应用，打平按 playOrder（与触发器同一个口径）
// 外加三条资源与确定性：**8 层上限**、匹配阶段不得推进 RNG、
// 以及被拦动作字段的**求值一次 + 冻结**（IR v1 §5.3 规则 1 跨过拦截器这道坎）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 每条测试都要有**判别力**：不只断言"挡住了"，还要断言"不该挡的没挡"
// ═══════════════════════════════════════════════════════════════════════════
// 拦截器测试最容易写成空壳：摆一个圣盾、断言它没掉血 —— 而"filter 整个被忽略"、
// "cond 被当成恒真"同样能让它没掉血。所以本文件的盘面一律**成对**摆：
// 一个该挡的 + 一个不该挡的，且尽量用**同一张卡**（于是差别只可能出在匹配上）。
// 每条断言旁边都写明「写错了会读到什么」。
//
// ⚠ 写测试卡时注意：`intercept.then` 里**不要**再放一条同 op 的动作。
//   `act.hit` 的 `then` 里再写 `act.hit`，那一条照样会被同一批拦截器拦下 ——
//   自己拦自己就是一个环，`resolve()` 会以 `ResolutionLoopError` 收场。
//   本文件的 `then` 一律用不被拦的动作（`act.draw` / `act.set_tag` / `act.set_flag`）。
//
// 注：本文件**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1）。

import { expect, test } from "bun:test";
import type { Act, Card, EntityId, Intercept, Sel } from "@prismfront/ir";
import type { GameEvent } from "../../events/index.ts";
import type { GameState, PlayerId } from "../../state/index.ts";
import { cloneState, getEntity, hasFlag } from "../../state/index.ts";
import {
  cardDeps,
  damageOf,
  eventNames,
  fightOnce,
  handOf,
  openGame,
  putCard,
  putCardInHand,
  putUnit,
  runActs,
  scriptCard,
  setFlag,
} from "../../testkit/index.ts";
import { InterceptChainError, InterceptRandomError, MAX_INTERCEPT_CHAIN } from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════════════════

const SELF: Sel = { op: "sel.self" };
const ENEMY_BOARD: Sel = { op: "sel.zone", side: "enemy", zone: "board" };

/** 打一个具体实体 `amount` 点（`sel.entity` 是 IR v1 §5.6 的运行时超集，测试可用）。 */
function hitAct(target: EntityId, amount = 1): Act {
  return { op: "act.hit", target: { op: "sel.entity", id: target }, amount };
}

/** 最常见的站位动作：控制者抽一张牌。`card_drawn` 与伤害类事件一眼分得开。 */
const DRAW_ONE: Act = { op: "act.draw", player: { op: "sel.controller" } };

/** 给宿主自己盖一个 armor，用来在事件流里留下一条带 `target` 的 `buffed`。 */
const MARK_SELF: Act = { op: "act.set_tag", target: SELF, tag: "armor", value: 1 };

/** 造一张只带一条拦截器的测试卡。 */
function interceptCard(id: string, intercept: Intercept): Card {
  return scriptCard(id, { intercepts: [intercept] });
}

/** 某方手牌张数。 */
function handSize(state: GameState, player: PlayerId): number {
  return handOf(state, player).length;
}

/**
 * 一批事件里每次 `engine.random_picked` 的结果。
 *
 * 条数 = **RNG 推进了几次**（`events/event.ts` 要求的一一配对），
 * 值可以拿来与"这一步真做了什么"对账 —— 于是"求值两次"既表现为条数多一条，
 * 也表现为对账对不上。
 */
function randomResults(events: readonly GameEvent[]): number[] {
  const out: number[] = [];
  for (const event of events) {
    if (event.name === "engine.random_picked") {
      out.push(event.result);
    }
  }
  return out;
}

/** 一批事件里 `buffed` 的 target 序列（顺序断言用）。 */
function buffedTargets(events: readonly GameEvent[]): EntityId[] {
  const out: EntityId[] = [];
  for (const event of events) {
    if (event.name === "buffed") {
      out.push(event.target);
    }
  }
  return out;
}

/** 一批事件里 `damaged` 的点数序列。 */
function damageAmounts(events: readonly GameEvent[]): number[] {
  const out: number[] = [];
  for (const event of events) {
    if (event.name === "damaged") {
      out.push(event.amount);
    }
  }
  return out;
}

/** 一个实体现在还有没有圣盾（读**生效值** `flags`，`refreshAuras` 每步重算的那个）。 */
function shielded(state: GameState, id: EntityId): boolean {
  const entity = getEntity(state, id);
  if (entity === undefined) {
    throw new Error(`夹具错误：实体 ${id} 不存在`);
  }
  return hasFlag(entity, "divine_shield");
}

// ═══════════════════════════════════════════════════════════════════════════
// ★ 标准用例：圣盾（IR v1 §10.6，逐字照抄那份规范 JSON）
// ═══════════════════════════════════════════════════════════════════════════

/** IR v1 §10.6 的圣盾：拦 `act.hit` + `filter{target:SELF}` + 有盾且伤害 > 0 ⇒ 取消 + 清盾。 */
const DIVINE_SHIELD: Card = interceptCard("T_SHIELD", {
  intercept: "act.hit",
  filter: { target: SELF },
  cond: {
    op: "cond.and",
    of: [
      { op: "cond.has_flag", of: SELF, flag: "divine_shield" },
      { op: "cond.gt", l: { op: "num.field", field: "amount" }, r: 0 },
    ],
  },
  effect: { kind: "cancel" },
  then: [{ op: "act.set_flag", target: SELF, flag: "divine_shield", value: false }],
  priority: 100,
});

test("★ 圣盾：挡下第一次伤害并把盾用掉，第二次照常受伤", () => {
  const deps = cardDeps([DIVINE_SHIELD]);
  const state = openGame();
  const shield = putCard(state, 1, 0, DIVINE_SHIELD, { atk: 0, health: 20 });
  setFlag(state, shield, "divine_shield");
  const attacker = putUnit(state, 0, 0, { atk: 0, health: 9 });

  const first = runActs(state, [hitAct(shield, 5)], attacker, deps);

  // ★ 一点伤害都不该有。`effect: cancel` 没落地 ⇒ 5 点。
  expect(damageOf(first.state, shield)).toBe(0);
  // ★ 盾必须被 `then` 清掉。取消分支跳过 `then` 的实现在这里读到 true（"永久免疫"）。
  expect(shielded(first.state, shield)).toBe(false);
  // 被取消的动作不产生 `damaged`；`act.set_flag` 不发事件（v2 §5 没有这个事件名）。
  expect(eventNames(first.events)).toEqual([]);

  // 第二次：盾已经没了 ⇒ `cond.has_flag` 为假 ⇒ 照常受伤。
  const second = runActs(first.state, [hitAct(shield, 5)], attacker, deps);
  // `cond` 整个被当成恒真的实现会在这里读到 0（第二次也挡住了）。
  expect(damageOf(second.state, shield)).toBe(5);
  expect(eventNames(second.events)).toEqual(["damaged"]);
});

test("★ 圣盾的 filter：只挡打在自己头上的那一份，隔壁同款不代挡", () => {
  const deps = cardDeps([DIVINE_SHIELD]);
  const state = openGame();
  const mine = putCard(state, 1, 0, DIVINE_SHIELD, { atk: 0, health: 20 });
  // 对照：**同一张卡、同一侧、就在隔壁**，也带着盾 —— 它不是这次伤害的目标。
  const bystander = putCard(state, 1, 1, DIVINE_SHIELD, { atk: 0, health: 20 });
  setFlag(state, mine, "divine_shield");
  setFlag(state, bystander, "divine_shield");
  const attacker = putUnit(state, 0, 0, { atk: 0, health: 9 });

  const step = runActs(state, [hitAct(mine, 5)], attacker, deps);

  expect(damageOf(step.state, mine)).toBe(0);
  expect(shielded(step.state, mine)).toBe(false);
  // ★ 旁观者的盾**必须还在**：`filter` 被忽略的实现会让它也命中、也清盾 ——
  //   而那种实现在上面两行读到的东西一字不差，所以判别力全在这一行上。
  expect(shielded(step.state, bystander)).toBe(true);
});

test("★ filter 是**全称量化**：多目标 AoE 里的那一份圣盾挡不下（有意的取舍）", () => {
  const deps = cardDeps([DIVINE_SHIELD]);
  const state = openGame();
  const shield = putCard(state, 1, 0, DIVINE_SHIELD, { atk: 0, health: 20 });
  setFlag(state, shield, "divine_shield");
  const other = putUnit(state, 1, 1, { atk: 0, health: 20 });
  const attacker = putUnit(state, 0, 0, { atk: 0, health: 9 });

  // 一条动作打**整条敌方战线**：`act.hit.target` 上有两个实体，其中只有一个是宿主。
  const step = runActs(state, [{ op: "act.hit", target: ENEMY_BOARD, amount: 3 }], attacker, deps);

  // ★ 这条钉的是一个**已知代价**，不是理想行为（`interceptors.ts` 的 `matchesFilter` 写明了）：
  //   拦截是**整条动作**级别的（`cancel` 取消的是整个动作），所以 filter 只能二选一 ——
  //   全称量化 ⇒ 圣盾挡不住 AoE 里落到自己头上的那一份；
  //   存在量化 ⇒ 一个带盾的单位会让整片 AoE 对**所有人**失效（下面那行会变成 0）。
  //   选了前者。真要两全，得把 `act.hit` 拆成逐目标的动作，那是动作层的改动。
  expect(damageOf(step.state, shield)).toBe(3);
  expect(damageOf(step.state, other)).toBe(3);
  // 没命中就不该消耗盾 —— 存在量化的实现会在这里读到 false。
  expect(shielded(step.state, shield)).toBe(true);
});

test("★ 拦 act.hit 对战斗同样生效（v2 §3.4：出手内部走 act.hit 管线）", () => {
  const deps = cardDeps([DIVINE_SHIELD]);
  /** 同一个盘面，唯一的差别是那面盾在不在。 */
  const board = (withShield: boolean): { state: GameState; guard: EntityId } => {
    const state = openGame();
    putUnit(state, 0, 0, { atk: 3, health: 20 }); // p0 的出手者，正对 p1 的 0 号格
    const guard = putCard(state, 1, 0, DIVINE_SHIELD, { atk: 0, health: 20 });
    if (withShield) {
      setFlag(state, guard, "divine_shield");
    }
    return { state, guard };
  };

  const shieldBoard = board(true);
  const guarded = fightOnce(shieldBoard.state, deps);
  const bareBoard = board(false);
  const bare = fightOnce(bareBoard.state, deps);

  // ★ 战斗里那一击被拦下了：`struck` 照发（出手这件事发生了），`damaged` 没有。
  //   只在 `resolve()` 里接线、忘了给战斗第 ③ 步传 `deps` 的实现，两边都会有 `damaged`。
  expect(eventNames(guarded.events)).toEqual(["combat_began", "struck", "combat_ended"]);
  expect(eventNames(bare.events)).toEqual(["combat_began", "struck", "damaged", "combat_ended"]);
  expect(damageOf(guarded.state, shieldBoard.guard)).toBe(0);
  expect(damageOf(bare.state, bareBoard.guard)).toBe(3);
  // `then` 在战斗批次里同样跑到了（它被 `applyStrikes` 的 harvest 收进本地链条）。
  expect(shielded(guarded.state, shieldBoard.guard)).toBe(false);
});

/**
 * 减伤：把落到自己头上的**出手**改成 1 点 —— 拦的是 `act.strike`，不是里面那条 `act.hit`。
 *
 * ★ 这张卡在 M5/T5 之前是**写不出来的**：那时 IR 的 `act.strike` 没有数值字段，
 *   `set_field{field:"amount"}` 会走 `ActView.writeNum` 的"动作没有这个字段 ⇒ 静默不写"
 *   那一支（IR v1 §5.2 的基调），整条拦截器等于白写。
 */
const STRIKE_CAP: Card = interceptCard("T_STRIKE_CAP", {
  intercept: "act.strike",
  filter: { target: SELF },
  effect: { kind: "set_field", field: "amount", value: 1 },
});

test("★ 拦 act.strike 的 amount：战斗出手改得动，卡牌驱动的 strike 静默跳过", () => {
  // v2 §3.4 说 strike 内部走 `act.hit` 管线，"拦截器因此**两处**都能拦"。
  // M5/T5 之前那句话对**数值**只兑现了一半：`act.strike` 层只拦得住 cancel / retarget，
  // 改数值必须下沉到 `act.hit`。T5 给 `act.strike` 加了运行时超集字段 `amount` 之后，
  // 战斗那条路上这句话才完整成立 —— 而卡牌驱动的 `Strike(a, t)` 仍然没有这个字段。
  // 这条**不对称**是有意的（IR §5.6：`amount` 编写子集不开放），钉在这里免得将来
  // 有人把它当 bug"修"掉。
  const deps = cardDeps([STRIKE_CAP]);

  // ① 战斗出手：快照把冻结值填进 `act.strike.amount` ⇒ 拦截器改得动，5 → 1。
  const combat = openGame();
  putUnit(combat, 0, 0, { atk: 5, health: 20 });
  const combatGuard = putCard(combat, 1, 0, STRIKE_CAP, { atk: 0, health: 30 });
  const fought = fightOnce(combat, deps);
  // 写错（`strikeActOf` 不填 amount / `strikeHandler` 不读它）会读到 5。
  expect(damageOf(fought.state, combatGuard)).toBe(1);
  expect(damageAmounts(fought.events)).toEqual([1]);

  // ② 卡牌驱动的同一个 op：动作上没有 `amount` 字段 ⇒ `set_field` 静默跳过，照打 5。
  //    ⚠ 别把这一半读成"拦截器没生效"：它匹配上了、`effect` 也应用了，
  //      只是 `writeNum` 在字段不存在时不写（IR v1 §5.2）。要拦这一条得拦 `act.hit`。
  const direct = openGame();
  const attacker = putUnit(direct, 0, 0, { atk: 5, health: 20 });
  const directGuard = putCard(direct, 1, 0, STRIKE_CAP, { atk: 0, health: 30 });
  const struck = runActs(
    direct,
    [
      {
        op: "act.strike",
        attacker: { op: "sel.entity", id: attacker },
        target: { op: "sel.entity", id: directGuard },
      },
    ],
    attacker,
    deps,
  );
  expect(damageOf(struck.state, directGuard)).toBe(5);
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 时序：`then` 是**入栈**的（框架 §4.1 时序规则 2），不是就地执行
// ═══════════════════════════════════════════════════════════════════════════

/** 把伤害加到致死量，并追加一条"抽一张牌"。`then` 的位置在事件流里一眼可辨。 */
const AMPLIFY: Card = interceptCard("T_AMPLIFY", {
  intercept: "act.hit",
  effect: { kind: "mod_field", field: "amount", delta: 5 },
  then: [DRAW_ONE],
});

test("★ then 入栈而非就地执行：它排在本步的伤害与死亡结算之后", () => {
  const deps = cardDeps([AMPLIFY]);
  const state = openGame();
  putCard(state, 0, 0, AMPLIFY, { atk: 0, health: 9 });
  const doomed = putUnit(state, 1, 0, { atk: 0, health: 3 });

  const step = runActs(state, [hitAct(doomed, 1)], doomed, deps);

  // ★ 三条事件的**顺序**就是这条测试的全部内容：
  //   damaged（第 ③ 步）→ unit_died（第 ⑤ 步）→ card_drawn（`then`，下一次弹栈）。
  //   `then` 若就地执行，`card_drawn` 会跑到最前面 —— 那正是"圣盾先清盾、后挡伤害"
  //   这类时序 bug 的形态（`interceptors.ts` 文件头点名说了）。
  expect(eventNames(step.events)).toEqual(["damaged", "unit_died", "card_drawn"]);
  // 顺带钉住 `mod_field` 真的改了数值：1 + 5 = 6 ≥ 3 血 ⇒ 死。
  expect(damageOf(step.state, doomed)).toBe(6);
});

/** 高优先级：只改数值、不取消，`then` 给自己盖 armor（留下一条 `buffed`）。 */
const FIRST_THEN: Card = interceptCard("T_THEN_1", {
  intercept: "act.hit",
  effect: { kind: "mod_field", field: "amount", delta: 0 },
  then: [MARK_SELF],
  priority: 100,
});
/** 低优先级：取消原动作，`then` 同样盖 armor。 */
const SECOND_THEN: Card = interceptCard("T_THEN_2", {
  intercept: "act.hit",
  effect: { kind: "cancel" },
  then: [MARK_SELF],
  priority: 0,
});

test("★ then 在动作被取消时照样执行，且多条 then 按**应用顺序**跑", () => {
  const deps = cardDeps([FIRST_THEN, SECOND_THEN]);
  const state = openGame();
  const high = putCard(state, 0, 0, FIRST_THEN, { atk: 0, health: 9 });
  const low = putCard(state, 0, 1, SECOND_THEN, { atk: 0, health: 9 });
  const victim = putUnit(state, 1, 0, { atk: 0, health: 9 });

  const step = runActs(state, [hitAct(victim, 4)], victim, deps);

  // ★ 两条 `then` 都跑了（取消的那条也不例外，IR v1 §4.2），且顺序 = 应用顺序。
  //   逐条各 push 一次（而不是一次性按执行顺序交给 `pushPendingInOrder`）的实现
  //   会读到 [low, high] —— LIFO 把顺序倒了过来。
  expect(buffedTargets(step.events)).toEqual([high, low]);
  // 原动作被取消 ⇒ 那 4 点没落地。
  expect(damageOf(step.state, victim)).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// `priority` 降序 + 打平按 playOrder（复用 `triggers.ts` 的唯一口径）
// ═══════════════════════════════════════════════════════════════════════════

/** 低优先级：把伤害减 3。 */
const SOFTEN: Card = interceptCard("T_SOFTEN", {
  intercept: "act.hit",
  effect: { kind: "mod_field", field: "amount", delta: -3 },
  priority: 0,
});
/** 高优先级：把伤害**设**成 10（非交换律，于是先后顺序可观测）。 */
const OVERRIDE: Card = interceptCard("T_OVERRIDE", {
  intercept: "act.hit",
  effect: { kind: "set_field", field: "amount", value: 10 },
  priority: 100,
});

test("priority 降序：先 set_field(10) 后 mod_field(-3) ⇒ 7，不是 10", () => {
  const deps = cardDeps([SOFTEN, OVERRIDE]);
  const state = openGame();
  // ★ 故意把**低**优先级那张先摆上场（于是它的 playOrder 更小）：
  //   不排序、按枚举/摆放顺序应用的实现会先减后设 ⇒ 读到 10。
  putCard(state, 0, 0, SOFTEN, { atk: 0, health: 9 });
  putCard(state, 0, 1, OVERRIDE, { atk: 0, health: 9 });
  const victim = putUnit(state, 1, 0, { atk: 0, health: 30 });

  const step = runActs(state, [hitAct(victim, 1)], victim, deps);

  // 10 → 10 - 3 = 7。升序应用会得到 (1-3) = -2 → set 10 ⇒ 10。
  expect(damageOf(step.state, victim)).toBe(7);
});

/** 同优先级的两张，`set_field` 成不同的值 —— **后应用的那个赢**，于是顺序可观测。 */
const SET_TEN: Card = interceptCard("T_SET_10", {
  intercept: "act.hit",
  effect: { kind: "set_field", field: "amount", value: 10 },
  priority: 5,
});
const SET_TWENTY: Card = interceptCard("T_SET_20", {
  intercept: "act.hit",
  effect: { kind: "set_field", field: "amount", value: 20 },
  priority: 5,
});

test("priority 打平：按「当前回合玩家优先 → playOrder」排，换手即整体翻面", () => {
  const deps = cardDeps([SET_TEN, SET_TWENTY]);
  const state = openGame(); // p0 先手且持有 priority
  // ★ p1 的那张**先**摆（playOrder 更小）：于是"只按 playOrder、不看侧别"与
  //   "按完整口径排"给出的答案不同，这条测试才有判别力。
  putCard(state, 1, 0, SET_TEN, { atk: 0, health: 9 });
  putCard(state, 0, 0, SET_TWENTY, { atk: 0, health: 9 });
  const victim = putUnit(state, 1, 1, { atk: 0, health: 40 });

  // p0 持有 priority ⇒ p0 的 SET_TWENTY 先应用、p1 的 SET_TEN 后应用 ⇒ 最终 10。
  expect(damageOf(runActs(state, [hitAct(victim, 1)], victim, deps).state, victim)).toBe(10);

  // 换手之后整体翻面：同一批拦截器，只是 `priority` 变了（`activePlayer` 的口径）。
  // ★ 两个方向合起来才是判别力：**完全不排序**的实现两边会读到同一个数，
  //   而 10 ≠ 20，于是它至少红一条。
  const flipped = cloneState(state);
  flipped.priority = 1;
  expect(damageOf(runActs(flipped, [hitAct(victim, 1)], victim, deps).state, victim)).toBe(20);
});

// ═══════════════════════════════════════════════════════════════════════════
// `cancel` 之后整条链停止
// ═══════════════════════════════════════════════════════════════════════════

const CANCEL_HIGH: Card = interceptCard("T_CANCEL_HI", {
  intercept: "act.hit",
  effect: { kind: "cancel" },
  then: [DRAW_ONE],
  priority: 100,
});
const CANCEL_LOW: Card = interceptCard("T_CANCEL_LO", {
  intercept: "act.hit",
  effect: { kind: "cancel" },
  then: [DRAW_ONE],
  priority: 0,
});

test("cancel 之后不再往下应用：一次伤害只消耗一层盾", () => {
  const deps = cardDeps([CANCEL_HIGH, CANCEL_LOW]);
  const state = openGame();
  putCard(state, 0, 0, CANCEL_HIGH, { atk: 0, health: 9 });
  putCard(state, 0, 1, CANCEL_LOW, { atk: 0, health: 9 });
  const victim = putUnit(state, 1, 0, { atk: 0, health: 9 });

  const step = runActs(state, [hitAct(victim, 4)], victim, deps);

  // ★ 恰好一条 `card_drawn`：取消之后继续遍历链的实现会读到两条 ——
  //   语义上就是"一次伤害同时用掉了两层盾"。
  expect(eventNames(step.events)).toEqual(["card_drawn"]);
  expect(damageOf(step.state, victim)).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// `filter`：动作没有这个字段 / 求值为空集 ⇒ 不匹配；宿主不在场上 ⇒ 不参与
// ═══════════════════════════════════════════════════════════════════════════

/** 拦 `act.hit`，但 filter 键取 `attacker` —— `act.hit` 根本没有这个字段。 */
const WRONG_KEY: Card = interceptCard("T_WRONG_KEY", {
  intercept: "act.hit",
  filter: { attacker: SELF },
  effect: { kind: "cancel" },
});
/** 同形但**不写 filter** —— 它证明"整条链根本没跑起来"不是上面那条的解释。 */
const NO_FILTER: Card = interceptCard("T_NO_FILTER", {
  intercept: "act.hit",
  effect: { kind: "cancel" },
});

test("filter：被拦动作没有这个实体字段 ⇒ 不匹配（不是「当作通过」）", () => {
  const deps = cardDeps([WRONG_KEY, NO_FILTER]);
  const base = openGame();

  const withWrongKey = cloneState(base);
  putCard(withWrongKey, 0, 0, WRONG_KEY, { atk: 0, health: 9 });
  const a = putUnit(withWrongKey, 1, 0, { atk: 0, health: 9 });
  // `act.hit` 没有 `attacker` ⇒ 永远匹配不上 ⇒ 伤害照落。
  // 把"字段缺失"当成通过的实现会在这里读到 0。
  expect(damageOf(runActs(withWrongKey, [hitAct(a, 4)], a, deps).state, a)).toBe(4);

  const withNoFilter = cloneState(base);
  putCard(withNoFilter, 0, 0, NO_FILTER, { atk: 0, health: 9 });
  const b = putUnit(withNoFilter, 1, 0, { atk: 0, health: 9 });
  // 同一张卡去掉 filter 就挡得住 ⇒ 上面那条不是"拦截器压根没接上"。
  expect(damageOf(runActs(withNoFilter, [hitAct(b, 4)], b, deps).state, b)).toBe(0);
});

test("★ filter：被拦动作那个字段**求值为空集** ⇒ 不匹配（对 IR v1 §5.2 的有意偏离）", () => {
  const deps = cardDeps([DIVINE_SHIELD]);
  const state = openGame();
  const shield = putCard(state, 1, 0, DIVINE_SHIELD, { atk: 0, health: 20 });
  setFlag(state, shield, "divine_shield");
  // p0 的战线一个人都没有 ⇒ 从宿主（p1）看，`sel.zone(enemy, board)` 求值为**空集**。
  const intoThinAir: Act = { op: "act.hit", target: ENEMY_BOARD, amount: 5 };

  const step = runActs(state, [intoThinAir], shield, deps);

  // ★ 判别力全在这一行。IR v1 §5.2 的全称量化对空集恒真，`matchesFilter` 在这一支上
  //   **有意偏离**它（"打空气"没有被拦的对象）；把这一支放宽成"空集也算命中"的实现
  //   会让圣盾把一条什么都没打到的动作也算成"挡下了一次"，白白清掉标志位 ⇒ 读到 false。
  //   ⚠ 这一支的**行覆盖率**被同一行的 `actual === null`（上一条测试）盖掉了，
  //   "覆盖率 100%"对它没有判别力 —— 只有这条行为断言拦得住。
  expect(shielded(step.state, shield)).toBe(true);
  // 打空气什么都没发生（两种实现都读到空事件流，这行只钉住"没有副作用"）。
  expect(eventNames(step.events)).toEqual([]);

  // 同一张卡、同一个盘面，只把目标换成实打实的宿主就挡得住 ⇒ 上面那条不是
  // "拦截器压根没接上"。
  const real = runActs(step.state, [hitAct(shield, 5)], shield, deps);
  expect(damageOf(real.state, shield)).toBe(0);
  expect(shielded(real.state, shield)).toBe(false);
});

test("宿主只在**场上**才提供拦截器（IR v1 §4.2 没给 Intercept zone 字段）", () => {
  const deps = cardDeps([NO_FILTER]);
  const inHand = openGame();
  putCardInHand(inHand, 0, NO_FILTER, { atk: 0, health: 9 });
  const victim = putUnit(inHand, 1, 0, { atk: 0, health: 9 });

  // 手里的那张不参与 ⇒ 伤害照落。不判区域的实现会读到 0
  //（语义上就是"牌库/手牌里的卡在给全场减伤"）。
  expect(damageOf(runActs(inHand, [hitAct(victim, 4)], victim, deps).state, victim)).toBe(4);

  // 同一张卡摆到场上就挡得住 ⇒ 上面那条不是"卡没接进 deps"。
  const onBoard = cloneState(inHand);
  putCard(onBoard, 0, 0, NO_FILTER, { atk: 0, health: 9 });
  expect(damageOf(runActs(onBoard, [hitAct(victim, 4)], victim, deps).state, victim)).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// `cond` + `num.field`：读被拦动作的数值字段
// ═══════════════════════════════════════════════════════════════════════════

/** 只挡大伤害（≥ 3）。读的是被拦动作的 `amount`。 */
const ABSORB_BIG: Card = interceptCard("T_ABSORB_BIG", {
  intercept: "act.hit",
  cond: { op: "cond.gte", l: { op: "num.field", field: "amount" }, r: 3 },
  effect: { kind: "cancel" },
});

test("cond：num.field 读到的是被拦动作的真实字段值", () => {
  const deps = cardDeps([ABSORB_BIG]);
  const state = openGame();
  putCard(state, 0, 0, ABSORB_BIG, { atk: 0, health: 9 });
  const victim = putUnit(state, 1, 0, { atk: 0, health: 20 });

  // ★ 两个读数把三种典型写错分开：
  //   `num.field` 恒返回 0（M4 的退化实现）→ 两条都"不挡" ⇒ 2 与 5；
  //   `cond` 被当成恒真                    → 两条都挡    ⇒ 0 与 0；
  //   正确                                 → 小的不挡、大的挡住 ⇒ 2 与 0。
  expect(damageOf(runActs(state, [hitAct(victim, 2)], victim, deps).state, victim)).toBe(2);
  expect(damageOf(runActs(state, [hitAct(victim, 5)], victim, deps).state, victim)).toBe(0);
});

/** 读一个 `act.hit` **根本没有**的数值字段（`count` 是 `act.draw` 的）。 */
const READ_ABSENT: Card = interceptCard("T_READ_ABSENT", {
  intercept: "act.hit",
  cond: { op: "cond.eq", l: { op: "num.field", field: "count" }, r: 0 },
  effect: { kind: "cancel" },
});

test("cond：动作没有那个数值字段 ⇒ num.field 退化成 0（IR v1 §5.2 的数值位）", () => {
  const deps = cardDeps([READ_ABSENT]);
  const state = openGame();
  putCard(state, 0, 0, READ_ABSENT, { atk: 0, health: 9 });
  const victim = putUnit(state, 1, 0, { atk: 0, health: 20 });

  // `count` 不存在 ⇒ 读 0 ⇒ `0 === 0` ⇒ 挡住。
  // 与上一条合起来才有判别力：上一条证明"存在的字段读得到真值"，本条证明
  // "不存在的字段读 0"，两者都对才排除了"恒 0"与"恒真"这两种退化实现。
  expect(damageOf(runActs(state, [hitAct(victim, 4)], victim, deps).state, victim)).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// `retarget`：★ `to` 在**宿主**的环境里求值
// ═══════════════════════════════════════════════════════════════════════════

/** 嘲讽的反面："打我？打我隔壁去。"`sel.adjacent(SELF)` 里的 SELF 必须是**宿主**。 */
const DEFLECT: Card = interceptCard("T_DEFLECT", {
  intercept: "act.hit",
  filter: { target: SELF },
  effect: { kind: "retarget", to: { op: "sel.adjacent", of: SELF } },
});

test("retarget：改到宿主的邻居身上，而不是施动者的邻居", () => {
  const deps = cardDeps([DEFLECT]);
  const state = openGame();
  const attacker = putUnit(state, 0, 0, { atk: 0, health: 9 });
  // ★ 施动者也有一个邻居：`to` 若在**动作**的环境里求值（那里 `sel.self` = 施动者），
  //   伤害会落到它头上 —— 这就是本条的判别力所在。
  const attackerNeighbour = putUnit(state, 0, 1, { atk: 0, health: 9 });
  const guard = putCard(state, 1, 3, DEFLECT, { atk: 0, health: 9 });
  const guardNeighbour = putUnit(state, 1, 4, { atk: 0, health: 9 });

  const step = runActs(state, [hitAct(guard, 4)], attacker, deps);

  expect(damageOf(step.state, guardNeighbour)).toBe(4); // 改到了宿主的邻居
  expect(damageOf(step.state, guard)).toBe(0); // 原目标没挨打
  expect(damageOf(step.state, attackerNeighbour)).toBe(0); // ★ 两个环境搞混会是 4
  expect(damageAmounts(step.events)).toEqual([4]); // 只打了一下，不是两下
});

test("retarget：改到**多个**目标上（冻结走 sel.or，一次动作打完整批）", () => {
  const deps = cardDeps([DEFLECT]);
  const state = openGame();
  const attacker = putUnit(state, 0, 0, { atk: 0, health: 9 });
  const guard = putCard(state, 1, 3, DEFLECT, { atk: 0, health: 9 });
  // 两侧各一个邻居 ⇒ `sel.adjacent(SELF)` 是**两个**实体。
  const left = putUnit(state, 1, 2, { atk: 0, health: 9 });
  const right = putUnit(state, 1, 4, { atk: 0, health: 9 });

  const step = runActs(state, [hitAct(guard, 4)], attacker, deps);

  // 冻结成单实体（只取第一个）的实现会漏掉其中一个 ⇒ 这里读到 [4, 0] 或 [0, 4]。
  expect([damageOf(step.state, left), damageOf(step.state, right)]).toEqual([4, 4]);
  expect(damageOf(step.state, guard)).toBe(0);
  // 仍然是**一个**动作（IR v1 §5.3 规则 1 的快照没被拆成两次），只是目标变成两个。
  expect(damageAmounts(step.events)).toEqual([4, 4]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 资源上限：最多 8 层（IR v1 §7）
// ═══════════════════════════════════════════════════════════════════════════

/** 每层减 1 点。摆 n 个就是 n 层链。 */
const ONE_LESS: Card = interceptCard("T_ONE_LESS", {
  intercept: "act.hit",
  effect: { kind: "mod_field", field: "amount", delta: -1 },
});

/** 摆 `layers` 个减伤单位 + 一个高血量靶子。 */
function boardWithLayers(layers: number): { state: GameState; victim: EntityId } {
  const state = openGame();
  for (let i = 0; i < layers; i += 1) {
    putCard(state, 0, i, ONE_LESS, { atk: 0, health: 9 });
  }
  return { state, victim: putUnit(state, 1, 0, { atk: 0, health: 40 }) };
}

test("恰好 8 层可用，第 9 层抛 InterceptChainError（IR v1 §7 资源上限）", () => {
  const deps = cardDeps([ONE_LESS]);

  const ok = boardWithLayers(MAX_INTERCEPT_CHAIN);
  const okStep = runActs(ok.state, [hitAct(ok.victim, 20)], ok.victim, deps);
  // 20 - 8 = 12：八层全部应用了，上限没有误伤合法的链。
  expect(damageOf(okStep.state, ok.victim)).toBe(20 - MAX_INTERCEPT_CHAIN);

  const tooMany = boardWithLayers(MAX_INTERCEPT_CHAIN + 1);
  let caught: unknown;
  try {
    runActs(tooMany.state, [hitAct(tooMany.victim, 20)], tooMany.victim, deps);
  } catch (error) {
    caught = error;
  }
  // 不设上限的实现会静默算出 20 - 9 = 11 而不抛。
  expect(caught instanceof InterceptChainError).toBe(true);
  expect((caught as InterceptChainError).limit).toBe(MAX_INTERCEPT_CHAIN);
  expect((caught as InterceptChainError).op).toBe("act.hit");
});

// ═══════════════════════════════════════════════════════════════════════════
// 确定性：匹配阶段不得推进 RNG（IR v1 §5.4 规则 5）
// ═══════════════════════════════════════════════════════════════════════════

/** `cond` 里塞随机 —— L3（M11）该在编写期挡住，引擎侧留的是运行时防线。 */
const RANDOM_COND: Card = interceptCard("T_RANDOM_COND", {
  intercept: "act.hit",
  cond: { op: "cond.gte", l: { op: "num.random", lo: 0, hi: 1 }, r: 0 },
  effect: { kind: "cancel" },
});
/** `filter` 里塞随机 —— IR v1 §7 的 L3 规则**只点名了 cond**，这一支只有引擎防线拦得住。 */
const RANDOM_FILTER: Card = interceptCard("T_RANDOM_FILTER", {
  intercept: "act.hit",
  filter: { target: { op: "sel.random", of: ENEMY_BOARD } },
  effect: { kind: "cancel" },
});

test("匹配阶段推进 RNG ⇒ InterceptRandomError（cond 与 filter 两支都拦）", () => {
  for (const card of [RANDOM_COND, RANDOM_FILTER]) {
    const deps = cardDeps([card]);
    const state = openGame();
    putCard(state, 0, 0, card, { atk: 0, health: 9 });
    const victim = putUnit(state, 1, 0, { atk: 0, health: 20 });

    let caught: unknown;
    try {
      runActs(state, [hitAct(victim, 4)], victim, deps);
    } catch (error) {
      caught = error;
    }
    // 没有这道防线的实现会静默跑通，随机流从此与"盘面上有没有这张卡"挂钩。
    expect(caught instanceof InterceptRandomError).toBe(true);
    expect((caught as InterceptRandomError).op).toBe("act.hit");
  }
});

/**
 * 防线盲区的形态：**既**读被拦动作的随机 `target`（`filter` 命中判定必然要读它），
 * **又**在自己的 `filter` 里写 `sel.random`。两次推进一次来自动作、一次来自拦截器。
 */
const RANDOM_FILTER_ON_RANDOM_TARGET: Card = interceptCard("T_RANDOM_BOTH", {
  intercept: "act.hit",
  filter: { target: { op: "sel.random", of: ENEMY_BOARD } },
  effect: { kind: "cancel" },
});

test("★ 防线按**次数差**记账：既读随机字段、又自带 sel.random 的拦截器同样被抓住", () => {
  const deps = cardDeps([RANDOM_FILTER_ON_RANDOM_TARGET]);
  const state = openGame();
  const host = putCard(state, 0, 0, RANDOM_FILTER_ON_RANDOM_TARGET, { atk: 0, health: 9 });
  for (let slot = 0; slot < 3; slot += 1) {
    putUnit(state, 1, slot, { atk: 0, health: 40 });
  }
  const randomTarget: Act = {
    op: "act.hit",
    target: { op: "sel.random", of: ENEMY_BOARD },
    amount: 1,
  };

  let caught: unknown;
  try {
    runActs(state, [randomTarget], host, deps);
  } catch (error) {
    caught = error;
  }

  // ★ 按「rng 变没变 && 读取器读没读过」记账的实现在这里读到 false：两个条件同时成立
  //   ⇒ 整道防线免判 ⇒ 违规**静默通过**（实测无异常，事件流是
  //   `[engine.random_picked ×2, damaged]`）。按次数差记账则是「读了 1 次、实际推进了
  //   2 次」，多出来的那次就是拦截器自己的。
  //   与上一条合起来才覆盖全：上一条测的是"只有拦截器自己随机"，本条测的是
  //   "动作与拦截器各随机一次"—— 后者恰好是前者那种实现看不见的那一半。
  expect(caught instanceof InterceptRandomError).toBe(true);
  expect((caught as InterceptRandomError).owner).toBe(host);
  expect((caught as InterceptRandomError).op).toBe("act.hit");
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ IR v1 §5.3 规则 1「动作内快照」跨过拦截器这道坎：读一次、冻回去
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 只**读** `amount`（恒真的 cond），效果却**不碰** `amount` —— 于是"冻结"这件事
 * 只可能来自 `num.field` 那次读取本身，而不是 `set_field` / `mod_field` 的顺手回写。
 * `to` 指向敌方战线（就是那个 victim），所以 retarget 不改变谁挨打。
 */
const PEEK_AMOUNT: Card = interceptCard("T_PEEK_AMOUNT", {
  intercept: "act.hit",
  cond: { op: "cond.gte", l: { op: "num.field", field: "amount" }, r: 0 },
  effect: { kind: "retarget", to: ENEMY_BOARD },
});

test("★ 被拦动作的随机数值字段只求值一次（num.field 读过之后冻回动作）", () => {
  const deps = cardDeps([PEEK_AMOUNT]);
  const state = openGame();
  const host = putCard(state, 0, 0, PEEK_AMOUNT, { atk: 0, health: 9 });
  const victim = putUnit(state, 1, 0, { atk: 0, health: 40 });
  const randomAmount: Act = {
    op: "act.hit",
    target: { op: "sel.entity", id: victim },
    amount: { op: "num.random", lo: 1, hi: 6 },
  };

  const step = runActs(state, [randomAmount], host, deps);

  // ★ 恰好一次 RNG 推进，而且**打出去的点数就是 cond 看到的那个数**
  //   （`num.random` 的返回值 = lo + rollInt 的结果，`eval/num.ts`）。
  //   拦截器读一次、handler 再求一次的实现会读到两条 `engine.random_picked`，
  //   并且真打出去的是**第二次**的结果 —— 于是这两行同时红。
  const rolls = randomResults(step.events);
  expect(rolls).toHaveLength(1);
  expect(damageOf(step.state, victim)).toBe(1 + (rolls[0] ?? -1));
  // 顺带：这条随机**不该**被上面那道确定性防线误判成违规 —— 它是**动作自己**的随机，
  //   不是拦截器的（读取器单独记账）。本条能跑到断言就说明没误判。
});

/** 读 `target`（`filter` 命中判定必然要读），只把伤害 +1 用来证明它确实命中了。 */
const PEEK_TARGET: Card = interceptCard("T_PEEK_TARGET", {
  intercept: "act.hit",
  filter: { target: ENEMY_BOARD },
  effect: { kind: "mod_field", field: "amount", delta: 1 },
});

test("★ 被拦动作的随机目标字段只求值一次（filter 读过之后冻回动作）", () => {
  const deps = cardDeps([PEEK_TARGET]);
  const state = openGame();
  const host = putCard(state, 0, 0, PEEK_TARGET, { atk: 0, health: 9 });
  const foes = [
    putUnit(state, 1, 0, { atk: 0, health: 20 }),
    putUnit(state, 1, 1, { atk: 0, health: 20 }),
    putUnit(state, 1, 2, { atk: 0, health: 20 }),
  ];
  const randomTarget: Act = {
    op: "act.hit",
    target: { op: "sel.random", of: ENEMY_BOARD },
    amount: 1,
  };

  const step = runActs(state, [randomTarget], host, deps);

  // ★ 恰好一次抽取。不冻结的实现会抽两次（拦截器一次、handler 一次），
  //   于是"拦截器判定用的那个目标"与"真正挨打的那个"可能是两个单位。
  expect(randomResults(step.events)).toHaveLength(1);
  // 拦截器命中了（1 + 1 = 2），而且**只有一个**单位挨打。
  expect(foes.map((id) => damageOf(step.state, id)).filter((value) => value > 0)).toEqual([2]);
});

test("★ 一次读取可以推进**多次** RNG：免判按实际次数记，合法的多重射击不被误伤", () => {
  const deps = cardDeps([PEEK_TARGET]);
  const state = openGame();
  const host = putCard(state, 0, 0, PEEK_TARGET, { atk: 0, health: 9 });
  const foes = [
    putUnit(state, 1, 0, { atk: 0, health: 20 }),
    putUnit(state, 1, 1, { atk: 0, health: 20 }),
    putUnit(state, 1, 2, { atk: 0, health: 20 }),
  ];
  // 多重射击：**一次**求值就抽满 2 个（IR v1 §5.3 规则 3）⇒ 一次字段读取推进 **2** 次 RNG。
  const multishot: Act = {
    op: "act.hit",
    target: { op: "sel.random", of: ENEMY_BOARD, n: 2 },
    amount: 1,
  };

  // ★ 判别力在**这一行**，不在下面的断言上：这张卡完全合法（`filter` / `cond` 里一处
  //   `*.random` 都没有，随机全在被拦动作那边），可只要 `createActView` 的记账写成
  //   「这次求值推进过 RNG 就 +1」，它就记 1 次、实测 2 次 ⇒ 确定性防线判它违规 ⇒
  //   这一行抛 `InterceptRandomError`，整条测试红在 `runActs` 上。
  //   累加**实际次数**（`randomAdvancesSince`）才对得上账，见 `interceptors.ts`
  //   「确定性」一节的 ★「记账按次数差而不是变没变」。
  const step = runActs(state, [multishot], host, deps);

  // 一次求值抽 2 个、冻回去之后 handler 不再重求 ⇒ 恰好两条 `engine.random_picked`。
  expect(randomResults(step.events)).toHaveLength(2);
  // 拦截器命中了（1 + 1 = 2），而且恰好**两个**单位挨打（冻结走 `sel.or`，一次动作打完整批）。
  expect(foes.map((id) => damageOf(step.state, id)).filter((value) => value > 0)).toEqual([2, 2]);
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 冻结的第二项代价：多个随机字段的**求值顺序**随拦截器变（钉住现状，不是理想行为）
// ═══════════════════════════════════════════════════════════════════════════

/** 只**读** `amount`（恒真的 cond），效果是 +0 —— 于是它唯一的作用就是"读了一下"。 */
const PEEK_ONLY: Card = interceptCard("T_PEEK_ONLY", {
  intercept: "act.hit",
  cond: { op: "cond.gte", l: { op: "num.field", field: "amount" }, r: 0 },
  effect: { kind: "mod_field", field: "amount", delta: 0 },
});

test("★ 一条只读 amount 的拦截器会把 target/amount 的求值顺序倒过来（已知代价）", () => {
  /** 同一个盘面、同一个种子；两次运行的差别**只有** deps 认不认识那张卡。 */
  const board = (): { state: GameState; host: EntityId; foes: EntityId[] } => {
    const state = openGame();
    const host = putCard(state, 0, 0, PEEK_ONLY, { atk: 0, health: 9 });
    const foes = [
      putUnit(state, 1, 0, { atk: 0, health: 40 }),
      putUnit(state, 1, 1, { atk: 0, health: 40 }),
      putUnit(state, 1, 2, { atk: 0, health: 40 }),
    ];
    return { state, host, foes };
  };
  // 两个随机字段。签名顺序是先 `target` 后 `amount`（IR v1 §5.4 规则 1）。
  const randomHit: Act = {
    op: "act.hit",
    target: { op: "sel.random", of: ENEMY_BOARD },
    amount: { op: "num.random", lo: 1, hi: 6 },
  };

  const seen = board();
  const withCard = runActs(seen.state, [randomHit], seen.host, cardDeps([PEEK_ONLY]));
  const blind = board();
  const withoutCard = runActs(blind.state, [randomHit], blind.host, cardDeps([]));

  // 两边都恰好推进 **2** 次 —— 冻结生效，handler 没有重求。
  // ⚠ 别把这两行读成「拦截器不改变随机数条数」：那句话是假的，两个方向都假
  //   （`interceptors.ts` 第一条 ⚠ 列了实测数字）。这里两边相等只是因为
  //   `PEEK_ONLY` **只读、不覆盖任何字段、也不取消动作** —— 换成纯 `cancel`
  //   就是 0 次对 2 次，换成 `set_field(amount)` 就是 1 次对 2 次。
  expect(randomResults(withCard.events)).toHaveLength(2);
  expect(randomResults(withoutCard.events)).toHaveLength(2);

  // ★ 但**顺序**不同，于是结果不同：
  //   有拦截器 ⇒ `cond` 先求 `amount`（抽 3 ⇒ 1+3 = 4 点），handler 才求 `target`（抽 2 ⇒ 第 3 格）；
  //   没拦截器 ⇒ 按签名顺序先 `target`（抽 0 ⇒ 第 1 格）后 `amount`（抽 2 ⇒ 3 点）。
  //   ⚠ 这条**钉的是现状，不是理想行为**：规则 1 要的是签名序，这里的顺序由
  //   「拦截器先读了谁」决定（`interceptors.ts` 文件头第二条 ⚠ 写明了这项代价与
  //   两全的代价）。哪天有人把 `createActView` 改成"首次被读即按签名序冻结全部字段"，
  //   本条会红 —— 那时该改的是这条测试与那段文件头，而不是把它删掉。
  expect(randomResults(withCard.events)).toEqual([3, 2]);
  expect(randomResults(withoutCard.events)).toEqual([0, 2]);
  expect(seen.foes.map((id) => damageOf(withCard.state, id))).toEqual([0, 0, 4]);
  expect(blind.foes.map((id) => damageOf(withoutCard.state, id))).toEqual([3, 0, 0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 退化形态：卡表里没有拦截器时，一切照旧
// ═══════════════════════════════════════════════════════════════════════════

test("卡上没有 intercepts ⇒ 一条动作的行为与不接卡表时逐字相同", () => {
  const blank: Card = scriptCard("T_BLANK_INTERCEPT", {});
  const deps = cardDeps([blank]);
  const state = openGame();
  putCard(state, 0, 0, blank, { atk: 0, health: 9 });
  const victim = putUnit(state, 1, 0, { atk: 0, health: 9 });
  const before = handSize(state, 0);

  const step = runActs(state, [hitAct(victim, 4)], victim, deps);

  expect(damageOf(step.state, victim)).toBe(4);
  expect(eventNames(step.events)).toEqual(["damaged"]);
  expect(handSize(step.state, 0)).toBe(before);
});
