// 绿 · 翠冠议会的卡（架构 §2.3：`src/pf1/{R,G,B,heroes,tokens}/`）。
//
// 《数值基准》§6：PF1 绿共 12 张（随从 9 + 法术 3），归属绿英雄
// （§6 归属段：PF1 每色恰好一名英雄 ⇒ 归属表就是颜色表，`data.hero` 由颜色唯一确定）。
// M4/E6 落地五张净水标尺 G01–G05（§8 第 1 条「标尺卡永不改」的那一组），
// 剩下的 G06–G12 带效果，在 M11 补。
//
// 新增卡的规矩（架构 §7 测试策略第 1 层）：**每张卡必须带测试**，就写在同目录的
// `green.test.ts` 里，每张 3 行。

import type { Card, Enchantment } from "@prismfront/ir";
import { PF1_G01 } from "./g01.ts";
import { PF1_G02 } from "./g02.ts";
import { PF1_G03 } from "./g03.ts";
import { PF1_G04 } from "./g04.ts";
import { PF1_G05 } from "./g05.ts";

export { PF1_G01 } from "./g01.ts";
export { PF1_G02 } from "./g02.ts";
export { PF1_G03 } from "./g03.ts";
export { PF1_G04 } from "./g04.ts";
export { PF1_G05 } from "./g05.ts";

/** 绿卡表。顺序不影响产物（`buildBundle` 按 id 排序），按卡号写便于人读。 */
export const GREEN_CARDS: readonly Card[] = [PF1_G01, PF1_G02, PF1_G03, PF1_G04, PF1_G05];

/** 绿卡引用的附魔（G08 成长、G10 +2/+2 会用到，M11 落地）。 */
export const GREEN_ENCHANTMENTS: readonly Enchantment[] = [];
