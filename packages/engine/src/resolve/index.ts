// resolve/ —— 结算流水线（架构 §2.3 的 `resolve/`，框架 §4.1 / §4.2）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 先读 `resolve.ts` 的文件头
// ═══════════════════════════════════════════════════════════════════════════
// **框架 §4.1 的四条时序规则逐字抄在那里**（文档明确要求）。90% 的卡牌 bug 来自时序，
// 这四条是本引擎唯一的时序权威；本目录的每个文件都只是它们的一处落地。
//
// ═══════════════════════════════════════════════════════════════════════════
// 文件分工（六步流水线逐步对应）
// ═══════════════════════════════════════════════════════════════════════════
//   resolve.ts       ★ 六步流水线本体 + 四条时序规则原文 + 步数上限与 ResolutionLoopError
//   context.ts       ① bindContext        —— 取出栈条目的上下文
//   interceptors.ts  ② applyInterceptors  —— 替换效果 / CANCELLED 哨兵 / 8 层上限
//   deps.ts          ③ handler 表与脚本展开器的注入点 + runHandler
//   act-slots.ts     ③ 动作的 SlotRef 参数：惰性解析器（求值恰好一次）+ 无效槽静默跳过（v2 §3.1）
//   triggers.ts      ④ queueTriggers      —— 排序（规则 1）+ 入栈（规则 2）+ 事件→触发器匹配
//                      （只排序不入栈的变体 `collectOrderedTriggers` 供战斗第 ③ 步累积用）
//   deaths.ts        ⑤ processDeaths      —— 批量移墓地、跑到不动点、判胜负【M2 真实现】
//   auras.ts         ⑥ refreshAuras       —— tags = base + Σ附魔 + Σ光环（两趟，光环不看光环）
//   push.ts          结算栈的写入口：条目怎么构造（inline / ref）+ LIFO 反转，都只在这里
//   suspend.ts       挂起与恢复（框架 §4.2）：suspend / resume / 超时兜底
//
// 关于 `triggers.ts` / `deaths.ts` / `auras.ts` 为什么在本目录：架构 §2.3 把
// `triggers/ deaths/ auras/` 列成了 engine 下的平级目录。M2 先把它们作为**流水线的
// 三个步骤**放在这里，因为此刻它们的全部内容就是"流水线在这一步调什么"。
// M5 写真语义时若长到需要独立目录，把函数体搬过去、让这里的同名函数转调即可 ——
// 接口（签名与调用点）不需要动，`resolve.ts` 的六步一行都不用改。
//
// ═══════════════════════════════════════════════════════════════════════════
// 当前边界
// ═══════════════════════════════════════════════════════════════════════════
// - **管线全通**：六步都在，顺序与框架 §4.1 逐条对齐。
// - **②④⑤⑥ 全是真实现**：
//   ② 的匹配与应用（`filter`/`cond`/四种 `effect`/`priority` 降序/8 层上限）在 M5/T2 落地，
//   来源同样经 `ResolveDeps.scripts` 注入；
//   ④ 的匹配（`on`/`filter`/`cond`/`once`/`zone` + 亡语糖展开）在 M5/T1 落地，
//   订阅源经 `ResolveDeps.scripts` / `enchantments` 注入；
//   ⑤ 的批量、不动点、base 归零判胜负 M2 就做了，亡语的匹配从来就属于 `triggers.ts`
//   （亡语是 `on: "unit_died"` 的触发器糖）；M5/T3 往里补了 `while_source_alive` 的剥离
//   与「判死前先重算光环」（v2 §4.2 第 ④ 步原文，见那个文件头）；
//   ⑥ 的两个 Σ（Σ附魔 + Σ生效光环）在 M5/T3 落地，定义经同样两张表注入。
//   **②④⑥ 不接卡表时都退化回"什么都没有"**（动作原样返回 / 排 0 条 / `tags = base`），
//   与 M2~M4 的行为逐字相同 —— 那是**语义正确的退化**，不是占位符。
// - **不含**：英雄/复燃泉语义（M6）、投影与 legalActions（M7）。
//   `apply(state, intent)` 属于 M3 的相位机，不在本目录。
//
// 上层 `src/index.ts` 由外层统一组装，本目录不参与。

export type {
  ActSlotAccess,
  ActSlotField,
  ActSlots,
  ErasedActSlots,
  SlotResolver,
} from "./act-slots.ts";
export { isActSkipped, NO_ACT_SLOTS, resolveActSlots } from "./act-slots.ts";
export { AuraRandomError, refreshAuras } from "./auras.ts";
export { bindContext } from "./context.ts";
export type { DeathReport } from "./deaths.ts";
export { processDeaths } from "./deaths.ts";
export type {
  ActHandler,
  HandlerTable,
  ResolveDeps,
  ScriptExpander,
  ScriptLookup,
  TriggerDeps,
} from "./deps.ts";
export { actOfPending, NO_SCRIPTS, runHandler } from "./deps.ts";
export type { InterceptResult } from "./interceptors.ts";
export {
  applyInterceptors,
  CANCELLED,
  InterceptChainError,
  InterceptRandomError,
  isCancelled,
  MAX_INTERCEPT_CHAIN,
} from "./interceptors.ts";
export {
  inlinePending,
  pushAct,
  pushActs,
  pushPending,
  pushPendingInOrder,
  pushScript,
} from "./push.ts";
export { MAX_RESOLUTION_DEPTH, ResolutionLoopError, resolve } from "./resolve.ts";
export type { ResumeInput } from "./suspend.ts";
export {
  defaultInputChoice,
  InvalidChoiceError,
  NotSuspendedError,
  resume,
  resumeWithTimeout,
  suspend,
} from "./suspend.ts";
export type { QueuedTrigger } from "./triggers.ts";
export {
  activePlayer,
  collectOrderedTriggers,
  collectTriggerSubscriptions,
  compareOwnerOrder,
  compareTriggerOrder,
  enqueueTriggers,
  queueTriggers,
  sortTriggers,
} from "./triggers.ts";
