// 文档级反编译：Card / Enchantment / Trigger / Intercept / Aura → `defineCard({...})` 文本。
//
// 这是 `ir:print <cardId>` 的落点（IR §11），也是架构 §2.3 列在 packages/ir 对外导出
// 清单里的 `printCard`。产出的形状就是 IR §10 与 v2 §8 里手写的那种 TS 源码：
//
// ```ts
// defineCard({
//   id: "GRID_001",
//   name: "斜刺长枪兵",
//   text: "战吼：战斗方向变为斜左。",
//   kind: "minion",
//   cost: 3,
//   colors: "red",
//   atk: 3,
//   health: 2,
//   play: Buff(SELF, "GRID_001e"),
// });
// ```
//
// ── 与 `builder/define.ts` 的对应关系（逐条都是逆运算）───────────────────────
//
// * 键序 = `CardSpec` / `EnchantmentSpec` 的字段声明顺序，不是 `Card` 的 data/script 二分：
//   **编写层是扁平的**（IR §10 与 v2 §8 的示例全是扁平写法），data/script 的分界线是
//   产物的事（IR §1 原则 6），反编译回编写层就该把它抹平。
// * `data.tags.atk` / `.health` 打回扁平的 `atk:` / `health:`，其余 tag 留在 `tags:`。
// * **builder 的默认值省掉**：`set === "pf1"`、`attachesTo === "minion"`、
//   `duration === "permanent"`、`trigger.zone === "board"`、`aura.zone === "board"`。
//   省掉才是逆运算 —— 重新喂给 builder 会原样补回来。
// * `play: [单个动作]` 打成 `play: 单个动作`（v2 §8.1），`auras: [单个光环]` 打成
//   `aura: 单个光环`（IR §10.3 / v2 §8.2）。`toArray` 两种写法产出同一份 JSON，可逆。
// * `triggers` / `intercepts` 永远是数组（IR §10.2 / v2 §8.5 的源码就是数组）。
//
// printer 不做规范化、不做校验、不求值。

import {
  DEFAULT_CARD_SET,
  DEFAULT_ENCHANTMENT_ATTACHES_TO,
  DEFAULT_ENCHANTMENT_DURATION,
} from "../builder/define.ts";
import type {
  Aura,
  Card,
  CardData,
  CardScript,
  ChooseOneOption,
  Color,
  Enchantment,
  EventName,
  FlagName,
  Intercept,
  InterceptEffect,
  LocalizedText,
  Sel,
  TagKey,
  Trigger,
  TriggerFilter,
} from "../types/index.ts";
import { ACT_ENTITY_FIELDS, EVENT_ENTITY_FIELDS, TAG_KEYS } from "../types/index.ts";
import {
  booleanLiteral,
  emitArray,
  emitCall,
  emitObject,
  emitObjectCall,
  nested,
  numberLiteral,
  type PrintContext,
  positional,
  quote,
  rootContext,
} from "./format.ts";
import { eventHelperName } from "./names.ts";
import { printAct, printActs, printCond, printNum, printSel } from "./print-node.ts";

/** 联合类型没穷尽时的兜底。类型正确的调用永远到不了这里。 */
function unreachable(value: never): never {
  throw new TypeError(`无法反编译的 IR 节点：${JSON.stringify(value)}`);
}

function isSet<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/** `ir:print` 的可选项。 */
export interface PrintOptions {
  /** 折行宽度，默认 {@link DEFAULT_PRINT_WIDTH}（100，与仓库 biome 一致）。 */
  readonly width?: number;
}

type Entry = readonly [string, string];

// ── 标量与自由映射 ──────────────────────────────────────────────────────────

/** 本地化文本：只有中文时打字符串（`defineCard` 的 `TextLike` 收），带英文时打对象。 */
function printText(text: LocalizedText, ctx: PrintContext): string {
  if (text.en === undefined) {
    return quote(text.zh);
  }
  return emitObject(
    [
      ["zh", quote(text.zh)],
      ["en", quote(text.en)],
    ],
    ctx,
  );
}

