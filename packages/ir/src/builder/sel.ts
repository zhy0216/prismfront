// sel.* 的编写层构造器（IR §3.1、DSL v2 §3.2、v2 §7 糖面清单）。
//
// 每个构造器只做一件事：按**规范签名的字段顺序**造出对应的 IR 节点，再套上链式原型。
// 没有任何校验（L1/L2 是校验器的事，L3 是 M11 的事），没有任何求值（M4 的事）。
//
// 命名约定：
// - IR 里**没有对应节点**的位置糖，名字照抄 v2 §7 的糖面清单（`OPPOSITE` / `COMBAT_TARGET` /
//   `AttackersOf` / `Adjacent`），大小写也照抄 —— 那份清单就是验收用例的调用形式。
// - `sel.and` / `sel.or` / `sel.minus` 的自由函数叫 `Intersect` / `Union` / `Except`，
//   把 `And` / `Or` / `Not` 三个名字让给 `cond.*`（IR §10.5、v2 §8.2 用的是条件版）。
//   集合版仍可用链式 `.and()` / `.or()` / `.not()` 写。

import type {
  Cond,
  LimitFrom,
  Num,
  Sel,
  SelSide,
  SlotRef,
  SortDir,
  TagKey,
  ZoneName,
} from "../types/index.ts";
import { withChain } from "./fluent.ts";

/** 挂在 `sel.*` 节点原型上的链式方法。全部是糖，产物仍是普通 IR 节点。 */
export interface SelChain {
  /** 交集 → `sel.and`。链上连写会**摊平**成一个变参节点，而不是层层嵌套。 */
  and(this: FluentSel, other: Sel): FluentSel;
  /** 并集 → `sel.or`。同样摊平。 */
  or(this: FluentSel, other: Sel): FluentSel;
  /** 差集 → `sel.minus`。IR §10.3 `FRIENDLY_MINIONS.not(SELF)`、v2 §8.4 `.not(TARGET)`。 */
  not(this: FluentSel, exclude: Sel): FluentSel;
  /** 过滤 → `sel.where`，`cond` 内以 `IT` 指代候选。 */
  where(this: FluentSel, cond: Cond): FluentSel;
  /** 随机 → `sel.random`。**一次性求值**取 n 个（IR §5.3 规则 3），推进 RNG。 */
  random(this: FluentSel, n?: Num, distinct?: boolean): FluentSel;
  /** 取前/后 n 个 → `sel.limit`。 */
  limit(this: FluentSel, n: Num, from?: LimitFrom): FluentSel;
  /** 排序 → `sel.sort`。 */
  sort(this: FluentSel, by: TagKey, dir?: SortDir): FluentSel;
  /** 正对面的实体 → `sel.opposite`（不看 direction）。 */
  opposite(this: FluentSel): FluentSel;
  /** 按当前 direction 解析的战斗目标 → `sel.combat_target`。 */
  combatTarget(this: FluentSel): FluentSel;
  /** 谁在瞄我 → `sel.attackers_of`。 */
  attackersOf(this: FluentSel): FluentSel;
  /** 位置相邻（v2 §3.2 语义变更）→ `sel.adjacent`，`dist` 默认 1。 */
  adjacent(this: FluentSel, dist?: Num): FluentSel;
}

/** 带链式方法的选择器。可直接当 `Sel` 用（多出来的只有原型方法，不是自有属性）。 */
export type FluentSel = Sel & SelChain;

const selProto: SelChain = {
  and(other) {
    return this.op === "sel.and"
      ? selNode({ op: "sel.and", of: [...this.of, other] })
      : selNode({ op: "sel.and", of: [this, other] });
  },
  or(other) {
    return this.op === "sel.or"
      ? selNode({ op: "sel.or", of: [...this.of, other] })
      : selNode({ op: "sel.or", of: [this, other] });
  },
  not(exclude) {
    return Except(this, exclude);
  },
  where(cond) {
    return Where(this, cond);
  },
  random(n, distinct) {
    return Random(this, n, distinct);
  },
  limit(n, from) {
    return Limit(this, n, from);
  },
  sort(by, dir) {
    return Sort(this, by, dir);
  },
  opposite() {
    return OPPOSITE(this);
  },
  combatTarget() {
    return COMBAT_TARGET(this);
  },
  attackersOf() {
    return AttackersOf(this);
  },
  adjacent(dist) {
    return Adjacent(this, dist);
  },
};

/** 给任意 `sel.*` 节点套上链式原型。手写 IR 节点想接着链下去时也可以用它。 */
export function selNode<T extends Sel>(node: T): T & SelChain {
  return withChain(selProto, node);
}

// ── 上下文叶子（IR §3.1 / §5.1）─────────────────────────────────────────────

