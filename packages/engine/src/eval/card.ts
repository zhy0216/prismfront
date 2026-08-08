// `evalCardRef` —— 卡牌引用求值（IR v1 §3.1 末表的 `CardRef` / `Pool`）。
//
// 返回的是**卡 id**（`CardId`），不是卡面数据：`act.summon` / `act.give` /
// `act.transform` 要的都是「哪一张卡」，卡面由调用方再去 {@link CardLookup} 查
// —— 于是「查不到卡面」这件事只在动作层判一次（见 `handlers/summon.ts`）。
//
// ── 空集合语义（IR v1 §5.2 末行）★ ──────────────────────────────────────────
// > `card.of` / `card.random` 求值为空 → **整个动作跳过**
// 取值来自 `empty.ts` 的统一表（`EMPTY_SET.cardRef` = `null`），本文件不自己发明。
// 判空一律写 `=== null`：`CardId` 是字符串，空串虽然不是合法卡 id，
// 但用真值判断会让「空串」与「没有」混成一件事。
//
// ── RNG（IR v1 §5.4）───────────────────────────────────────────────────────
// `card.random` 与 `sel.random` / `num.random` / `slot.random_empty` 同级：推进 RNG，
// 走 `context.ts` 的 `rollInt`（origin 取 `"card.random"`），**候选为空时一次都不抽**。
//
// ── `card.pool` 为什么在 E4 求不出来 ────────────────────────────────────────
// `card.pool{filter}` 是「从**全卡池**按条件筛」（IR v1 §3.1），而引擎手里只有
// `CardLookup`（按 id 查一张），没有「枚举全卡池」的能力 —— 那是 bundle 的事，
// 且 `filter` 里的 `sel.it` 绑定的是**卡**而不是实体，与 `CtxBindings.it`
// （`EntityId`）不是同一个取值域，需要另一套求值环境（`eval/index.ts` 文件头已点名）。
// 所以这里按空集退化：`card.random{from: card.pool}` → `null` → 动作跳过。
// 真正需要它的是「发现」（`act.discover`），那本身就是 M4 之后的挂起点动作。

import type { CardId, CardRef, Pool, Sel } from "@prismfront/ir";
import { getEntities } from "../state/index.ts";
import type { EvalEnv } from "./context.ts";
import { assertNever, rollInt } from "./context.ts";
import { EMPTY_SET } from "./empty.ts";
import { evalEntities, evalSel, single } from "./sel.ts";

/**
 * 求值一个 {@link CardRef} → 卡 id；求不出来给 `null`（= 整个动作跳过，IR v1 §5.2）。
 *
 * 三支：
 * - **字面 `CardId`**（IR v1 原则 4：常见字面量不包装）→ 原样返回。
 *   注意这里**不校验它在不在卡表里** —— 引用完整性是编写期 L3 的事（IR v1 §7），
 *   而运行时「卡表里没有」与「求值为空」是两回事，前者由动作层按各自语义处理。
 * - `card.of{of}` —— 取某实体的 `cardId`（复制用）。**非单实体 → `null`**，
 *   与 `num.attr` / `slot.of` 共用 `sel.ts` 的 `single` 判据（同一个函数，不是同款写法）。
 * - `card.random{from}` —— 随机一张，**推进 RNG**。
 */
export function evalCardRef(env: EvalEnv, node: CardRef): CardId | null {
  if (typeof node === "string") {
    return node;
  }
  switch (node.op) {
    case "card.of": {
      // 「恰好一个实体」的判据复用 `sel.ts` 的 `single`（`num.attr` / `slot.of` 同一条）。
      const entity = single(evalEntities(env, node.of));
      return entity === undefined ? EMPTY_SET.cardRef : entity.cardId;
    }
    case "card.random":
      return randomCard(env, node.from);
    default:
      // ★ 穷尽检查：IR 新增一个 card.* 而这里漏写 case → 编译不过（见 `assertNever`）。
      return assertNever(node);
  }
}

/**
 * `card.random{from}` 的候选与抽取。
 *
 * `from` 是 `Sel | Pool`（IR v1 §3.1）：
 * - `Sel` —— 候选是**这些实体各自的 `cardId`**（"从对手手牌里随机复制一张"就是它）。
 *   **按实体枚举顺序去重**：同名卡出现两次不该让它中奖概率翻倍，而枚举顺序是
 *   `evalSel` 已经钉死的语义（见 `sel.ts` 文件头）。
 * - `Pool` —— 见文件头：E4 求不出全卡池，按空集退化。
 *
 * 空候选**一次 RNG 都不抽**（`rollInt` 的 max 不许为 0）。
 */
function randomCard(env: EvalEnv, from: Sel | Pool): CardId | null {
  const pool = candidateCards(env, from);
  if (pool.length === 0) {
    return EMPTY_SET.cardRef;
  }
  return pool[rollInt(env, "card.random", pool.length)] ?? EMPTY_SET.cardRef;
}

/** {@link randomCard} 的候选集：`Sel` 摊成去重后的卡 id 列表，`Pool` 给空列表。 */
function candidateCards(env: EvalEnv, from: Sel | Pool): CardId[] {
  if (isPool(from)) {
    return [];
  }
  const out: CardId[] = [];
  for (const entity of getEntities(env.state, evalSel(env, from))) {
    if (!out.includes(entity.cardId)) {
      out.push(entity.cardId);
    }
  }
  return out;
}

/**
 * `from` 是不是 `card.pool`。
 *
 * `Sel` 与 `Pool` 都是带 `op` 的对象，靠 op 名区分；`card.pool` 是 `Pool` 唯一的成员
 * （IR v1 §9），所以一次相等比较就够，不需要前缀匹配。
 */
function isPool(from: Sel | Pool): from is Pool {
  return from.op === "card.pool";
}
