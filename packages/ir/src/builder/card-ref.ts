// card.* 的编写层构造器（IR §3.1 末尾表）：卡牌引用与卡池。
//
// 字面卡牌 id 直接写字符串（IR §1 原则 4，不包装），所以这里只有三个节点构造器。

import type { CardRef, Cond, Pool, Sel } from "../types/index.ts";

/** `card.of`：取某实体的 cardId（复制用）。 */
export function CardOf(of: Sel): Extract<CardRef, { op: "card.of" }> {
  return { op: "card.of", of };
}

/** `card.random`：随机一张。**推进 RNG**，禁止出现在 aura / intercept.cond 内。 */
export function RandomCard(from: Sel | Pool): Extract<CardRef, { op: "card.random" }> {
  return { op: "card.random", from };
}

/** `card.pool`：从全卡池按条件筛（发现用）。`filter` 内以 `IT` 指代候选卡。 */
export function CardPool(filter: Cond): Pool {
  return { op: "card.pool", filter };
}

/**
 * 把"卡牌引用位置上写了个选择器"这种糖归一成 `card.of`。
 *
 * IR §10.5 的 `AddToHand(CONTROLLER, CHOSEN)` 就是这么回事：
 * `CHOSEN` 是 `Sel`，落到 `act.give.card` 上必须包成 `{op:"card.of", of: CHOSEN}`。
 */
export function toCardRef(card: CardRef | Sel): CardRef {
  if (typeof card === "string") {
    return card;
  }
  if (card.op === "card.of" || card.op === "card.random") {
    return card;
  }
  return CardOf(card);
}
