// pendingInput：结算中途等玩家选择的挂起点。
// 来源：框架 §4.2、IR v1 §6.1（挂起协议）、IR v1 §3.4（discover / select_target）、
//       DSL v2 §4.4（战斗阶段的挂起兼容性）。

import type { CardId, EntityId } from "@prismfront/ir";
import type { PlayerId } from "./player.ts";

/** 挂起点的种类（IR v1 §6.1）。 */
export const INPUT_KINDS = ["discover", "select_target", "choose_one"] as const;

export type InputKind = (typeof INPUT_KINDS)[number];

/**
 * 挂起点（IR v1 §6.1 的 `state.pendingInput`）。
 *
 * 置上它 ⇒ `resolve` 的循环 break ⇒ 整个 state 可序列化落盘（框架 §4.2）。
 * 玩家回应后 `resume(state, { chosen })` 把结果写进栈顶条目的 `ctx.chosen`，继续弹栈。
 *
 * **超时兜底必须定义**（IR v1 §6.1，不能让一个挂起点把房间永久卡死）：
 * - `discover`：取 `options[0]`；
 * - `select_target`：`optional` 为真则跳过，否则取第一个合法目标。
 *
 * 字段一律「必填 + `| null`」，理由见 `stack.ts` 的 {@link import("./stack.ts").CtxBindings}。
 */
export interface InputRequest {
  /** 该谁做选择。 */
  player: PlayerId;
  kind: InputKind;
  /**
   * 候选项。`select_target` 给的是实体 id；`discover` 从 `Pool` 发现时给的是卡 id、
   * 从 `Sel` 发现时给的是实体 id（IR v1 §3.4 的 `act.discover.from: Sel | Pool`）。
   * 两种 id 在 `ctx.chosen` 里本来就是同一个联合，这里不再拆成两个数组类型。
   */
  options: readonly (EntityId | CardId)[];
  /** 是否允许放弃（`act.select_target.optional`）。`discover` 恒为 `false`。 */
  optional: boolean;
  /**
   * 回合计时快照，**由 server 层填**（IR v1 §6.1）。
   *
   * 引擎自己永远不写它（恒为 `null`）—— 架构 §6.1：引擎必须确定性且不读时间，
   * `Date` 在 engine 的 biome.json 里是被禁的全局。需要时间就由调用方喂进来，
   * 这个字段就是喂进来的那个位置。
   */
  deadline: number | null;
}
