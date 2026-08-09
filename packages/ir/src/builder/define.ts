// `defineCard` / `defineEnchantment` —— 编写层的入口，也是规范化的落点。
//
// 编写层是**扁平**的（`{ id, name, kind, cost, atk, health, play, triggers, aura }`，
// 见 IR §10 与 v2 §8 的全部示例），规范形式是 **data / script 二分**（IR §1 原则 6：
// 策划改 `data`、程序改 `script`，两边独立走审批和热更）。这两个函数负责这一步翻译。
//
// ★ 三条规范化保证（IR §1 原则 1），由 `__tests__/canonical.test.ts` 逐条钉死：
//   1. `play: Hit(...)` 与 `play: [Hit(...)]` 产出**同一份 JSON**
//   2. 可选字段缺省 / null / 空数组一律不出现，默认值只在规范要求处显式化
//   3. 键序固定（= 规范签名的字段声明顺序），与书写顺序无关
// 三条合起来才有"同一份源永远产出同一份 JSON"，diff、缓存 key、哈希才立得住。

import type {
  Act,
  Aura,
  Card,
  CardData,
  CardId,
  CardKind,
  CardScript,
  ChooseOneOption,
  Color,
  Cond,
  Duration,
  EnchantId,
  Enchantment,
  EnchantmentScript,
  FlagName,
  Intercept,
  LocalizedText,
  Num,
  Rarity,
  Sel,
  SetId,
  TagKey,
  TribeName,
  Trigger,
} from "../types/index.ts";
import type { ActLike } from "./act.ts";
import { canonicalizeCard, canonicalizeEnchantment } from "./canonical.ts";
import { toArray } from "./list.ts";

/**
 * `card.set` 的默认值。PF1 是本仓库唯一的卡集（架构 §5.1 的 `cards.ir.json`）。
 * 规范里 `set` 必填，但示例源码从不写它 —— 默认值把这条噪音吃掉。
 */
export const DEFAULT_CARD_SET: SetId = "pf1";

/** `attachesTo` 的默认值（IR §2.3 的示例即 `"minion"`）。 */
export const DEFAULT_ENCHANTMENT_ATTACHES_TO: CardKind = "minion";

/** `duration` 的默认值（IR §2.3）。v2 §8.1 的 `{id, direction:-1}` 就吃这个默认。 */
export const DEFAULT_ENCHANTMENT_DURATION: Duration = "permanent";

/** 文案：编写层写 `"火球术"`，规范形式是 `{zh:"火球术"}`；要英文时直接给对象。 */
export type TextLike = string | LocalizedText;

function toText(text: TextLike): LocalizedText {
  return typeof text === "string" ? { zh: text } : text;
}

/**
 * `defineCard` 的入参（编写层的扁平形状）。
 *
 * `data` 侧字段与 `script` 侧字段平铺在一起，因为编写时人不关心这条分界线；
 * 分界线是**产物**的事，由 {@link defineCard} 划。
 */
export interface CardSpec {
  id: CardId;
  /** 卡集。省略 → {@link DEFAULT_CARD_SET}。 */
  set?: SetId;
  name: TextLike;
  /** 卡面文案。 */
  text?: TextLike;
  kind: CardKind;
  /** 费用（水晶）。`kind:"hero"` 无 cost（英雄在卡组外，不打出，v2.1 §11.4）。 */
  cost?: number;
  /**
   * 颜色（v2.1 §11.4 取代 v1 的 `faction`）。**长度 1-2**，长度 2 = 融合卡。
   * 单色可直接写 `"red"`。这是必填项 —— 色门与色轮 lint 都以它为准，没有合理的默认值。
   */
  colors: Color | readonly Color[];
  rarity?: Rarity;
  tribe?: TribeName;
  art?: string;
  collectible?: boolean;
  /** 构筑层专属英雄；引擎不读取。 */
  hero?: CardId;
  /** 基础攻击力 → `data.tags.atk`。 */
  atk?: number;
  /** 基础血量 → `data.tags.health`。 */
  health?: number;
  /** 其余基础属性（如 `direction`）。与 `atk` / `health` 合并，此处显式给出的优先。 */
  tags?: Partial<Record<TagKey, number>>;

  /** 打出时的目标域。用了 `TARGET` 就必须声明它。 */
  target?: Sel;
  /** 打出的前置条件。 */
  requires?: Cond;
  /** 打出时执行。单个动作或数组 —— 两种写法产出同一份 JSON。 */
  play?: ActLike;
  /** 亡语（IR §4.1：它是 `unit_died` 触发器的糖，字段保留只为可读性与 lint）。 */
  deathrattle?: ActLike;
  triggers?: Trigger | readonly Trigger[];
  intercepts?: Intercept | readonly Intercept[];
  /** 单个光环（IR §10.3 / v2 §8.2 用的就是单数形式）。与 `auras` 合并。 */
  aura?: Aura | readonly Aura[];
  auras?: Aura | readonly Aura[];
  /** 费用修正，例：`Count(FRIENDLY_MINIONS).negate()`（IR §10.4）。 */
  costMod?: Num;
  chooseOne?: readonly ChooseOneOption[];
}

