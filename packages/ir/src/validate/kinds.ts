// L1/L2 校验器的「字段种类」词汇表 —— 一份表，两层校验都读它。
//
// 为什么不是 JSON Schema：`packages/ir` 是零运行时依赖的包（架构 §2.3），
// 不许引入 ajv / zod（包级 biome.json 的 noRestrictedImports 直接拦下 zod）。
// IR §11 的 `ir:schema`（用 ts-json-schema-generator 从 TS 类型生成 JSON Schema）
// 是后续工具链的事，不在 M1 范围内。所以这里手写一个**由 T1 的 TS 类型驱动**的小结构校验器。
//
// 这份文件定义的是「一个字段位置能接受什么」：
//   L1 结构 —— 值的形状（对象 / 数组 / 标量）、`op` 是否已知、枚举取值是否合法（IR §7）
//   L2 种类 —— 值的 `op` 是否属于该位置接受的族（IR §7：靠前缀，一次遍历，无需推导）
// 两层共用同一份 {@link KIND_SPECS}，因此不可能出现「L1 认得的字段 L2 不认得」这种漂移。
//
// {@link KindValueMap} 是 token → T1 类型 的映射。`schemas.ts` 用它把「字段 → 种类」表
// 反向钉在 T1 的权威类型上：种类写错、字段漏写、新增 op 没登记，三种情况都编译不过。

import type {
  Act,
  ActNumField,
  ActOp,
  Aura,
  Bundle,
  Card,
  CardData,
  CardId,
  CardKind,
  CardRef,
  CardScript,
  ChooseOneOption,
  Color,
  Cond,
  Duration,
  EnchantId,
  Enchantment,
  EnchantmentScript,
  EventEntityField,
  EventName,
  FlagName,
  GlobalTag,
  Intercept,
  InterceptEffect,
  InterceptFilter,
  IRVersion,
  LimitFrom,
  LocalizedText,
  MoveSide,
  NodeOp,
  Num,
  Pool,
  Rarity,
  Sel,
  SelSide,
  SlotRef,
  SlotSearchFrom,
  SlotSide,
  SortDir,
  TagKey,
  TribeName,
  Trigger,
  TriggerFilter,
  ZoneName,
} from "../types/index.ts";
import {
  ACT_ENTITY_FIELDS,
  ACT_NUM_FIELDS,
  ACT_OPS,
  CARD_KINDS,
  COLORS,
  COND_OPS,
  DURATIONS,
  EVENT_ENTITY_FIELDS,
  EVENT_NAMES,
  FLAG_NAMES,
  GLOBAL_TAGS,
  LIMIT_FROMS,
  MOVE_SIDES,
  NODE_OPS,
  NUM_OPS,
  RARITIES,
  SEL_OPS,
  SEL_SIDES,
  SLOT_OPS,
  SLOT_SEARCH_FROMS,
  SLOT_SIDES,
  SORT_DIRS,
  TAG_KEYS,
  TRIBE_NAMES,
  ZONE_NAMES,
} from "../types/index.ts";

/**
 * 种类 token → 它在 T1 权威类型里对应的类型。
 *
 * 这张接口就是 token 的定义处：{@link FieldKind} 是它的键集，
 * {@link KIND_SPECS} 必须为每个键给出运行时规格（`satisfies` 双向钉死）。
 *
 * 命名约定：
 * - `xxx[]` = 数组；`xxxOrYyy` = 形状互斥的联合（walker 靠形状选分支）
 * - 节点族 token（`sel`/`num`/`cond`/`slot`/`act`/`card`/`selOrPool`）是 L2 的全部依据
 * - `cardDoc` 是**卡牌文档**（`Card`），`card` 是 **CardRef 节点**，两者别混
 */
export interface KindValueMap {
  // ── 节点族（L2 的检查对象）───────────────────────────────────────────────
  sel: Sel;
  num: Num;
  cond: Cond;
  slot: SlotRef;
  act: Act;
  card: CardRef;
  /** `act.discover.from` / `card.random.from`：选择器**或**卡池，不接受 card.of / card.random。 */
  selOrPool: Sel | Pool;

