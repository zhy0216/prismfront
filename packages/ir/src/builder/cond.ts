// cond.* 的编写层构造器（IR §3.3、DSL v2 §3.3）。
//
// ★ 全称量化陷阱（IR §3.3 注意 + §5.2）：`cond.has_*` / `cond.is_*` 是**全称量化** ——
//   `of` 中每个实体都满足才为真，因此**对空集返回 `true`**。
//   "存在一个野兽" 必须写成 `Any(of, HasTribe(IT, "beast"))`。
//   为此这里提供 {@link Any} / {@link All} 两个明确的糖，别再手写 exists+where 组合。

import type {
  CardKind,
  Cond,
  CondNode,
  FlagName,
  Num,
  Sel,
  SlotRef,
  TagKey,
  TribeName,
  ZoneName,
} from "../types/index.ts";
import { withChain } from "./fluent.ts";
import { IT, Where } from "./sel.ts";

/** 挂在 `cond.*` 节点原型上的链式方法。 */
export interface CondChain {
  /** `cond.and`：**短路求值**，遇 false 停。链上连写会摊平成一个变参节点。 */
  and(this: FluentCond, other: Cond): FluentCond;
  /** `cond.or`：**短路求值**，遇 true 停。同样摊平。 */
  or(this: FluentCond, other: Cond): FluentCond;
  /** `cond.not`。 */
  not(this: FluentCond): FluentCond;
}

/** 带链式方法的条件**节点**（不含字面 `boolean` —— 原始值挂不住方法）。 */
export type FluentCond = CondNode & CondChain;

const condProto: CondChain = {
  and(other) {
    return this.op === "cond.and"
      ? condNode({ op: "cond.and", of: [...this.of, other] })
      : condNode({ op: "cond.and", of: [this, other] });
  },
  or(other) {
    return this.op === "cond.or"
      ? condNode({ op: "cond.or", of: [...this.of, other] })
      : condNode({ op: "cond.or", of: [this, other] });
  },
  not() {
    return Not(this);
  },
};

/** 给任意 `cond.*` 节点套上链式原型。 */
export function condNode<T extends CondNode>(node: T): T & CondChain {
  return withChain(condProto, node);
}

// ── 集合与量化 ──────────────────────────────────────────────────────────────

/** `cond.exists`：集合非空 / 至少 n 个。`atLeast` 默认 1。空集 → `false`。 */
export function Exists(of: Sel, atLeast?: Num): FluentCond {
  const node: Extract<Cond, { op: "cond.exists" }> = { op: "cond.exists", of };
  if (atLeast !== undefined) {
    node.atLeast = atLeast;
  }
  return condNode(node);
}

/**
 * **存在量化**："`of` 中存在满足 `cond` 的实体" → `cond.exists(sel.where(of, cond))`。
 * 省略 `cond` 时退化为 `Exists(of)`。空集 → `false`。
 */
export function Any(of: Sel, cond?: Cond): FluentCond {
  return cond === undefined ? Exists(of) : Exists(Where(of, cond));
}

/**
 * **全称量化**："`of` 中每个实体都满足 `cond`" →
 * `cond.not(cond.exists(sel.where(of, cond.not(cond))))`（找不到反例即为真）。
 * 空集 → `true`，与 `cond.has_*` 家族的空集语义一致。
 */
export function All(of: Sel, cond: Cond): FluentCond {
  return Not(Exists(Where(of, Not(cond))));
}

// ── 比较 ────────────────────────────────────────────────────────────────────

/** `cond.eq`。 */
export function Eq(l: Num, r: Num): FluentCond {
  return condNode({ op: "cond.eq", l, r });
}

/** `cond.ne`。 */
export function Ne(l: Num, r: Num): FluentCond {
  return condNode({ op: "cond.ne", l, r });
}

/** `cond.gt`。 */
export function Gt(l: Num, r: Num): FluentCond {
  return condNode({ op: "cond.gt", l, r });
}

/** `cond.gte`。 */
export function Gte(l: Num, r: Num): FluentCond {
  return condNode({ op: "cond.gte", l, r });
}

/** `cond.lt`。 */
export function Lt(l: Num, r: Num): FluentCond {
  return condNode({ op: "cond.lt", l, r });
}

/** `cond.lte`。 */
export function Lte(l: Num, r: Num): FluentCond {
  return condNode({ op: "cond.lte", l, r });
}

// ── 逻辑 ────────────────────────────────────────────────────────────────────

/** `cond.and`：**短路求值**，遇 false 停（IR §5.4 规则 3）。 */
export function And(...of: readonly Cond[]): FluentCond {
  return condNode({ op: "cond.and", of });
}

/** `cond.or`：**短路求值**，遇 true 停。 */
export function Or(...of: readonly Cond[]): FluentCond {
  return condNode({ op: "cond.or", of });
}

/** `cond.not`。v2 §8.2 空袭猎手：`Not(Occupied(SlotOf(SELF).opposite()))`。 */
export function Not(of: Cond): FluentCond {
  return condNode({ op: "cond.not", of });
}

// ── 谓词（全部是全称量化，空集 → true）─────────────────────────────────────

/** `cond.has_tag`：`of` 中每个实体的 `tag` 都（等于 `value`）。 */
export function HasTag(of: Sel, tag: TagKey, value?: Num): FluentCond {
  const node: Extract<Cond, { op: "cond.has_tag" }> = { op: "cond.has_tag", of, tag };
  if (value !== undefined) {
    node.value = value;
  }
  return condNode(node);
}

/** `cond.has_flag`。 */
export function HasFlag(of: Sel, flag: FlagName): FluentCond {
  return condNode({ op: "cond.has_flag", of, flag });
}

/** `cond.is_kind`。 */
export function IsKind(of: Sel, kind: CardKind | readonly CardKind[]): FluentCond {
  return condNode({ op: "cond.is_kind", of, kind });
}

/** `IsMinion(EVENT.target)`（v2 §8.7 Siege）。省略参数时判的是迭代游标 `IT`。 */
export function IsMinion(of: Sel = IT): FluentCond {
  return IsKind(of, "minion");
}

/** `IsSpell()`（IR §10.5 发现）。省略参数时判的是迭代游标 `IT`（卡池里的候选卡）。 */
export function IsSpell(of: Sel = IT): FluentCond {
  return IsKind(of, "spell");
}

/** 英雄是占格参战的单位（v2.1 §11.2），与随从的区分靠 `kind`。 */
export function IsHero(of: Sel = IT): FluentCond {
  return IsKind(of, "hero");
}

/** 衍生物。 */
export function IsToken(of: Sel = IT): FluentCond {
  return IsKind(of, "token");
}

/** `cond.has_tribe`。IR §10.3 野猪王：`HasTribe(IT, "beast")`。 */
export function HasTribe(of: Sel, tribe: TribeName): FluentCond {
  return condNode({ op: "cond.has_tribe", of, tribe });
}

/** `cond.in_zone`。 */
export function InZone(of: Sel, zone: ZoneName): FluentCond {
  return condNode({ op: "cond.in_zone", of, zone });
}

/** `cond.dead`。 */
export function IsDead(of: Sel): FluentCond {
  return condNode({ op: "cond.dead", of });
}

/** `cond.occupied`（v2 §3.3 新增）：格上有单位。无效槽 → `false`。判空用 `Not(...)` 包一层。 */
export function Occupied(slot: SlotRef): FluentCond {
  return condNode({ op: "cond.occupied", slot });
}
