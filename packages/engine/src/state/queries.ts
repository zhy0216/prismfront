// 纯查询辅助。
//
// 全部是 `f(state, ...)` 形式的自由函数 —— **辅助函数放模块里，不挂到状态对象上**：
// 挂上去就是方法，状态就变成了 class 实例，框架 §3.1 / §13 坑 3 当场破功。
//
// 全部只读、无副作用、不消耗 RNG、不读时间。写入状态的动作属于 `../handlers`。

import type { CardId, EntityId, FlagName, TagKey, ZoneName } from "@prismfront/ir";
import type { EntityData, FlagMask } from "./entity.ts";
import { maskHas } from "./entity.ts";
import type { GameState } from "./game-state.ts";
import type { PlayerData, PlayerId } from "./player.ts";
import type { ZoneKey } from "./zone.ts";
import { parseZoneKey, zoneKey } from "./zone.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 玩家
// ═══════════════════════════════════════════════════════════════════════════

/** 取玩家数据。`players` 是 2 元组、下标是 `0 | 1`，所以不会有 `undefined`。 */
export function playerData(state: GameState, player: PlayerId): PlayerData {
  return player === 0 ? state.players[0] : state.players[1];
}

/** 取某方的 base 实体（v2.1 §11.2：承伤与胜负判定的那个实体）。 */
export function baseOf(state: GameState, player: PlayerId): EntityData | undefined {
  return getEntity(state, playerData(state, player).baseId);
}

// ═══════════════════════════════════════════════════════════════════════════
// 实体
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 按 id 取实体。
 *
 * 返回 `EntityData | undefined`：`entities` 是索引签名，`noUncheckedIndexedAccess`
 * 会加上 `undefined`，而这**正确**反映了「id 可能指向一个已经不存在的实体」。
 * 不要用 `!` 抹掉它 —— 悬空 id 是死亡结算与延迟触发里最常见的一类真实情况。
 */
export function getEntity(state: GameState, id: EntityId): EntityData | undefined {
  return state.entities[id];
}

/** 按 id 列表批量取实体，**静默跳过**取不到的 id（IR v1 §5.2 的空集合语义同款处理）。 */
export function getEntities(state: GameState, ids: readonly EntityId[]): EntityData[] {
  const out: EntityData[] = [];
  for (const id of ids) {
    const entity = state.entities[id];
    if (entity !== undefined) {
      out.push(entity);
    }
  }
  return out;
}

/** 实体的**当前控制者**（`act.steal` 之后可能不等于 `entity.owner`）。 */
export function controllerOf(entity: EntityData): PlayerId {
  return parseZoneKey(entity.zone).player;
}

/** 实体所在的区域名（不含玩家位）。 */
export function zoneOf(entity: EntityData): ZoneName {
  return parseZoneKey(entity.zone).zone;
}

/** 实体是否在某个区域。 */
export function isInZone(entity: EntityData, zone: ZoneName): boolean {
  return zoneOf(entity) === zone;
}

/** 实体是否站在战线上。 */
export function isOnBoard(entity: EntityData): boolean {
  return isInZone(entity, "board");
}

// ═══════════════════════════════════════════════════════════════════════════
// 属性、标志位、血量
// ═══════════════════════════════════════════════════════════════════════════

/** 读生效属性值（`num.attr` 的落点）。`tags` 是全量表，恒有值，缺省即 0。 */
export function tagOf(entity: EntityData, tag: TagKey): number {
  return entity.tags[tag];
}

/** 生效标志位（`cond.has_flag` 的落点）。 */
export function hasFlag(entity: EntityData, flag: FlagName): boolean {
  return maskHas(entity.flags, flag);
}

/** 卡面标志位（沉默复位时的目标值）。 */
export function hasBaseFlag(entity: EntityData, flag: FlagName): boolean {
  return maskHas(entity.baseFlags, flag);
}

/** 当前生效标志位掩码。 */
export function flagsOf(entity: EntityData): FlagMask {
  return entity.flags;
}

/** 当前血量 = `tags.health - damage`（记账方式见 `entity.ts` 的 {@link EntityData}）。 */
export function currentHealth(entity: EntityData): number {
  return entity.tags.health - entity.damage;
}

/**
 * 是否已致死（死亡结算的判据，框架 §4.1 时序规则 3）。
 *
 * 注意它只回答「血量归零了没有」，**不问实体在不在场** —— 已经躺在墓地里的实体
 * 同样满足这个谓词。死亡结算要先按区域筛，再用它判。
 */
