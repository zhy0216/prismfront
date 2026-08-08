// 「字段 → 种类」表：L1 查它做结构校验，L2 查它做前缀校验。
//
// ★ 这张表**不是手抄的**，是被 T1 的权威类型钉住的（IR §12：TS 类型是唯一权威定义）。
// {@link ObjectSchema} 是一个映射类型，对每个节点类型 T 生成「T 的每个字段各需要一条规格」：
//   1. 漏字段        → 缺少属性，编译不过
//   2. 字段名写错     → 多余属性，编译不过
//   3. 可选性写反     → `?` 前缀由 T 的 `x?: T` 推出来，写反编译不过
//   4. 种类写错      → 该位置只允许「值类型可赋给该字段类型」的 token，
//                     例如 `act.hit.target: Sel` 只接受 `"sel"`，写 `"num"` 编译不过
//   5. **新增 op 忘了登记** → `satisfies OpSchemaTable<Act>` 报缺少属性，编译不过
// 于是「加新 op 必须同步更新校验表」这条纪律由编译器执行，不靠人记。

import type {
  Act,
  Aura,
  Bundle,
  Card,
  CardData,
  CardRefNode,
  CardScript,
  ChooseOneOption,
  CondNode,
  Enchantment,
  EnchantmentScript,
  Intercept,
  InterceptEffect,
  LocalizedText,
  NodeOp,
  NumNode,
  Sel,
  SlotRef,
  Trigger,
} from "../types/index.ts";
import type { FieldKind, FieldSpec, StructKind, TaggedKind, ValueOfKind } from "./kinds.ts";

// ── 由 T1 类型推导「字段 → 规格」的机器 ──────────────────────────────────────

/** 字段在 T1 里是否写成 `x?: T`。 */
type IsOptionalField<T, K extends keyof T> = undefined extends T[K] ? true : false;

/**
 * 值类型可赋给 `V` 的全部 token。
 *
 * 这就是「表从类型推出来」的那一步：候选集由 {@link ValueOfKind} 与字段的声明类型求交，
 * 类型对不上的 token 根本不在候选里。多个 token 同时成立时（如 `Num` 位置的 `"num"`/`"int"`）
 * 由作者挑更贴切的那个，正例卡与生成式测试兜底。
 */
type KindTokenFor<V> = { [S in FieldKind]: ValueOfKind<S> extends V ? S : never }[FieldKind];

type SpecForField<T, K extends keyof T> =
  IsOptionalField<T, K> extends true
    ? `?${KindTokenFor<Exclude<T[K], undefined>>}`
    : KindTokenFor<T[K]>;

/** 一个对象类型的完整字段表；`Skip` 用来排除判别字段（`op` / `kind`）。 */
export type ObjectSchema<T, Skip extends keyof T = never> = {
  readonly [K in Exclude<keyof T, Skip>]-?: SpecForField<T, K>;
};

/** 一族按 `op` 判别的节点的字段表。少写一个 op 编译不过。 */
type OpSchemaTable<Node extends { op: string }> = {
  readonly [K in Node["op"]]: ObjectSchema<Extract<Node, { op: K }>, "op">;
};

/** walker 眼里的字段表（丢掉具体键名，只剩 `string → FieldSpec`）。 */
export type RuntimeObjectSchema = Readonly<Record<string, FieldSpec>>;

// ── sel.*（IR §3.1 + v2 §3.2）───────────────────────────────────────────────

export const SEL_SCHEMAS = {
  "sel.self": {},
  "sel.target": {},
  "sel.controller": {},
  "sel.opponent": {},
  "sel.chosen": {},
  "sel.it": {},
  "sel.event": { field: "eventField" },
  "sel.entity": { id: "int" },
  "sel.zone": { side: "selSide", zone: "zoneOrZones" },
  "sel.and": { of: "sel[]" },
  "sel.or": { of: "sel[]" },
  "sel.minus": { of: "sel", exclude: "sel" },
  "sel.where": { of: "sel", cond: "cond" },
  "sel.random": { of: "sel", n: "?num", distinct: "?boolean" },
  "sel.limit": { of: "sel", n: "num", from: "?limitFrom" },
  "sel.sort": { of: "sel", by: "tagKey", dir: "?sortDir" },
  "sel.at": { slot: "slotOrSlots" },
  "sel.opposite": { of: "sel" },
  "sel.combat_target": { of: "sel" },
  "sel.attackers_of": { of: "sel" },
  "sel.adjacent": { of: "sel", dist: "?num" },
} as const satisfies OpSchemaTable<Sel>;

// ── slot.*（v2 §3.1）────────────────────────────────────────────────────────

export const SLOT_SCHEMAS = {
  "slot.at": { side: "slotSide", index: "num" },
  "slot.of": { of: "sel" },
  "slot.opposite": { of: "slot" },
  "slot.shift": { of: "slot", delta: "num" },
  "slot.random_empty": { side: "slotSide" },
  "slot.first_empty": { side: "slotSide", from: "?slotSearchFrom" },
} as const satisfies OpSchemaTable<SlotRef>;

// ── num.*（IR §3.2 + v2 §3.3）───────────────────────────────────────────────