  // ── 数组 ────────────────────────────────────────────────────────────────
  "sel[]": readonly Sel[];
  "num[]": readonly Num[];
  "cond[]": readonly Cond[];
  "act[]": readonly Act[];
  "slot[]": readonly SlotRef[];
  "zone[]": readonly ZoneName[];
  "cardKind[]": readonly CardKind[];
  "color[]": readonly Color[];
  "flag[]": readonly FlagName[];
  "nodeOp[]": readonly NodeOp[];
  "trigger[]": readonly Trigger[];
  "intercept[]": readonly Intercept[];
  "aura[]": readonly Aura[];
  "chooseOne[]": readonly ChooseOneOption[];

  // ── 形状互斥的联合 ───────────────────────────────────────────────────────
  slotOrSlots: SlotRef | readonly SlotRef[];
  zoneOrZones: ZoneName | readonly ZoneName[];
  cardKindOrKinds: CardKind | readonly CardKind[];
  /** `script.target`：IR §2.2「省略等价于空数组 / null」，所以 null 是合法写法。 */
  selOrNull: Sel | null;
  condOrNull: Cond | null;
  numOrNull: Num | null;
  tribeOrNull: TribeName | null;
  null: null;

  // ── 枚举 ────────────────────────────────────────────────────────────────
  zone: ZoneName;
  tagKey: TagKey;
  globalTag: GlobalTag;
  flag: FlagName;
  tribe: TribeName;
  cardKind: CardKind;
  color: Color;
  rarity: Rarity;
  selSide: SelSide;
  slotSide: SlotSide;
  moveSide: MoveSide;
  sortDir: SortDir;
  limitFrom: LimitFrom;
  slotSearchFrom: SlotSearchFrom;
  eventName: EventName;
  eventField: EventEntityField;
  actNumField: ActNumField;
  actOp: ActOp;
  duration: Duration;
  nodeOp: NodeOp;

  // ── 标量 ────────────────────────────────────────────────────────────────
  int: number;
  string: string;
  boolean: boolean;
  cardId: CardId;
  enchId: EnchantId;
  irVersion: IRVersion;
  isoDate: string;

  // ── 文档结构（IR §2）─────────────────────────────────────────────────────
  bundle: Bundle;
  cardDoc: Card;
  cardData: CardData;
  cardScript: CardScript;
  chooseOne: ChooseOneOption;
  enchantment: Enchantment;
  enchantmentScript: EnchantmentScript;
  trigger: Trigger;
  intercept: Intercept;
  aura: Aura;
  text: LocalizedText;
  /** 按 `kind` 判别的小联合（IR §4.2），不是按 `op`，所以单独一种 form。 */
  interceptEffect: InterceptEffect;

  // ── 键值表 ──────────────────────────────────────────────────────────────
  tagMods: Partial<Record<TagKey, number>>;
  triggerFilter: TriggerFilter;
  interceptFilter: InterceptFilter;
  cardMap: Readonly<Record<CardId, Card>>;
  enchantmentMap: Readonly<Record<EnchantId, Enchantment>>;
}

/** 字段种类 token 全集。 */
export type FieldKind = keyof KindValueMap;

/** token 对应的 T1 类型。 */
export type ValueOfKind<K extends FieldKind> = KindValueMap[K];

/**
 * 一个字段位置的规格：`"num"` = 必填，`"?num"` = 可选（对应 T1 类型里的 `x?: T`）。
 * `?` 前缀的有无由 `schemas.ts` 的映射类型强制与 T1 的可选性一致，写反了编译不过。
 */
export type FieldSpec = FieldKind | `?${FieldKind}`;

/** 节点位置可接受的字面量（IR 原则 4：常见字面量不包装）。 */
export type NodeLiteral = "number" | "boolean" | "string";

/** 带 `op` 的节点位置。`ops` 就是 L2 的判据。 */
export interface NodeKindSpec {
  readonly form: "node";
  readonly ops: readonly NodeOp[];
  /** 允许的字面量形式，无则该位置必须是节点对象。 */
  readonly literal?: NodeLiteral;
  readonly describe: string;
}