function buildCardData(spec: CardSpec): CardData {
  const tags: Partial<Record<TagKey, number>> = {};
  if (spec.atk !== undefined) {
    tags.atk = spec.atk;
  }
  if (spec.health !== undefined) {
    tags.health = spec.health;
  }
  Object.assign(tags, spec.tags ?? {});

  const data: CardData = {
    name: toText(spec.name),
    kind: spec.kind,
    colors: typeof spec.colors === "string" ? [spec.colors] : spec.colors,
    tags,
  };
  if (spec.text !== undefined) {
    data.text = toText(spec.text);
  }
  if (spec.cost !== undefined) {
    data.cost = spec.cost;
  }
  if (spec.rarity !== undefined) {
    data.rarity = spec.rarity;
  }
  if (spec.tribe !== undefined) {
    data.tribe = spec.tribe;
  }
  if (spec.art !== undefined) {
    data.art = spec.art;
  }
  if (spec.collectible !== undefined) {
    data.collectible = spec.collectible;
  }
  if (spec.hero !== undefined) {
    data.hero = spec.hero;
  }
  return data;
}

function buildCardScript(spec: CardSpec): CardScript {
  const script: CardScript = {};
  if (spec.target !== undefined) {
    script.target = spec.target;
  }
  if (spec.requires !== undefined) {
    script.requires = spec.requires;
  }
  const play: readonly Act[] = toArray(spec.play);
  if (play.length > 0) {
    script.play = play;
  }
  const deathrattle: readonly Act[] = toArray(spec.deathrattle);
  if (deathrattle.length > 0) {
    script.deathrattle = deathrattle;
  }
  const triggers = toArray(spec.triggers);
  if (triggers.length > 0) {
    script.triggers = triggers;
  }
  const intercepts = toArray(spec.intercepts);
  if (intercepts.length > 0) {
    script.intercepts = intercepts;
  }
  const auras = [...toArray(spec.aura), ...toArray(spec.auras)];
  if (auras.length > 0) {
    script.auras = auras;
  }
  if (spec.costMod !== undefined) {
    script.costMod = spec.costMod;
  }
  if (spec.chooseOne !== undefined && spec.chooseOne.length > 0) {
    script.chooseOne = spec.chooseOne;
  }
  return script;
}

/**
 * 编写层 → 规范形式的卡牌。产物是**纯数据**：链式糖留下的原型方法不会跟进来
 * （`canonicalize*` 逐字段重建了每个节点）。
 */
export function defineCard(spec: CardSpec): Card {
  return canonicalizeCard({
    id: spec.id,
    set: spec.set ?? DEFAULT_CARD_SET,
    data: buildCardData(spec),
    script: buildCardScript(spec),
  });
}

/**
 * `defineEnchantment` 的入参。
 *
 * `atk` / `health` / `cost` / `direction` / `armor` 是 `mods` 的扁平写法：
 * v2 §8.1 的 `defineEnchantment({ id: "GRID_001e", direction: -1 })` 就靠它 ——
 * "战吼：方向 -1"只是一张带 `{direction:-1}` 的附魔，沉默它方向自动回 0（v2 §2.3）。
 */
export interface EnchantmentSpec {
  id: EnchantId;
  /** 可附着的卡牌种类。省略 → `"minion"`。 */
  attachesTo?: CardKind;
  atk?: number;
  health?: number;
  cost?: number;
  /** 战斗方向增减。v2 §9：出现在非 minion 的附魔里 → L3 告警。 */
  direction?: number;
  armor?: number;
  /** 其余属性加成，与上面几个扁平字段合并，此处显式给出的优先。 */
  mods?: Partial<Record<TagKey, number>>;
  flags?: FlagName | readonly FlagName[];
  /** 存续时长。省略 → `"permanent"`。 */
  duration?: Duration;
  /** 附魔自带的触发器（"这个随从死亡时……"）。 */
  triggers?: Trigger | readonly Trigger[];
  /** 附魔自带的光环。 */
  auras?: Aura | readonly Aura[];
}

/** 编写层 → 规范形式的附魔。 */
export function defineEnchantment(spec: EnchantmentSpec): Enchantment {
  const mods: Partial<Record<TagKey, number>> = {};
  if (spec.atk !== undefined) {
    mods.atk = spec.atk;
  }
  if (spec.health !== undefined) {
    mods.health = spec.health;
  }
  if (spec.cost !== undefined) {
    mods.cost = spec.cost;
  }
  if (spec.direction !== undefined) {
    mods.direction = spec.direction;
  }
  if (spec.armor !== undefined) {
    mods.armor = spec.armor;
  }
  Object.assign(mods, spec.mods ?? {});

  const script: EnchantmentScript = {};
  const triggers = toArray(spec.triggers);
  if (triggers.length > 0) {
    script.triggers = triggers;
  }
  const auras = toArray(spec.auras);
  if (auras.length > 0) {
    script.auras = auras;
  }

  return canonicalizeEnchantment({
    id: spec.id,
    attachesTo: spec.attachesTo ?? DEFAULT_ENCHANTMENT_ATTACHES_TO,
    mods,
    flags: toArray(spec.flags),
    duration: spec.duration ?? DEFAULT_ENCHANTMENT_DURATION,
    script,
  });
}
