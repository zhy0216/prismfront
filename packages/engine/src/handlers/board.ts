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
// 四个原语：`moveToZone`（换区域）、`placeOnSlot`（进场占格 + 取 playOrder）、
// `spawnOnSlot`（新建实体并落格，`act.summon`）、`swapSlots`（换位，**不**重取 playOrder）。
//
// ⚠ `resolve/deaths.ts` 有一份私有的 `removeFromZone` —— 它先于本文件落地，
//   且死亡结算对"先收集齐再一起搬"的顺序有额外要求（批量是同归于尽能成立的原因），
//   合并进来只会让那份论证变得难读。两处都很短，M5 若要统一再说。

import type { CardId, ZoneName } from "@prismfront/ir";
import type { EntityData, GameState, PlayerId, TagValues } from "../state/index.ts";
import {
  controllerOf,
  createTagValues,
  isSlotEmpty,
  isValidSlot,
  NO_FLAGS,
  zoneKey,
} from "../state/index.ts";

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
 * `pos`（`act.move.pos` 对非 board 区的插入位置）仍不实现：牌库中间插牌只有
 * `act.shuffle` 这类效果用得上，而它在 `handlers/index.ts` 里还挂着 `notImplemented`
 * 占位 —— 补那个 op 的时候连本函数一起补。
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

/**
 * **新建**一个实体并直接落到 `player` 的第 `index` 格（`act.summon` 的落点，IR v1 §3.4）。
 *
 * 放不下时返回 `null`，且**一个实体都不建**（先判格位再分配 id）：
 * 半途建出来的实体没有任何区域收得下它，会当场破坏状态不变量 1；
 * 而白白吃掉一个 `nextEntityId` 又会让实体 id 与回放对不上（id 进回放，见 `create.ts`）。
 * 判据两条，与 v2 §3.4 的 `act.summon` 逐字一致：**`at` 无效或被占 → 跳过**。
 *
 * `tags` 写进 `base`（卡面原始值）而不是 `tags`：后者是派生值，流水线第 ⑥ 步
 * `refreshAuras` 会从 `base` 重算覆盖（时序规则 4）。这里顺手把 `tags` 也对齐，
 * 免得在本步的第 ⑤ 步（死亡结算）读到全 0 的血量而当场判死。
 *
 * `owner` 取 `player`：`act.summon` 造的是**新**实体，没有"原主"可言 ——
 * 它死后进 `player` 的墓地，与 `act.steal` 偷来的单位回原主墓地不冲突。
 */
export function spawnOnSlot(
  state: GameState,
  cardId: CardId,
  player: PlayerId,
  index: number,
  tags: Partial<TagValues>,
): EntityData | null {
  if (!isValidSlot(state, index) || !isSlotEmpty(state, player, index)) {
    return null;
  }
  const id = state.nextEntityId;
  state.nextEntityId += 1;
  const key = zoneKey(player, "board");
  const entity: EntityData = {
    id,
    cardId,
    owner: player,
    zone: key,
    // `slot` / `playOrder` 由紧接着的 `placeOnSlot` 写 —— 上场取号这条规矩只有那一处实现。
    slot: null,
    playOrder: 0,
    base: createTagValues(tags),
    tags: createTagValues(tags),
    baseFlags: NO_FLAGS,
    flags: NO_FLAGS,
    enchantments: [],
    damage: 0,
    firedOnce: [],
    respawnAt: null,
  };
  state.entities[id] = entity;
  state.zones[key].push(id);
  // 前面已经判过格位，这一步必然成功；它负责占格与取 playOrder。
  placeOnSlot(state, entity, player, index);
  return entity;
}

/**
 * 交换两个在场单位的格位（`act.swap`，v2 §3.4）。
 *
 * 返回 `false` = 换不成（同一个实体、或有一方不在场）⇒ 调用方静默跳过。
 *
 * ★ **不重取 `playOrder`** —— 这是本函数不能直接复用 {@link placeOnSlot} 的原因：
 * 那个函数是"进场"的落点，进场要取号（框架 §4.1 时序规则 1 的触发排序依赖它）；
 * 而换位的两个单位**本来就在场**，重新取号会让它们的触发顺序莫名跳到全场最后。
 *
 * 先把两格一起腾空再落位：逐个搬会让第二个撞上"格子被占"（对面那格还没空出来）。
 * 跨阵营换位（`a`、`b` 分属两方）连**区域**一起换 —— 控制者就是 `zone` 的玩家位
 * （`state/queries.ts` 的 `controllerOf`），不换区域就会出现"站在敌方格子上、
 * 却仍算我方单位"的分叉盘面。
 */
export function swapSlots(state: GameState, a: EntityData, b: EntityData): boolean {
  if (a.id === b.id || a.slot === null || b.slot === null) {
    return false;
  }
  const playerA = controllerOf(a);
  const playerB = controllerOf(b);
  const slotA = a.slot;
  const slotB = b.slot;
  state.slots[playerA][slotA] = null;
  state.slots[playerB][slotB] = null;
  if (playerA !== playerB) {
    // 只换区域列表；`vacateSlot` 在这里是空转（两格已经腾空）。
    moveToZone(state, a, playerB, "board");
    moveToZone(state, b, playerA, "board");
  }
  state.slots[playerB][slotB] = a.id;
  a.slot = slotB;
  state.slots[playerA][slotA] = b.id;
  b.slot = slotA;
  return true;
}
