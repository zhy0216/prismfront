// packages/ir/src/types —— IR 权威类型（irVersion 2.1.0）。
//
// 这份类型是**唯一权威定义**（IR §12 落地顺序第 1 步）：
// engine 的 handler 表与求值器、cards 的 builder、L1/L2 校验器、printer/differ 全从它派生。
// Act / Sel / Num / Cond / SlotRef / CardRef 都是按 `op` 判别的**可辨识联合**，
// TS 的穷尽检查是后面 handler 表与求值器的兜底 —— 漏一个 op 编译不过。
//
// 三处来源的合并关系：
//   1. 《卡牌 DSL 的 JSON IR 规范》§9        —— 基线（最大的一块）
//   2. 《格子战斗卡牌 DSL 规范 v2》§7        —— 格子战斗的全量差异（slot.* 族、增改删）
//   3. 《格子战斗卡牌 DSL 规范 v2》§11       —— v2.1 增补（英雄 / 色门 / 融合 / 复燃泉）
// 并顺带做掉《Prismfront 工程与技术架构》§10 的六项规范一致性清理，
// 每一项都在对应位置留了「架构 §10 第 N 项」注释：
//   1. irVersion 定为 "2.1.0"                 → ir-version.ts
//   2. RulesConfig.heroHp → baseHp            → rules-config.ts
//   3. ZoneName 补 base / fountain、删 hero    → zone.ts
//   4. Side 拆成 SlotSide / SelSide            → zone.ts
//   5. stunned 进战斗快照条件                  → tag.ts（FlagName）
//   6. deploySchedule 语义注释                 → rules-config.ts
//
// 本目录不导出任何求值/校验逻辑，只有类型与由类型派生的常量表。

export type { Act, ActEntityField, ActNode, ActNumField, ActOp } from "./act.ts";
export { ACT_ENTITY_FIELDS, ACT_NUM_FIELDS } from "./act.ts";
export type { Aura } from "./aura.ts";
export type { Bundle } from "./bundle.ts";
export type { Card, CardData, CardScript, ChooseOneOption } from "./card.ts";
export type { CardKind, Color, Rarity } from "./card-kind.ts";
export { CARD_KINDS, COLORS, RARITIES } from "./card-kind.ts";
export type { CardOp, CardRef, CardRefNode, Pool } from "./card-ref.ts";
export type {
  BundleId,
  CardId,
  EnchantId,
  EntityId,
  Locale,
  LocalizedText,
  SetId,
} from "./common.ts";
export type { Cond, CondNode, CondOp } from "./cond.ts";
export type { Duration, Enchantment, EnchantmentScript } from "./enchantment.ts";
export { DURATIONS } from "./enchantment.ts";
export type { EventEntityField, EventName } from "./event.ts";
export { EVENT_ENTITY_FIELDS, EVENT_NAMES } from "./event.ts";
export type {
  Intercept,
  InterceptEffect,
  InterceptEffectKind,
  InterceptedAct,
  InterceptFilter,
} from "./intercept.ts";
export type { CurrentIRVersion, IRVersion } from "./ir-version.ts";
export { IR_VERSION, IR_VERSION_MAJOR } from "./ir-version.ts";
export type { Num, NumNode, NumOp } from "./num.ts";
export type { NodeFamily, NodeOp } from "./ops.ts";
export {
  ACT_OP_SET,
  ACT_OPS,
  CARD_OP_SET,
  CARD_OPS,
  COND_OP_SET,
  COND_OPS,
  NODE_OP_PREFIXES,
  NODE_OP_SET,
  NODE_OPS,
  NUM_OP_SET,
  NUM_OPS,
  SEL_OP_SET,
  SEL_OPS,
  SLOT_OP_SET,
  SLOT_OPS,
} from "./ops.ts";
export type {
  InitiativeRule,
  PlayerActionKind,
  RulesConfig,
} from "./rules-config.ts";
export { DEFAULT_RULES_CONFIG, INITIATIVE_RULES, PLAYER_ACTION_KINDS } from "./rules-config.ts";
export type { LimitFrom, Sel, SelNode, SelOp, SortDir } from "./sel.ts";
export { LIMIT_FROMS, SORT_DIRS } from "./sel.ts";
export type { SlotNode, SlotOp, SlotRef, SlotSearchFrom } from "./slot.ts";
export { SLOT_SEARCH_FROMS } from "./slot.ts";
export type { FlagName, GlobalTag, TagKey, TribeName } from "./tag.ts";
export { FLAG_NAMES, GLOBAL_TAGS, TAG_KEYS, TRIBE_NAMES } from "./tag.ts";
export type { Trigger, TriggerFilter } from "./trigger.ts";
export type { MoveSide, SelSide, SlotSide, ZoneName } from "./zone.ts";
export { MOVE_SIDES, SEL_SIDES, SLOT_SIDES, ZONE_NAMES } from "./zone.ts";