/** `colors`：单色打字符串（`CardSpec.colors` 收 `Color | Color[]`），融合卡打数组。 */
function printColors(colors: readonly Color[], ctx: PrintContext): string {
  const [only] = colors;
  if (colors.length === 1 && only !== undefined) {
    return quote(only);
  }
  return emitArray(colors.map(quote), ctx);
}

/** `flags`：单个打字符串（builder 的 `flags` 也收 `FlagName | FlagName[]`），多个打数组。 */
function printFlags(flags: readonly FlagName[], ctx: PrintContext): string {
  const [only] = flags;
  if (flags.length === 1 && only !== undefined) {
    return quote(only);
  }
  return emitArray(flags.map(quote), ctx);
}

/** `CardSpec` 上有扁平字段的 tag（其余落进 `tags: {...}`）。 */
const CARD_FLAT_TAGS: readonly TagKey[] = ["atk", "health"];

/** `EnchantmentSpec` 上有扁平字段的 tag（其余落进 `mods: {...}`）。 */
const ENCHANTMENT_FLAT_MODS: readonly TagKey[] = ["atk", "health", "cost", "direction", "armor"];

/** `TAG_KEYS` 里除 `flat` 之外的那些，保持声明顺序。 */
function otherTagKeys(flat: readonly TagKey[]): readonly TagKey[] {
  return TAG_KEYS.filter((key) => !flat.includes(key));
}

/** `mods` / `tags` → 对象条目。`keys` 决定取哪些键、以及顺序（与 `canonicalizeTagMap` 同序）。 */
function tagEntries(
  map: Partial<Record<TagKey, number>> | undefined,
  keys: readonly TagKey[],
): readonly Entry[] {
  if (map === undefined) {
    return [];
  }
  const entries: Entry[] = [];
  for (const key of keys) {
    const value = map[key];
    if (value !== undefined) {
      entries.push([key, numberLiteral(value)]);
    }
  }
  return entries;
}

/** `trigger.filter` / `intercept.filter`：键按各自词汇表的声明顺序（与 canonical 同序）。 */
function printFilter<K extends string>(
  filter: Partial<Record<K, Sel>>,
  keys: readonly K[],
  ctx: PrintContext,
): string {
  const valueCtx = nested(ctx);
  const entries: Entry[] = [];
  for (const key of keys) {
    const value = filter[key];
    if (value !== undefined) {
      entries.push([key, printSel(value, valueCtx)]);
    }
  }
  return emitObject(entries, ctx);
}

// ── Trigger ─────────────────────────────────────────────────────────────────

/**
 * 事件助手调用：`CombatBegan()` / `Struck(SELF)` / `Struck({ source: SELF })`。
 *
 * builder 的 `toFilter` 规定：给 `Sel` = 简写成 `{target: 那个 Sel}`，给对象 = 完整过滤器
 * （builder/trigger.ts）。所以**只有 `target` 一个键**时打简写，其余打对象 —— 正是逆运算。
 */
function printEventHelper(
  on: EventName,
  filter: TriggerFilter | undefined,
  ctx: PrintContext,
): string {
  const name = eventHelperName(on);
  const argCtx = nested(ctx);
  if (filter === undefined) {
    return emitCall(name, [], ctx);
  }
  const keys = EVENT_ENTITY_FIELDS.filter((key) => filter[key] !== undefined);
  const [firstKey] = keys;
  const target = filter.target;
  if (keys.length === 0) {
    return emitCall(name, [], ctx);
  }
  if (keys.length === 1 && firstKey === "target" && target !== undefined) {
    return emitCall(name, [printSel(target, argCtx)], ctx);
  }
  return emitCall(name, [printFilter(filter, EVENT_ENTITY_FIELDS, argCtx)], ctx);
}

/**
 * 反编译一个触发器。
 *
 * 没有 `cond` / `once`、且 `zone` 是默认的 `"board"` 时打成 `on(事件, 动作…)`
 * （IR §10.2 / v2 §8.5 / §8.6 的写法）；否则打成完整形式 `trigger({...})`。
 */
