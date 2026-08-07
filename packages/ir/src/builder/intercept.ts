// 拦截器（替换效果）的编写层构造器（IR §4.2、§10.6 圣盾）。
//
// 圣盾、免疫、减伤、"改为受到 1 点伤害"不是事后反应，而是**修改正在发生的动作**，
// 必须和 trigger 分开，否则时序永远对不上。
//
// 圣盾（IR §10.6）用本文件写出来是：
//   intercept({
//     intercept: "act.hit",
//     filter: { target: SELF },
//     cond: HasFlag(SELF, "divine_shield").and(Field("amount").gt(0)),
//     effect: Cancel(),
//     then: SetFlag(SELF, "divine_shield", false),
//     priority: 100,
//   })

import type {
  Act,
  ActNumField,
  ActOp,
  Cond,
  Intercept,
  InterceptEffect,
  InterceptFilter,
  Num,
  Sel,
} from "../types/index.ts";
import { type ActLike, toActs } from "./act.ts";

/** `effect.kind = "cancel"`：取消该动作，`then` 仍然执行。 */
export function Cancel(): InterceptEffect {
  return { kind: "cancel" };
}

/** `effect.kind = "set_field"`：覆盖被拦截动作的某个数值字段。 */
export function SetField(field: ActNumField, value: Num): InterceptEffect {
  return { kind: "set_field", field, value };
}

/** `effect.kind = "mod_field"`：增减被拦截动作的某个数值字段。 */
export function ModField(field: ActNumField, delta: Num): InterceptEffect {
  return { kind: "mod_field", field, delta };
}

/** `effect.kind = "retarget"`：改目标（转移伤害）。 */
export function Retarget(to: Sel): InterceptEffect {
  return { kind: "retarget", to };
}

/** {@link intercept} 的入参。`then` 收单个动作或数组。 */
export interface InterceptSpec {
  /** 拦哪个 op。战斗出手内部走 `act.hit` 管线，所以拦 `act.hit` 对战斗同样生效（v2 §3.4）。 */
  intercept: ActOp;
  filter?: InterceptFilter;
  /** 可用 `Field(...)` 读被拦截动作的字段值；**不得出现任何 `*.random`**（确定性规则）。 */
  cond?: Cond;
  effect: InterceptEffect;
  then?: ActLike;
  /** 默认 0，多个拦截器按它**降序**应用，最多 8 层。 */
  priority?: number;
}

/**
 * 拦截器构造器。字段顺序即规范键序：`intercept, filter, cond, effect, then, priority`
 * —— 与 IR §10.6 的规范 JSON 逐字对齐。
 */
export function intercept(spec: InterceptSpec): Intercept {
  const head: { intercept: ActOp; filter?: InterceptFilter; cond?: Cond } = {
    intercept: spec.intercept,
  };
  if (spec.filter !== undefined) {
    head.filter = spec.filter;
  }
  if (spec.cond !== undefined) {
    head.cond = spec.cond;
  }
  const tail: { then?: readonly Act[]; priority?: number } = {};
  if (spec.then !== undefined) {
    tail.then = toActs(spec.then);
  }
  if (spec.priority !== undefined) {
    tail.priority = spec.priority;
  }
  return { ...head, effect: spec.effect, ...tail };
}
