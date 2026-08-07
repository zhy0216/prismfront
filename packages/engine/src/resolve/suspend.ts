// 挂起与恢复：结算中途等玩家选择（框架 §4.2、IR v1 §6.1）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 这是「结算栈进状态」这个设计的主要回报（框架 §4.2 原话）
// ═══════════════════════════════════════════════════════════════════════════
// > 因为 action 是**纯数据**、结算栈**在状态里**，暂停变成了天然能力：
// >   state.pendingInput = { player: 0, kind: "DISCOVER", options: [c1, c2, c3] };
// >   // → 序列化整个 state 存起来，玩家断线重连也不丢
// >   engine.resume(state, { chosen: c2 });   // 栈顶继续弹
// > 如果 action 是带方法的 class 实例（Fireplace 的做法），这里就得额外做协程
// > 或者把状态机拆成一堆特判。**action 即数据**这个决定，回报主要就在这里。
//
// 所以本文件几乎没有代码 —— 挂起能力不是在这里"实现"出来的，而是纯数据状态白送的。
// 这里只做三件小事：置挂起点、把玩家的选择写回栈顶上下文、继续弹栈。
// 反过来说：**哪天有人往栈条目里放了闭包或 class 实例，这个能力立刻失效**
// （框架 §13 坑 3）。架构 §6.1 第二条测试（序列化往返）就是它的探针。
//
// ═══════════════════════════════════════════════════════════════════════════
// 挂起点的调用契约（M4 写 `act.discover` / `act.select_target` 时必须遵守）
// ═══════════════════════════════════════════════════════════════════════════
// handler 被调用时，**它自己那条栈条目已经被弹出去了**。所以想"从中断处继续"，
// 必须由 handler 先把**续跑的动作**压回栈，再调 {@link suspend}：
//
//   pushActs(state, 拿到选择之后要做的事, ctx);   // 先压续跑
//   suspend(state, { player, kind: "discover", options, optional: false, deadline: null });
//
// {@link resume} 会把玩家的选择写进**栈顶条目**的 `ctx.chosen`（IR v1 §6.1 原文：
// 「写入 ctx.chosen，栈顶动作从中断处继续」），也就是刚压回去的那条续跑动作。
// 顺序写反（先 suspend 再 push）在 M2 看不出区别，但 M4 一接真求值器就会
// 把选择写到别人的条目上 —— 所以契约写在这里，别只写在 M4 的脑子里。

import type { CardId, EntityId } from "@prismfront/ir";
import type { GameEvent } from "../events/index.ts";
import type { GameState, InputRequest } from "../state/index.ts";
import { withCtx } from "../state/index.ts";
import type { ResolveDeps } from "./deps.ts";
import { resolve } from "./resolve.ts";

/** {@link resume} 的入参（框架 §4.2 的 `engine.resume(state, { chosen: c2 })`）。 */
export interface ResumeInput {
  /**
   * 玩家的选择。`null` = 放弃 —— 仅当 `pendingInput.optional` 为真
   * （或候选集为空）时合法，否则抛 {@link InvalidChoiceError}。
   *
   * 类型是 `EntityId | CardId` 的联合：`act.select_target` 与「从 `Sel` 发现」给的是
   * 实体 id，「从 `Pool` 发现」给的是卡 id（IR v1 §3.4 / §6.1）。
   * 要判别用 `state/queries.ts` 的 `isEntityId`。
   */
  readonly chosen: EntityId | CardId | null;
}

/** 在没有挂起点的状态上调 `resume()`。协议层撞上它多半是消息重放或 seq 错位。 */
export class NotSuspendedError extends Error {
  constructor() {
    super("resume() 要求 state.pendingInput 非空：当前状态没有挂起点（框架 §4.2）");
    this.name = "NotSuspendedError";
  }
}

/** 玩家回了一个不在候选集里的选择（或在不可放弃的挂起点上放弃）。 */
export class InvalidChoiceError extends Error {
  /** 被拒绝的选择。 */
  readonly chosen: EntityId | CardId | null;

  constructor(chosen: EntityId | CardId | null) {
    super(`resume() 收到的选择不在 pendingInput.options 内：${String(chosen)}（IR v1 §6.1）`);
    this.name = "InvalidChoiceError";
    this.chosen = chosen;
  }
}

