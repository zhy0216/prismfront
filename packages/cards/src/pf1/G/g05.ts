// PF1_G05 擎天古木 —— 《数值基准》§6 绿 6 费净水标尺（预算 35 = 35 ✓）。
//
// 6 费 7/7，五张绿净水标尺里的最后一张（§6 绿表**没有 5 费净水**，
// 5 费那一格给了 G09 光环卡）。同属 §8 第 1 条的「标尺卡永不改」。
// 净水（vanilla）= **没有 script**。
//
// 世界观取名依据：《世界观与背景故事》绿 · 翠冠议会 —— 母冠树是**唯一**的那一株，
// 不做成随从；擎天古木是林海里长到能撑起一片天穹的同族，不是母冠树本身。

import { defineCard } from "@prismfront/ir";

export const PF1_G05 = defineCard({
  id: "PF1_G05",
  name: { zh: "擎天古木", en: "Titanbough Elder" },
  kind: "minion",
  cost: 6,
  colors: "green",
  rarity: "common",
  collectible: true,
  atk: 7,
  health: 7,
  art: "pf1/g05-titanbough-elder",
});
