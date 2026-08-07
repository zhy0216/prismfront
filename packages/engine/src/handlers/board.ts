// 位置与区域的**写入原语**。
//
// handler 里凡是要挪动实体的地方都走这里，理由只有一条：
// **`state/index.ts` 列的四条一致性不变量必须由改状态的人维护**，而"改三个地方"
// （实体的 `zone`/`slot` 字段、`zones[k]` 的有序列表、`slots[p][i]` 的格位）
// 只要有一处漏掉，盘面就会分叉成两份互相矛盾的真相：
//
//   1. `zones[k]` 含 `id`  ⇔  `entities[id].zone === k`
//   2. `slots[p][i] === id` ⇔ `entities[id].slot === i` 且 `entities[id].zone === "p{p}:board"`
//
// 所以本文件是「三处同步」的唯一实现，handler 不许自己写 `state.zones[...].push(...)`。
//
// ⚠ `resolve/deaths.ts` 有一份私有的 `removeFromZone` —— 它先于本文件落地，
//   且死亡结算对"先收集齐再一起搬"的顺序有额外要求（批量是同归于尽能成立的原因），
//   合并进来只会让那份论证变得难读。两处都很短，M5 若要统一再说。

import type { ZoneName } from "@prismfront/ir";
import type { EntityData, GameState, PlayerId } from "../state/index.ts";
import { controllerOf, isSlotEmpty, isValidSlot, zoneKey } from "../state/index.ts";

/** 从实体**当前**所在的区域列表里摘掉它（只动列表，`entity.zone` 由调用方接着改）。 */
function removeFromZoneList(state: GameState, entity: EntityData): void {
  const list = state.zones[entity.zone];
  const at = list.indexOf(entity.id);
  if (at >= 0) {
    list.splice(at, 1);
  }
}

/** 实体若正占着格位，清掉那一格并把 `entity.slot` 置 `null`（维护不变量 2）。 */
function vacateSlot(state: GameState, entity: EntityData): void {
  const slot = entity.slot;
  if (slot === null) {
    return;
  }
  const row = state.slots[controllerOf(entity)];
  if (row[slot] === entity.id) {
    row[slot] = null;
  }
  entity.slot = null;
}

/**
 * 把实体移入 `player` 的 `zone` 区，追加到该区列表末尾。
 *
 * 离开 board 时会顺手腾空原格位。**不发任何事件** —— 该发什么事件取决于
 * 「从哪个区到哪个区」的组合（`card_drawn` / `card_discarded` / `card_added_to_hand` /
 * `unit_summoned` …），那是各个 handler 自己的语义，不是位置原语该替它们决定的。
 *
 * `pos`（`act.move.pos` 对非 board 区的插入位置）M2 不实现：牌库中间插牌只有
 * `act.shuffle` 这类效果用得上，属于 M4。
 */
export function moveToZone(
  state: GameState,
  entity: EntityData,
  player: PlayerId,
  zone: ZoneName,
): void {
  vacateSlot(state, entity);
  removeFromZoneList(state, entity);
  const key = zoneKey(player, zone);
  state.zones[key].push(entity.id);
  entity.zone = key;
}

/**
 * 把实体放到 `player` 的第 `index` 格。
 *
 * 返回 `false` = **没放成**，调用方应当静默跳过（不发事件）：
 * - 无效槽（越界 / 非整数）—— v2 §3.1 的无效槽语义；
 * - 该格已被占 —— v2 §3.4 `act.summon`：「`at` 被占或无效 → 跳过」。
 *
 * 放成功时**重新取一个 `playOrder`**（`state/create.ts`：进入 board / base 时取号）。
 * 触发排序（框架 §4.1 时序规则 1「同一方按 playOrder 升序」）与 `sel.sort` 的稳定性
 * 都依赖它，所以"从手牌上场"这一刻必须取号，不能沿用手牌里的 0。
 */
export function placeOnSlot(
  state: GameState,
  entity: EntityData,
  player: PlayerId,
  index: number,
): boolean {
  if (!isValidSlot(state, index) || !isSlotEmpty(state, player, index)) {
    return false;
  }
  moveToZone(state, entity, player, "board");
  state.slots[player][index] = entity.id;
  entity.slot = index;
  entity.playOrder = state.nextPlayOrder;
  state.nextPlayOrder += 1;
  return true;
}
