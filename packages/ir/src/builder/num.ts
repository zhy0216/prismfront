// num.* 的编写层构造器（IR §3.2、DSL v2 §3.3）。
//
// IR §1 原则 4：**常见字面量不包装** —— 数字直接写 `6`，所以 `Num = number | num.*节点`。
// 因此链式方法只能挂在**节点**上：`Count(X).times(2)` 可以，`2 .times(x)` 不行 ——
// 后者请写 `Mul(2, x)`。

import type { ActNumField, Cond, GlobalTag, Num, NumNode, Sel, TagKey } from "../types/index.ts";
import type { FluentCond } from "./cond.ts";
import { Eq, Gt, Gte, Lt, Lte, Ne } from "./cond.ts";
import { withChain } from "./fluent.ts";

/** 挂在 `num.*` 节点原型上的链式方法。 */
export interface NumChain {
  /** `num.add`。链上连写会摊平成一个变参节点。 */
  plus(this: FluentNum, other: Num): FluentNum;
  /** `num.sub`（`this - other`）。 */
  minus(this: FluentNum, other: Num): FluentNum;
  /** `num.mul`。IR §10.4 的 `Count(FRIENDLY_MINIONS).times(2)`。链上连写会摊平。 */
  times(this: FluentNum, other: Num): FluentNum;
  /** `num.div`：**向下取整，除零得 0**。 */
  dividedBy(this: FluentNum, other: Num): FluentNum;
  /** `num.neg`。IR §10.4 的 `Count(FRIENDLY_MINIONS).negate()`（费用修正常用）。 */
  negate(this: FluentNum): FluentNum;
  /** `num.clamp`。 */
  clamp(this: FluentNum, lo: Num, hi: Num): FluentNum;
  /** `cond.eq`。 */
  eq(this: FluentNum, other: Num): FluentCond;
  /** `cond.ne`。 */
  ne(this: FluentNum, other: Num): FluentCond;
  /** `cond.gt`。 */
  gt(this: FluentNum, other: Num): FluentCond;
  /** `cond.gte`。IR §10.4 的 `Attr(SELF,"atk").gte(3)`。 */
  gte(this: FluentNum, other: Num): FluentCond;
  /** `cond.lt`。 */
  lt(this: FluentNum, other: Num): FluentCond;
  /** `cond.lte`。 */
  lte(this: FluentNum, other: Num): FluentCond;
}

/** 带链式方法的数值**节点**（不含字面 `number`）。 */
export type FluentNum = NumNode & NumChain;

const numProto: NumChain = {
  plus(other) {
    return this.op === "num.add"
      ? numNode({ op: "num.add", of: [...this.of, other] })
      : numNode({ op: "num.add", of: [this, other] });
  },
  minus(other) {
    return Sub(this, other);
  },
  times(other) {
    return this.op === "num.mul"
      ? numNode({ op: "num.mul", of: [...this.of, other] })
      : numNode({ op: "num.mul", of: [this, other] });
  },
  dividedBy(other) {
    return Div(this, other);
  },
  negate() {
    return Neg(this);
  },
  clamp(lo, hi) {
    return Clamp(this, lo, hi);
  },
  eq(other) {
    return Eq(this, other);
  },
  ne(other) {
    return Ne(this, other);
  },
  gt(other) {
    return Gt(this, other);
  },
  gte(other) {
    return Gte(this, other);
  },
  lt(other) {
    return Lt(this, other);
  },
  lte(other) {
    return Lte(this, other);
  },
};

/** 给任意 `num.*` 节点套上链式原型。 */
export function numNode<T extends NumNode>(node: T): T & NumChain {
  return withChain(numProto, node);
}

/** `num.count`：集合大小。空集 → 0。 */
export function Count(of: Sel): FluentNum {
  return numNode({ op: "num.count", of });
}

/** `num.attr`：单个实体的属性。集合非单元素时返回 0。 */
export function Attr(of: Sel, tag: TagKey): FluentNum {
  return numNode({ op: "num.attr", of, tag });
}

/** `Attr(of, "direction")` 的别名 —— 方向是普通 Tag（v2 §2.3），读它没有特殊 op。 */
export function Direction(of: Sel): FluentNum {
  return Attr(of, "direction");
}

/** `num.sum`：求和。空集 → 0。 */
export function Sum(of: Sel, tag: TagKey): FluentNum {
  return numNode({ op: "num.sum", of, tag });
}

/** `num.add`：变参求和。 */
export function Add(...of: readonly Num[]): FluentNum {
  return numNode({ op: "num.add", of });
}

/** `num.mul`：变参求积。 */
export function Mul(...of: readonly Num[]): FluentNum {
  return numNode({ op: "num.mul", of });
}

/** `num.max`：多值取最大。 */
export function Max(...of: readonly Num[]): FluentNum {
  return numNode({ op: "num.max", of });
}

/** `num.min`：多值取最小。 */
export function Min(...of: readonly Num[]): FluentNum {
  return numNode({ op: "num.min", of });
}

/** `num.sub`：减法。 */
export function Sub(l: Num, r: Num): FluentNum {
  return numNode({ op: "num.sub", l, r });
}

/** `num.div`：**向下取整，除零得 0**（IR §3.2）。 */
export function Div(l: Num, r: Num): FluentNum {
  return numNode({ op: "num.div", l, r });
}

/** `num.neg`：取负。 */
export function Neg(of: Num): FluentNum {
  return numNode({ op: "num.neg", of });
}

/** `num.clamp`：夹取到 `[lo, hi]`。 */
export function Clamp(of: Num, lo: Num, hi: Num): FluentNum {
  return numNode({ op: "num.clamp", of, lo, hi });
}

/**
 * `num.if`：三元。**只求值命中的那个分支**（IR §5.4 规则 4 的数值版）。
 * 第三个形参在 IR 里叫 `else`（保留字不能当形参名，故这里叫 `otherwise`）。
 */
export function NumIf(cond: Cond, then: Num, otherwise: Num): FluentNum {
  return numNode({ op: "num.if", cond, then, else: otherwise });
}

/** `num.random`：闭区间随机整数。**推进 RNG**，禁止出现在 aura / intercept.cond 内。 */
export function RandomInt(lo: Num, hi: Num): FluentNum {
  return numNode({ op: "num.random", lo, hi });
}

/** `num.tag`：全局量（`round` / `crystals` / `crystal_cap` / `fatigue`）。 */
export function GlobalNum(tag: GlobalTag): FluentNum {
  return numNode({ op: "num.tag", tag });
}

/** 当前回合数。 */
export const ROUND = GlobalNum("round");
/** 本回合可用水晶。 */
export const CRYSTALS = GlobalNum("crystals");
/** 水晶上限。 */
export const CRYSTAL_CAP = GlobalNum("crystal_cap");
/** 疲劳计数。 */
export const FATIGUE = GlobalNum("fatigue");

/**
 * `num.field`：读取**被拦截动作**的数值字段（IR §4.2）。
 * 仅在 `intercept` 内部合法 —— 圣盾的 `Field("amount").gt(0)` 就是它（IR §10.6）。
 */
export function Field(field: ActNumField): FluentNum {
  return numNode({ op: "num.field", field });
}

/**
 * `num.slot_index`：所站格索引。
 * **全 IR 唯一的例外返回值：不在场 / 非单实体 → `-1`**（v2 §3.3）。
 */
export function SlotIndex(of: Sel): FluentNum {
  return numNode({ op: "num.slot_index", of });
}
