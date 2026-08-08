// cond.* 节点族：条件（求值得到 boolean）。
// 来源：IR v1 §3.3 + §9（基线）、DSL v2 §3.3（增改）、§7（TS 权威类型）。

import type { CardKind, Color } from "./card-kind.ts";
import type { Num } from "./num.ts";
import type { Sel } from "./sel.ts";
import type { SlotRef } from "./slot.ts";
import type { FlagName, TagKey, TribeName } from "./tag.ts";
import type { ZoneName } from "./zone.ts";

/**
 * 条件节点（IR v1 §3.3、DSL v2 §3.3）。
 *
 * 字面布尔不包装（IR v1 原则 4），所以 `boolean` 是这个联合的合法成员。
 *
 * ★ **全称量化陷阱**（IR v1 §3.3 注意 + §5.2）：
 * `cond.has_*` / `cond.is_*` 是**全称量化** —— `of` 中**每个**实体都满足才为真，
 * 因此**对空集返回 `true`**（数学惯例）。
 * 要表达"存在一个野兽"必须写
 * `cond.exists(sel.where(of, cond.has_tribe(sel.it, "beast")))`。
 * 这是最容易写错的一处，builder 应提供 `Any()` / `All()` 两个明确的糖。
 */
export type Cond =
  /** 字面布尔（IR v1 原则 4，不包装）。 */
  | boolean
  /** 集合非空 / 至少 n 个。`atLeast` 默认 1。空集 → `false`。 */
  | { op: "cond.exists"; of: Sel; atLeast?: Num }
  /** 相等。 */
  | { op: "cond.eq"; l: Num; r: Num }
  /** 不等。 */
  | { op: "cond.ne"; l: Num; r: Num }
  /** 大于。 */
  | { op: "cond.gt"; l: Num; r: Num }
  /** 大于等于。 */
  | { op: "cond.gte"; l: Num; r: Num }
  /** 小于。 */
  | { op: "cond.lt"; l: Num; r: Num }
  /** 小于等于。 */
  | { op: "cond.lte"; l: Num; r: Num }
  /**
   * 逻辑与。**短路求值**：遇 false 停（IR v1 §5.4 规则 3）。
   * ⚠ 短路会跳过后面分支里的 RNG 消耗 —— 不要把带随机的表达式放在短路条件右侧。
   */
  | { op: "cond.and"; of: readonly Cond[] }
  /** 逻辑或。**短路求值**：遇 true 停（IR v1 §5.4 规则 3）。 */
  | { op: "cond.or"; of: readonly Cond[] }
  /** 逻辑非。 */
  | { op: "cond.not"; of: Cond }
  /** 全称量化：`of` 中每个实体的 `tag` 都（等于 `value`）。空集 → `true`。 */
  | { op: "cond.has_tag"; of: Sel; tag: TagKey; value?: Num }
  /** 全称量化。空集 → `true`。 */
  | { op: "cond.has_flag"; of: Sel; flag: FlagName }
  /** 全称量化。空集 → `true`。 */
  | { op: "cond.is_kind"; of: Sel; kind: CardKind | readonly CardKind[] }
  /**
   * 按颜色筛卡（决策 #9，irVersion 2.2.0 新增；v2.1 §11.4 用 `data.colors` 取代了 `faction`）。
   *
   * 语义 = `of` 中**每个**成员的 `data.colors` 与 `color` 参数集合**有交集**：
   * `of` 上全称量化（空集 → `true`）、`color` 列表上存在量化，与 `cond.is_kind` 完全一致，
   * 不引入第四种量化形态。推论：**融合卡（`colors` 长度 2）同时命中它的两个颜色** ——
   * "发现一张红牌"包含红蓝融合卡（《数值基准》§6.2）。
   *
   * 读的是**卡面数据**不是实体 tag：`card.pool` 位上过滤 CardDef 的 `data.colors`，
   * 作用在场上实体时取该实体源卡的颜色。与 `cond.is_kind` 读 `data.kind` 完全平行。
   */
  | { op: "cond.has_color"; of: Sel; color: Color | readonly Color[] }
  /** 全称量化。空集 → `true`。 */
  | { op: "cond.has_tribe"; of: Sel; tribe: TribeName }
  /** 全称量化。空集 → `true`。 */
  | { op: "cond.in_zone"; of: Sel; zone: ZoneName }
  /** 全称量化。空集 → `true`。 */
  | { op: "cond.dead"; of: Sel }
  /**
   * 格上有单位（DSL v2 §3.3 新增）。判空用 `cond.not` 包一层。
   * 无效槽 → `false`（无效槽语义，v2 §3.1）。
   */
  | { op: "cond.occupied"; slot: SlotRef };

/** `cond.*` 的 op 全集（不含字面 `boolean` 这一支）。 */
export type CondOp = Extract<Cond, { op: string }>["op"];

/** 按 op 取出单个条件节点类型，例：`CondNode<"cond.exists">`。 */
export type CondNode<K extends CondOp = CondOp> = Extract<Cond, { op: K }>;
