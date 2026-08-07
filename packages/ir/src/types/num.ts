// num.* 节点族：数值（求值得到 number）。
// 来源：IR v1 §3.2 + §9（基线）、DSL v2 §3.3（增改）、§7（TS 权威类型）。

import type { ActNumField } from "./act.ts";
import type { Cond } from "./cond.ts";
import type { Sel } from "./sel.ts";
import type { GlobalTag, TagKey } from "./tag.ts";

/**
 * 数值节点（IR v1 §3.2、DSL v2 §3.3）。
 *
 * IR v1 原则 4：**常见字面量不包装** —— 数字直接写 `6`，不写 `{"op":"num.const","v":6}`。
 * 只有需要惰性求值时才升级为节点。所以 `number` 是这个联合的合法成员。
 *
 * 空集合语义（IR v1 §5.2）：`num.count` / `num.attr` / `num.sum` 对空集一律返回 `0`。
 * **唯一例外是 `num.slot_index`：返回 `-1`**（因为 0 是真实格子，不能当空值用，v2 §3.3）。
 */
export type Num =
  /** 字面数字（IR v1 原则 4，不包装）。 */
  | number
  /** 集合大小。空集 → 0。 */
  | { op: "num.count"; of: Sel }
  /** 单个实体的属性。集合非单元素时返回 0。方向读数就是 `num.attr(of, "direction")`。 */
  | { op: "num.attr"; of: Sel; tag: TagKey }
  /** 求和。空集 → 0。 */
  | { op: "num.sum"; of: Sel; tag: TagKey }
  /** 变参求和。 */
  | { op: "num.add"; of: readonly Num[] }
  /** 变参求积。 */
  | { op: "num.mul"; of: readonly Num[] }
  /** 多值取最大。 */
  | { op: "num.max"; of: readonly Num[] }
  /** 多值取最小。 */
  | { op: "num.min"; of: readonly Num[] }
  /** 减法。 */
  | { op: "num.sub"; l: Num; r: Num }
  /** 除法：**向下取整，除零得 0**（IR v1 §3.2）。 */
  | { op: "num.div"; l: Num; r: Num }
  /** 取负（`costMod` 常用）。 */
  | { op: "num.neg"; of: Num }
  /** 夹取到 `[lo, hi]`。 */
  | { op: "num.clamp"; of: Num; lo: Num; hi: Num }
  /** 三元。只求值命中的那个分支（IR v1 §5.4 规则 4 的数值版）。 */
  | { op: "num.if"; cond: Cond; then: Num; else: Num }
  /**
   * 闭区间随机整数。**推进 RNG**（IR v1 §5.4）。
   * 禁止出现在 aura / intercept.cond 内（确定性规则，L3/M11 校验）。
   */
  | { op: "num.random"; lo: Num; hi: Num }
  /** 全局量：`round` / `crystals` / `crystal_cap` / `fatigue`（v2 §3.3）。 */
  | { op: "num.tag"; tag: GlobalTag }
  /**
   * 读取**被拦截动作**的某个数值字段。
   * **仅在 intercept 内部合法**（IR v1 §5.1 / §4.2，L3 校验）。
   */
  | { op: "num.field"; field: ActNumField }
  /**
   * 所站格索引。
   * **全 IR 唯一的例外返回值：不在场 / 非单实体 → `-1`**（v2 §3.3）。
   */
  | { op: "num.slot_index"; of: Sel };

/** `num.*` 的 op 全集（不含字面 `number` 这一支）。 */
export type NumOp = Extract<Num, { op: string }>["op"];

/** 按 op 取出单个数值节点类型，例：`NumNode<"num.count">`。 */
export type NumNode<K extends NumOp = NumOp> = Extract<Num, { op: K }>;
