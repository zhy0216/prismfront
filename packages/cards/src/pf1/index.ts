// PF1 卡集（《命名与主题》§4：基准集码 `PF1`，卡号形如 `PF1_G01`）。
//
// 三色各一个目录（架构 §2.3 的 `src/pf1/{R,G,B,heroes,tokens}/`）。
// `heroes/` 与 `tokens/` 到 M6（英雄与色门）才有内容，那时按同样的形状加目录即可。

import type { Card, Enchantment } from "@prismfront/ir";
import { BLUE_CARDS, BLUE_ENCHANTMENTS } from "./B/index.ts";
import { GREEN_CARDS, GREEN_ENCHANTMENTS } from "./G/index.ts";
import { RED_CARDS, RED_ENCHANTMENTS } from "./R/index.ts";

/** PF1 全部卡。产物里的顺序由 `buildBundle` 按 id 定，这里的拼接顺序只影响可读性。 */
export const PF1_CARDS: readonly Card[] = [...RED_CARDS, ...GREEN_CARDS, ...BLUE_CARDS];

/** PF1 全部附魔（`act.buff.ench` 指向它们，IR §2.3）。 */
export const PF1_ENCHANTMENTS: readonly Enchantment[] = [
  ...RED_ENCHANTMENTS,
  ...GREEN_ENCHANTMENTS,
  ...BLUE_ENCHANTMENTS,
];
