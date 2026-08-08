// 蓝 · 折光学府的卡（架构 §2.3）。
//
// 《数值基准》§6：PF1 蓝共 10 张（控制/位移向），归属蓝英雄，也是三色里种类最紧的
// 一条（每名英雄 10 张配额、同名至多 3 份 ⇒ 种类数须 ≥ ⌈10/3⌉ = 4）。
// M4/E6 落地两张：
//   B01 换位术 —— `act.swap`（§1.2 蓝主色），也是全卡表第一张带**挂起点**的卡
//   B02 引光术 —— `act.draw`（§1.2 蓝主色）
// 其余 B03–B10 在 M11 补。
//
// 新增卡的规矩（架构 §7 测试策略第 1 层）：**每张卡必须带测试**，写在同目录的
// `blue.test.ts` 里。

import type { Card, Enchantment } from "@prismfront/ir";
import { PF1_B01 } from "./b01.ts";
import { PF1_B02 } from "./b02.ts";

export { PF1_B01 } from "./b01.ts";
export { PF1_B02 } from "./b02.ts";

/** 蓝卡表。顺序不影响产物（`buildBundle` 按 id 排序），按卡号写便于人读。 */
export const BLUE_CARDS: readonly Card[] = [PF1_B01, PF1_B02];

/** 蓝卡引用的附魔（M11 起可能有，目前一个都不需要）。 */
export const BLUE_ENCHANTMENTS: readonly Enchantment[] = [];