export interface ListKindSpec {
  readonly form: "list";
  readonly of: FieldKind;
  readonly describe: string;
}

/** 形状互斥的联合：walker 按值的形状（null / 数组 / 对象 / 标量）唯一选出成员。 */
export interface UnionKindSpec {
  readonly form: "union";
  readonly of: readonly FieldKind[];
  readonly describe: string;
}

export interface EnumKindSpec {
  readonly form: "enum";
  readonly values: readonly string[];
  readonly describe: string;
}

export interface ScalarKindSpec {
  readonly form: "scalar";
  readonly type: "int" | "string" | "boolean";
  /** 字符串的附加形状约束（irVersion 的三段式、createdAt 的 ISO 8601）。 */
  readonly pattern?: RegExp;
  readonly describe: string;
}

/** 固定字段集的对象，schema 在 `schemas.ts` 的 `STRUCT_SCHEMAS` 里。 */
export interface StructKindSpec {
  readonly form: "struct";
  readonly describe: string;
}

/** 按非 `op` 字段判别的小联合（目前只有 `InterceptEffect` 的 `kind`）。 */
export interface TaggedKindSpec {
  readonly form: "tagged";
  readonly tag: string;
  readonly describe: string;
}

export interface MapKindSpec {
  readonly form: "map";
  /** 允许的键；`null` = 任意字符串键（bundle 的 cards / enchantments）。 */
  readonly keys: readonly string[] | null;
  readonly value: FieldKind;
  /** 值对象里必须与键相等的字段（`cards` 以 id 为键，IR §2.1）。 */
  readonly keyField?: string;
  /**
   * 子路径改用这个绝对前缀，而不是接在父路径后面。
   * 于是错误路径是 `card.GRID_001.script.play[0].target` 而不是
   * `bundle.cards.GRID_001.…` —— 前者更短、更好 grep，也是 M11 `ir:validate` 的约定格式。
   */
  readonly pathPrefix?: string;
  readonly describe: string;
}

export interface NullKindSpec {
  readonly form: "null";
  readonly describe: string;
}

export type KindSpec =
  | NodeKindSpec
  | ListKindSpec
  | UnionKindSpec
  | EnumKindSpec
  | ScalarKindSpec
  | StructKindSpec
  | TaggedKindSpec
  | MapKindSpec
  | NullKindSpec;

/** 枚举规格的小工厂：取值少就直接列出来，多了只报名字与数量，免得错误信息糊满屏。 */
const enumOf = (name: string, values: readonly string[]): EnumKindSpec => ({
  form: "enum",
  values,
  describe:
    values.length <= 8
      ? `${name}（${values.join(" | ")}）`
      : `${name}（${values.length} 个取值之一）`,
});

const listOf = (of: FieldKind, describe: string): ListKindSpec => ({ form: "list", of, describe });

/** IR §9：`IRVersion` 是 semver 三段式。 */
const IR_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** IR §2.1：`createdAt` 是 ISO 8601 时间戳。 */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * 每个 token 的运行时规格。
 *
 * `satisfies Record<FieldKind, KindSpec>` 把它和 {@link KindValueMap} 双向钉死：
 * 少一个 token 编译不过，多一个 token 也编译不过。
 */
