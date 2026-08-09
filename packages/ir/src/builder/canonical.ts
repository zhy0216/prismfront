// 规范形式（canonical form）—— IR §1 原则 1 的落地。
//
// > **IR 是规范形式，糖只存在于编写层。** TS 里 `play: Hit(TARGET, 6)` 和
// > `play: [Hit(TARGET, 6)]` 都合法，编译产出永远是数组。IR 里不存在"两种写法等价"
// > 这种事，否则 diff、缓存 key、哈希全部会出问题。
//
// 所以本文件定义"同一份逻辑只有一种 JSON"的四条规则：
//
// 1. **单个 → 数组**：`play` / `then` / `else` / `do` / `deathrattle` / `triggers` /
//    `auras` / `intercepts` 一律是数组（由 `toArray` 在 builder 入口完成，这里兜底）。
// 2. **键序固定**：每个节点的键序 = 规范签名的**字段声明顺序**，`op` 永远第一。
//    这不只是好看：IR §5.4 规则 1 规定"字段声明顺序即求值顺序"，
//    而求值顺序决定 RNG 推进次序 —— 键序就是可审计的求值顺序。
//    自由映射（`mods` / `tags` / `filter` / `flags` / `colors` / `zone` 数组）
//    按各自词汇表的**声明顺序**排，不按字母序，理由同上。
// 3. **缺省不写**：可选字段缺省、`null`、空数组、空对象一律不出现在产物里。
//    两个例外都有出处：`act.summon.at`（v2 §3.4 规范形式必填）、
//    `act.discover.show/pick`（IR §10.5 的规范 JSON 显式写了 3 / 1）；
//    另有两个默认值被显式化：`trigger.zone` 与 `aura.zone` 补 `"board"`
//    （IR §10.2 / §10.3 / v2 §8.2 的规范 JSON 都带着它）。
//    ⚠ IR §2.2 那个"写全所有字段"的示例是**说明性**的，与 §10 的六个例子相冲，
//    这里取 §10 的写法（也是 v2 §8 的写法）。
// 4. **单元素集合退化为标量**：`zone: ["board"]` → `zone: "board"`，
//    `kind: ["spell"]` → `kind: "spell"`，`slot: [x]` → `slot: x`。
//
// 这些函数同时是**比对器**：把规范文档里手写的 JSON 喂进来，两边过同一套规则，
// 再比 `JSON.stringify` 就是逐字节比对（见 `__tests__/spec-cards.test.ts`）。
//
// 它们只重排与裁剪，**不校验、不求值**（L1/L2 是校验器的事，求值是 M4 的事）。

import type {
  Act,
  ActEntityField,
  Aura,
  Card,
  CardData,
  CardKind,
  CardRef,
  CardScript,
  ChooseOneOption,
  Color,
  Cond,
  Enchantment,
  EnchantmentScript,
  EventEntityField,
  FlagName,
  Intercept,
  InterceptEffect,
  InterceptFilter,
  LocalizedText,
  Num,
  Pool,
  Sel,
  SlotRef,
  TagKey,
  Trigger,
  TriggerFilter,
  ZoneName,
} from "../types/index.ts";
import {
  ACT_ENTITY_FIELDS,
  CARD_KINDS,
  COLORS,
  EVENT_ENTITY_FIELDS,
  FLAG_NAMES,
  TAG_KEYS,
  ZONE_NAMES,
} from "../types/index.ts";
import { toArray } from "./list.ts";

/** 联合类型没穷尽时的兜底。类型正确的调用永远到不了这里。 */
function unreachable(value: never): never {
  throw new TypeError(`未知的 IR 节点：${JSON.stringify(value)}`);
}

function isSet<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/** 按词汇表声明顺序取交集并去重 —— 用于 `zone` / `kind` / `flags` / `colors` 这类枚举集合。 */
function orderedSubset<T extends string>(vocabulary: readonly T[], values: readonly T[]): T[] {
  return vocabulary.filter((item) => values.includes(item));
}

/** 单元素集合退化为标量（规则 4）。 */
function collapse<T>(values: readonly T[]): T | readonly T[] {
  const [only] = values;
  return values.length === 1 && only !== undefined ? only : values;
}

// ── 叶子与自由映射 ──────────────────────────────────────────────────────────

function canonicalizeZones(zone: ZoneName | readonly ZoneName[]): ZoneName | readonly ZoneName[] {
  if (typeof zone === "string") {
    return zone;
  }
  return collapse(orderedSubset(ZONE_NAMES, zone));
}

