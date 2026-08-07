// 流水线第 2 步：拦截器 / 替换效果（框架 §4.1 的 `applyInterceptors`）。
// 来源：框架 §4.1（`const action = applyInterceptors(...); if (action === CANCELLED) continue;`）、
//       IR v1 §4.2（Intercept 的形状与应用顺序）、IR v1 §7（拦截器链长度上限 8）、
//       DSL v2 §3.4（`act.strike` 内部走 `act.hit` 管线，所以拦 `act.hit` 对战斗同样生效）。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ M2 是**恒等空实现**，真语义在 M5 ★
// ═══════════════════════════════════════════════════════════════════════════
// M2 没有卡表，也就没有任何拦截器源，于是「收集到的拦截器链为空」⇒ 动作原样返回。
// 这不是占位符，而是**语义正确的退化情形**：空链的结果本来就是恒等。
// 所以这里**不抛 TODO 异常** —— 抛了会让 M2 的走查跑不通，而走查正是 M2 的完成标志。
//
// M5 往里填什么（流水线本身不需要改）：
//   1. 收集候选拦截器：场上（以及 `zone` 指定区域）所有实体的 `intercept`，
//      按 `intercept.intercept === act.op` 过滤；
//   2. `filter` 命中判定：键是被拦动作的实体字段（IR v1 §4.2 的 `ActEntityField`），
//      值是 `Sel`，需要 M4 的求值器；
//   3. `cond` 判定：可用 `num.field` 读被拦动作的字段值，**且不得含 `*.random`**
//      （IR v1 §5.4 规则 5：拦截器必须确定性，否则同一份状态两次结算会分叉）；
//   4. 按 `priority` **降序**依次应用，同优先级按 playOrder ——
//      即框架 §4.1 时序规则 1 的同一套排序，`triggers.ts` 的 `compareTriggerOrder` 可直接复用；
//   5. 每命中一条就执行它的 `then`（圣盾在这里清掉自己的标志位）——
//      `then` 是 `Act[]`，用 `push.ts` 的 `pushActs` **入栈**，不要就地执行
//      （时序规则 2：触发/连锁一律入栈）；
//   6. 链长超过 {@link MAX_INTERCEPT_CHAIN} 报错（IR v1 §7 资源上限）。
//
// ⚠ 拦截器与触发器**必须分开**（IR v1 §4.2 原文）：圣盾、免疫、减伤、"改为受到 1 点伤害"
//   不是事后反应，而是**修改正在发生的动作**。混进 trigger 里时序永远对不上。

import type { Act } from "@prismfront/ir";
import type { CtxBindings, GameState } from "../state/index.ts";

/**
 * 「该动作被取消」的哨兵（框架 §4.1 的 `CANCELLED`）。
 *
 * 用字符串常量而不是 `null`：`null` 会和「没有拦截器」「求值为空」混淆，
 * 而这三件事在流水线里的处理完全不同。`Act` 是对象联合，与字符串永不相撞，
 * 于是 `action === CANCELLED` 就是一次零成本、无歧义的判别。
 *
 * 被取消**不等于什么都没发生**：拦截器的 `then` 仍然执行（IR v1 §4.2），
 * 圣盾就是靠这一点在挡下伤害的同时清掉自己的标志位。
 */
export const CANCELLED = "__cancelled" as const;

/** {@link applyInterceptors} 的返回类型：改写后的动作，或 {@link CANCELLED}。 */
export type InterceptResult = Act | typeof CANCELLED;

/** 拦截器链长度上限（IR v1 §7 资源上限表）。M5 应用链时用它兜底。 */
export const MAX_INTERCEPT_CHAIN = 8;

/** 判别 {@link InterceptResult}。写成类型守卫，调用点不必重复字面量。 */
export function isCancelled(result: InterceptResult): result is typeof CANCELLED {
  return result === CANCELLED;
}

/**
 * 对一个即将执行的动作应用拦截器链（框架 §4.1 第 2 步 / IR v1 §4.2）。
 *
 * **M2：恒等实现** —— 没有拦截器源 ⇒ 空链 ⇒ 原样返回 `act`，永不返回 {@link CANCELLED}。
 * 真语义与 M5 的填法见文件头。
 *
 * 遵守框架 §4.1 的哪条时序规则：**规则 2**。拦截器命中后追加的 `then` 动作
 * 属于「连锁」，必须**入栈**而不是就地执行 —— 否则 `then` 会插到当前动作的
 * 死亡结算之前，圣盾的清标志位就可能早于它所挡下的那次伤害生效。
 *
 * 参数在 M2 未被使用，但签名与框架 §4.1 逐字对齐（`state, ctx, action`），
 * M5 直接在函数体里填，流水线与调用点一行都不用改。
 */
export function applyInterceptors(_state: GameState, _ctx: CtxBindings, act: Act): InterceptResult {
  return act;
}
