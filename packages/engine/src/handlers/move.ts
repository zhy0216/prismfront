// 区域与位置的动作：`act.move`（换区域 / 放单位到格）、`act.swap`（换位）。
// 来源：IR v1 §3.4（`act.move{target, zone, side?, pos?}`，`side` 默认 `"owner"`）、
//       v2 §3.4（`act.swap{a, b}`：须各为单个在场单位，否则跳过）、
//       v2 §2.1（格位是一维 `(side, index)`）、v2 §5（`unit_summoned` / `unit_moved`）。
//
// ═══════════════════════════════════════════════════════════════════════════
// `act.move{zone:"board"}` 与 `act.summon` 的分工
// ═══════════════════════════════════════════════════════════════════════════
// `act.move` 的主语是一个**已经存在**的实体（手牌里的牌、墓地里的尸体），
// 它只换位置；`act.summon` 是**从 CardRef 新建**实体（`summon.ts`），要卡表。
// 打出一张单位牌走的是前者（`rules/phase.ts` 把 `play_card` 翻译成 `act.move`），
// 亡语召唤走后者。两条路都汇到 `board.ts` 的 `placeOnSlot`，三条位置不变量只有一处实现。
//
// ⚠ `act.move.pos` 是**字面格索引**，不是 `SlotRef` —— 它是 v1 的字段（IR v1 §3.4）。
//   v2 的位置四件套（`act.move_to` / `act.shift`）才用 `slot.*`，由 `resolve/act-slots.ts`
//   给出惰性解析器、handler 在自己的签名位置上拉（v2 §3.1 + IR v1 §5.4 规则 1）。

import { evalNum, playerEntityId } from "../eval/index.ts";
import { emitEvent } from "../events/index.ts";
import type { ActHandler } from "../resolve/index.ts";
import { opponentOf } from "../state/index.ts";
import { moveToZone, placeOnSlot, swapSlots } from "./board.ts";
import { frozenEntities, singleTarget, snapshot, sourceOf } from "./targets.ts";

/**
 * 没有给出 `pos` 时用的格索引。
 *
 * -1 是**无效槽**（`state/queries.ts` 的 `isValidSlot`：索引须落在 `[0, slots)`），
 * 于是"往战线上放却没说放哪格"按 v2 §3.1 的无效槽语义静默跳过 ——
 * 而**不会**悄悄落到 0 号格。0 是一个真实格子，拿它当缺省值是 `num.slot_index`
 * 那条唯一例外（`eval/empty.ts`）想避免的同一类错误。
 */
const NO_POS = -1;

/**
 * `act.move{target, zone, side?, pos?}` 的 handler。
 *
 * `side`（IR v1 §3.4，默认 `"owner"`）决定进**谁**的对应区：`"owner"` = 原始拥有者，
 * `"opposite"` = 其对手。注意基准是 `entity.owner` 而不是当前控制者 ——
 * 被 `act.steal` 偷走的单位，`side:"owner"` 要把它还给原主
 * （与 `resolve/deaths.ts` 让死亡单位回原主墓地是同一条记账原则）。
 *
 * ★ 目标只求值一次（IR v1 §5.3 规则 1），`pos` 也只求一次；多目标时逐个搬 ——
 * 搬到 board 的情形下第二个开始会撞上"格子被占"而静默跳过（v2 §3.1），
 * 这正是"一条 `act.move` 只能放一个单位"的自然形态，不需要额外守卫。
 *
 * 两条分支：
 * - `zone: "board"` —— `pos` 就是格索引。无效槽 / 该格被占 → **静默跳过**
 *   （v2 §3.1 无效槽语义），跳过时不发事件；放成功发 `unit_summoned`。
 * - 其余区域 —— 直接追加到该区列表末尾，**不发事件**。
 *   区域间移动该发什么事件取决于"从哪来到哪去"的组合（`card_discarded` /
 *   `card_added_to_hand` / …），那些组合各自属于 `act.discard` / `act.give`（M5），
 *   在这里替它们发事件只会让同一件事出现两个来源。
 *
 * `unit_summoned.source` 是**召唤者**（亡语召唤时是死掉的那个）。这里把
 * 「SELF 就是被移上场的那个实体」的情形归一成 `null`：手牌里的牌被打出时 SELF 是牌
 * 自己（`rules/phase.ts` 的 `play_card` 也这么绑），而"自己召唤了自己"不是一条有意义
 * 的因果，客户端拿它连不出任何动画。
 */
export const moveHandler: ActHandler<"act.move"> = (env, act) => {
  const targets = snapshot(env, act.target);
  if (targets.length === 0) {
    return;
  }
  const index = act.pos === undefined ? NO_POS : evalNum(env, act.pos);
  const source = sourceOf(env);
  for (const target of frozenEntities(env, targets)) {
    const owner = target.owner;
    const player = (act.side ?? "owner") === "owner" ? owner : opponentOf(owner);

    if (act.zone !== "board") {
      moveToZone(env.state, target, player, act.zone);
      continue;
    }
    if (!placeOnSlot(env.state, target, player, index)) {
      continue;
    }
    emitEvent(env.state, {
      name: "unit_summoned",
      player: playerEntityId(env.state, player),
      source: source === target.id ? null : source,
      target: target.id,
      cardId: target.cardId,
      slot: index,
    });
  }
};

/**
 * `act.swap{a, b}` —— 交换两个在场单位的位置（v2 §3.4）。
 *
 * v2 §3.4 原文：「`a`、`b` 须各为**单个在场单位**，否则跳过」——
 * 判据走 `targets.ts` 的 `singleTarget`（与 `act.strike` / `slot.of` 同一条），
 * "在场"由 `board.ts` 的 `swapSlots` 用 `slot !== null` 判。
 *
 * 发**两条** `unit_moved`（v2 §5：`{target, fromSlot, toSlot}`，move_to/shift/swap 都发）：
 * 换位是两个单位各自动了一下，客户端要两条才能同时播两个动画；
 * 合并成一条会丢掉"另一个是谁"这个信息。顺序按 `a`、`b` —— 与签名字段顺序一致
 * （IR v1 §5.4 规则 1），于是事件顺序不依赖实现细节。
 */
export const swapHandler: ActHandler<"act.swap"> = (env, act) => {
  const a = singleTarget(env, act.a);
  const b = singleTarget(env, act.b);
  if (a === undefined || b === undefined) {
    return;
  }
  const fromA = a.slot;
  const fromB = b.slot;
  if (fromA === null || fromB === null || !swapSlots(env.state, a, b)) {
    return;
  }
  emitEvent(env.state, { name: "unit_moved", target: a.id, fromSlot: fromA, toSlot: fromB });
  emitEvent(env.state, { name: "unit_moved", target: b.id, fromSlot: fromB, toSlot: fromA });
};
