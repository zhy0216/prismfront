// `act.draw` —— 抽牌（走查第 1 步）。
// 来源：IR v1 §3.4（`act.draw{player, count?}`，`count` 默认 1）、v2 §5（`card_drawn`）、
//       框架 §3.1（`zones` 是**有序**列表，牌库顺序就由它表达）。

import type { EntityId } from "@prismfront/ir";
import { emitEvent } from "../events/index.ts";
import type { ActHandler } from "../resolve/index.ts";
import type { GameState, PlayerId } from "../state/index.ts";
import { getEntity, getZone } from "../state/index.ts";
import { moveToZone } from "./board.ts";
import { playerEntity, readNum, readPlayer } from "./read.ts";

/**
 * 抽一张：牌库顶 → 手牌，发 `card_drawn`。
 *
 * **牌库顶 = `zones["p{n}:deck"]` 的下标 0**（`state/create.ts` 的 `decks` 注释：
 * 「下标 0 = 牌堆顶」）。区域列表是有序的，抽牌就是从头部取。
 *
 * 返回 `false` = 没抽成，调用方应当停止继续抽：
 * - **牌库空** —— 疲劳（v2 §6 `deck.fatigue`）是 M3 的事（见 `state/player.ts` 的
 *   `fatigue` 字段说明），M2 静默跳过、不发事件。注意 v2 §5 明确规定
 *   **疲劳不发 `card_drawn`**，所以将来补疲劳时也只在这里加伤害，不要顺手补事件。
 * - **牌库顶是悬空 id** —— 实体表里查不到。正常对局里不会发生；真发生了就停在这里，
 *   比静默吞掉一张不存在的牌更容易被测试抓到。
 */
export function drawOne(state: GameState, player: PlayerId): boolean {
  const topId: EntityId | undefined = getZone(state, player, "deck")[0];
  if (topId === undefined) {
    return false;
  }
  const card = getEntity(state, topId);
  if (card === undefined) {
    return false;
  }
  moveToZone(state, card, player, "hand");
  emitEvent(state, {
    name: "card_drawn",
    player: playerEntity(state, player),
    target: card.id,
    cardId: card.cardId,
  });
  return true;
}

/**
 * `act.draw` 的 M2 临时 handler。
 *
 * `player` 求值为空（M2 只认得几个叶子，见 `read.ts`）→ **整个动作静默跳过**
 * （IR v1 §5.2 空集合语义）。`count` 只认字面量，缺省 1。
 *
 * 一次 `act.draw{count: 3}` 在牌库只剩 1 张时抽 1 张就停 —— 而不是把剩下两次
 * 也走一遍空流程。抽牌是**逐张**发事件的，事件流必须与真实发生的张数一致。
 */
export const drawHandler: ActHandler<"act.draw"> = (state, ctx, act) => {
  const player = readPlayer(state, ctx, act.player);
  if (player === null) {
    return;
  }
  const count = readNum(act.count, 1);
  for (let i = 0; i < count; i += 1) {
    if (!drawOne(state, player)) {
      return;
    }
  }
};
