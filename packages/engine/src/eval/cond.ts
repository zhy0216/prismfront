// `evalCond` —— 条件求值（IR v1 §3.3 的 `cond.*` 族 + DSL v2 §3.3 的增改）。
//
// ── 字面量不包装（IR v1 原则 4）─────────────────────────────────────────────
// `boolean` 是 `Cond` 联合的合法成员，所以先判 `typeof node === "boolean"`。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 全称量化陷阱（IR v1 §3.3 注意 + §5.2）—— 整份规范最容易写错的一处 ★
// ═══════════════════════════════════════════════════════════════════════════
// `cond.has_*` / `cond.is_*` 是**全称量化**：`of` 中**每个**实体都满足才为真，
// 因此**对空集返回 `true`**（数学惯例）。
// 要表达"存在一个野兽"必须写 `cond.exists(sel.where(of, cond.has_tribe(sel.it,"beast")))`。
// 本文件把这条规则收在 `empty.ts` 的 {@link forAll} 一个函数里：所有全称量化的 op
// 都从那里过，于是空集判定只有一处实现，新加一个全称 op 也不可能忘掉它。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 短路求值（IR v1 §5.4 规则 3）★
// ═══════════════════════════════════════════════════════════════════════════
// `cond.and` 遇 `false` 停，`cond.or` 遇 `true` 停。
// ⚠ 规范原文：「这意味着短路会**跳过后面分支里的 RNG 消耗**。这是有意的，但写卡时
//   要注意不要把带随机的表达式放在短路条件的右侧。」
// 所以这里必须真短路 —— 写成"先把所有分支求值出来再 `every` / `some`"会多消耗 RNG，
// 是**静默的确定性 bug**。反过来，其余 op（比较、`cond.exists` 的 `atLeast`、
// `cond.has_tag` 的 `value`）一律**按签名声明顺序把字段全部求值**，不擅自提前返回，
// 否则同一张卡在"集合恰好为空"时会少推进一次 RNG。

import type { CardKind, Color, Cond, CondNode } from "@prismfront/ir";
import { hasFlag, isInZone, isLethal, tagOf } from "../state/index.ts";
import type { EvalEnv } from "./context.ts";
import { assertNever, cardDataOf } from "./context.ts";
import { EMPTY_SET, forAll } from "./empty.ts";
import { evalNum } from "./num.ts";
import { evalEntities } from "./sel.ts";
import { evalSlot, isSlotAddrOccupied } from "./slot.ts";

/** 六个数值比较 op —— 它们的字段完全同形，求值顺序也必须一致，故合并成一支。 */
type CompareOp = "cond.eq" | "cond.ne" | "cond.gt" | "cond.gte" | "cond.lt" | "cond.lte";

