// PF1_G04 苔背巨鹿 —— 《数值基准》§6 绿 4 费净水标尺（预算 25 = 25 ✓）。
//
// 4 费 5/5。同属 §8 第 1 条的「标尺卡永不改」。
// 净水（vanilla）= **没有 script**。
//
// 世界观取名依据：《世界观与背景故事》绿 · 翠冠议会 —— 巨兽也是议会的一员；
// 背上长着苔与幼苗的老鹿，本身就是「一株会倒，林海不会」的一个走动的注脚。

import { defineCard } from "@prismfront/ir";

export const PF1_G04 = defineCard({
  id: "PF1_G04",
  hero: "PF1_HERO_GREEN",
  name: { zh: "苔背巨鹿", en: "Mossback Stag" },
  kind: "minion",
  cost: 4,
  colors: "green",
  rarity: "common",
  collectible: true,
  atk: 5,
  health: 5,
  art: "pf1/g04-mossback-stag",
});
