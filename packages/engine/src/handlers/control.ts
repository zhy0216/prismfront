// 控制流三件套：`act.when` / `act.repeat` / `act.for_each`（IR v1 §3.4）。
// 来源：IR v1 §5.3 规则 1/2（动作内快照 vs 每轮重新求值）、§5.4 规则 2/4（求值顺序）、
//       框架 §4.1 时序规则 2（连锁一律入栈）。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 三条铁规里的两条在这个文件里正面相撞 ★★★
// ═══════════════════════════════════════════════════════════════════════════
// 规则 2｜`act.repeat` **每轮重新求值**（奥术飞弹：三发可能打同一个）→ ★ 本文件
// 规则 3｜`sel.random(n)` **一次性求值**（多重射击：一次选 n 个不重复）→ `eval/sel.ts`
//
//   repeat(3, hit(random(enemies), 1))   三次独立抽，可能重复 —— 每轮一条 RNG
//   hit(random(enemies, n=3), 1)         一次抽 3 个，互不重复 —— 一次三条 RNG
//
// **两个写法长得像、语义完全不同**（规范原话）。本文件的落地方式让"重求"这件事
// 成为结构性的而不是靠自觉：{@link repeatHandler} 把 `do` **原样**压 n 份进栈，
// 里面的 `Sel` 节点一次都不在这里求值 —— 每一份出栈时才由它自己的 handler 求，
// 于是"每轮重新求值"是免费的，想写错反而要多花力气（得先在这里求一次值再冻进去）。
//
// ⚠ **review checklist（M4 起长期）**：见 `handlers/index.ts` 文件头那一节。
//   改本文件之前先读它；两条对照测试在 `handlers/__tests__/eval-timing.test.ts`。
//
// ═══════════════════════════════════════════════════════════════════════════
// 为什么三个 handler 都只压栈、不就地递归执行
// ═══════════════════════════════════════════════════════════════════════════
// 框架 §4.1 时序规则 2：**触发是入栈而非立即执行**。就地递归调 `runHandler` 会让
// 循环体内部的动作绕过流水线的第 ④~⑥ 步 —— 一轮里打死的单位不会在下一轮开始前
// 结算死亡，亡语也排不进队。压栈之后每一条循环体动作都是**独立的一步**，
// 六步流水线一步不落，这正是 `act.for_each` 那条"一个个打过去，死一个结算一个"
// 的手感来源。代价是栈会长一点（`MAX_RESOLUTION_DEPTH = 256` 兜底）。

import type { Act, EntityId } from "@prismfront/ir";
import { evalCond, evalNum } from "../eval/index.ts";
import type { ActHandler } from "../resolve/index.ts";
import { MAX_RESOLUTION_DEPTH, pushActs } from "../resolve/index.ts";
import { withCtx } from "../state/index.ts";
import { snapshot } from "./targets.ts";

/**
 * `act.when{cond, then, else?}` —— 条件分支。
 *
 * ★ IR v1 §5.4 规则 4：**只求值命中的那个分支**。这里只把命中的那一支压栈，
 * 另一支连碰都不碰 —— 写成"先把两支都算出来再选"会多消耗一整条分支的 RNG，
 * 单测全绿、回放失真（`eval/index.ts` 文件头把这条与 `cond.and/or` 的短路并列）。
 *
 * `else` 省略且条件为假 ⇒ 什么都不压，动作到此结束（IR v1 §3.4：字段可省，省略等价空数组）。
 */
export const whenHandler: ActHandler<"act.when"> = (env, act) => {
  const branch = evalCond(env, act.cond) ? act.then : act.else;
  if (branch === undefined) {
    return;
  }
  pushActs(env.state, branch, env.ctx);
};