/** 求值一个条件节点（字面布尔直接返回 —— IR v1 原则 4）。 */
export function evalCond(env: EvalEnv, node: Cond): boolean {
  if (typeof node === "boolean") {
    return node;
  }
  switch (node.op) {
    // ── 存在量化 ──────────────────────────────────────────────────────────
    case "cond.exists": {
      // 字段按声明顺序全部求值（`atLeast` 里也可能有 RNG），再判空。
      const count = evalEntities(env, node.of).length;
      const atLeast = node.atLeast === undefined ? 1 : evalNum(env, node.atLeast);
      // 空集恒假 —— 统一表压过算术：`atLeast <= 0` 时 `0 >= atLeast` 本来为真，
      // 但 IR v1 §5.2 把 `cond.exists` 的空集行为直接写死成 `false`，
      // 而那张表的标题就是「不许各 op 各自发明」。
      return count === 0 ? EMPTY_SET.exists : count >= atLeast;
    }

    // ── 数值比较 ──────────────────────────────────────────────────────────
    case "cond.eq":
    case "cond.ne":
    case "cond.gt":
    case "cond.gte":
    case "cond.lt":
    case "cond.lte":
      return compareNums(env, node);

    // ── 逻辑 ★ 短路（IR v1 §5.4 规则 3）─────────────────────────────────────
    case "cond.and":
      // 遇 false 停。空数组 → `true`（合取单位元）。
      for (const one of node.of) {
        if (!evalCond(env, one)) {
          return false;
        }
      }
      return true;
    case "cond.or":
      // 遇 true 停。空数组 → `false`（析取单位元）。
      for (const one of node.of) {
        if (evalCond(env, one)) {
          return true;
        }
      }
      return false;
    case "cond.not":
      return !evalCond(env, node.of);

    // ── 全称量化（空集恒真，一律走 `forAll`）────────────────────────────────
    case "cond.has_tag": {
      const entities = evalEntities(env, node.of);
      // `value` 只求值**一次**（不是每个实体一次）：否则集合大小会决定 RNG 推进次数，
      // 而集合大小随盘面变 —— 回放立刻失真。
      const value = node.value === undefined ? undefined : evalNum(env, node.value);
      return forAll(entities, (entity) =>
        // 省略 `value` = "有这个属性"。属性表是全量表、缺省即 0（`state/entity.ts`），
        // 所以"有"就是**非 0**。
        value === undefined ? tagOf(entity, node.tag) !== 0 : tagOf(entity, node.tag) === value,
      );
    }
    case "cond.has_flag":
      return forAll(evalEntities(env, node.of), (entity) => hasFlag(entity, node.flag));
    case "cond.is_kind": {
      const wanted = toList(node.kind);
      // 读的是**卡面数据** `data.kind`（IR v1 §2.2），不是实体 tag。
      // 查不到卡（引擎不带卡表时的退化形态）⇒ 无法确认满足 ⇒ 不满足。
      return forAll(evalEntities(env, node.of), (entity) => {
        const kind = cardDataOf(env, entity)?.kind;
        return kind !== undefined && wanted.includes(kind);
      });
    }
    case "cond.has_color": {
      // 决策 #9：`of` 上**全称量化**、`color` 列表上**存在量化**，与 `cond.is_kind`
      // 完全平行，不引入第四种量化形态。推论：**融合卡（colors 长度 2）同时命中
      // 它的两个颜色** —— "发现一张红牌"包含红蓝融合卡（《数值基准》§6.2）。
      const wanted = toList(node.color);
      return forAll(evalEntities(env, node.of), (entity) => {
        const own = cardDataOf(env, entity)?.colors ?? [];
        return own.some((color) => wanted.includes(color));
      });
    }
    case "cond.has_tribe":
      // `tribe` 在 CardData 上是可选且可 `null`（PF1 无部族设计，见 ir 的 `TribeName`），
      // 查不到卡与"卡面没写部族"在这个判据下同为不满足。
      return forAll(
        evalEntities(env, node.of),
        (entity) => cardDataOf(env, entity)?.tribe === node.tribe,
      );
    case "cond.in_zone":
      return forAll(evalEntities(env, node.of), (entity) => isInZone(entity, node.zone));
    case "cond.dead":
      // 判据是 `state/queries.ts` 的 `isLethal`（血量归零）—— 与死亡结算
      // （`resolve/deaths.ts`）**同一个谓词**，引擎里"死"只有这一个定义，
      // 不在求值器里另发明第二个。它不问实体在不在场，所以已经躺进墓地的实体
      // （damage 保留不清）同样为真，亡语脚本里问"我死了没"能得到期望的答案。
      return forAll(evalEntities(env, node.of), isLethal);

    // ── 位置（DSL v2 §3.3）────────────────────────────────────────────────
    case "cond.occupied":
      // 无效槽 → `false`（v2 §3.1）。判空要用 `cond.not` 包一层。
      return isSlotAddrOccupied(env, evalSlot(env, node.slot));

    default:
      // ★ 穷尽检查：IR 新增一个 cond.* 而这里漏写 case → 编译不过（见 `assertNever`）。
      return assertNever(node);
  }
}

/**
 * 六个比较 op 的共同实现。
 *
 * 合成一处的收益是**求值顺序只写一遍**：先 `l` 后 `r`（IR v1 §5.4 规则 1 的签名声明
 * 顺序），六个 op 不可能各自漂一种。内层 switch 同样有穷尽检查兜底。
 */
function compareNums(env: EvalEnv, node: CondNode<CompareOp>): boolean {
  const l = evalNum(env, node.l);
  const r = evalNum(env, node.r);
  switch (node.op) {
    case "cond.eq":
      return l === r;
    case "cond.ne":
      return l !== r;
    case "cond.gt":
      return l > r;
    case "cond.gte":
      return l >= r;
    case "cond.lt":
      return l < r;
    case "cond.lte":
      return l <= r;
    default:
      return assertNever(node);
  }
}

/**
 * `kind` / `color` 这类 `X | readonly X[]` 字段摊成列表。
 *
 * 取值都是字符串字面量联合，所以用 `typeof === "string"` 判别（与
 * `ir/src/tools/print-node.ts` 的同款处理一致），不依赖 `Array.isArray` 对
 * `readonly` 数组的窄化行为。
 */
function toList<T extends CardKind | Color>(value: T | readonly T[]): readonly T[] {
  return typeof value === "string" ? [value] : value;
}