/**
 * 置上挂起点（框架 §4.2）。
 *
 * 调用方是**挂起类动作的 handler**，调用前必须已经把续跑动作压回栈 —— 见文件头契约。
 * 置上之后 `resolve()` 的循环会在本步的第 ⑥ 步之后 break，整个 `state`
 * 可以直接 `JSON.stringify` 落盘（断线重连不丢，框架 §4.2）。
 *
 * `deadline` 由 server 层填（IR v1 §6.1）；**引擎永远写 `null`** ——
 * 架构 §6.1：引擎必须确定性且不读时间，`Date` 在 engine 的 biome.json 里是禁用全局。
 */
export function suspend(state: GameState, request: InputRequest): void {
  state.pendingInput = request;
}

/**
 * 超时兜底的选择（IR v1 §6.1：**超时兜底必须定义**，不能让一个挂起点把房间永久卡死）。
 *
 * 规范原文的两条，逐字落地：
 * - `discover` 超时取第一项；
 * - `select_target` 超时且 `optional=true` 则跳过，否则取第一个合法目标。
 *
 * `choose_one` 规范没单说，按 `discover` 同款处理（同是"给几个选项挑一个"）。
 * 候选集为空时返回 `null` —— 那本来就不该挂起（handler 该先判空再决定要不要挂），
 * 但兜底不该在兜底的时候崩。
 *
 * ⚠ **判定"超时了没有"不是引擎的事**：引擎不读时间（架构 §6.1）。
 *   server 层（M9）自己算超时，然后拿这个函数的返回值去调 {@link resume}。
 */
export function defaultInputChoice(request: InputRequest): EntityId | CardId | null {
  if (request.kind === "select_target" && request.optional) {
    return null;
  }
  return request.options[0] ?? null;
}

/**
 * 玩家做出选择，结算继续（框架 §4.2 / IR v1 §6.1）。
 *
 * 三步：校验选择合法 → 把选择写进**栈顶条目**的 `ctx.chosen` → 继续弹栈。
 * 返回值与 {@link resolve} 一样是这一段的事件流。
 *
 * **写的是栈顶**（IR v1 §6.1 原文「写入 ctx.chosen，栈顶动作从中断处继续」）。
 * 上下文用 `withCtx` **派生**而不是原地改：栈里可能有两条条目共享同一个 ctx 对象
 * （`act.for_each` 一次压入多条时就是），原地改会串到别人身上
 * （见 `state/stack.ts` 的 `withCtx`）。
 *
 * 栈是空的（挂起点之后没有续跑动作）也不算错：清掉挂起点、走一遍 `resolve()`
 * 排空日志即可 —— "问了一个不影响任何后续动作的问题"是合法的（例如只为记录选择）。
 */
export function resume(state: GameState, input: ResumeInput, deps: ResolveDeps): GameEvent[] {
  const request = state.pendingInput;
  if (request === null) {
    throw new NotSuspendedError();
  }

  const chosen = input.chosen;
  if (chosen === null) {
    // 放弃：只有可选的挂起点、或压根没有候选项时才允许。
    if (!request.optional && request.options.length > 0) {
      throw new InvalidChoiceError(chosen);
    }
  } else if (!request.options.includes(chosen)) {
    throw new InvalidChoiceError(chosen);
  }

  state.pendingInput = null;
  const top = state.stack[state.stack.length - 1];
  if (top !== undefined) {
    top.ctx = withCtx(top.ctx, { chosen });
  }

  return resolve(state, deps);
}

/**
 * 按 IR v1 §6.1 的超时兜底恢复结算。
 *
 * 等价于 `resume(state, { chosen: defaultInputChoice(state.pendingInput) }, deps)`。
 * server 层（M9）判定超时后调它；引擎自己**永远不会**主动调 —— 引擎不读时间。
 */
export function resumeWithTimeout(state: GameState, deps: ResolveDeps): GameEvent[] {
  const request = state.pendingInput;
  if (request === null) {
    throw new NotSuspendedError();
  }
  return resume(state, { chosen: defaultInputChoice(request) }, deps);
}