/**
 * `act.repeat{n, do}` —— 重复 n 次。★ **每轮重新求值**（IR v1 §5.3 规则 2）★
 *
 * 实现就是「把 `do` **原样**压 n 份」：节点里的 `Sel` / `Num` 在本函数里一次都不求值，
 * 每一份出栈时各自求各自的，于是三发奥术飞弹是三次独立的随机。
 * 与 `sel.random(n)` 的一次性求值（规则 3）的对照见文件头。
 *
 * `n` 本身**只求值一次**（它是本动作的字段，受规则 1 管）：
 * `repeat(num.random(1,3), …)` 抽一次决定轮数，不是每轮再抽一次。
 *
 * `n <= 0` ⇒ 一份都不压（不是"至少跑一轮"）。
 *
 * ── 为什么要按 `MAX_RESOLUTION_DEPTH` 截一刀 ───────────────────────────────
 * IR v1 §7 的「`act.repeat.n` 字面量时 ≤ 64」是**编写期**校验，管不住算出来的 `n`
 * （`num.mul(9999, 9999)` 是合法表达式）。而 `resolve.ts` 的 `MAX_RESOLUTION_DEPTH`
 * 数的是**弹栈次数**，压栈这一步够不着它 —— 不截的话一个失控的 `n` 会先把这个
 * `for` 循环挂死，连 `ResolutionLoopError` 都抛不出来。
 * 截在 256 **不改变可观测行为**：第 257 次弹栈必定抛 `ResolutionLoopError`
 * （本动作自己已经占掉一次弹栈），所以第 257 轮起本来就永远执行不到。
 * 也就是说这一刀只是把"挂死"换成"照常抛那个唯一的连锁失控错误"。
 *
 * 压栈顺序：n 份内容完全相同，先压哪一份都一样；仍然按倒序循环，
 * 与 {@link forEachHandler} 保持同一种写法（那里的顺序**是**语义）。
 */
export const repeatHandler: ActHandler<"act.repeat"> = (env, act) => {
  const times = Math.min(evalNum(env, act.n), MAX_RESOLUTION_DEPTH);
  for (let round = times - 1; round >= 0; round -= 1) {
    pushActs(env.state, act.do, env.ctx);
  }
};

/**
 * `act.for_each{of, do}` —— 遍历，把 `sel.it` 绑到每个成员。
 *
 * ★ IR v1 §5.3：**`act.for_each` 遵循规则 1** —— 列表在**循环开始时快照**，
 * 循环中新增的实体不会被迭代到。实现方式让这条成为结构性的：
 * {@link snapshot} 求值一次得到 id 列表，随即把 `do` 逐个压栈并把 `it`
 * 冻进**各自的栈条目 ctx**（纯数据，跨得过挂起点）。循环开始后 `of` 再也不会被求值，
 * 所以"循环中上场的单位也被打了一下"这种 bug 在这里写不出来。
 *
 * `it` 走 `state/stack.ts` 的 `withCtx` 而不是 `eval/context.ts` 的 `withIt`：
 * 后者产出的是求值期的一次性载体，进不了状态（见那两个函数的说明）。
 *
 * ── 压栈顺序**是**语义 ────────────────────────────────────────────────────
 * 栈是 LIFO，最后压的最先执行 ⇒ 要让 `ids[0]` 先跑，就得**倒着压**。
 * 顺序会一路变成事件顺序（v2 §4.2 顺序敏感点），写反了不会报错，只会让
 * 「从左到右一个个打」变成「从右到左」—— 而 `sel.zone` 的枚举顺序刚好是格序 0→8。
 */
export const forEachHandler: ActHandler<"act.for_each"> = (env, act) => {
  const frozen: readonly EntityId[] = snapshot(env, act.of);
  const body: readonly Act[] = act.do;
  for (let i = frozen.length - 1; i >= 0; i -= 1) {
    const it = frozen[i];
    if (it === undefined) {
      continue;
    }
    pushActs(env.state, body, withCtx(env.ctx, { it }));
  }
};

/** `act.nothing`：什么都不做（IR v1 §3.4）。它是一条**真实现**，不是占位。 */
export const nothingHandler: ActHandler<"act.nothing"> = () => {};
