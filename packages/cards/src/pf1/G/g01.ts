// PF1_G01 新芽树裔 —— 《数值基准》§6 绿 1 费净水标尺（预算 10 = 10 ✓）。
//
// **净水（vanilla）= 没有 script**：全部预算都花在攻血上，一行逻辑都不写。
// 《数值基准》§8 第 1 条把 G01-05 列为「标尺卡永不改」—— 它们是全套定价公式的测量单位，
// 改了标尺就没有刻度了。所以这张卡的 `cost/atk/health` 三个数字是**规格**，不是手感调参。
//
// 世界观取名依据：《世界观与背景故事》绿 · 翠冠议会 —— 树裔是母冠树的一次伸展，
// 「一株会倒，林海不会」；1 费的那一株就是刚破土的新芽。

import { defineCard } from "@prismfront/ir";

export const PF1_G01 = defineCard({
  id: "PF1_G01",
  name: { zh: "新芽树裔", en: "Sapling Scion" },
  kind: "minion",
  cost: 1,
  colors: "green",
  rarity: "common",
  collectible: true,
  atk: 2,
  health: 2,
  art: "pf1/g01-sapling-scion",
});
