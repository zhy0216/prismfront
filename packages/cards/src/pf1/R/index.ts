// 红 · 燎火汗庭的卡（架构 §2.3）。
//
// 《数值基准》§6：PF1 红共 11 张（进攻向；净水与身板卡全线 +1，见 §2.2 推论 2），
// 归属红英雄。M4/E6 落地三张：
//   R01 净水标尺（攻偏形状 `(c+2)/(c)`）
//   R07 / R09 一对**只差目标域**的直伤法术 —— §4 价格表把「限单位 4/伤」与
//       「任意目标 4.5/伤」分成两行，两张卡就是那两行各自的换算示例。
// 其余 R02–R06、R08、R10、R11 在 M11 补。
//
// 新增卡的规矩（架构 §7 测试策略第 1 层）：**每张卡必须带测试**，写在同目录的
// `red.test.ts` 里。

import type { Card, Enchantment } from "@prismfront/ir";
import { PF1_R01 } from "./r01.ts";
import { PF1_R02 } from "./r02.ts";
import { PF1_R03 } from "./r03.ts";
import { PF1_R04 } from "./r04.ts";
import { PF1_R05 } from "./r05.ts";
import { PF1_R06 } from "./r06.ts";
import { PF1_R07 } from "./r07.ts";
import { PF1_R08 } from "./r08.ts";
import { PF1_R09 } from "./r09.ts";
import { PF1_R10 } from "./r10.ts";
import { PF1_R11 } from "./r11.ts";

export { PF1_R01 } from "./r01.ts";
export { PF1_R02 } from "./r02.ts";
export { PF1_R03 } from "./r03.ts";
export { PF1_R04 } from "./r04.ts";
export { PF1_R05 } from "./r05.ts";
export { PF1_R06 } from "./r06.ts";
export { PF1_R07 } from "./r07.ts";
export { PF1_R08 } from "./r08.ts";
export { PF1_R09 } from "./r09.ts";
export { PF1_R10 } from "./r10.ts";
export { PF1_R11 } from "./r11.ts";

/** 红卡表。顺序不影响产物（`buildBundle` 按 id 排序），按卡号写便于人读。 */
export const RED_CARDS: readonly Card[] = [
  PF1_R01,
  PF1_R02,
  PF1_R03,
  PF1_R04,
  PF1_R05,
  PF1_R06,
  PF1_R07,
  PF1_R08,
  PF1_R09,
  PF1_R10,
  PF1_R11,
];

/** 红卡引用的附魔（M11 起可能有，目前一个都不需要）。 */
export const RED_ENCHANTMENTS: readonly Enchantment[] = [];
