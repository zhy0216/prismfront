// PF1_G02 巡林木灵 —— 《数值基准》§6 绿 2 费净水标尺（预算 15 = 15 ✓）。
//
// 绿的净水曲线是 `(c+1)/(c+1)`（§1.1 一句话身份：均衡最实），2 费就是 3/3。
// 与 G01/G03/G04/G05 一样属于 §8 第 1 条的「标尺卡永不改」—— 五张一起构成
// 那条被全套定价公式当刻度用的直线，抽掉中间任何一张，曲线就没有插值点了。
//
// 净水（vanilla）= **没有 script**：预算全花在攻血上，一行逻辑都不写。
//
// 世界观取名依据：《世界观与背景故事》绿 · 翠冠议会 —— 树裔、林精、野性精灵
// 围绕母冠树结成议会；巡林木灵是议会派出去守着林缘的那一类。

import { defineCard } from "@prismfront/ir";

export const PF1_G02 = defineCard({
  id: "PF1_G02",
  hero: "PF1_HERO_GREEN",
  name: { zh: "巡林木灵", en: "Grove Warden" },
  kind: "minion",
  cost: 2,
  colors: "green",
  rarity: "common",
  collectible: true,
  atk: 3,
  health: 3,
  art: "pf1/g02-grove-warden",
});
