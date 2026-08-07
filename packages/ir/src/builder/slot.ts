// slot.* 的编写层构造器（DSL v2 §3.1 新节点族、§7 糖面清单）。
//
// 位置是**值**不是实体：空格子选不出实体，但召唤/移动/判空都需要它。
// 无效槽语义 = 空集合语义的位置版：动作的 SlotRef 解析为无效槽 → 该动作静默跳过。

import type { Num, Sel, SlotRef, SlotSearchFrom, SlotSide } from "../types/index.ts";
import { withChain } from "./fluent.ts";

/** 挂在 `slot.*` 节点原型上的链式方法。 */
export interface SlotChain {
  /** 翻转 side、索引不变 → `slot.opposite`。v2 §8.2 的 `SlotOf(SELF).opposite()`。 */
  opposite(this: FluentSlot): FluentSlot;
  /** 同排位移 → `slot.shift`，出界即无效槽。 */
  shift(this: FluentSlot, delta: Num): FluentSlot;
}

/** 带链式方法的位置引用。 */
export type FluentSlot = SlotRef & SlotChain;

const slotProto: SlotChain = {
  opposite() {
    return SlotOpposite(this);
  },
  shift(delta) {
    return SlotShift(this, delta);
  },
};

/** 给任意 `slot.*` 节点套上链式原型。 */
export function slotNode<T extends SlotRef>(node: T): T & SlotChain {
  return withChain(slotProto, node);
}

/** `At(FRIENDLY, 4)`（v2 §7）→ `slot.at`：字面位置，`index` 字面量须落在 `[0, 8]`。 */
export function At(side: SlotSide, index: Num): FluentSlot {
  return slotNode({ op: "slot.at", side, index });
}

/** `SlotOf(SELF)`（v2 §7）→ `slot.of`：某实体所站的格；非单实体或不在场 → 无效槽。 */
export function SlotOf(of: Sel): FluentSlot {
  return slotNode({ op: "slot.of", of });
}

/** `slot.opposite`：正对面那一格。链式写法是 `.opposite()`。 */
export function SlotOpposite(of: SlotRef): FluentSlot {
  return slotNode({ op: "slot.opposite", of });
}

/** `slot.shift`：同排位移。链式写法是 `.shift(delta)`。 */
export function SlotShift(of: SlotRef, delta: Num): FluentSlot {
  return slotNode({ op: "slot.shift", of, delta });
}

/**
 * `slot.random_empty`：随机空格，无空格 → 无效槽。**推进 RNG**，
 * 因此禁止出现在 aura / intercept.cond 内（v2 §3.1）。
 * 这也是 `Summon` 省略 `at` 时自动补上的那个默认值（v2 §7）。
 */
export function RandomEmptySlot(side: SlotSide): FluentSlot {
  return slotNode({ op: "slot.random_empty", side });
}

/** `slot.first_empty`：最左/最右空格，`from` 默认 `"left"`；无空格 → 无效槽。 */
export function FirstEmptySlot(side: SlotSide, from?: SlotSearchFrom): FluentSlot {
  const node: Extract<SlotRef, { op: "slot.first_empty" }> = { op: "slot.first_empty", side };
  if (from !== undefined) {
    node.from = from;
  }
  return slotNode(node);
}