export function printTrigger(node: Trigger, ctx: PrintContext): string {
  const inner = nested(ctx);
  const event = printEventHelper(node.on, node.filter, inner);
  const zone = node.zone ?? "board";
  if (node.cond === undefined && node.once === undefined && zone === "board") {
    return emitCall("on", [event, ...node.do.map((act) => printAct(act, inner))], ctx);
  }
  const entries: Entry[] = [["on", event]];
  if (isSet(node.cond)) {
    entries.push(["cond", printCond(node.cond, inner)]);
  }
  if (node.once !== undefined) {
    entries.push(["once", booleanLiteral(node.once)]);
  }
  if (zone !== "board") {
    entries.push(["zone", quote(zone)]);
  }
  entries.push(["do", printActs(node.do, inner)]);
  return emitObjectCall("trigger", entries, ctx);
}

// ── Intercept ───────────────────────────────────────────────────────────────

function printEffect(effect: InterceptEffect, ctx: PrintContext): string {
  const inner = nested(ctx);
  switch (effect.kind) {
    case "cancel":
      return emitCall("Cancel", [], ctx);
    case "set_field":
      return emitCall("SetField", [quote(effect.field), printNum(effect.value, inner)], ctx);
    case "mod_field":
      return emitCall("ModField", [quote(effect.field), printNum(effect.delta, inner)], ctx);
    case "retarget":
      return emitCall("Retarget", [printSel(effect.to, inner)], ctx);
    default:
      return unreachable(effect);
  }
}

/** 反编译一个拦截器（IR §10.6 圣盾的形状）。键序即 `InterceptSpec` 的声明顺序。 */
export function printIntercept(node: Intercept, ctx: PrintContext): string {
  const inner = nested(ctx);
  const entries: Entry[] = [["intercept", quote(node.intercept)]];
  if (isSet(node.filter)) {
    entries.push(["filter", printFilter(node.filter, ACT_ENTITY_FIELDS, inner)]);
  }
  if (isSet(node.cond)) {
    entries.push(["cond", printCond(node.cond, inner)]);
  }
  entries.push(["effect", printEffect(node.effect, inner)]);
  if (isSet(node.then) && node.then.length > 0) {
    entries.push(["then", printActs(node.then, inner)]);
  }
  if (node.priority !== undefined) {
    entries.push(["priority", numberLiteral(node.priority)]);
  }
  return emitObjectCall("intercept", entries, ctx);
}

// ── Aura ────────────────────────────────────────────────────────────────────

/**
 * 反编译一个光环。
 *
 * 没有 `flags`、`zone` 是默认的 `"board"`、且不出现"给了 cond 却没给 mods"的空洞时，
 * 打成位置参数形式 `Aura(affects, mods?, cond?)`（IR §10.3 野猪王、v2 §8.2 空袭猎手的写法）；
 * 否则打成完整形式 `aura({...})`。
 */
export function printAura(node: Aura, ctx: PrintContext): string {
  const inner = nested(ctx);
  const zone = node.zone ?? "board";
  const hasFlags = isSet(node.flags) && node.flags.length > 0;
  const mods = isSet(node.mods) ? emitObject(tagEntries(node.mods, TAG_KEYS), inner) : undefined;
  const cond = isSet(node.cond) ? printCond(node.cond, inner) : undefined;
  if (!hasFlags && zone === "board" && (mods !== undefined || cond === undefined)) {
    return emitCall("Aura", positional([printSel(node.affects, inner), mods, cond]), ctx);
  }
  const entries: Entry[] = [["affects", printSel(node.affects, inner)]];
  if (mods !== undefined) {
    entries.push(["mods", mods]);
  }
  if (isSet(node.flags) && node.flags.length > 0) {
    entries.push(["flags", printFlags(node.flags, inner)]);
  }
  if (cond !== undefined) {
    entries.push(["cond", cond]);
  }
  if (zone !== "board") {
    entries.push(["zone", quote(zone)]);
  }
  return emitObjectCall("aura", entries, ctx);
}

// ── Card ────────────────────────────────────────────────────────────────────

