// `act.move` —— 把实体挪到某个区域；`zone: "board"` 时就是**放单位到指定格**（走查第 2 步）。
// 来源：IR v1 §3.4（`act.move{target, zone, side?, pos?}`，`side` 默认 `"owner"`）、
//       v2 §2.1（格位是一维 `(side, index)`）、v2 §5（`unit_summoned`）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 为什么"放单位到格"用 `act.move` 而不是 `act.summon`
// ═══════════════════════════════════════════════════════════════════════════
// `act.summon` 的语义是**从一个 `CardRef` 新建实体**（IR v1 §3.4）。新建实体就得知道
// 这张卡的卡面属性（atk / health / flags），而卡面在 bundle 里 —— **M2 没有卡表**，
// 也不许去读（里程碑 M2 第 5 项：不碰 DSL、不读 IR 卡表）。
// 硬要写一个 `act.summon` 只会产出 0/0 的单位，而 0 血单位在流水线第 ⑤ 步就会被判死
// （`state/entity.ts` 的血量记账：当前血量 = `tags.health - damage`）—— 召唤出来当场
// 暴毙，那是个会误导人的地雷，不是"退化情形"。
//
// 而 M2 的走查要的是「抽到的那张牌站到格子上」，主语是一个**已经存在**的实体，
// 正好落在 `act.move` 的语义里：把实体移到 board 区的第 `pos` 格。
// M4 接上卡表后再补 `act.summon`（新建实体 + 复用本文件的 {@link placeOnSlot}）。

import { emitEvent } from "../events/index.ts";
import type { ActHandler } from "../resolve/index.ts";
import { opponentOf } from "../state/index.ts";
import { moveToZone, placeOnSlot } from "./board.ts";
import { playerEntity, readEntity, readNum, sourceOf } from "./read.ts";

/**
 * `act.move` 的 M2 临时 handler。
 *
 * `side`（IR v1 §3.4，默认 `"owner"`）决定进**谁**的对应区：`"owner"` = 原始拥有者，
 * `"opposite"` = 其对手。注意基准是 `entity.owner` 而不是当前控制者 ——
 * 被 `act.steal` 偷走的单位，`side:"owner"` 要把它还给原主
 * （与 `resolve/deaths.ts` 让死亡单位回原主墓地是同一条记账原则）。
 *
 * 两条分支：
 * - `zone: "board"` —— `pos` 就是格索引。无效槽 / 该格被占 → **静默跳过**
 *   （v2 §3.1 无效槽语义），跳过时不发事件；放成功发 `unit_summoned`。
 * - 其余区域 —— 直接追加到该区列表末尾，**不发事件**。
 *   区域间移动该发什么事件取决于"从哪来到哪去"的组合（`card_discarded` /
 *   `card_added_to_hand` / …），M2 不替 M4 预先拍板；走查也用不到这一支。
 *
 * `unit_summoned.source` 是**召唤者**（亡语召唤时是死掉的那个）。这里把
 * 「SELF 就是被移上场的那个实体」的情形归一成 `null`：手牌里的牌被打出时 SELF 是牌
 * 自己（M3 的 `play_card` 也这么绑），而"自己召唤了自己"不是一条有意义的因果，
 * 客户端拿它连不出任何动画。
 */
export const moveHandler: ActHandler<"act.move"> = (state, ctx, act) => {
  const target = readEntity(state, ctx, act.target);
  if (target === undefined) {
    return;
  }
  const owner = target.owner;
  const player = (act.side ?? "owner") === "owner" ? owner : opponentOf(owner);

  if (act.zone !== "board") {
    moveToZone(state, target, player, act.zone);
    return;
  }

  const index = readNum(act.pos, -1);
  const source = sourceOf(state, ctx);
  if (!placeOnSlot(state, target, player, index)) {
    return;
  }
  emitEvent(state, {
    name: "unit_summoned",
    player: playerEntity(state, player),
    source: source === target.id ? null : source,
    target: target.id,
    cardId: target.cardId,
    slot: index,
  });
};
