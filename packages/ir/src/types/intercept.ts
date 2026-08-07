// Intercept：替换效果（修改正在发生的动作）。
// 来源：IR v1 §4.2 + §9。v2 未改动这一族的形状。

import type { Act, ActEntityField, ActNumField, ActOp } from "./act.ts";
import type { Cond } from "./cond.ts";
import type { Num } from "./num.ts";
import type { Sel } from "./sel.ts";

/**
 * 拦截器的动作过滤器（IR v1 §4.2）。
 * 键是被拦截动作的实体字段名，值是 `Sel`。例：圣盾 `{ target: sel.self }`。
 */
export type InterceptFilter = Partial<Record<ActEntityField, Sel>>;

/** 拦截效果（IR v1 §4.2 的 `effect.kind` 表）。 */
export type InterceptEffect =
  /** 取消该动作，`then` 仍然执行。 */
  | { kind: "cancel" }
  /** 覆盖动作的某个数值字段。 */
  | { kind: "set_field"; field: ActNumField; value: Num }
  /** 增减动作的某个数值字段。 */
  | { kind: "mod_field"; field: ActNumField; delta: Num }
  /** 改目标（转移伤害）。 */
  | { kind: "retarget"; to: Sel };

/** `effect.kind` 的全集。 */
export type InterceptEffectKind = InterceptEffect["kind"];

/**
 * 替换效果（IR v1 §4.2）。
 *
 * 圣盾、免疫、减伤、"改为受到 1 点伤害"这类效果不是"事后反应"，而是**修改正在发生的动作**。
 * 必须和 trigger 分开，否则时序永远对不上。
 *
 * 多个拦截器按 `priority` **降序**依次应用，同优先级按 playOrder。
 * **最多 8 层**，超出报错（IR v1 §7 资源上限）。
 *
 * `cond` 内可用 `num.field(field)` 读被拦截动作的字段值，
 * 但**不得出现 `*.random` / `slot.random_empty`**（确定性规则，IR v1 §5.4 规则 5 + v2 §3.1）。
 */
export interface Intercept {
  /** 拦哪个 op。战斗出手内部走 `act.hit` 管线，所以拦 `act.hit` 对战斗同样生效（v2 §3.4）。 */
  intercept: ActOp;
  filter?: InterceptFilter;
  cond?: Cond;
  effect: InterceptEffect;
  /** 拦截命中后追加执行的动作（圣盾在这里清掉自己的标志位）。 */
  then?: readonly Act[];
  /** 默认 0。降序应用。 */
  priority?: number;
}

/** 便于 handler / 校验器按 op 取被拦截动作的类型。 */
export type InterceptedAct<K extends ActOp = ActOp> = Extract<Act, { op: K }>;