/**
 * `chooseOne` 是**唯一没有 builder 糖层的位置**：`CardSpec.chooseOne` 收的是裸 IR
 * （`readonly ChooseOneOption[]`），不是 `TextLike` / `ActLike`。
 *
 * 所以这里必须用**严格形式**打印，不能复用卡面那套糖：
 *   - `text` 是必填的 `LocalizedText`，不能塌成 `printText` 的字符串简写
 *     （`text: "乙"` 贴回去既丢结构又编译不过）。
 *   - `play` 是 `readonly Act[]`，不能用 `printActs` 把单元素数组塌成裸动作
 *     （`play: Nothing()` 贴回去报 TS2740）。
 * 两处都由 tools/__tests__ 里的 round-trip 测试兜住。
 */
function printChooseOne(option: ChooseOneOption, ctx: PrintContext): string {
  const inner = nested(ctx);
  const entries: Entry[] = [
    ["id", quote(option.id)],
    ["text", printLocalizedText(option.text, inner)],
  ];
  if (isSet(option.target)) {
    entries.push(["target", printSel(option.target, inner)]);
  }
  entries.push([
    "play",
    emitArray(
      option.play.map((act) => printAct(act, nested(inner))),
      inner,
    ),
  ]);
  return emitObject(entries, ctx);
}

/** `LocalizedText` 的严格形式：始终打对象，绝不塌成裸字符串。 */
function printLocalizedText(text: LocalizedText, ctx: PrintContext): string {
  const entries: Entry[] = [["zh", quote(text.zh)]];
  if (text.en !== undefined) {
    entries.push(["en", quote(text.en)]);
  }
  return emitObject(entries, ctx);
}

/** `data` 段 → 扁平的编写层字段（`CardSpec` 的前半截）。 */
function dataEntries(data: CardData, ctx: PrintContext): readonly Entry[] {
  const entries: Entry[] = [["name", printText(data.name, ctx)]];
  if (isSet(data.text)) {
    entries.push(["text", printText(data.text, ctx)]);
  }
  entries.push(["kind", quote(data.kind)]);
  if (data.cost !== undefined) {
    entries.push(["cost", numberLiteral(data.cost)]);
  }
  entries.push(["colors", printColors(data.colors, ctx)]);
  if (isSet(data.rarity)) {
    entries.push(["rarity", quote(data.rarity)]);
  }
  if (isSet(data.tribe)) {
    entries.push(["tribe", quote(data.tribe)]);
  }
  if (isSet(data.art)) {
    entries.push(["art", quote(data.art)]);
  }
  if (data.collectible !== undefined) {
    entries.push(["collectible", booleanLiteral(data.collectible)]);
  }
  const atk = data.tags?.atk;
  if (atk !== undefined) {
    entries.push(["atk", numberLiteral(atk)]);
  }
  const health = data.tags?.health;
  if (health !== undefined) {
    entries.push(["health", numberLiteral(health)]);
  }
  const rest = tagEntries(data.tags, otherTagKeys(CARD_FLAT_TAGS));
  if (rest.length > 0) {
    entries.push(["tags", emitObject(rest, ctx)]);
  }
  return entries;
}

/** `script` 段 → 编写层字段（`CardSpec` 的后半截）。 */
function scriptEntries(script: CardScript, ctx: PrintContext): readonly Entry[] {
  const inner = nested(ctx);
  const entries: Entry[] = [];
  if (isSet(script.target)) {
    entries.push(["target", printSel(script.target, ctx)]);
  }
  if (isSet(script.requires)) {
    entries.push(["requires", printCond(script.requires, ctx)]);
  }
  if (isSet(script.play) && script.play.length > 0) {
    entries.push(["play", printActs(script.play, ctx)]);
  }
  if (isSet(script.deathrattle) && script.deathrattle.length > 0) {
    entries.push(["deathrattle", printActs(script.deathrattle, ctx)]);
  }
  if (isSet(script.triggers) && script.triggers.length > 0) {
    entries.push([
      "triggers",
      emitArray(
        script.triggers.map((trigger) => printTrigger(trigger, inner)),
        ctx,
      ),
    ]);
  }
  if (isSet(script.intercepts) && script.intercepts.length > 0) {
    entries.push([
      "intercepts",
      emitArray(
        script.intercepts.map((one) => printIntercept(one, inner)),
        ctx,
      ),
    ]);
  }
  const auras = script.auras ?? [];
  const [onlyAura] = auras;
  if (auras.length === 1 && onlyAura !== undefined) {
    entries.push(["aura", printAura(onlyAura, ctx)]);
  } else if (auras.length > 1) {
    entries.push([
      "auras",
      emitArray(
        auras.map((one) => printAura(one, inner)),
        ctx,
      ),
    ]);
  }
  if (isSet(script.costMod)) {
    entries.push(["costMod", printNum(script.costMod, ctx)]);
  }
  if (isSet(script.chooseOne) && script.chooseOne.length > 0) {
    entries.push([
      "chooseOne",
      emitArray(
        script.chooseOne.map((option) => printChooseOne(option, inner)),
        ctx,
      ),
    ]);
  }
  return entries;
}

