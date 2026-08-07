// state/ —— 引擎的状态模型（架构 §2.3 的 `state/`）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 一条铁律，从第一行代码守到最后一行（框架 §3.1、§13 坑 3）★
// ═══════════════════════════════════════════════════════════════════════════
// **状态是纯数据，实体用 id 互相引用。**
//
// 允许：string / number / boolean / null / 纯对象 / 数组
// 禁止：函数、闭包、class 实例、Map、Set、Symbol、BigInt、NaN、Infinity，
//       以及任何指向另一个实体对象的引用（一律换成 EntityId）
//
// 三条推论，本目录逐条落实：
//   1. **行为不进状态** —— 实体只存 `cardId`，脚本永远从注册表取。
//   2. **辅助函数放模块里** —— 本目录所有查询都是 `f(state, ...)`（`queries.ts`），
//      一个都不挂到状态对象上（挂上去就是方法 = class 化）。
//   3. **不用可选属性，一律「必填 + `| null`」** —— `JSON.stringify({a: undefined})`
//      会丢键，`null` 能原样往返。状态里不存在可选属性这个形态，
//      架构 §6.1 第二条测试（序列化往返）才是逐字相等的探针，而不会假绿。
//      （与 `../events/event.ts` 同一条规矩。）
//
// 探针：架构 §6.1 的第二条测试。**它一红就说明架构腐化了，去改状态，别去改测试。**
//
// ═══════════════════════════════════════════════════════════════════════════
// 文件分工
// ═══════════════════════════════════════════════════════════════════════════
//   game-state.ts  GameState / Phase / MatchResult —— 顶层形状与字段语义
//   entity.ts      EntityData / TagValues / 标志位掩码 / 附魔实例 / 血量记账定案
//   player.ts      PlayerId / PlayerData（crystals / crystalCap / baseId / fatigue）
//   zone.ts        ZoneKey（`p0:hand` 形态）与区域表构造
//   stack.ts       PendingAction / CtxBindings —— 结算栈条目（框架 §4.2）
//   input.ts       InputRequest —— 挂起点（IR v1 §6.1）
//   create.ts      createInitialState —— 建局（不洗牌、不消耗 RNG、不读时间）
//   queries.ts     纯查询：按 id 取实体、按格位取实体、区域、血量、深拷贝……
//
// ═══════════════════════════════════════════════════════════════════════════
// 状态的四条一致性不变量（改状态的代码必须一起维护）
// ═══════════════════════════════════════════════════════════════════════════
//   1. `zones[k]` 含 `id`  ⇔  `entities[id].zone === k`
//   2. `slots[p][i] === id` ⇔ `entities[id].slot === i` 且 `entities[id].zone === "p{p}:board"`
//   3. `entities[id].id === id`
//   4. `players[p].baseId` 指向的实体在 `p{p}:base` 区
//
// M2 只建模与查询；写入这些结构的动作在 `../handlers`，相位机在 M3。

export type { CreateInitialStateOptions } from "./create.ts";
export {
  createEmptySlots,
  createInitialState,
  FIRST_ENTITY_ID,
  FIRST_PLAY_ORDER,
  FIRST_ROUND,
} from "./create.ts";
export type { AttachedEnchantment, EntityData, FlagMask, TagValues } from "./entity.ts";
export {
  addTagValues,
  BASE_CARD_ID,
  createTagValues,
  FLAG_BITS,
  maskHas,
  maskWith,
  NO_FLAGS,
  ZERO_TAGS,
} from "./entity.ts";
export type { GameState, MatchResult, Phase } from "./game-state.ts";
export { PHASES } from "./game-state.ts";
export type { InputKind, InputRequest } from "./input.ts";
export { INPUT_KINDS } from "./input.ts";
export type { PlayerData, PlayerId } from "./player.ts";
export { opponentOf, PLAYER_IDS } from "./player.ts";
export {
  baseOf,
  boardEntities,
  cloneState,
  controllerOf,
  currentHealth,
  emptySlotIndices,
  entityAtSlot,
  flagsOf,
  getEntities,
  getEntity,
  getSlots,
  getZone,
  getZoneByKey,
  getZoneEntities,
  hasBaseFlag,
  hasFlag,
  isEntityId,
  isInZone,
  isLethal,
  isOnBoard,
  isOver,
  isSlotEmpty,
  isSlotOccupied,
  isSuspended,
  isValidSlot,
  playerData,
  slotCount,
  slotOccupant,
  tagOf,
  zoneOf,
} from "./queries.ts";
export type {
  CtxBindings,
  PendingAction,
  PendingInlineAct,
  PendingScript,
  ScriptRef,
} from "./stack.ts";
export { createCtx, withCtx } from "./stack.ts";
export type { ZoneKey, ZoneKeyParts } from "./zone.ts";
export { createEmptyZones, parseZoneKey, ZONE_NAMES, zoneKey } from "./zone.ts";
