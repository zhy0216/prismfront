// 挂起类动作：`act.select_target` —— 打出后再指一个目标（IR v1 §3.4 / §6.1）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 为什么 M4/E6 要把这个 op 从占位换成真实现
// ═══════════════════════════════════════════════════════════════════════════
// PF1 的 B01 换位术（v2 §8.4 的原型卡）需要**两个**目标：`script.target` 给第一个，
// 第二个只能在打出之后再问一次 —— 也就是 `act.select_target`。E6 的完成判据是
// 「卡打出去有正确效果」，所以它属于 M4 任务书那句「先支持 8–10 个最常用 op」。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 与 `resolve/suspend.ts` 文件头「挂起点调用契约」的关系 ★
// ═══════════════════════════════════════════════════════════════════════════
// 那份契约写的是：
//   pushActs(state, 拿到选择之后要做的事, ctx);   // 先压续跑
//   suspend(state, {...});
// 本 handler **没有那一行 `pushActs`**，不是漏了 —— 而是续跑动作**本来就已经在栈上**：
// `act.select_target` 出现在一段 `Act[]` 的中间（`[SelectTarget(…), Swap(TARGET, CHOSEN)]`），
// 而 `push.ts` 的 `pushActs` 把这段数组的**每一条**都压成了独立条目。轮到本动作执行时
// 它自己那条已经弹出去了，栈顶恰好就是它后面那一条（`Swap`）——
// `resume()` 把选择写进**栈顶条目**的 `ctx.chosen`（IR v1 §6.1 原文），正中目标。
// 契约里那一行是给「handler 自己造出续跑动作」的挂起点准备的（例如 `act.discover`
// 要在选完之后把卡加进手牌），本动作没有自造动作，所以不写。
//
// ⚠ 由此而来的一条边界：`act.select_target` **写在一段动作序列的最后一条**时，
//   栈顶是别人的条目，选择会写到那条上去。这在编写层是一张没有意义的卡
//   （问了一个谁都不读的问题），L3 语义校验（M11）应当报它；引擎侧不另设防 ——
//   IR v1 §6.1 定义的就是"写栈顶"这个语义，在这里发明第二套规则只会两处打架。

import { controllerOfSelf } from "../eval/index.ts";
import type { ActHandler } from "../resolve/index.ts";
import { suspend } from "../resolve/index.ts";
import { snapshot } from "./targets.ts";

/**
 * `act.select_target{from, optional?}` —— 置上挂起点，等玩家从 `from` 里指一个（IR v1 §3.4）。
 *
 * 三步，顺序即字段的声明顺序（IR v1 §5.4 规则 1）：
 * 1. `from` **求值一次**冻成候选集（规则 1「动作内快照」，经 `targets.ts` 的 `snapshot`）；
 * 2. 候选集为空 ⇒ **整个动作静默跳过**，不挂起（IR v1 §5.2）——
 *    挂一个没有候选项的选择点等于把房间卡在一个谁都答不出的问题上；
 * 3. 否则置 `pendingInput`，`resolve()` 的循环随即 break，整个 state 可落盘（框架 §4.2）。
 *
 * `player` = **SELF 的当前控制者**（不是 owner —— `act.steal` 之后两者会不同）。
 * 取不到 SELF 的实体（悬空 self 是常态，见 `eval/context.ts`）⇒ 没人可问，静默跳过。
 *
 * `optional` 缺省 `false`（IR v1 §3.4）。它同时决定超时兜底的行为：
 * `true` 跳过、`false` 取第一个合法目标（`resolve/suspend.ts` 的 `defaultInputChoice`）。
 *
 * 候选集只有一个成员时**照样挂起**：规范没有"唯一目标自动选中"这条捷径，
 * 引擎替玩家做决定会让客户端的挂起协议出现一个没有对应消息的分支。
 */
export const selectTargetHandler: ActHandler<"act.select_target"> = (env, act) => {
  const options = snapshot(env, act.from);
  if (options.length === 0) {
    return;
  }
  const player = controllerOfSelf(env);
  if (player === null) {
    return;
  }
  suspend(env.state, {
    player,
    kind: "select_target",
    options,
    optional: act.optional ?? false,
    deadline: null,
  });
};
