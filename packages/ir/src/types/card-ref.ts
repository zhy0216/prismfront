// card.* 节点族：卡牌引用与卡池（用于召唤 / 生成 / 发现）。
// 来源：IR v1 §3.1 末尾表 + §9（`CardRef`、`Pool`）。v2 未改动这一族。

import type { CardId } from "./common.ts";
import type { Cond } from "./cond.ts";
import type { Sel } from "./sel.ts";

/**
 * 卡池：从全卡池按条件筛（发现用，IR v1 §3.1）。
 * `filter` 内以 `sel.it` 指代候选卡（见 v1 §10.5 发现示例）。
 */
export interface Pool {
  op: "card.pool";
  filter: Cond;
}

/**
 * 卡牌引用（IR v1 §3.1 / §9）。
 *
 * 空集合语义（IR v1 §5.2）：`card.of` / `card.random` 求值为空 → **整个动作跳过**。
 */
export type CardRef =
  /** 字面卡牌 id，例：`"CORE_TOKEN_01"`。L3 校验它必须指向 bundle 里真实存在的卡。 */
  | CardId
  /** 取某实体的 cardId（复制用）。 */
  | { op: "card.of"; of: Sel }
  /**
   * 随机一张。**推进 RNG**（IR v1 §5.4）。
   * 禁止出现在 aura / intercept.cond 内（确定性规则，L3/M11 校验）。
   */
  | { op: "card.random"; from: Sel | Pool };

/** `card.*` 的 op 全集（含 `card.pool`；不含字面 CardId 那一支）。 */
export type CardOp = Extract<CardRef, { op: string }>["op"] | Pool["op"];

/** 按 op 取出单个卡牌引用节点类型，例：`CardRefNode<"card.of">`。 */
export type CardRefNode<K extends CardOp = CardOp> = Extract<CardRef | Pool, { op: K }>;
