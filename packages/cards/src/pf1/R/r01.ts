// PF1_R01 烬鬃斥候 —— 《数值基准》§6 红 1 费净水标尺（11 vs 10，**+1**）。
//
// 红的净水形状是 `(c+2)/(c)`（§1.1：攻偏），1 费就是 3/1。
// 那个 +1 不是配错了数：§2.2 推论 2 说红的净水与身板卡**全线 +1**，
// 「形状使然」——攻血单价不同，攻偏形状换算回预算天然多出一点，§6 把它列为**监控项**
// 而不是当场抹平。抹平会让红失去它的身份形状，所以宁可留一条待数据裁决的监控线。
//
// 净水（vanilla）= **没有 script**：3/1 的全部内容就是"先出手的那个"。
//
// 世界观取名依据：《世界观与背景故事》红 · 燎火汗庭 —— 烬鬃兽族是汗庭的主干，
// 信条「光会熄，冲锋不会」；1 费的那一个就是冲在最前面探路的斥候。

import { defineCard } from "@prismfront/ir";

export const PF1_R01 = defineCard({
  id: "PF1_R01",
  name: { zh: "烬鬃斥候", en: "Embermane Scout" },
  kind: "minion",
  cost: 1,
  colors: "red",
  rarity: "common",
  collectible: true,
  atk: 3,
  health: 1,
  art: "pf1/r01-embermane-scout",
});
