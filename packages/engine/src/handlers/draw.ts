// `act.draw` —— 抽牌。
// 来源：IR v1 §3.4（`act.draw{player, count?}`，`count` 默认 1）、v2 §5（`card_drawn`）、
//       框架 §3.1（`zones` 是**有序**列表，牌库顺序就由它表达）、
//       IR v1 §5.4 规则 1（字段按声明顺序求值：先 player 后 count）。

import type { EntityId } from "@prismfront/ir";
import { evalNum, playerEntityId } from "../eval/index.ts";
import { emitEvent } from "../events/index.ts";
import type { ActHandler } from "../resolve/index.ts";
import type { GameState, PlayerId } from "../state/index.ts";
import { getEntity, getZone } from "../state/index.ts";
import { moveToZone } from "./board.ts";
import { targetPlayers } from "./targets.ts";

/**
 * 抽一张：牌库顶 → 手牌，发 `card_drawn`。
 *
 * **牌库顶 = `zones["p{n}:deck"]` 的下标 0**（`state/create.ts` 的 `decks` 注释：
 * 「下标 0 = 牌堆顶」）。区域列表是有序的，抽牌就是从头部取。
 *
 * 返回 `false` = 没抽成，调用方应当停止继续抽：
 * - **牌库空** —— 疲劳伤害由回合状态机在 `round_start` 的抽牌里处理
 *   （`rules/phase.ts`，v2 §6 `deck.fatigue`）；效果驱动的 `act.draw` 抽空就停，
 *   静默跳过、不发事件。注意 v2 §5 明确规定**疲劳不发 `card_drawn`**。
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
    player: playerEntityId(state, player),
    target: card.id,
    cardId: card.cardId,
  });
  return true;
}

/**
 * `act.draw{player, count?}` 的 handler。
 *
 * `player` 是一个 `Sel`（IR v1 §3.1：`sel.controller` 的取值是**实体**），
 * 由 `targets.ts` 的 `targetPlayers` 反推成玩家列表并去重 ——
 * 于是 `sel.zone{side:"both", zone:"base"}` 这类写法会给双方各抽一次，
 * 而同一方被选中两次只抽一次。空列表 ⇒ **整个动作静默跳过**（IR v1 §5.2）。
 *
 * `count` 缺省 1（IR v1 §3.4），**对整个动作只求一次**（规则 1）：
 * `act.draw{player: 双方, count: num.random(1,3)}` 是"各抽同样多张"，不是各抽各的随机。
 *
 * 一次 `count: 3` 在牌库只剩 1 张时抽 1 张就停 —— 而不是把剩下两次也走一遍空流程。
 * 抽牌是**逐张**发事件的，事件流必须与真实发生的张数一致。
 */
export const drawHandler: ActHandler<"act.draw"> = (env, act) => {
  const players = targetPlayers(env, act.player);
  if (players.length === 0) {
    return;
  }
  const count = act.count === undefined ? 1 : evalNum(env, act.count);
  for (const player of players) {
    for (let i = 0; i < count; i += 1) {
      if (!drawOne(env.state, player)) {
        break;
      }
    }
  }
};
