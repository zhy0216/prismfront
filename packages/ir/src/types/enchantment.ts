// Enchantment：附魔 / buff。
// 来源：IR v1 §2.3 + §9、DSL v2 §3.5（附魔修订）。

import type { Aura } from "./aura.ts";
import type { CardKind } from "./card-kind.ts";
import type { EnchantId } from "./common.ts";
import type { FlagName, TagKey } from "./tag.ts";
import type { Trigger } from "./trigger.ts";

/**
 * 附魔存续时长（DSL v2 §3.5 修订）。
 *
 * - `"permanent"`：永久
 * - `"end_of_round"`：回合结束剥离。**v1 的 `"end_of_turn"` 改名而来**
 *   （v2 §10 迁移清单第 4 条），因为 v2 的"回合"是 round（行动阶段 + 战斗阶段）
 * - `"end_of_combat"`：**v2 新增**，战斗结束剥离。"战斗号角"类（v2 §8.5 战地号手）必需
 * - `"while_source_alive"`：来源存活期间有效
 */
export const DURATIONS = [
  "permanent",
  "end_of_round",
  "end_of_combat",
  "while_source_alive",
] as const;

export type Duration = (typeof DURATIONS)[number];

/**
 * 附魔自带的脚本（IR v1 §2.3）。
 * 附魔本身可以带触发器（"这个随从死亡时……"），所以 script 是递归结构。
 */
export interface EnchantmentScript {
  triggers?: readonly Trigger[];
  auras?: readonly Aura[];
}

/** 附魔 / buff（IR v1 §2.3、DSL v2 §3.5）。 */
export interface Enchantment {
  id: EnchantId;
  /** 可附着的卡牌种类。v1 示例为 `"minion"`。 */
  attachesTo: CardKind;
  /**
   * 属性加成。**可含 `direction`**（v2 §2.3 / §3.5）——
   * 于是"战吼：方向 -1"只是一张带 `{direction:-1}` 的附魔，沉默它方向自动回 0，零额外代码。
   * v2 §9 校验：`direction` 出现在非 minion 的附魔 mods 中 → 告警。
   */
  mods?: Partial<Record<TagKey, number>>;
  /** 授予的标志位，例：`["divine_shield"]`。 */
  flags?: readonly FlagName[];
  duration: Duration;
  script?: EnchantmentScript;
}
