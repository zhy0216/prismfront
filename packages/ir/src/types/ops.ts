// op 全集的运行时镜像。
//
// 为什么需要它：IR §12 说 TS 类型是唯一权威定义，但 L1/L2 校验器、`bundle.opsUsed`
// 与 engine 的"启动时比对支持的 op 集"（架构 §5.1）都需要在**运行时**枚举 op。
// 手抄一份必然漂移，所以这里用 `satisfies Record<XxxOp, true>` 把表与联合**双向钉死**：
// 少写一个 op → "缺少属性"编译错误；多写一个 op → 多余属性编译错误。
//
// 分四类的前缀约定见 IR v1 原则 2：前缀让类型校验退化成字符串前缀检查（L2 的全部内容），
// 删掉了整整一类"把选择器塞进数值位置"的攻击面。

import type { ActOp } from "./act.ts";
import type { CardOp } from "./card-ref.ts";
import type { CondOp } from "./cond.ts";
import type { NumOp } from "./num.ts";
import type { SelOp } from "./sel.ts";
import type { SlotOp } from "./slot.ts";

/** `Object.keys` 的类型安全包装：表的键集已由 `satisfies` 钉死，转型是安全的。 */
const keysOf = <T extends string>(table: Readonly<Record<T, true>>): readonly T[] =>
  Object.keys(table) as T[];

/** `sel.*` 全集（IR v1 §3.1 + DSL v2 §3.2）。 */
export const SEL_OP_SET = {
  "sel.self": true,
  "sel.target": true,
  "sel.controller": true,
  "sel.opponent": true,
  "sel.chosen": true,
  "sel.it": true,
  "sel.event": true,
  "sel.entity": true,
  "sel.zone": true,
  "sel.and": true,
  "sel.or": true,
  "sel.minus": true,
  "sel.where": true,
  "sel.random": true,
  "sel.limit": true,
  "sel.sort": true,
  "sel.at": true,
  "sel.opposite": true,
  "sel.combat_target": true,
  "sel.attackers_of": true,
  "sel.adjacent": true,
} as const satisfies Record<SelOp, true>;

export const SEL_OPS = keysOf(SEL_OP_SET);

/** `slot.*` 全集（DSL v2 §3.1）。 */
export const SLOT_OP_SET = {
  "slot.at": true,
  "slot.of": true,
  "slot.opposite": true,
  "slot.shift": true,
  "slot.random_empty": true,
  "slot.first_empty": true,
} as const satisfies Record<SlotOp, true>;

export const SLOT_OPS = keysOf(SLOT_OP_SET);

/** `num.*` 全集（IR v1 §3.2 + DSL v2 §3.3）。 */
export const NUM_OP_SET = {
  "num.count": true,
  "num.attr": true,
  "num.sum": true,
  "num.add": true,
  "num.mul": true,
  "num.max": true,
  "num.min": true,
  "num.sub": true,
  "num.div": true,
  "num.neg": true,
  "num.clamp": true,
  "num.if": true,
  "num.random": true,
  "num.tag": true,
  "num.field": true,
  "num.slot_index": true,
} as const satisfies Record<NumOp, true>;

export const NUM_OPS = keysOf(NUM_OP_SET);

/** `cond.*` 全集（IR v1 §3.3 + DSL v2 §3.3）。 */
export const COND_OP_SET = {
  "cond.exists": true,
  "cond.eq": true,
  "cond.ne": true,
  "cond.gt": true,
  "cond.gte": true,
  "cond.lt": true,
  "cond.lte": true,
  "cond.and": true,
  "cond.or": true,
  "cond.not": true,
  "cond.has_tag": true,
  "cond.has_flag": true,
  "cond.is_kind": true,
  // 2.2.0 新增（决策 #9）：按颜色筛卡池，v2.1 §11.4 废掉 faction 后留下的表达力缺口
  "cond.has_color": true,
  "cond.has_tribe": true,
  "cond.in_zone": true,
  "cond.dead": true,
  "cond.occupied": true,
} as const satisfies Record<CondOp, true>;

export const COND_OPS = keysOf(COND_OP_SET);

/** `card.*` 全集（IR v1 §3.1 末尾表）。 */
export const CARD_OP_SET = {
  "card.of": true,
  "card.random": true,
  "card.pool": true,
} as const satisfies Record<CardOp, true>;

export const CARD_OPS = keysOf(CARD_OP_SET);

/** `act.*` 全集（IR v1 §3.4 + DSL v2 §3.4）。 */
export const ACT_OP_SET = {
  "act.hit": true,
  "act.heal": true,
  "act.set_health": true,
  "act.gain_armor": true,
  "act.draw": true,
  "act.give": true,
  "act.shuffle": true,
  "act.discard": true,
  "act.move": true,
  "act.steal": true,
  "act.summon": true,
  "act.destroy": true,
  "act.transform": true,
  "act.buff": true,
  "act.silence": true,
  "act.set_tag": true,
  "act.mod_tag": true,
  "act.set_flag": true,
  "act.move_to": true,
  "act.shift": true,
  "act.swap": true,
  "act.strike": true,
  "act.gain_crystal": true,
  "act.gain_crystal_cap": true,
  "act.when": true,
  "act.repeat": true,
  "act.for_each": true,
  "act.discover": true,
  "act.select_target": true,
  "act.nothing": true,
} as const satisfies Record<ActOp, true>;

export const ACT_OPS = keysOf(ACT_OP_SET);

/** 任意 IR 节点的 op。`bundle.opsUsed` 用它。 */
export type NodeOp = SelOp | SlotOp | NumOp | CondOp | CardOp | ActOp;

/** 六族合并后的 op 全集。 */
export const NODE_OP_SET: Readonly<Record<NodeOp, true>> = {
  ...SEL_OP_SET,
  ...SLOT_OP_SET,
  ...NUM_OP_SET,
  ...COND_OP_SET,
  ...CARD_OP_SET,
  ...ACT_OP_SET,
};

export const NODE_OPS = keysOf(NODE_OP_SET);

/**
 * 节点族前缀（IR v1 原则 2）。L2 种类校验就是一次前缀检查：
 * `act.hit.target` 位置只接受 `sel.*`，`amount` 位置只接受 `number` 或 `num.*`。
 */
export const NODE_OP_PREFIXES = {
  sel: "sel.",
  slot: "slot.",
  num: "num.",
  cond: "cond.",
  card: "card.",
  act: "act.",
} as const;

/** 节点族名。 */
export type NodeFamily = keyof typeof NODE_OP_PREFIXES;
