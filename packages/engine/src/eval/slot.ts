// `evalSlot` —— SlotRef 求值（DSL v2 §3.1 的 `slot.*` 族）。
//
// 为什么位置要有自己的一族：选择器返回**实体**，但「空格子」不是实体 ——
// 召唤、移动、判空都需要**位置值**（v2 §3.1 原文）。
//
// 本文件在 E2 存在的理由：`sel.at` 与 `cond.occupied` 的参数就是 SlotRef，
// 不解析它，那两个 op 无法实现。**动作层**的无效槽语义（「动作的 SlotRef 解析为
// 无效槽 → 该动作静默跳过」）落在 `handlers/`，是 E3/E4 的事，本文件只提供取值。
//
// ── 无效槽 = 空集合语义的位置版（v2 §3.1）────────────────────────────────────
// 越界、非整数、指向不在场的实体、没有空格……一律得到 `INVALID_SLOT`（= `null`），
// 取值来源是 `empty.ts` 那张统一表，本文件不自己发明。
//
// ── 坐标是一维 `(side, index)`（v2 §0 规则 1 / §12）────────────────────────
// 双方同索引对齐，友方 i 的"对面"就是敌方 i。v2 §12 已定案永不加 lane/row 维度，
// 所以 {@link SlotAddr} 就这两个字段，格子数量本身走 `rules.board.slots`。
//
// ── RNG ────────────────────────────────────────────────────────────────────
// `slot.random_empty` 与 `sel.random` / `num.random` **同级**（v2 §3.1）：推进 RNG，
// 因此禁止出现在 aura / intercept.cond 内（编写期 L3 校验，IR v1 §5.4 规则 5）。
// 它走 `context.ts` 的 `rollInt`，**没有空格时一次都不抽** —— 空集不消耗 RNG。

import type { SlotRef } from "@prismfront/ir";
import type { PlayerId } from "../state/index.ts";
import {
  controllerOf,
  emptySlotIndices,
  isValidSlot,
  opponentOf,
  slotOccupant,
} from "../state/index.ts";
import type { EvalEnv } from "./context.ts";
import { assertNever, resolveSlotSide, rollInt } from "./context.ts";
import { INVALID_SLOT } from "./empty.ts";
import { evalNum } from "./num.ts";
import { evalEntities, single } from "./sel.ts";

/**
 * 一个**已经解析成绝对坐标**的格位（v2 §3.1 的 SlotRef 求值结果）。
 *
 * `player` 是绝对的 {@link PlayerId} 而不是相对的 `SlotSide` —— 相对 → 绝对的换算
 * 依赖上下文里的 SELF，在 `context.ts` 的 `resolveSlotSide` 里做掉，之后全引擎只谈绝对坐标。
 *
 * 纯数据（两个 number），可以直接进事件与断言。
 */
export interface SlotAddr {
  readonly player: PlayerId;
  readonly index: number;
}

/**
 * 求值一个 SlotRef。返回 `null` = **无效槽**（v2 §3.1），调用方按「静默跳过 / false」处理。
 *
 * 返回的坐标**保证有效**（`index` 落在 `[0, rules.board.slots)`）：凡是新算出索引的分支
 * 都经 {@link addr} 过一遍 `isValidSlot`（`slot.opposite` 只翻转 side、索引照搬上一层
 * 已验过的值，因此不必重验），于是调用方不必再验一次。
 * 注意「有效」不等于「有人占」—— 空格是有效的，判占用要另问 `slotOccupant`。
 */
export function evalSlot(env: EvalEnv, node: SlotRef): SlotAddr | null {
  switch (node.op) {
    case "slot.at": {
      // 字段按签名声明顺序求值（IR v1 §5.4 规则 1）：先 side 后 index。
      const player = resolveSlotSide(env, node.side);
      const index = evalNum(env, node.index);
      return player === null ? INVALID_SLOT : addr(env, player, index);
    }

    case "slot.of": {
      // v2 §3.1：非单实体或不在场 → 无效槽。`slot !== null` 即「在场且占着一格」
      // （状态不变量 2：`slots[p][i] === id` ⇔ `entities[id].slot === i` 且 zone 是 board）。
      const entity = single(evalEntities(env, node.of));
      if (entity === undefined || entity.slot === null) {
        return INVALID_SLOT;
      }
      return addr(env, controllerOf(entity), entity.slot);
    }

    case "slot.opposite": {
      // 翻转 side，索引不变（v2 §0 规则 1：双方同索引对齐）。索引已经验过，无需再验。
      const of = evalSlot(env, node.of);
      return of === null ? INVALID_SLOT : { player: opponentOf(of.player), index: of.index };
    }

    case "slot.shift": {
      const of = evalSlot(env, node.of);
      const delta = evalNum(env, node.delta);
      // 出界 → 无效槽（v2 §3.1）。**不 clamp、不回绕**：clamp 会让「推到边缘」与
      // 「推出边界」变成同一件事，而 v2 §3.4 的 `act.shift` 要靠这个区别决定推不推得动。
      return of === null ? INVALID_SLOT : addr(env, of.player, of.index + delta);
    }

    case "slot.random_empty": {
      const player = resolveSlotSide(env, node.side);
      if (player === null) {
        return INVALID_SLOT;
      }
      const empties = emptySlotIndices(env.state, player);
      // ★ 无空格 → 无效槽，且**一次 RNG 都不抽**（空集不消耗随机，见 `rollInt` 的说明）。
      if (empties.length === 0) {
        return INVALID_SLOT;
      }
      const picked = empties[rollInt(env, "slot.random_empty", empties.length)];
      return picked === undefined ? INVALID_SLOT : addr(env, player, picked);
    }

    case "slot.first_empty": {
      const player = resolveSlotSide(env, node.side);
      if (player === null) {
        return INVALID_SLOT;
      }
      const empties = emptySlotIndices(env.state, player);
      // `emptySlotIndices` 给的是**升序**索引，于是 left = 头、right = 尾。
      const picked = (node.from ?? "left") === "left" ? empties[0] : empties[empties.length - 1];
      return picked === undefined ? INVALID_SLOT : addr(env, player, picked);
    }

    default:
      // ★ 穷尽检查：IR 新增一个 slot.* 而这里漏写 case → 编译不过（见 `assertNever`）。
      return assertNever(node);
  }
}

/** 组装坐标，顺手做**唯一一次**有效性判定（越界 / 非整数 → 无效槽，v2 §3.1）。 */
function addr(env: EvalEnv, player: PlayerId, index: number): SlotAddr | null {
  return isValidSlot(env.state, index) ? { player, index } : INVALID_SLOT;
}

/**
 * 格上有单位（`cond.occupied` 的落点，v2 §3.3）。
 *
 * 无效槽 → `false`（v2 §3.1 明文）。判空要用 `cond.not` 包一层，
 * 因为「空格」与「无效槽」在这个谓词下同为 `false`，只有它俩合起来的补集才是「有人」。
 */
export function isSlotAddrOccupied(env: EvalEnv, addr: SlotAddr | null): boolean {
  if (addr === null) {
    return false;
  }
  const occupant = slotOccupant(env.state, addr.player, addr.index);
  return occupant !== null && occupant !== undefined;
}
