// Card：卡牌文档（data / script 二分）。
// 来源：IR v1 §2.2 + §9、DSL v2 §11.2/§11.4（英雄与色门）、架构 §5.2（客户端展示字段）。

import type { Act } from "./act.ts";
import type { Aura } from "./aura.ts";
import type { CardKind, Color, Rarity } from "./card-kind.ts";
import type { CardId, LocalizedText, SetId } from "./common.ts";
import type { Cond } from "./cond.ts";
import type { Intercept } from "./intercept.ts";
import type { Num } from "./num.ts";
import type { Sel } from "./sel.ts";
import type { TagKey, TribeName } from "./tag.ts";
import type { Trigger } from "./trigger.ts";

/**
 * 卡牌数据（IR v1 §2.2 的 `card.data`）。
 *
 * IR v1 原则 6：**数据与逻辑在文档层面就分开**。策划改 `data`、程序改 `script`，
 * 两边可以独立走审批和热更。
 * 架构 §5.2：`cards.client.json` 只投影 `id/name/text/kind/cost/colors/atk/health/rarity/art`，
 * **绝不含 `script`** —— 客户端一旦持有卡牌逻辑就能预判隐藏信息。
 */
export interface CardData {
  name: LocalizedText;
  text?: LocalizedText;
  kind: CardKind;
  /**
   * 费用（水晶）。
   * `kind:"hero"` **无 cost**（英雄在卡组外，不打出，v2.1 §11.4）—— 此时整个字段省略。
   */
  cost?: number;
  /**
   * 颜色（v2.1 §11.4）。**长度 1-2**：长度 2 = 融合卡，需两色英雄同时在场。
   * 取代 v1 的 `data.faction`（已废弃）。
   * 色门是 legality 层的事（M6），不进 DSL；色轮归属 lint 见 `src/color-ownership.ts`。
   */
  colors: readonly Color[];
  rarity?: Rarity;
  /** 部族。PF1 无部族设计，见 `TribeName`。 */
  tribe?: TribeName | null;
  /** 美术资源路径，例：`"pf1/fireball"`。 */
  art?: string;
  /** 是否可收藏（token 为 false）。 */
  collectible?: boolean;
  /**
   * 基础属性，例：`{ atk: 4, health: 4 }`。法术写 `{}` 或省略。
   * 这些是 base 值，生效值 = base + Σ附魔 + Σ生效光环（v2 §2.3）。
   */
  tags?: Partial<Record<TagKey, number>>;
}

/** `chooseOne` 的一个选项（IR v1 §9）。 */
export interface ChooseOneOption {
  id: string;
  text: LocalizedText;
  target?: Sel;
  play: readonly Act[];
}

/**
 * 卡牌脚本（IR v1 §2.2 / §9 的 `card.script`）。
 *
 * IR v1 §2.2 原文："`script` 的所有字段可省略，省略等价于空数组 / `null`。
 * 构建器统一补齐成规范形式。" 因此这里的字段与 §9 一致地保持可选；
 * 至于 `ir:build` 的产物是否把空字段全部写出来，由 builder 的规范化策略定
 * （§2.2 的完整示例写全了，§10 的示例只写非空字段 —— 规范里这两处不一致，
 * 以 builder 的实现为准，只要**同一份源永远产出同一份 JSON**，IR v1 原则 1 就成立）。
 */
export interface CardScript {
  /** 打出时的目标域。用了 `sel.target` 却没声明它 → L3 报错；声明了没用 → 告警。 */
  target?: Sel | null;
  /** 打出的前置条件。 */
  requires?: Cond | null;
  /** 打出时执行。 */
  play?: readonly Act[];
  /**
   * 亡语。是 `{on:"unit_died", filter:{target:SELF}, zone:"graveyard"}` 触发器的糖，
   * 保留字段只为可读性与 lint，engine 内部一律当 trigger 处理（IR v1 §4.1）。
   */
  deathrattle?: readonly Act[];
  triggers?: readonly Trigger[];
  intercepts?: readonly Intercept[];
  auras?: readonly Aura[];
  /** 费用修正，例：`num.neg(num.count(FRIENDLY_MINIONS))`（IR v1 §10.4）。 */
  costMod?: Num | null;
  chooseOne?: readonly ChooseOneOption[];
}

/** 一张卡（IR v1 §2.2）。bundle 的 `cards` 以 `id` 为键。 */
export interface Card {
  id: CardId;
  /** 所属卡集，例：`"pf1"`（IR v1 §2.2 的 `set`）。 */
  set: SetId;
  data: CardData;
  script: CardScript;
}
