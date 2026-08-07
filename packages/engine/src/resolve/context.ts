// 流水线第 1 步：绑定上下文（框架 §4.1 的 `bindContext(state, pending)`）。
//
// 框架 §4.1 把它写成「绑定 SELF / TARGET / EVENT」，那是**动作与上下文分开存**的写法。
// 本引擎按 IR v1 §6.2 把上下文**随条目一起存进栈**（`PendingAction.ctx`），
// 于是绑定在「入栈那一刻」就已经完成，出栈时只需把它取出来。
//
// 为什么仍然保留这个函数而不是内联一句 `pending.ctx`：
//   1. **流水线的六步要在代码里逐步可见**。框架 §4.1 那段代码是本引擎唯一的时序权威，
//      读 `resolve.ts` 的人应当能一行一行对上规范，少一步就少一个可对照的锚点。
//   2. M4/M5 会往这里加真实工作：`sel.entity` 这类运行时超集节点的绑定（IR v1 §5.6）、
//      悬空 `self` 的处理（持有脚本的实体在入栈后死了）、trigger 条目的 `event` 复原。
//      有一个具名函数在，那些改动就落在这里，不会渗进流水线主体。
//
// ⚠ 上下文是**纯数据**（`state/stack.ts` 的 `CtxBindings`）：全是 id 与事件负载，
//   没有闭包、没有对象引用。这正是「结算中途可以整个落盘」的前提（框架 §4.2）。

import type { CtxBindings, GameState, PendingAction } from "../state/index.ts";

/**
 * 绑定一条栈条目的上下文（框架 §4.1 第 1 步）。
 *
 * M2：条目里存的 ctx 就是最终 ctx，原样返回。
 *
 * **不做防御性重建**（例如「`self` 已不存在就换成 0」）：悬空 id 是常态而不是错误
 * （见 `state/queries.ts` 的 `getEntity`），把它抹平只会让「亡语里引用自己」这类
 * 完全正常的场景失去信息。取不到实体时该静默跳过的是**求值器**（IR v1 §5.2），
 * 不是绑定这一步。
 *
 * `state` 参数在 M2 用不到，但**签名要与框架 §4.1 一致**：M4 的运行时超集绑定、
 * M5 的 trigger 事件复原都要读状态，届时直接在这里用，不必改流水线与全部调用点。
 */
export function bindContext(_state: GameState, pending: PendingAction): CtxBindings {
  return pending.ctx;
}
