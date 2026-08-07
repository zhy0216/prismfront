// 结算栈的写入口。
// 来源：框架 §4.1（`stack.pop()` ⇒ 后进先出）、IR v1 §5.4 规则 2（`Act[]` 按数组下标升序求值）、
//       IR v1 §6.2（栈条目用 `<cardId>#<路径>` 引用，不内联节点）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 为什么需要一组具名的 push 函数，而不是到处写 `state.stack.push(...)`
// ═══════════════════════════════════════════════════════════════════════════
// 因为**栈是 LIFO，而 `Act[]` 的语义是顺序执行**，两者方向相反：
//
//   `[A, B, C]` 要按 A → B → C 执行  ⇒  必须按 C、B、A 的顺序 push
//
// 这个反转只要有一处写反，卡牌的动作顺序就会静默颠倒 —— 而颠倒后的结果往往
// 「看起来也挺合理」，于是能一路混进产线。把反转关进 {@link pushActs} 一个函数里，
// 全引擎（handler、触发器入栈、resume 续跑）都只调它，反转就只有一处可能写错。
//
// 同一条理由适用于框架 §4.1 时序规则 1 的触发器排序：`triggers.ts` 把排好序的
// 触发器交给 {@link pushPendingInOrder }，同样由本模块做那一次逆序。

import type { Act } from "@prismfront/ir";
import type { CtxBindings, GameState, PendingAction, ScriptRef } from "../state/index.ts";

/**
 * 把一个已经造好的栈条目压栈。
 *
 * 这是最底层的写入口；正常代码请优先用 {@link pushAct} / {@link pushActs} /
 * {@link pushScript}，它们负责造条目并处理顺序。
 */
export function pushPending(state: GameState, pending: PendingAction): void {
  state.stack.push(pending);
}

/**
 * 按「`items[0]` 最先出栈」的语义压入一批条目，即**逆序 push**。
 *
 * 调用方给的永远是**执行顺序**，反转由本函数负责 —— 见文件头。
 */
export function pushPendingInOrder(state: GameState, items: readonly PendingAction[]): void {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    // `noUncheckedIndexedAccess` 下 `items[i]` 是 `T | undefined`。这里 i 恒在界内，
    // 但不用 `!` 绕过去（架构对 M2 的硬约束之一），显式判一下更便宜也更诚实。
    if (item !== undefined) {
      state.stack.push(item);
    }
  }
}

/**
 * 压入一条**内联动作**（IR v1 §5.6 的运行时超集）。
 *
 * 内联而不是引用，只用于「引擎自己生成、在 bundle 里没有位置」的动作：
 * 战斗快照展开出的 `act.strike`（M3）、拦截器改写后重新入栈的动作（M5）、
 * 以及 M2 手写临时 handler 造出来的动作。来自卡表的脚本一律走 {@link pushScript}。
 */
export function pushAct(state: GameState, act: Act, ctx: CtxBindings): void {
  state.stack.push({ via: "inline", act, ctx });
}

/**
 * 压入一串内联动作，保证按**数组下标升序**执行（IR v1 §5.4 规则 2）。
 *
 * 这是 `act.when.then` / `act.repeat.do` / `act.for_each.do` / 触发器的 `do`
 * 这些 `Act[]` 字段唯一正确的入栈方式。
 */
export function pushActs(state: GameState, acts: readonly Act[], ctx: CtxBindings): void {
  for (let i = acts.length - 1; i >= 0; i -= 1) {
    const act = acts[i];
    if (act !== undefined) {
      state.stack.push({ via: "inline", act, ctx });
    }
  }
}

/**
 * 压入一条**脚本引用**条目（IR v1 §6.2 的规范形态）。
 *
 * `ref` 形如 `"CORE_050#play.1"`。条目里不内联节点，收益见 `state/stack.ts`：
 * 条目极小 → `clone(state)` 快 → MCTS 可行、快照/回放便宜。
 * 展开由 `deps.ts` 的 `ScriptExpander` 负责（M4 的求值器提供）。
 */
export function pushScript(state: GameState, ref: ScriptRef, ctx: CtxBindings): void {
  state.stack.push({ via: "ref", ref, ctx });
}