/**
 * **反编译一张卡**：IR → `defineCard({...});` 文本（IR §11 的 `ir:print`）。
 *
 * 纯函数：IR 进，字符串出。不读文件、不查 bundle、不做校验。
 */
export function printCard(card: Card, options: PrintOptions = {}): string {
  const ctx = rootContext(options.width);
  const inner = nested(ctx);
  const entries: Entry[] = [["id", quote(card.id)]];
  if (card.set !== DEFAULT_CARD_SET) {
    entries.push(["set", quote(card.set)]);
  }
  entries.push(...dataEntries(card.data, inner), ...scriptEntries(card.script, inner));
  return `${emitObjectCall("defineCard", entries, ctx)};`;
}

/**
 * **反编译一个附魔**：IR → `defineEnchantment({...});` 文本。
 *
 * `mods` 的五个键（`atk` / `health` / `cost` / `direction` / `armor`）打回
 * `EnchantmentSpec` 的扁平写法 —— v2 §8.1 的
 * `defineEnchantment({ id: "GRID_001e", direction: -1 })` 就是这么写的。
 */
export function printEnchantment(ench: Enchantment, options: PrintOptions = {}): string {
  const ctx = rootContext(options.width);
  const inner = nested(ctx);
  const deeper = nested(inner);
  const entries: Entry[] = [["id", quote(ench.id)]];
  if (ench.attachesTo !== DEFAULT_ENCHANTMENT_ATTACHES_TO) {
    entries.push(["attachesTo", quote(ench.attachesTo)]);
  }
  // `EnchantmentSpec` 为今天的五个 TagKey 都开了扁平字段，所以 `mods:` 这一支现在打不出来；
  // 保留它是为了 `TAG_KEYS` 将来扩充时（新增取值 = minor 版本，IR §8）printer 不漏字段 ——
  // 新 tag 会落进 `mods:`，而不是被打成 `EnchantmentSpec` 上并不存在的扁平字段。
  entries.push(...tagEntries(ench.mods, ENCHANTMENT_FLAT_MODS));
  const restMods = tagEntries(ench.mods, otherTagKeys(ENCHANTMENT_FLAT_MODS));
  if (restMods.length > 0) {
    entries.push(["mods", emitObject(restMods, inner)]);
  }
  if (isSet(ench.flags) && ench.flags.length > 0) {
    entries.push(["flags", printFlags(ench.flags, inner)]);
  }
  if (ench.duration !== DEFAULT_ENCHANTMENT_DURATION) {
    entries.push(["duration", quote(ench.duration)]);
  }
  const triggers = ench.script?.triggers ?? [];
  if (triggers.length > 0) {
    entries.push([
      "triggers",
      emitArray(
        triggers.map((trigger) => printTrigger(trigger, deeper)),
        inner,
      ),
    ]);
  }
  const auras = ench.script?.auras ?? [];
  if (auras.length > 0) {
    entries.push([
      "auras",
      emitArray(
        auras.map((one) => printAura(one, deeper)),
        inner,
      ),
    ]);
  }
  return `${emitObjectCall("defineEnchantment", entries, ctx)};`;
}