export const NUM_SCHEMAS = {
  "num.count": { of: "sel" },
  "num.attr": { of: "sel", tag: "tagKey" },
  "num.sum": { of: "sel", tag: "tagKey" },
  "num.add": { of: "num[]" },
  "num.mul": { of: "num[]" },
  "num.max": { of: "num[]" },
  "num.min": { of: "num[]" },
  "num.sub": { l: "num", r: "num" },
  "num.div": { l: "num", r: "num" },
  "num.neg": { of: "num" },
  "num.clamp": { of: "num", lo: "num", hi: "num" },
  "num.if": { cond: "cond", then: "num", else: "num" },
  "num.random": { lo: "num", hi: "num" },
  "num.tag": { tag: "globalTag" },
  "num.field": { field: "actNumField" },
  "num.slot_index": { of: "sel" },
} as const satisfies OpSchemaTable<NumNode>;

// ── cond.*（IR §3.3 + v2 §3.3）──────────────────────────────────────────────

export const COND_SCHEMAS = {
  "cond.exists": { of: "sel", atLeast: "?num" },
  "cond.eq": { l: "num", r: "num" },
  "cond.ne": { l: "num", r: "num" },
  "cond.gt": { l: "num", r: "num" },
  "cond.gte": { l: "num", r: "num" },
  "cond.lt": { l: "num", r: "num" },
  "cond.lte": { l: "num", r: "num" },
  "cond.and": { of: "cond[]" },
  "cond.or": { of: "cond[]" },
  "cond.not": { of: "cond" },
  "cond.has_tag": { of: "sel", tag: "tagKey", value: "?num" },
  "cond.has_flag": { of: "sel", flag: "flag" },
  "cond.is_kind": { of: "sel", kind: "cardKindOrKinds" },
  "cond.has_color": { of: "sel", color: "colorOrColors" },
  "cond.has_tribe": { of: "sel", tribe: "tribe" },
  "cond.in_zone": { of: "sel", zone: "zone" },
  "cond.dead": { of: "sel" },
  "cond.occupied": { slot: "slot" },
} as const satisfies OpSchemaTable<CondNode>;

// ── card.*（IR §3.1 末尾表）─────────────────────────────────────────────────

export const CARD_SCHEMAS = {
  "card.of": { of: "sel" },
  "card.random": { from: "selOrPool" },
  "card.pool": { filter: "cond" },
} as const satisfies OpSchemaTable<CardRefNode>;

// ── act.*（IR §3.4 + v2 §3.4）───────────────────────────────────────────────
// 字段顺序 = 求值顺序（IR §5.4 规则 1），与 types/act.ts 的签名逐字对齐，不许重排。

export const ACT_SCHEMAS = {
  "act.hit": { target: "sel", amount: "num", spellDamage: "?boolean" },
  "act.heal": { target: "sel", amount: "num" },
  "act.set_health": { target: "sel", value: "num" },
  "act.gain_armor": { target: "sel", amount: "num" },
  "act.draw": { player: "sel", count: "?num" },
  "act.give": { player: "sel", card: "card", count: "?num" },
  "act.shuffle": { player: "sel", card: "card", count: "?num" },
  "act.discard": { target: "sel" },
  "act.move": { target: "sel", zone: "zone", side: "?moveSide", pos: "?num" },
  "act.steal": { target: "sel", to: "sel" },
  "act.summon": { player: "sel", card: "card", at: "slot", count: "?num" },
  "act.destroy": { target: "sel" },
  "act.transform": { target: "sel", card: "card" },
  "act.buff": { target: "sel", ench: "enchId" },
  "act.silence": { target: "sel" },
  "act.set_tag": { target: "sel", tag: "tagKey", value: "num" },
  "act.mod_tag": { target: "sel", tag: "tagKey", delta: "num" },
  // ⚠ set_flag 的 value 是 boolean 而不是 Num（types/act.ts 的提醒），种类由类型强制
  "act.set_flag": { target: "sel", flag: "flag", value: "boolean" },
  "act.move_to": { target: "sel", to: "slot" },
  "act.shift": { target: "sel", delta: "num" },
  "act.swap": { a: "sel", b: "sel" },
  "act.strike": { attacker: "sel", target: "sel" },
  "act.gain_crystal": { player: "sel", amount: "num" },
  "act.gain_crystal_cap": { player: "sel", amount: "num" },
  "act.when": { cond: "cond", then: "act[]", else: "?act[]" },
  "act.repeat": { n: "num", do: "act[]" },
  "act.for_each": { of: "sel", do: "act[]" },
  "act.discover": { from: "selOrPool", show: "?num", pick: "?num" },
  "act.select_target": { from: "sel", optional: "?boolean" },
  "act.nothing": {},
} as const satisfies OpSchemaTable<Act>;

/**
 * 六族合并后的节点表：walker 只认这一张。
 *
 * 注意这里刻意标注成 `Record<NodeOp, ...>` 而不是 `as const` ——
 * 与 `types/ops.ts` 的 `NODE_OP_SET` 同样的手法：合并后立刻回到「op 全集」这个契约上，
 * 少一族或多一族都会在这里报错。
 */