export const KIND_SPECS = {
  // ── 节点族。ops 即 L2 的「这个位置接受哪些前缀」──────────────────────────
  sel: { form: "node", ops: SEL_OPS, describe: "sel.*（选择器）" },
  num: { form: "node", ops: NUM_OPS, literal: "number", describe: "number 字面量或 num.*" },
  cond: { form: "node", ops: COND_OPS, literal: "boolean", describe: "boolean 字面量或 cond.*" },
  slot: { form: "node", ops: SLOT_OPS, describe: "slot.*（位置引用）" },
  act: { form: "node", ops: ACT_OPS, describe: "act.*（动作）" },
  card: {
    form: "node",
    ops: ["card.of", "card.random"],
    literal: "string",
    describe: "卡牌 id 字面量、card.of 或 card.random",
  },
  selOrPool: {
    form: "node",
    ops: [...SEL_OPS, "card.pool"],
    describe: "sel.* 或 card.pool",
  },

  // ── 数组 ────────────────────────────────────────────────────────────────
  "sel[]": listOf("sel", "sel.* 的数组"),
  "num[]": listOf("num", "number / num.* 的数组"),
  "cond[]": listOf("cond", "boolean / cond.* 的数组"),
  "act[]": listOf("act", "act.* 的数组（IR §3.4：数组本身就是序列，没有 act.seq）"),
  "slot[]": listOf("slot", "slot.* 的数组"),
  "zone[]": listOf("zone", "ZoneName 的数组"),
  "cardKind[]": listOf("cardKind", "CardKind 的数组"),
  "color[]": listOf("color", "Color 的数组（长度 1-2，v2.1 §11.4）"),
  "flag[]": listOf("flag", "FlagName 的数组"),
  "nodeOp[]": listOf("nodeOp", "IR op 的数组"),
  "trigger[]": listOf("trigger", "Trigger 的数组"),
  "intercept[]": listOf("intercept", "Intercept 的数组"),
  "aura[]": listOf("aura", "Aura 的数组"),
  "chooseOne[]": listOf("chooseOne", "ChooseOneOption 的数组"),

  // ── 形状互斥的联合 ───────────────────────────────────────────────────────
  slotOrSlots: { form: "union", of: ["slot[]", "slot"], describe: "slot.* 或其数组" },
  zoneOrZones: { form: "union", of: ["zone[]", "zone"], describe: "ZoneName 或其数组" },
  cardKindOrKinds: { form: "union", of: ["cardKind[]", "cardKind"], describe: "CardKind 或其数组" },
  selOrNull: { form: "union", of: ["null", "sel"], describe: "sel.* 或 null" },
  condOrNull: { form: "union", of: ["null", "cond"], describe: "boolean / cond.* 或 null" },
  numOrNull: { form: "union", of: ["null", "num"], describe: "number / num.* 或 null" },
  tribeOrNull: { form: "union", of: ["null", "tribe"], describe: "TribeName 或 null" },
  null: { form: "null", describe: "null" },

  // ── 枚举 ────────────────────────────────────────────────────────────────
  zone: enumOf("ZoneName", ZONE_NAMES),
  tagKey: enumOf("TagKey", TAG_KEYS),
  globalTag: enumOf("GlobalTag", GLOBAL_TAGS),
  flag: enumOf("FlagName", FLAG_NAMES),
  tribe: enumOf("TribeName", TRIBE_NAMES),
  cardKind: enumOf("CardKind", CARD_KINDS),
  color: enumOf("Color", COLORS),
  rarity: enumOf("Rarity", RARITIES),
  selSide: enumOf("SelSide", SEL_SIDES),
  slotSide: enumOf("SlotSide", SLOT_SIDES),
  moveSide: enumOf("MoveSide", MOVE_SIDES),
  sortDir: enumOf("SortDir", SORT_DIRS),
  limitFrom: enumOf("LimitFrom", LIMIT_FROMS),
  slotSearchFrom: enumOf("SlotSearchFrom", SLOT_SEARCH_FROMS),
  eventName: enumOf("EventName", EVENT_NAMES),
  eventField: enumOf("EventEntityField", EVENT_ENTITY_FIELDS),
  actNumField: enumOf("ActNumField", ACT_NUM_FIELDS),
  actOp: enumOf("ActOp", ACT_OPS),
  duration: enumOf("Duration", DURATIONS),
  nodeOp: enumOf("NodeOp", NODE_OPS),

  // ── 标量 ────────────────────────────────────────────────────────────────
  int: { form: "scalar", type: "int", describe: "整数" },
  string: { form: "scalar", type: "string", describe: "非空字符串" },
  boolean: { form: "scalar", type: "boolean", describe: "boolean 字面量" },
  cardId: { form: "scalar", type: "string", describe: "CardId（非空字符串）" },
  enchId: { form: "scalar", type: "string", describe: "EnchantId（非空字符串）" },
  irVersion: {
    form: "scalar",
    type: "string",
    pattern: IR_VERSION_PATTERN,
    describe: "IRVersion（semver 三段式，如 2.1.0）",
  },
  isoDate: {
    form: "scalar",
    type: "string",
    pattern: ISO_DATE_PATTERN,
    describe: "ISO 8601 时间戳",
  },

  // ── 文档结构 ────────────────────────────────────────────────────────────
  bundle: { form: "struct", describe: "Bundle（IR §2.1）" },
  cardDoc: { form: "struct", describe: "Card（IR §2.2）" },
  cardData: { form: "struct", describe: "CardData" },
  cardScript: { form: "struct", describe: "CardScript" },
  chooseOne: { form: "struct", describe: "ChooseOneOption" },
  enchantment: { form: "struct", describe: "Enchantment（IR §2.3）" },
  enchantmentScript: { form: "struct", describe: "EnchantmentScript" },
  trigger: { form: "struct", describe: "Trigger（IR §4.1）" },
  intercept: { form: "struct", describe: "Intercept（IR §4.2）" },
  aura: { form: "struct", describe: "Aura（IR §4.3）" },
  text: { form: "struct", describe: "LocalizedText（至少有 zh）" },
  interceptEffect: { form: "tagged", tag: "kind", describe: "InterceptEffect（按 kind 判别）" },

  // ── 键值表 ──────────────────────────────────────────────────────────────
  tagMods: {
    form: "map",
    keys: TAG_KEYS,
    value: "int",
    describe: "属性加成表（键为 TagKey，值为整数）",
  },
  triggerFilter: {
    form: "map",
    keys: EVENT_ENTITY_FIELDS,
    value: "sel",
    describe: "事件过滤器（键为事件负载的实体字段，值为 sel.*）",
  },
  interceptFilter: {
    form: "map",
    keys: ACT_ENTITY_FIELDS,
    value: "sel",
    describe: "动作过滤器（键为动作的实体字段，值为 sel.*）",
  },
  cardMap: {
    form: "map",
    keys: null,
    value: "cardDoc",
    keyField: "id",
    pathPrefix: "card",
    describe: "以 CardId 为键的卡牌表",
  },
  enchantmentMap: {
    form: "map",
    keys: null,
    value: "enchantment",
    keyField: "id",
    pathPrefix: "enchantment",
    describe: "以 EnchantId 为键的附魔表",
  },
} as const satisfies Record<FieldKind, KindSpec>;

