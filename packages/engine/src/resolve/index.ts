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
//   interceptors.ts  ② applyInterceptors  —— 替换效果 / CANCELLED 哨兵      【M5 填】
//   deps.ts          ③ handler 表与脚本展开器的注入点 + runHandler
//   triggers.ts      ④ queueTriggers      —— 排序（规则 1）与入栈（规则 2）【匹配 M5 填】
//   deaths.ts        ⑤ processDeaths      —— 批量移墓地、跑到不动点、判胜负【M2 真实现】
//   auras.ts         ⑥ refreshAuras       —— tags = base + Σ附魔 + Σ光环    【两个 Σ M5 填】
//   push.ts          结算栈的写入口（LIFO 反转只在这里发生）
//   suspend.ts       挂起与恢复（框架 §4.2）：suspend / resume / 超时兜底
//
// 关于 `triggers.ts` / `deaths.ts` / `auras.ts` 为什么在本目录：架构 §2.3 把
// `triggers/ deaths/ auras/` 列成了 engine 下的平级目录。M2 先把它们作为**流水线的
// 三个步骤**放在这里，因为此刻它们的全部内容就是"流水线在这一步调什么"。
// M5 写真语义时若长到需要独立目录，把函数体搬过去、让这里的同名函数转调即可 ——
// 接口（签名与调用点）不需要动，`resolve.ts` 的六步一行都不用改。
//
// ═══════════════════════════════════════════════════════════════════════════
// M2 的边界
// ═══════════════════════════════════════════════════════════════════════════
// - **管线全通**：六步都在，顺序与框架 §4.1 逐条对齐。
// - **②④⑥ 是恒等空实现**（M5 补真语义）。它们不是抛异常的占位符，而是
//   「没有拦截器源 / 没有触发器源 / 没有增益源」这三种退化情形下的**正确结果**：
//   拦截器不改动作、触发不入栈、光环重算得到 `base` 本身。
//   于是 M2 的走查（抽牌 → 放单位到格 → 手动 strike → 死亡）能真的跑通。
// - **⑤ 是真实现**：批量、不动点、base 归零判胜负都做了；只有"亡语的匹配"落在 M5，
//   而那件事本来就属于 `triggers.ts`（亡语是 `on: "unit_died"` 的触发器糖）。
// - **不含**：DSL 求值器（M4）、回合状态机与战斗（M3）、英雄/复燃泉语义（M6）、
//   投影与 legalActions（M7）。`apply(state, intent)` 属于 M3 的相位机，不在本目录。
//
// 上层 `src/index.ts` 由外层统一组装，本目录不参与。

export { refreshAuras } from "./auras.ts";
export { bindContext } from "./context.ts";
export type { DeathReport } from "./deaths.ts";
export { processDeaths } from "./deaths.ts";
export type { ActHandler, HandlerTable, ResolveDeps, ScriptExpander } from "./deps.ts";
export { actOfPending, NO_DEPS, NO_HANDLERS, runHandler } from "./deps.ts";
export type { InterceptResult } from "./interceptors.ts";
export { applyInterceptors, CANCELLED, isCancelled, MAX_INTERCEPT_CHAIN } from "./interceptors.ts";
export {
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
  collectTriggerSubscriptions,
  compareTriggerOrder,
  enqueueTriggers,
  queueTriggers,
  sortTriggers,
} from "./triggers.ts";