/** 持有本脚本的实体。 */
export const SELF = selNode({ op: "sel.self" });
/** 本次打出/动作指定的目标。用了它就必须在 `defineCard` 里声明 `target`。 */
export const TARGET = selNode({ op: "sel.target" });
/** SELF 的控制者（玩家实体）。 */
export const CONTROLLER = selNode({ op: "sel.controller" });
/** 对手玩家实体。 */
export const OPPONENT = selNode({ op: "sel.opponent" });
/** 最近一次 `Discover` / `SelectTarget` 的结果。 */
export const CHOSEN = selNode({ op: "sel.chosen" });
/** 迭代游标。只在 `.where(...)` / `ForEach(...)` 内部合法。 */
export const IT = selNode({ op: "sel.it" });

/**
 * 事件负载里的实体（只在触发器内部合法）。
 * v2 §8.6 荆棘卫士写 `Hit(EVENT.source, 1)`、§8.7 Cleave 写 `Adjacent(EVENT.target)`。
 */
export const EVENT = {
  source: selNode({ op: "sel.event", field: "source" }),
  target: selNode({ op: "sel.event", field: "target" }),
  player: selNode({ op: "sel.event", field: "player" }),
} as const;

// 刻意不提供 `sel.entity` 的构造器：它属于 IR §5.6 的**运行时超集**，
// 由引擎绑定时生成，编写层出现即校验错误。builder 不该给出写它的路径。

// ── 区域（IR §3.1）──────────────────────────────────────────────────────────

/** 区域选择器 → `sel.zone`。具名常量（`FRIENDLY_UNITS` 等）全部编译成这一个 op。 */
export function Zone(side: SelSide, zone: ZoneName | readonly ZoneName[]): FluentSel {
  return selNode({ op: "sel.zone", side, zone });
}

// ── 组合与过滤（IR §3.1）────────────────────────────────────────────────────

/** 交集 → `sel.and`，保持 `of[0]` 的顺序。 */
export function Intersect(...of: readonly Sel[]): FluentSel {
  return selNode({ op: "sel.and", of });
}

/** 并集 → `sel.or`，去重后按 playOrder 排序。 */
export function Union(...of: readonly Sel[]): FluentSel {
  return selNode({ op: "sel.or", of });
}

/** 差集 → `sel.minus`。链式写法是 `.not(exclude)`。 */
export function Except(of: Sel, exclude: Sel): FluentSel {
  return selNode({ op: "sel.minus", of, exclude });
}

/** 过滤 → `sel.where`，`cond` 内以 `IT` 指代候选。 */
export function Where(of: Sel, cond: Cond): FluentSel {
  return selNode({ op: "sel.where", of, cond });
}

/** 随机取 n 个 → `sel.random`。默认 `n=1, distinct=true`，缺省时不写进 IR。 */
export function Random(of: Sel, n?: Num, distinct?: boolean): FluentSel {
  const node: Extract<Sel, { op: "sel.random" }> = { op: "sel.random", of };
  if (n !== undefined) {
    node.n = n;
  }
  if (distinct !== undefined) {
    node.distinct = distinct;
  }
  return selNode(node);
}

/** 取前/后 n 个 → `sel.limit`，`from` 默认 `"start"`。 */
export function Limit(of: Sel, n: Num, from?: LimitFrom): FluentSel {
  const node: Extract<Sel, { op: "sel.limit" }> = { op: "sel.limit", of, n };
  if (from !== undefined) {
    node.from = from;
  }
  return selNode(node);
}

/** 排序 → `sel.sort`，`dir` 默认 `"asc"`，同值按 playOrder 稳定。 */
export function Sort(of: Sel, by: TagKey, dir?: SortDir): FluentSel {
  const node: Extract<Sel, { op: "sel.sort" }> = { op: "sel.sort", of, by };
  if (dir !== undefined) {
    node.dir = dir;
  }
  return selNode(node);
}

// ── 位置相关（DSL v2 §3.2 + §7 糖面清单）────────────────────────────────────

/** 格上的实体 → `sel.at`。空格贡献空集。例：`UnitsAt(At(FRIENDLY, 4))`。 */
export function UnitsAt(slot: SlotRef | readonly SlotRef[]): FluentSel {
  return selNode({ op: "sel.at", slot });
}

/** `OPPOSITE(SELF)`（v2 §7）→ `sel.opposite`：正对面的实体，不看 direction。 */
export function OPPOSITE(of: Sel): FluentSel {
  return selNode({ op: "sel.opposite", of });
}

/** `COMBAT_TARGET(SELF)`（v2 §7）→ `sel.combat_target`：按 direction 解析，指空格 → 敌方基地。 */
export function COMBAT_TARGET(of: Sel): FluentSel {
  return selNode({ op: "sel.combat_target", of });
}

/** `AttackersOf(SELF)`（v2 §7）→ `sel.attackers_of`：所有方向指向 `of` 的敌方单位。 */
export function AttackersOf(of: Sel): FluentSel {
  return selNode({ op: "sel.attackers_of", of });
}

/** `Adjacent(SELF)`（v2 §7）→ `sel.adjacent`：同侧 ±dist 格内的单位，`dist` 默认 1。 */
export function Adjacent(of: Sel, dist?: Num): FluentSel {
  const node: Extract<Sel, { op: "sel.adjacent" }> = { op: "sel.adjacent", of };
  if (dist !== undefined) {
    node.dist = dist;
  }
  return selNode(node);
}