/** form 为 `"struct"` 的 token —— `STRUCT_SCHEMAS` 必须逐个给出字段表。 */
export type StructKind = {
  [K in FieldKind]: (typeof KIND_SPECS)[K] extends StructKindSpec ? K : never;
}[FieldKind];

/** form 为 `"tagged"` 的 token —— `TAGGED_SCHEMAS` 必须逐个给出变体表。 */
export type TaggedKind = {
  [K in FieldKind]: (typeof KIND_SPECS)[K] extends TaggedKindSpec ? K : never;
}[FieldKind];

/**
 * 取某个 token 的规格。
 *
 * 为什么不直接 `KIND_SPECS[kind]`：`as const` 保留了每条的字面量类型（`StructKind` /
 * `TaggedKind` 的推导要靠它），但那样索引出来的联合里，**省略了的可选字段根本不存在**，
 * walker 读 `spec.literal` / `spec.keyField` 会编译不过。这里统一放宽回 {@link KindSpec}。
 */
export const specOf = (kind: FieldKind): KindSpec => KIND_SPECS[kind];

/** 拆掉 `?` 前缀，得到 token 本身。 */
export const kindOfSpec = (spec: FieldSpec): FieldKind =>
  (spec.startsWith("?") ? spec.slice(1) : spec) as FieldKind;

/** 该字段是否可选（`?` 前缀）。 */
export const isOptionalSpec = (spec: FieldSpec): boolean => spec.startsWith("?");
