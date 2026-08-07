// 事件日志：累积 + 排空。
//
// 来源：《框架设计》§3.3（输出是事件流）、§4.1（`resolve()` 末尾的 `drainEventLog(state)`）、
//       §3.2（引擎是纯函数）、§4.2（结算栈进状态 → 中途可挂起）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 决策：事件日志放在 state 里，不放在外部
// ═══════════════════════════════════════════════════════════════════════════
//
// 备选是「resolve 内部开一个局部数组」或「模块级全局缓冲」。选 state，三条理由，
// 第一条是决定性的：
//
// 1. **除了 state 之外，没有第二样东西能被所有产事件的子系统看到。**
//    看框架 §4.1 的流水线签名：`processDeaths(state)`、`refreshAuras(state)`、
//    `queueTriggers(state, emitted)` —— 死亡结算要发 `unit_died`、光环重算可能发
//    `buffed`、handler 要发本行动的事件，而它们手里**只有 state 一个参数**。
//    局部数组要能被它们看到，就得给每个 handler、每个子系统、每层递归都加一个
//    accumulator 参数；一旦哪天漏传一处，事件就静默丢失——这类 bug 没有编译期防线。
//    §4.1 写的是 `drainEventLog(state)` 而不是 `drainEventLog(log)`，就是这个意思。
//
// 2. **模块级全局缓冲会直接打破 §3.2「引擎是纯函数」。** bot 的 MCTS 要在一个
//    进程里并行推演成千上万个克隆状态（框架 §10），全局缓冲会让它们互相串味；
//    `clone(state)` 也复制不到那份缓冲，克隆出来的局面一结算就少事件。
//    放进 state 则 `clone` / `JSON.stringify` 自动带上，什么都不用额外做。
//
// 3. **顺带被架构 §6.1 第二条测试守住。** 事件日志既然是 state 的一部分，
//    「序列化往返不改变结算结果」这条探针就同时覆盖了 GameEvent 的纯数据性：
//    往事件里塞了函数或 class 实例，那条测试立刻红。多一个免费的探针。
//
// 代价与它的解法：state 会背着一段临时数组。所以定死一条不变量——
// **`apply()` / `resume()` 返回时 `state.eventLog` 必为空**：`resolve()` 的每条
// 退出路径（栈空、命中 `pendingInput` 挂起、深度上限抛错前）都要 `drainEventLog`。
// 于是快照里永远不会积压事件，挂起点存档也不会重复下发（框架 §4.2）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 为什么是结构类型 EventSink 而不是 GameState
// ═══════════════════════════════════════════════════════════════════════════
// 本模块只需要「有一个 eventLog 数组」这一点。声明成结构类型让事件层不反向依赖
// 状态层（state/ 定义 `GameState` 时把 `eventLog: GameEvent[]` 写进去即自动满足），
// 也让测试可以拿一个 `{ eventLog: [] }` 字面量当靶子，不必造一整局。

import type { GameEvent } from "./event.ts";

/**
 * 能收事件的东西。`GameState` 满足它——`state/` 只要带上 `eventLog: GameEvent[]` 字段。
 *
 * `readonly` 修饰的是**字段绑定**不是数组内容：本模块一律原地增删，从不给
 * `eventLog` 重新赋值。这样即使 `GameState` 把它声明成 `readonly`，这里也照样能用。
 */
export interface EventSink {
  readonly eventLog: GameEvent[];
}

/**
 * 造一个空日志。`state/` 建局时用它，别写裸 `[]`——
 * 有个具名构造函数，将来要换表示（比如加环形缓冲上限）只需改这一处。
 */
export function createEventLog(): GameEvent[] {
  return [];
}

/**
 * 累积一个事件（框架 §4.1 第 2 步 handler 的产出口）。
 *
 * 只追加，不做任何加工：去重、合并、投影都不是这一层的事
 * （投影是 M7 的 `projectEvent`，见 event.ts 文件头）。
 */
export function emitEvent(sink: EventSink, event: GameEvent): void {
  sink.eventLog.push(event);
}

/**
 * 按顺序累积一批事件。
 *
 * 用循环而不是 `push(...events)`：后者在事件量大时会把整批铺进调用栈参数，
 * 而战斗阶段一轮 18 次出手连锁下来，批量并不总是小的。
 */
export function emitEvents(sink: EventSink, events: readonly GameEvent[]): void {
  for (const event of events) {
    sink.eventLog.push(event);
  }
}

/**
 * 排空日志并返回这一批（框架 §4.1：`resolve()` 的返回值就是它）。
 *
 * 用 `splice(0)` 而不是「返回旧数组 + 赋一个新的」：**保持数组身份不变**，
 * 于是 `state.eventLog` 可以是 `readonly` 字段，也不会有别处捏着一个
 * 已经被换掉的旧引用继续 push（那些事件会永远发不出去）。
 *
 * 返回的数组与 `sink.eventLog` 是两个对象，调用方随便改，不会污染状态。
 */
export function drainEventLog(sink: EventSink): GameEvent[] {
  return sink.eventLog.splice(0);
}

/**
 * 只读地看一眼当前积压的事件，不清空。
 *
 * 给测试与断言用（「这一步该发 2 个事件」）。产线代码要拿事件请用
 * {@link drainEventLog}——看完不排空，下一批就会重复下发。
 */
export function peekEventLog(sink: EventSink): readonly GameEvent[] {
  return sink.eventLog;
}
