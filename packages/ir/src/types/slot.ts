// slot.* 节点族：位置一等公民（SlotRef）。
// 来源：DSL v2 §3.1（新节点族）、§7（TS 权威类型）。v1 没有这一族。

import type { Num } from "./num.ts";
import type { Sel } from "./sel.ts";
import type { SlotSide } from "./zone.ts";

/** `slot.first_empty.from`：从最左还是最右找空格（DSL v2 §3.1），默认 `"left"`。 */
export const SLOT_SEARCH_FROMS = ["left", "right"] as const;

export type SlotSearchFrom = (typeof SLOT_SEARCH_FROMS)[number];

/**
 * 位置引用（DSL v2 §3.1 / §7）。
 *
 * 为什么需要它：选择器返回**实体**，但"空格子"不是实体 —— 召唤、移动、判空都需要**位置值**。
 *
 * **无效槽语义 = 空集合语义的位置版**（v2 §3.1）：
 * 动作的 SlotRef 参数解析为无效槽 → 该动作**静默跳过**；`cond.occupied(无效槽)` → `false`。
 *
 * 坐标是**一维** `(side, index)`，索引 0-8，双方同索引对齐；
 * v2 §12 已定案：永不加 lane/row 维度，格子数量本身仍走 `RulesConfig.board.slots`。
 */
export type SlotRef =
  /** 字面位置。`index` 为字面量时须落在 `[0, 8]`（v2 §9，L3/M11 校验）。 */
  | { op: "slot.at"; side: SlotSide; index: Num }
  /** 某实体所站的格。非单实体或不在场 → 无效槽。 */
  | { op: "slot.of"; of: Sel }
  /** 翻转 side，索引不变（"正对面那一格"）。 */
  | { op: "slot.opposite"; of: SlotRef }
  /** 同排位移。出界 → 无效槽。 */
  | { op: "slot.shift"; of: SlotRef; delta: Num }
  /**
   * 随机空格。无空格 → 无效槽。
   *
   * **推进 RNG**：与 `sel.random` / `num.random` / `card.random` 同级，
   * 因此**禁止出现在 aura / intercept.cond 内**（v2 §3.1 + IR v1 §5.4 规则 5，
   * 光环重算与死亡结算每步都跑，一旦消耗 RNG 就无法保证确定性）。
   */
  | { op: "slot.random_empty"; side: SlotSide }
  /** 最左/最右空格，`from` 默认 `"left"`。无空格 → 无效槽。 */
  | { op: "slot.first_empty"; side: SlotSide; from?: SlotSearchFrom };

/** `slot.*` 的 op 全集。 */
export type SlotOp = SlotRef["op"];

/** 按 op 取出单个 slot 节点类型，例：`SlotNode<"slot.at">`。 */
export type SlotNode<K extends SlotOp = SlotOp> = Extract<SlotRef, { op: K }>;
