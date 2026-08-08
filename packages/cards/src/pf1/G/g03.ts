// PF1_G03 林海巨兽 —— 《数值基准》§6 绿 3 费净水（预算 20 = 20 ✓，**全游戏基准**）。
//
// 「全游戏基准」不是修辞：3 费 4/4 是 §2 交换率推导的锚点，其余所有卡的效果定价
// 都换算回它。它同样属于 §8 第 1 条的「标尺卡永不改」。
//
// 与 G01 一样是净水：没有 script。E5 时它俩的职责是把 `ir:build` 管线跑通；
// E6 补齐了 G02 / G04 / G05，五张绿净水标尺到此完整，其余绿卡在 M11 补。

import { defineCard } from "@prismfront/ir";

export const PF1_G03 = defineCard({
  id: "PF1_G03",
  name: { zh: "林海巨兽", en: "Verdant Behemoth" },
  kind: "minion",
  cost: 3,
  colors: "green",
  rarity: "common",
  collectible: true,
  atk: 4,
  health: 4,
  art: "pf1/g03-verdant-behemoth",
});