export function isLethal(entity: EntityData): boolean {
  return currentHealth(entity) <= 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// 区域
// ═══════════════════════════════════════════════════════════════════════════

/** 取某方某区域的**有序** id 列表（牌库顺序、手牌顺序都由它表达）。 */
export function getZone(state: GameState, player: PlayerId, zone: ZoneName): readonly EntityId[] {
  return state.zones[zoneKey(player, zone)];
}

/** 按区域键取有序 id 列表。 */
export function getZoneByKey(state: GameState, key: ZoneKey): readonly EntityId[] {
  return state.zones[key];
}

/** 取某方某区域的实体，保持区域列表的顺序。 */
export function getZoneEntities(state: GameState, player: PlayerId, zone: ZoneName): EntityData[] {
  return getEntities(state, getZone(state, player, zone));
}

// ═══════════════════════════════════════════════════════════════════════════
// 格位
//
// 这里的 `player` 是**绝对**的 PlayerId，不是 IR 的 SlotSide（`"friendly" | "enemy"`）。
// 相对侧别 → 绝对玩家的换算依赖上下文里的 SELF，是求值器（M4）的事，不是状态层的事。
// ═══════════════════════════════════════════════════════════════════════════

/** 每方的格子数（v2 §6 的 `board.slots`，默认 9）。 */
export function slotCount(state: GameState): number {
  return state.rules.board.slots;
}

/** 取某方一整行战线（只读）。 */
export function getSlots(state: GameState, player: PlayerId): readonly (EntityId | null)[] {
  return player === 0 ? state.slots[0] : state.slots[1];
}

/** 索引是否落在战线内。越界即「无效槽」（v2 §3.1）。 */
export function isValidSlot(state: GameState, index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < slotCount(state);
}

/**
 * 格位占用情况，**三态**（v2 §3.1「无效槽 = 空集合语义的位置版」）：
 *
 * - `undefined` —— **无效槽**（越界/非整数）：动作的 SlotRef 解析到它就**静默跳过**，
 *   `cond.occupied` 为 `false`；
 * - `null` —— 有效但**空**的格；
 * - `EntityId` —— 有人占。
 *
 * 三态是有意保留的：`noUncheckedIndexedAccess` 给出的 `undefined` 本身就是无效槽信号，
 * **不要用 `!` 把它抹掉**，也不要把它和 `null` 合并 —— 「召唤到无效槽」与「召唤到空格」
 * 是完全相反的两件事。
 */
export function slotOccupant(
  state: GameState,
  player: PlayerId,
  index: number,
): EntityId | null | undefined {
  if (!Number.isInteger(index)) {
    return undefined;
  }
  return getSlots(state, player)[index];
}

/** 格位上的实体。无效槽与空格都得到 `undefined`（取不到实体这一点上两者同义）。 */
export function entityAtSlot(
  state: GameState,
  player: PlayerId,
  index: number,
): EntityData | undefined {
  const id = slotOccupant(state, player, index);
  return id === null || id === undefined ? undefined : getEntity(state, id);
}

/** 有效且空的格 → `true`；无效槽 → `false`。`cond.occupied` 取它的反面。 */
export function isSlotEmpty(state: GameState, player: PlayerId, index: number): boolean {
  return slotOccupant(state, player, index) === null;
}

/** 有效且有人占 → `true`（`cond.occupied`，v2 §3.3）。 */
export function isSlotOccupied(state: GameState, player: PlayerId, index: number): boolean {
  const id = slotOccupant(state, player, index);
  return id !== null && id !== undefined;
}

/** 某方全部空格的索引，**升序**（`slot.first_empty` / `slot.random_empty` 的候选集）。 */
export function emptySlotIndices(state: GameState, player: PlayerId): number[] {
  const row = getSlots(state, player);
  const out: number[] = [];
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === null) {
      out.push(i);
    }
  }
  return out;
}

/**
 * 某方战线上的实体，**按格序 0→8 枚举**（v2 §3.2：board 的枚举顺序自 v2 起有定义，
 * v1 是无序列表 + playOrder）。战斗快照（v2 §4.2 第 ② 步）就按这个顺序遍历。
 */
export function boardEntities(state: GameState, player: PlayerId): EntityData[] {
  const row = getSlots(state, player);
  const out: EntityData[] = [];
  for (const id of row) {
    if (id === null) {
      continue;
    }
    const entity = state.entities[id];
    if (entity !== undefined) {
      out.push(entity);
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 整局
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 深拷贝整个状态（框架 §3.1 的 `clone(state)`）。
 *
 * 用 JSON 往返而不是 `structuredClone`：后者不在 `lib: ["ES2023"]` 里（架构 §4.2 的
 * `types: []` 环境下它根本没有声明），而且引擎必须运行时中立（架构 §6.3）——
 * JSON 是唯一在任何 JS 运行时上都存在、且语义完全一致的深拷贝手段。
 *
 * **它同时是一条不变量探针**：状态里一旦混进函数 / class 实例 / Map / Set / BigInt，
 * 拷贝结果就会与原状态行为不一致（BigInt 更是直接抛错）。
 * 架构 §6.1 的第二条测试用的就是这条路径。
 */
export function cloneState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

/** 对局是否已结束（v2 §4.1：base 归零 → over，双亡 → draw）。 */
export function isOver(state: GameState): boolean {
  return state.winner !== null;
}

/** 是否正挂起等玩家输入（框架 §4.2）。 */
export function isSuspended(state: GameState): boolean {
  return state.pendingInput !== null;
}

/**
 * 卡 id 与实体 id 的判别 —— `ctx.chosen` / `InputRequest.options` 是二者的联合
 * （IR v1 §6.1）。`EntityId` 是 number、`CardId` 是 string，靠 `typeof` 即可分开。
 */
export function isEntityId(value: EntityId | CardId): value is EntityId {
  return typeof value === "number";
}
