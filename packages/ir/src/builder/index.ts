// packages/ir/src/builder —— TS builder（编写层的糖 + 规范化）。
//
// 定位（IR §12 落地顺序第 4 步）："builder 只是构造 IR 节点的类型安全外壳，实现量很小。"
// 它不认识任何一张具体的卡（那是 `packages/cards`），不解释 IR（那是 engine），
// 不做校验（L1/L2 是校验器，L3 是 M11）。
//
// 三层：
//   1. 节点构造器 —— `Hit` / `Buff` / `At` / `SlotOf` / `Count` / `Occupied` …
//      一一对应 IR §3 与 v2 §3 的 op，只负责按**规范签名的字段顺序**造对象。
//   2. 糖 —— 链式方法（`.where()` / `.not()` / `.opposite()` / `.gte()` / `.negate()`）、
//      具名常量（`SELF` / `FRIENDLY_MINIONS` / `ENEMY_BASE`）、
//      事件助手（`Struck` / `CombatBegan`）、`Push` / `Pull` / `AddToHand` / `Any` / `All`。
//      **糖只存在于这一层**：产物里找不到它们的任何痕迹（IR §1 原则 1）。
//   3. 规范化 —— `defineCard` / `defineEnchantment` / `canonicalize*`：
//      单个→数组、缺省不写、键序固定。同一份源永远产出同一份 JSON。
//
// 验收：能用它写出 v2 §8 的六张示例卡与 IR §10 的六个例子，
// 序列化后与文档里手写的 JSON 逐字节一致（`__tests__/spec-cards.test.ts`）。

// ── 1. 节点构造器 + 糖 ──────────────────────────────────────────────────────
export type { ActLike } from "./act.ts";
export {
  AddToHand,
  Buff,
  Destroy,
  Discard,
  Discover,
  Draw,
  ForEach,
  GainArmor,
  GainCrystal,
  GainCrystalCap,
  Give,
  Heal,
  Hit,
  ModDirection,
  ModTag,
  Move,
  MoveTo,
  Nothing,
  Pull,
  Push,
  Repeat,
  SelectTarget,
  SetDirection,
  SetFlag,
  SetHealth,
  SetTag,
  Shift,
  Shuffle,
  Silence,
  Steal,
  Strike,
  Summon,
  Swap,
  Transform,
  toActs,
  when,
} from "./act.ts";
export type { AuraSpec } from "./aura.ts";
export { Aura, aura } from "./aura.ts";
// ── 2. 规范化 ───────────────────────────────────────────────────────────────
export {
  canonicalizeAct,
  canonicalizeActs,
  canonicalizeAura,
  canonicalizeCard,
  canonicalizeCardData,
  canonicalizeCardRef,
  canonicalizeCardScript,
  canonicalizeCond,
  canonicalizeEnchantment,
  canonicalizeIntercept,
  canonicalizeNum,
  canonicalizePool,
  canonicalizeSel,
  canonicalizeSlot,
  canonicalizeTrigger,
  canonicalJson,
} from "./canonical.ts";
export { CardOf, CardPool, RandomCard, toCardRef } from "./card-ref.ts";
export type { CondChain, FluentCond } from "./cond.ts";
export {
  All,
  And,
  Any,
  condNode,
  Eq,
  Exists,
  Gt,
  Gte,
  HasFlag,
  HasTag,
  HasTribe,
  InZone,
  IsDead,
  IsHero,
  IsKind,
  IsMinion,
  IsSpell,
  IsToken,
  Lt,
  Lte,
  Ne,
  Not,
  Occupied,
  Or,
} from "./cond.ts";
export {
  ALL_CHARACTERS,
  ALL_MINIONS,
  ALL_UNITS,
  ANY_CHARACTER,
  BOTH,
  ENEMY,
  ENEMY_BASE,
  ENEMY_DECK,
  ENEMY_GRAVEYARD,
  ENEMY_HAND,
  ENEMY_HEROES,
  ENEMY_MINIONS,
  ENEMY_UNITS,
  FRIENDLY,
  FRIENDLY_BASE,
  FRIENDLY_DECK,
  FRIENDLY_FOUNTAIN,
  FRIENDLY_GRAVEYARD,
  FRIENDLY_HAND,
  FRIENDLY_HEROES,
  FRIENDLY_MINIONS,
  FRIENDLY_UNITS,
} from "./constants.ts";
export type { CardSpec, EnchantmentSpec, TextLike } from "./define.ts";
export {
  DEFAULT_CARD_SET,
  DEFAULT_ENCHANTMENT_ATTACHES_TO,
  DEFAULT_ENCHANTMENT_DURATION,
  defineCard,
  defineEnchantment,
} from "./define.ts";
export { withChain } from "./fluent.ts";
export type { InterceptSpec } from "./intercept.ts";
export { Cancel, intercept, ModField, Retarget, SetField } from "./intercept.ts";
export { toArray } from "./list.ts";
export type { FluentNum, NumChain } from "./num.ts";
export {
  Add,
  Attr,
  Clamp,
  Count,
  CRYSTAL_CAP,
  CRYSTALS,
  Direction,
  Div,
  FATIGUE,
  Field,
  GlobalNum,
  Max,
  Min,
  Mul,
  Neg,
  NumIf,
  numNode,
  RandomInt,
  ROUND,
  SlotIndex,
  Sub,
  Sum,
} from "./num.ts";
export type { FluentSel, SelChain } from "./sel.ts";
export {
  Adjacent,
  AttackersOf,
  CHOSEN,
  COMBAT_TARGET,
  CONTROLLER,
  EVENT,
  Except,
  Intersect,
  IT,
  Limit,
  OPPONENT,
  OPPOSITE,
  Random,
  SELF,
  Sort,
  selNode,
  TARGET,
  Union,
  UnitsAt,
  Where,
  Zone,
} from "./sel.ts";
export type { FluentSlot, SlotChain } from "./slot.ts";
export {
  At,
  FirstEmptySlot,
  RandomEmptySlot,
  SlotOf,
  SlotOpposite,
  SlotShift,
  slotNode,
} from "./slot.ts";
export type { EventScope, EventSpec, TriggerSpec } from "./trigger.ts";
export {
  ActionTaken,
  Buffed,
  CardAddedToHand,
  CardDiscarded,
  CardDrawn,
  CardPlayed,
  CombatBegan,
  CombatEnded,
  CrystalGained,
  Damaged,
  DirectionChanged,
  EVENT_HELPERS,
  Healed,
  HeroDeployed,
  HeroDied,
  HeroPowerUsed,
  on,
  PlayerPassed,
  RoundBegan,
  RoundEnded,
  SecretRevealed,
  Silenced,
  Struck,
  Transformed,
  trigger,
  UnitDied,
  UnitMoved,
  UnitSummoned,
} from "./trigger.ts";