export const NODE_SCHEMAS: Readonly<Record<NodeOp, RuntimeObjectSchema>> = {
  ...SEL_SCHEMAS,
  ...SLOT_SCHEMAS,
  ...NUM_SCHEMAS,
  ...COND_SCHEMAS,
  ...CARD_SCHEMAS,
  ...ACT_SCHEMAS,
};

// ── 文档结构（IR §2 / §4）──────────────────────────────────────────────────

const TEXT_SCHEMA = { zh: "string", en: "?string" } as const satisfies ObjectSchema<LocalizedText>;

const CARD_DATA_SCHEMA = {
  name: "text",
  text: "?text",
  kind: "cardKind",
  cost: "?int",
  colors: "color[]",
  rarity: "?rarity",
  tribe: "?tribeOrNull",
  art: "?string",
  collectible: "?boolean",
  tags: "?tagMods",
} as const satisfies ObjectSchema<CardData>;

const CARD_SCRIPT_SCHEMA = {
  target: "?selOrNull",
  requires: "?condOrNull",
  play: "?act[]",
  deathrattle: "?act[]",
  triggers: "?trigger[]",
  intercepts: "?intercept[]",
  auras: "?aura[]",
  costMod: "?numOrNull",
  chooseOne: "?chooseOne[]",
} as const satisfies ObjectSchema<CardScript>;

const CHOOSE_ONE_SCHEMA = {
  id: "string",
  text: "text",
  target: "?sel",
  play: "act[]",
} as const satisfies ObjectSchema<ChooseOneOption>;

const CARD_SCHEMA = {
  id: "cardId",
  set: "string",
  data: "cardData",
  script: "cardScript",
} as const satisfies ObjectSchema<Card>;

const TRIGGER_SCHEMA = {
  on: "eventName",
  filter: "?triggerFilter",
  cond: "?cond",
  once: "?boolean",
  zone: "?zone",
  do: "act[]",
} as const satisfies ObjectSchema<Trigger>;

const INTERCEPT_SCHEMA = {
  intercept: "actOp",
  filter: "?interceptFilter",
  cond: "?cond",
  effect: "interceptEffect",
  then: "?act[]",
  priority: "?int",
} as const satisfies ObjectSchema<Intercept>;

const AURA_SCHEMA = {
  affects: "sel",
  mods: "?tagMods",
  flags: "?flag[]",
  cond: "?cond",
  zone: "?zone",
} as const satisfies ObjectSchema<Aura>;

const ENCHANTMENT_SCRIPT_SCHEMA = {
  triggers: "?trigger[]",
  auras: "?aura[]",
} as const satisfies ObjectSchema<EnchantmentScript>;

const ENCHANTMENT_SCHEMA = {
  id: "enchId",
  attachesTo: "cardKind",
  mods: "?tagMods",
  flags: "?flag[]",
  duration: "duration",
  script: "?enchantmentScript",
} as const satisfies ObjectSchema<Enchantment>;

const BUNDLE_SCHEMA = {
  irVersion: "irVersion",
  bundleId: "string",
  createdAt: "isoDate",
  opsUsed: "nodeOp[]",
  cards: "cardMap",
  enchantments: "enchantmentMap",
} as const satisfies ObjectSchema<Bundle>;

/** 固定字段集的文档结构表。少一个 struct token 编译不过。 */
export const STRUCT_SCHEMAS: Readonly<Record<StructKind, RuntimeObjectSchema>> = {
  bundle: BUNDLE_SCHEMA,
  cardDoc: CARD_SCHEMA,
  cardData: CARD_DATA_SCHEMA,
  cardScript: CARD_SCRIPT_SCHEMA,
  chooseOne: CHOOSE_ONE_SCHEMA,
  enchantment: ENCHANTMENT_SCHEMA,
  enchantmentScript: ENCHANTMENT_SCRIPT_SCHEMA,
  trigger: TRIGGER_SCHEMA,
  intercept: INTERCEPT_SCHEMA,
  aura: AURA_SCHEMA,
  text: TEXT_SCHEMA,
};

/** `InterceptEffect` 按 `kind` 判别（IR §4.2），少一个 kind 编译不过。 */
const INTERCEPT_EFFECT_SCHEMAS = {
  cancel: {},
  set_field: { field: "actNumField", value: "num" },
  mod_field: { field: "actNumField", delta: "num" },
  retarget: { to: "sel" },
} as const satisfies {
  readonly [K in InterceptEffect["kind"]]: ObjectSchema<
    Extract<InterceptEffect, { kind: K }>,
    "kind"
  >;
};

/** 按非 `op` 字段判别的小联合表。 */
export const TAGGED_SCHEMAS: Readonly<
  Record<TaggedKind, Readonly<Record<string, RuntimeObjectSchema>>>
> = {
  interceptEffect: INTERCEPT_EFFECT_SCHEMAS,
};

/** `act.*` 之外的顶层入口用得到：把一个 op 归到它的族前缀（IR 原则 2）。 */
export const familyPrefixOf = (op: string): string => {
  const dot = op.indexOf(".");
  return dot < 0 ? op : op.slice(0, dot + 1);
};
