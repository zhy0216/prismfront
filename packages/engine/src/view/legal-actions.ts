// 合法动作快照（M7）。
//
// 这是 UI / bot 的方便索引，不是权威校验：真正收到意图时仍必须走 apply()，
// 因为快照可能已经过期。颜色门直接复用 rules/apply.ts 的 lockedColorsOf，
// 保证「没有红色光源」这类动态细节与服务端拒绝逻辑只有一个实现。

import type { Color } from "@prismfront/ir";
import type { CardLookup } from "../eval/index.ts";
import type { ResolveDeps } from "../resolve/index.ts";
import { lockedColorsOf } from "../rules/apply.ts";
import type { IllegalReason, Intent } from "../rules/intent.ts";
import type { GameState, PlayerId } from "../state/index.ts";
import { emptySlotIndices, getEntity, getZone, playerData } from "../state/index.ts";

/** 单条动作的 UI 置灰信息。`intent` 始终是可重新提交给 apply 的形状。 */
export interface LegalAction {
  readonly intent: Extract<Intent, { t: "play_card" | "pass" }>;
  /** 展平后的协议字段，方便 UI 直接渲染；与 `intent` 始终一致。 */
  readonly t: "play_card" | "pass";
  readonly card: number | null;
  readonly slot: number | null;
  readonly legal: boolean;
  readonly reason: IllegalReason | null;
  /** `illegalReason` 是协议命名的同义别名，便于直接映射 shared LegalMoves。 */
  readonly illegalReason: IllegalReason | null;
  /** 色门锁定时缺少的颜色；其它原因恒为空数组。 */
  readonly missingColors: readonly Color[];
  /** 对应手牌当前可尝试的空格。UI 选格时可直接复用，不扩大动作分支。 */
  readonly slots: readonly number[];
}

export interface LegalMoves {
  readonly player: PlayerId;
  readonly actions: readonly LegalAction[];
  readonly playCard: readonly LegalAction[];
  readonly pass: LegalAction;
}

/** 接受卡表查询或完整 ResolveDeps，保持引擎无全局卡表。 */
export type LegalActionsDeps = CardLookup | Pick<ResolveDeps, "cards">;

function cardsOf(deps: LegalActionsDeps | undefined): CardLookup | undefined {
  return typeof deps === "function" ? deps : deps?.cards;
}

function gateReason(state: GameState, player: PlayerId): IllegalReason | null {
  if (state.winner !== null) {
    return "game_over";
  }
  if (state.pendingInput !== null) {
    return "awaiting_input";
  }
  if (state.phase !== "actions") {
    return "wrong_phase";
  }
  if (state.priority !== player) {
    return "wrong_player";
  }
  return null;
}

function action(
  intent: Extract<Intent, { t: "play_card" | "pass" }>,
  legal: boolean,
  reason: IllegalReason | null,
  missingColors: readonly Color[] = [],
  slots: readonly number[] = [],
): LegalAction {
  return {
    intent,
    t: intent.t,
    card: intent.t === "play_card" ? intent.card : null,
    slot: intent.t === "play_card" ? intent.slot : null,
    legal,
    reason,
    illegalReason: reason,
    missingColors,
    slots,
  };
}

/**
 * 枚举当前手牌的 `play_card` 与一个 `pass`，仅开放这两个动作分支。
 *
 * 每张手牌只生成一条动作记录；空格列表独立放在 `slots`，避免把动作空间膨胀成
 * 「手牌 × 9 格」。`intent.slot` 是当前第一个空格（没有空格时为 0），仅作方便
 * 的代表值，`legal` 与 `reason` 才是 UI 置灰信息；apply 仍会重新校验完整意图。
 */
export function legalActions(
  state: GameState,
  player: PlayerId,
  deps?: LegalActionsDeps,
): LegalMoves {
  const gate = gateReason(state, player);
  const cards = cardsOf(deps);
  const slots = emptySlotIndices(state, player);
  const representativeSlot = slots[0] ?? 0;
  const actions: LegalAction[] = [];

  for (const id of getZone(state, player, "hand")) {
    const card = getEntity(state, id);
    if (card === undefined) {
      continue;
    }
    let reason = gate;
    let missingColors: readonly Color[] = [];
    if (reason === null) {
      missingColors = lockedColorsOf(state, player, card, cards);
      if (missingColors.length > 0) {
        reason = "color_locked";
      } else if (playerData(state, player).crystals < card.tags.cost) {
        reason = "not_enough_crystals";
      } else if (cards?.(card.cardId)?.kind !== "spell" && slots.length === 0) {
        reason = "slot_occupied";
      }
    }
    actions.push(
      action(
        { t: "play_card", player, card: id, slot: representativeSlot },
        reason === null,
        reason,
        missingColors,
        slots,
      ),
    );
  }

  const pass = action({ t: "pass", player }, gate === null, gate);
  actions.push(pass);
  return {
    player,
    actions,
    playCard: actions.filter((move) => move.t === "play_card"),
    pass,
  };
}
