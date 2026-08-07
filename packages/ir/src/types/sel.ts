// sel.* 节点族：选择器（求值得到 Entity[]）。
// 来源：IR v1 §3.1 + §9（基线）、DSL v2 §3.2（增改）、§7（TS 权威类型）。

import type { Cond } from "./cond.ts";
import type { EventEntityField } from "./event.ts";
import type { Num } from "./num.ts";
import type { SlotRef } from "./slot.ts";
import type { TagKey } from "./tag.ts";
import type { SelSide, ZoneName } from "./zone.ts";

/** `sel.sort.dir`（IR v1 §3.1），默认 `"asc"`。同值按 playOrder 稳定。 */
export const SORT_DIRS = ["asc", "desc"] as const;

export type SortDir = (typeof SORT_DIRS)[number];

/** `sel.limit.from`（IR v1 §3.1）：取前 n 个还是后 n 个，默认 `"start"`。 */
export const LIMIT_FROMS = ["start", "end"] as const;

export type LimitFrom = (typeof LIMIT_FROMS)[number];

/**
 * 选择器节点（IR v1 §3.1、DSL v2 §3.2）。
 *
 * 空集合语义（IR v1 §5.2，统一规则，不许各 op 各自发明）：
 * `act.*` 的 target/player 求值为空集 → **静默跳过**，不报错、不产生事件。
 *
 * 求值时机三条规则（IR v1 §5.3，整份规范最容易出错的地方）：
 * 1. **动作内快照**：一个动作开始执行时其 target 选择器求值**一次**，结果在该动作全程冻结
 * 2. `act.repeat` **每轮重新求值**（奥术飞弹：三发可能打同一个）
 * 3. `sel.random(n)` **一次性求值**（多重射击：一次选 n 个不重复）
 *    —— 规则 2 与 3 长得像，语义完全不同
 */
export type Sel =
  // ── 上下文叶子（求值时从绑定上下文取，IR v1 §3.1 / §5.1）──────────────────
  /** 持有本脚本的实体。 */
  | { op: "sel.self" }
  /** 本次打出/动作指定的目标。用了它就必须声明 `script.target`（L3/M11 校验）。 */
  | { op: "sel.target" }
  /** SELF 的控制者（玩家实体）。 */
  | { op: "sel.controller" }
  /** 对手玩家实体。 */
  | { op: "sel.opponent" }
  /** 最近一次 `act.discover` / `act.select_target` 的结果。 */
  | { op: "sel.chosen" }
  /** 迭代游标。**仅在 `sel.where` / `act.for_each` 内部合法**（IR v1 §5.1，L3 校验）。 */
  | { op: "sel.it" }
  /** 事件负载中的实体。**仅在 trigger 内部合法**（IR v1 §5.1，L3 校验）。 */
  | { op: "sel.event"; field: EventEntityField }
  /**
   * 字面实体 id。
   * **编写层禁用**：只属于 IR v1 §5.6 的运行时超集，由引擎绑定时生成。
   * 构建产物里出现即校验错误（L3/M11）—— 这条是 UGC 场景的安全边界。
   */
  | { op: "sel.entity"; id: number }

  // ── 区域选择器（IR v1 §3.1）─────────────────────────────────────────────
  /**
   * 区域选择器。TS 里的具名常量（`FRIENDLY_MINIONS`、`ENEMY_BASE`…）全部编译成这一个 op。
   *
   * `side` 用 {@link SelSide}（含 `"both"`），与 `slot.*` 的 {@link SlotSide} 是
   * **同名不同集**（架构 §10 第 4 项）。
   * DSL v2 §3.2：`zone:"board"` 现在**按格序 0→8 枚举**，顺序有定义了。
   */
  | { op: "sel.zone"; side: SelSide; zone: ZoneName | readonly ZoneName[] }

  // ── 组合与过滤（IR v1 §3.1）─────────────────────────────────────────────
  /** 交集，保持 `of[0]` 的顺序。 */
  | { op: "sel.and"; of: readonly Sel[] }
  /** 并集，去重，按 playOrder 排序。 */
  | { op: "sel.or"; of: readonly Sel[] }
  /** 差集。 */
  | { op: "sel.minus"; of: Sel; exclude: Sel }
  /** 逐个求值 `cond`，其中 `sel.it` 绑定到候选。 */
  | { op: "sel.where"; of: Sel; cond: Cond }
  /**
   * 随机取 n 个，默认 `n=1, distinct=true`。**推进 RNG**（IR v1 §5.4）。
   * 禁止出现在 aura / intercept.cond 内（确定性规则，L3/M11 校验）。
   */
  | { op: "sel.random"; of: Sel; n?: Num; distinct?: boolean }
  /** 取前/后 n 个。 */
  | { op: "sel.limit"; of: Sel; n: Num; from?: LimitFrom }
  /** 排序，同值按 playOrder 稳定。 */
  | { op: "sel.sort"; of: Sel; by: TagKey; dir?: SortDir }

  // ── 位置相关（DSL v2 §3.2 新增/变更）─────────────────────────────────────
  /** 格上的实体。空格贡献空集。 */
  | { op: "sel.at"; slot: SlotRef | readonly SlotRef[] }
  /** `of` 中每个实体的**正对面**实体（不看 direction）。 */
  | { op: "sel.opposite"; of: Sel }
  /** 按当前 direction 解析的战斗目标。指空格 → **敌方基地**（v2 §4.3 + v2.1 §11.2 改名）。 */
  | { op: "sel.combat_target"; of: Sel }
  /** 所有当前方向指向 `of` 中实体的敌方单位（"谁在瞄我"）。 */
  | { op: "sel.attackers_of"; of: Sel }
  /**
   * 相邻单位。
   * **语义在 v2 §3.2 变更**：v1 是"召唤顺序相邻"，v2 是**位置相邻** ——
   * 同侧 ±dist 格内的单位，`dist` 默认 1（v2 §10 迁移清单第 6 条要求逐卡复查）。
   */
  | { op: "sel.adjacent"; of: Sel; dist?: Num };

/** `sel.*` 的 op 全集。 */
export type SelOp = Sel["op"];

/** 按 op 取出单个选择器节点类型，例：`SelNode<"sel.zone">`。 */
export type SelNode<K extends SelOp = SelOp> = Extract<Sel, { op: K }>;