function canonicalizeKinds(kind: CardKind | readonly CardKind[]): CardKind | readonly CardKind[] {
  if (typeof kind === "string") {
    return kind;
  }
  return collapse(orderedSubset(CARD_KINDS, kind));
}

function canonicalizeSlots(slot: SlotRef | readonly SlotRef[]): SlotRef | readonly SlotRef[] {
  if (Array.isArray(slot)) {
    return collapse((slot as readonly SlotRef[]).map(canonicalizeSlot));
  }
  return canonicalizeSlot(slot as SlotRef);
}

/** `mods` / `tags`：按 `TAG_KEYS` 的声明顺序排，丢掉未设置的键。 */
function canonicalizeTagMap(map: Partial<Record<TagKey, number>>): Partial<Record<TagKey, number>> {
  const out: Partial<Record<TagKey, number>> = {};
  for (const key of TAG_KEYS) {
    const value = map[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function canonicalizeFlags(flags: readonly FlagName[]): readonly FlagName[] {
  return orderedSubset(FLAG_NAMES, flags);
}

function canonicalizeColors(colors: readonly Color[]): readonly Color[] {
  return orderedSubset(COLORS, colors);
}

/**
 * `cond.has_color.color`：与 `canonicalizeKinds` 同款处理（决策 #9 要求签名对齐 `is_kind`）。
 *
 * 与上面的 {@link canonicalizeColors} 分开写不是重复：`data.colors` 是**卡面字段**，
 * 规范形式里永远是数组（v2.1 §11.4 定的就是 `Color[]`，融合卡靠长度 2 表达）；
 * 这里是**节点参数位**，适用规则 4「单元素集合退化为标量」。
 */
function canonicalizeColorArg(color: Color | readonly Color[]): Color | readonly Color[] {
  if (typeof color === "string") {
    return color;
  }
  return collapse(orderedSubset(COLORS, color));
}

/** `trigger.filter`：按 `EVENT_ENTITY_FIELDS`（source, target, player）排。 */
function canonicalizeTriggerFilter(filter: TriggerFilter): TriggerFilter {
  const out: TriggerFilter = {};
  for (const key of EVENT_ENTITY_FIELDS satisfies readonly EventEntityField[]) {
    const value = filter[key];
    if (value !== undefined) {
      out[key] = canonicalizeSel(value);
    }
  }
  return out;
}

/** `intercept.filter`：按 `ACT_ENTITY_FIELDS`（target, player, attacker, a, b, to）排。 */
function canonicalizeInterceptFilter(filter: InterceptFilter): InterceptFilter {
  const out: InterceptFilter = {};
  for (const key of ACT_ENTITY_FIELDS satisfies readonly ActEntityField[]) {
    const value = filter[key];
    if (value !== undefined) {
      out[key] = canonicalizeSel(value);
    }
  }
  return out;
}

function canonicalizeText(text: LocalizedText): LocalizedText {
  const out: LocalizedText = { zh: text.zh };
  if (text.en !== undefined) {
    out.en = text.en;
  }
  return out;
}

function isEmpty(record: object): boolean {
  return Object.keys(record).length === 0;
}

// ── sel.* ───────────────────────────────────────────────────────────────────

/** 规范化一个选择器节点（含链式糖产生的节点）。 */
export function canonicalizeSel(node: Sel): Sel {
  switch (node.op) {
    case "sel.self":
    case "sel.target":
    case "sel.controller":
    case "sel.opponent":
    case "sel.chosen":
    case "sel.it":
      return { op: node.op };
    case "sel.event":
      return { op: node.op, field: node.field };
    case "sel.entity":
      return { op: node.op, id: node.id };
    case "sel.zone":
      return { op: node.op, side: node.side, zone: canonicalizeZones(node.zone) };
    case "sel.and":
    case "sel.or":
      return { op: node.op, of: node.of.map(canonicalizeSel) };
    case "sel.minus":
      return {
        op: node.op,
        of: canonicalizeSel(node.of),
        exclude: canonicalizeSel(node.exclude),
      };
    case "sel.where":
      return { op: node.op, of: canonicalizeSel(node.of), cond: canonicalizeCond(node.cond) };
    case "sel.random": {
      const out: Extract<Sel, { op: "sel.random" }> = {
        op: node.op,
        of: canonicalizeSel(node.of),
      };
      if (node.n !== undefined) {
        out.n = canonicalizeNum(node.n);
      }
      if (node.distinct !== undefined) {
        out.distinct = node.distinct;
      }
      return out;
    }
    case "sel.limit": {
      const out: Extract<Sel, { op: "sel.limit" }> = {
        op: node.op,
        of: canonicalizeSel(node.of),
        n: canonicalizeNum(node.n),
      };
      if (node.from !== undefined) {
        out.from = node.from;
      }
      return out;
    }
    case "sel.sort": {
      const out: Extract<Sel, { op: "sel.sort" }> = {
        op: node.op,
        of: canonicalizeSel(node.of),
        by: node.by,
      };
      if (node.dir !== undefined) {
        out.dir = node.dir;
      }
      return out;
    }
    case "sel.at":
      return { op: node.op, slot: canonicalizeSlots(node.slot) };
    case "sel.opposite":
    case "sel.combat_target":
    case "sel.attackers_of":
      return { op: node.op, of: canonicalizeSel(node.of) };
    case "sel.adjacent": {
      const out: Extract<Sel, { op: "sel.adjacent" }> = {
        op: node.op,
        of: canonicalizeSel(node.of),
      };
      if (node.dist !== undefined) {
        out.dist = canonicalizeNum(node.dist);
      }
      return out;
    }
    default:
      return unreachable(node);
  }
}

// ── slot.* ──────────────────────────────────────────────────────────────────

/** 规范化一个位置引用节点。 */
export function canonicalizeSlot(node: SlotRef): SlotRef {
  switch (node.op) {
    case "slot.at":
      return { op: node.op, side: node.side, index: canonicalizeNum(node.index) };
    case "slot.of":
      return { op: node.op, of: canonicalizeSel(node.of) };
    case "slot.opposite":
      return { op: node.op, of: canonicalizeSlot(node.of) };
    case "slot.shift":
      return { op: node.op, of: canonicalizeSlot(node.of), delta: canonicalizeNum(node.delta) };
    case "slot.random_empty":
      return { op: node.op, side: node.side };
    case "slot.first_empty": {
      const out: Extract<SlotRef, { op: "slot.first_empty" }> = { op: node.op, side: node.side };
      if (node.from !== undefined) {
        out.from = node.from;
      }
      return out;
    }
    default:
      return unreachable(node);
  }
}

// ── num.* ───────────────────────────────────────────────────────────────────

/** 规范化一个数值（字面数字原样返回 —— IR §1 原则 4，字面量不包装）。 */
export function canonicalizeNum(node: Num): Num {
  if (typeof node === "number") {
    return node;
  }
  switch (node.op) {
    case "num.count":
      return { op: node.op, of: canonicalizeSel(node.of) };
    case "num.attr":
    case "num.sum":
      return { op: node.op, of: canonicalizeSel(node.of), tag: node.tag };
    case "num.add":
    case "num.mul":
    case "num.max":
    case "num.min":
      return { op: node.op, of: node.of.map(canonicalizeNum) };
    case "num.sub":
    case "num.div":
      return { op: node.op, l: canonicalizeNum(node.l), r: canonicalizeNum(node.r) };
    case "num.neg":
      return { op: node.op, of: canonicalizeNum(node.of) };
    case "num.clamp":
      return {
        op: node.op,
        of: canonicalizeNum(node.of),
        lo: canonicalizeNum(node.lo),
        hi: canonicalizeNum(node.hi),
      };
    case "num.if":
      return {
        op: node.op,
        cond: canonicalizeCond(node.cond),
        then: canonicalizeNum(node.then),
        else: canonicalizeNum(node.else),
      };
    case "num.random":
      return { op: node.op, lo: canonicalizeNum(node.lo), hi: canonicalizeNum(node.hi) };
    case "num.tag":
      return { op: node.op, tag: node.tag };
    case "num.field":
      return { op: node.op, field: node.field };
    case "num.slot_index":
      return { op: node.op, of: canonicalizeSel(node.of) };
    default:
      return unreachable(node);
  }
}

// ── cond.* ──────────────────────────────────────────────────────────────────

/** 规范化一个条件（字面布尔原样返回 —— IR §1 原则 4）。 */
export function canonicalizeCond(node: Cond): Cond {
  if (typeof node === "boolean") {
    return node;
  }
  switch (node.op) {
    case "cond.exists": {
      const out: Extract<Cond, { op: "cond.exists" }> = {
        op: node.op,
        of: canonicalizeSel(node.of),
      };
      if (node.atLeast !== undefined) {
        out.atLeast = canonicalizeNum(node.atLeast);
      }
      return out;
    }
    case "cond.eq":
    case "cond.ne":
    case "cond.gt":
    case "cond.gte":
    case "cond.lt":
    case "cond.lte":
      return { op: node.op, l: canonicalizeNum(node.l), r: canonicalizeNum(node.r) };
    case "cond.and":
    case "cond.or":
      return { op: node.op, of: node.of.map(canonicalizeCond) };
    case "cond.not":
      return { op: node.op, of: canonicalizeCond(node.of) };
    case "cond.has_tag": {
      const out: Extract<Cond, { op: "cond.has_tag" }> = {
        op: node.op,
        of: canonicalizeSel(node.of),
        tag: node.tag,
      };
      if (node.value !== undefined) {
        out.value = canonicalizeNum(node.value);
      }
      return out;
    }
    case "cond.has_flag":
      return { op: node.op, of: canonicalizeSel(node.of), flag: node.flag };
    case "cond.is_kind":
      return { op: node.op, of: canonicalizeSel(node.of), kind: canonicalizeKinds(node.kind) };
    case "cond.has_color":
      return { op: node.op, of: canonicalizeSel(node.of), color: canonicalizeColorArg(node.color) };
    case "cond.has_tribe":
      return { op: node.op, of: canonicalizeSel(node.of), tribe: node.tribe };
    case "cond.in_zone":
      return { op: node.op, of: canonicalizeSel(node.of), zone: node.zone };
    case "cond.dead":
      return { op: node.op, of: canonicalizeSel(node.of) };
    case "cond.occupied":
      return { op: node.op, slot: canonicalizeSlot(node.slot) };
    default:
      return unreachable(node);
  }
}

// ── card.* ──────────────────────────────────────────────────────────────────

/** 规范化卡池节点。 */
export function canonicalizePool(pool: Pool): Pool {
  return { op: pool.op, filter: canonicalizeCond(pool.filter) };
}

/** 规范化卡牌引用（字面 cardId 原样返回）。 */
export function canonicalizeCardRef(ref: CardRef): CardRef {
  if (typeof ref === "string") {
    return ref;
  }
  switch (ref.op) {
    case "card.of":
      return { op: ref.op, of: canonicalizeSel(ref.of) };
    case "card.random":
      return { op: ref.op, from: canonicalizeSelOrPool(ref.from) };
    default:
      return unreachable(ref);
  }
}

function canonicalizeSelOrPool(from: Sel | Pool): Sel | Pool {
  return from.op === "card.pool" ? canonicalizePool(from) : canonicalizeSel(from);
}

// ── act.* ───────────────────────────────────────────────────────────────────

/** 规范化一串动作。单个动作也收 —— 这就是 `play: Hit(...)` ≡ `play: [Hit(...)]` 的那一步。 */
export function canonicalizeActs(acts: Act | readonly Act[] | undefined): readonly Act[] {
  return toArray(acts).map(canonicalizeAct);
}

/** 规范化一个动作节点。 */
export function canonicalizeAct(node: Act): Act {
  switch (node.op) {
    case "act.hit": {
      const out: Extract<Act, { op: "act.hit" }> = {
        op: node.op,
        target: canonicalizeSel(node.target),
        amount: canonicalizeNum(node.amount),
      };
      if (node.spellDamage !== undefined) {
        out.spellDamage = node.spellDamage;
      }
      return out;
    }
    case "act.heal":
    case "act.gain_armor":
      return {
        op: node.op,
        target: canonicalizeSel(node.target),
        amount: canonicalizeNum(node.amount),
      };
    case "act.set_health":
      return {
        op: node.op,
        target: canonicalizeSel(node.target),
        value: canonicalizeNum(node.value),
      };
    case "act.draw": {
      const out: Extract<Act, { op: "act.draw" }> = {
        op: node.op,
        player: canonicalizeSel(node.player),
      };
      if (node.count !== undefined) {
        out.count = canonicalizeNum(node.count);
      }
      return out;
    }
    case "act.give":
    case "act.shuffle": {
      const out: Extract<Act, { op: "act.give" | "act.shuffle" }> = {
        op: node.op,
        player: canonicalizeSel(node.player),
        card: canonicalizeCardRef(node.card),
      };
      if (node.count !== undefined) {
        out.count = canonicalizeNum(node.count);
      }
      return out;
    }
    case "act.discard":
    case "act.destroy":
    case "act.silence":
      return { op: node.op, target: canonicalizeSel(node.target) };
    case "act.move": {
      const out: Extract<Act, { op: "act.move" }> = {
        op: node.op,
        target: canonicalizeSel(node.target),
        zone: node.zone,
      };
      if (node.side !== undefined) {
        out.side = node.side;
      }
      if (node.pos !== undefined) {
        out.pos = canonicalizeNum(node.pos);
      }
      return out;
    }
    case "act.steal":
      return {
        op: node.op,
        target: canonicalizeSel(node.target),
        to: canonicalizeSel(node.to),
      };
    case "act.summon": {
      const out: Extract<Act, { op: "act.summon" }> = {
        op: node.op,
        player: canonicalizeSel(node.player),
        card: canonicalizeCardRef(node.card),
        at: canonicalizeSlot(node.at),
      };
      if (node.count !== undefined) {
        out.count = canonicalizeNum(node.count);
      }
      return out;
    }
    case "act.transform":
      return {
        op: node.op,
        target: canonicalizeSel(node.target),
        card: canonicalizeCardRef(node.card),
      };
    case "act.buff":
      return { op: node.op, target: canonicalizeSel(node.target), ench: node.ench };
    case "act.set_tag":
      return {
        op: node.op,
        target: canonicalizeSel(node.target),
        tag: node.tag,
        value: canonicalizeNum(node.value),
      };
    case "act.mod_tag":
      return {
        op: node.op,
        target: canonicalizeSel(node.target),
        tag: node.tag,
        delta: canonicalizeNum(node.delta),
      };
    case "act.set_flag":
      return {
        op: node.op,
        target: canonicalizeSel(node.target),
        flag: node.flag,
        value: node.value,
      };
    case "act.move_to":
      return {
        op: node.op,
        target: canonicalizeSel(node.target),
        to: canonicalizeSlot(node.to),
      };
    case "act.shift":
      return {
        op: node.op,
        target: canonicalizeSel(node.target),
        delta: canonicalizeNum(node.delta),
      };
    case "act.swap":
      return { op: node.op, a: canonicalizeSel(node.a), b: canonicalizeSel(node.b) };
    case "act.strike": {
      // `amount` 是运行时超集字段（IR §5.6），编写产物里不会有它 —— 但**若真喂进来**
      // 就要原样带出去：本文件的规则 3「缺省不写」说的是「没写的可选字段不补」，
      // 不是「写了的字段可以丢」。悄悄丢一个数值字段 = 冻结的出手数变回当前 atk，
      // 而那正是 M5/T5 花一整条目消灭的那个失真。
      const out: Extract<Act, { op: "act.strike" }> = {
        op: node.op,
        attacker: canonicalizeSel(node.attacker),
        target: canonicalizeSel(node.target),
      };
      if (node.amount !== undefined) {
        out.amount = canonicalizeNum(node.amount);
      }
      return out;
    }
    case "act.gain_crystal":
    case "act.gain_crystal_cap":
      return {
        op: node.op,
        player: canonicalizeSel(node.player),
        amount: canonicalizeNum(node.amount),
      };
    case "act.when": {
      const out: Extract<Act, { op: "act.when" }> = {
        op: node.op,
        cond: canonicalizeCond(node.cond),
        then: canonicalizeActs(node.then),
      };
      if (node.else !== undefined) {
        out.else = canonicalizeActs(node.else);
      }
      return out;
    }
    case "act.repeat":
      return { op: node.op, n: canonicalizeNum(node.n), do: canonicalizeActs(node.do) };
    case "act.for_each":
      return { op: node.op, of: canonicalizeSel(node.of), do: canonicalizeActs(node.do) };
    case "act.discover": {
      const out: Extract<Act, { op: "act.discover" }> = {
        op: node.op,
        from: canonicalizeSelOrPool(node.from),
      };
      if (node.show !== undefined) {
        out.show = canonicalizeNum(node.show);
      }
      if (node.pick !== undefined) {
        out.pick = canonicalizeNum(node.pick);
      }
      return out;
    }
    case "act.select_target": {
      const out: Extract<Act, { op: "act.select_target" }> = {
        op: node.op,
        from: canonicalizeSel(node.from),
      };
      if (node.optional !== undefined) {
        out.optional = node.optional;
      }
      return out;
    }
    case "act.nothing":
      return { op: node.op };
    default:
      return unreachable(node);
  }
}

// ── Trigger / Intercept / Aura ──────────────────────────────────────────────

/** 规范化触发器。键序：`on, filter, cond, once, zone, do`；`zone` 缺省补 `"board"`。 */
export function canonicalizeTrigger(node: Trigger): Trigger {
  const head: { on: Trigger["on"]; filter?: TriggerFilter; cond?: Cond; once?: boolean } = {
    on: node.on,
  };
  if (isSet(node.filter)) {
    const filter = canonicalizeTriggerFilter(node.filter);
    if (!isEmpty(filter)) {
      head.filter = filter;
    }
  }
  if (isSet(node.cond)) {
    head.cond = canonicalizeCond(node.cond);
  }
  if (node.once !== undefined) {
    head.once = node.once;
  }
  return { ...head, zone: node.zone ?? "board", do: canonicalizeActs(node.do) };
}

function canonicalizeEffect(effect: InterceptEffect): InterceptEffect {
  switch (effect.kind) {
    case "cancel":
      return { kind: effect.kind };
    case "set_field":
      return { kind: effect.kind, field: effect.field, value: canonicalizeNum(effect.value) };
    case "mod_field":
      return { kind: effect.kind, field: effect.field, delta: canonicalizeNum(effect.delta) };
    case "retarget":
      return { kind: effect.kind, to: canonicalizeSel(effect.to) };
    default:
      return unreachable(effect);
  }
}

/** 规范化拦截器。键序：`intercept, filter, cond, effect, then, priority`。 */
export function canonicalizeIntercept(node: Intercept): Intercept {
  const head: { intercept: Intercept["intercept"]; filter?: InterceptFilter; cond?: Cond } = {
    intercept: node.intercept,
  };
  if (isSet(node.filter)) {
    const filter = canonicalizeInterceptFilter(node.filter);
    if (!isEmpty(filter)) {
      head.filter = filter;
    }
  }
  if (isSet(node.cond)) {
    head.cond = canonicalizeCond(node.cond);
  }
  const tail: { then?: readonly Act[]; priority?: number } = {};
  if (isSet(node.then) && node.then.length > 0) {
    tail.then = canonicalizeActs(node.then);
  }
  if (node.priority !== undefined) {
    tail.priority = node.priority;
  }
  return { ...head, effect: canonicalizeEffect(node.effect), ...tail };
}

/** 规范化光环。键序：`affects, mods, flags, cond, zone`；`zone` 缺省补 `"board"`。 */
export function canonicalizeAura(node: Aura): Aura {
  const head: {
    affects: Sel;
    mods?: Partial<Record<TagKey, number>>;
    flags?: readonly FlagName[];
    cond?: Cond;
  } = { affects: canonicalizeSel(node.affects) };
  if (isSet(node.mods)) {
    const mods = canonicalizeTagMap(node.mods);
    if (!isEmpty(mods)) {
      head.mods = mods;
    }
  }
  if (isSet(node.flags) && node.flags.length > 0) {
    head.flags = canonicalizeFlags(node.flags);
  }
  if (isSet(node.cond)) {
    head.cond = canonicalizeCond(node.cond);
  }
  return { ...head, zone: node.zone ?? "board" };
}

// ── Card / Enchantment ──────────────────────────────────────────────────────

/**
 * 规范化 `card.data`。键序照 IR §2.2 的字段表：
 * `name, text, kind, cost, colors, rarity, tribe, art, collectible, hero, tags`。
 * `tribe: null` 视同缺省（IR §2.2 的示例写 `null`，规范形式统一省略）。
 */
export function canonicalizeCardData(data: CardData): CardData {
  const head: Pick<CardData, "name"> & Partial<Pick<CardData, "text">> = {
    name: canonicalizeText(data.name),
  };
  if (isSet(data.text)) {
    head.text = canonicalizeText(data.text);
  }
  const mid: Pick<CardData, "kind"> & Partial<Pick<CardData, "cost">> = { kind: data.kind };
  if (data.cost !== undefined) {
    mid.cost = data.cost;
  }
  const tail: Partial<
    Pick<CardData, "rarity" | "tribe" | "art" | "collectible" | "hero" | "tags">
  > = {};
  if (isSet(data.rarity)) {
    tail.rarity = data.rarity;
  }
  if (isSet(data.tribe)) {
    tail.tribe = data.tribe;
  }
  if (isSet(data.art)) {
    tail.art = data.art;
  }
  if (data.collectible !== undefined) {
    tail.collectible = data.collectible;
  }
  if (data.hero !== undefined) {
    tail.hero = data.hero;
  }
  if (isSet(data.tags)) {
    const tags = canonicalizeTagMap(data.tags);
    if (!isEmpty(tags)) {
      tail.tags = tags;
    }
  }
  return { ...head, ...mid, colors: canonicalizeColors(data.colors), ...tail };
}

function canonicalizeChooseOne(option: ChooseOneOption): ChooseOneOption {
  const head: { id: string; text: LocalizedText; target?: Sel } = {
    id: option.id,
    text: canonicalizeText(option.text),
  };
  if (isSet(option.target)) {
    head.target = canonicalizeSel(option.target);
  }
  return { ...head, play: canonicalizeActs(option.play) };
}

/**
 * 规范化 `card.script`。键序照 IR §9 的 `CardScript` 声明顺序，
 * 空字段一律省略（`target: null` / `play: []` / `triggers: []` 都不写）。
 */
export function canonicalizeCardScript(script: CardScript): CardScript {
  const out: CardScript = {};
  if (isSet(script.target)) {
    out.target = canonicalizeSel(script.target);
  }
  if (isSet(script.requires)) {
    out.requires = canonicalizeCond(script.requires);
  }
  if (isSet(script.play) && script.play.length > 0) {
    out.play = canonicalizeActs(script.play);
  }
  if (isSet(script.deathrattle) && script.deathrattle.length > 0) {
    out.deathrattle = canonicalizeActs(script.deathrattle);
  }
  if (isSet(script.triggers) && script.triggers.length > 0) {
    out.triggers = script.triggers.map(canonicalizeTrigger);
  }
  if (isSet(script.intercepts) && script.intercepts.length > 0) {
    out.intercepts = script.intercepts.map(canonicalizeIntercept);
  }
  if (isSet(script.auras) && script.auras.length > 0) {
    out.auras = script.auras.map(canonicalizeAura);
  }
  if (isSet(script.costMod)) {
    out.costMod = canonicalizeNum(script.costMod);
  }
  if (isSet(script.chooseOne) && script.chooseOne.length > 0) {
    out.chooseOne = script.chooseOne.map(canonicalizeChooseOne);
  }
  return out;
}

/** 规范化一张卡。键序：`id, set, data, script`。 */
export function canonicalizeCard(card: Card): Card {
  return {
    id: card.id,
    set: card.set,
    data: canonicalizeCardData(card.data),
    script: canonicalizeCardScript(card.script),
  };
}

function canonicalizeEnchantmentScript(script: EnchantmentScript): EnchantmentScript {
  const out: EnchantmentScript = {};
  if (isSet(script.triggers) && script.triggers.length > 0) {
    out.triggers = script.triggers.map(canonicalizeTrigger);
  }
  if (isSet(script.auras) && script.auras.length > 0) {
    out.auras = script.auras.map(canonicalizeAura);
  }
  return out;
}

/** 规范化一个附魔。键序：`id, attachesTo, mods, flags, duration, script`。 */
export function canonicalizeEnchantment(ench: Enchantment): Enchantment {
  const head: {
    id: string;
    attachesTo: Enchantment["attachesTo"];
    mods?: Partial<Record<TagKey, number>>;
    flags?: readonly FlagName[];
  } = { id: ench.id, attachesTo: ench.attachesTo };
  if (isSet(ench.mods)) {
    const mods = canonicalizeTagMap(ench.mods);
    if (!isEmpty(mods)) {
      head.mods = mods;
    }
  }
  if (isSet(ench.flags) && ench.flags.length > 0) {
    head.flags = canonicalizeFlags(ench.flags);
  }
  const out: Enchantment = { ...head, duration: ench.duration };
  if (isSet(ench.script)) {
    const script = canonicalizeEnchantmentScript(ench.script);
    if (!isEmpty(script)) {
      out.script = script;
    }
  }
  return out;
}

/**
 * 规范形式的 JSON 文本。**比对的最后一步**：两边都过 `canonicalize*` 之后再进这里，
 * 字符串相等即逐字节一致。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}
