// PF1_B01 换位术 —— 《数值基准》§6 蓝 1 费法术：交换两个友方单位的位置（8 vs 10，−2）。
//
// §4 价格表的「交换两个友方位置 8」这一行就以它为换算示例（1 费换位术，8 vs 10 ✓）。
// §1.2 机制归属表：`act.swap` 是**蓝主色**（红绿都是禁区），所以它只能是蓝卡。
// 卡名照 §6 表里的写法「换位术」，与 DSL v2 §8.4 的示例卡同名 —— 那张示例卡就是它的原型。
//
// ═══════════════════════════════════════════════════════════════════════════
// 两个目标怎么写：`script.target` 给第一个，`act.select_target` 再问第二个
// ═══════════════════════════════════════════════════════════════════════════
// v2 §8.4 的原文写法逐字照搬：
//   target: FRIENDLY_UNITS,
//   play: [SelectTarget(FRIENDLY_UNITS.not(TARGET)), Swap(TARGET, CHOSEN)]
// `act.select_target` 是**挂起点**（IR §6.1）：结算停在这里等玩家指第二个，
// 回应之后写进 `sel.chosen`，栈顶那条 `act.swap` 接着跑。
// `.not(TARGET)` 把第一个目标从候选域里减掉 —— 自己跟自己换位不是一次选择。
//
// ⚠ v2 §8.4 原文用的是 `FRIENDLY_MINIONS`，这里写 `FRIENDLY_UNITS`。
//   这**不是**改设计：§8.4 写于 v2.1 §11.2（英雄占格参战）之前，那时两个常量同义；
//   `ir/src/builder/constants.ts` 文件头第 2 条已经把这条对应关系写死了 ——
//   「v1 里的 FRIENDLY_MINIONS 写于英雄占格之前，对应到今天应读作 FRIENDLY_UNITS」。
//   卡面文案说的是「友方单位」，而 v2.1 之后英雄就是站在九曜位上的单位，
//   把英雄折到安全格正是蓝该干的事（§1.2：位移是蓝主色）。
//
// `act.swap` 的退化语义（v2 §3.4）：`a`、`b` 须各为**单个在场单位**，否则整条跳过。
// 于是"选完之后其中一个已经不在场了"不会炸，只是什么都没发生 —— 不需要在卡里写守卫。
//
// 世界观取名依据：《世界观与背景故事》蓝 · 折光学府 ——「把敌人折到错误的位置」的
// 镜像用法：把自己人折到正确的位置。

import { CHOSEN, defineCard, FRIENDLY_UNITS, SelectTarget, Swap, TARGET } from "@prismfront/ir";

export const PF1_B01 = defineCard({
  id: "PF1_B01",
  name: { zh: "换位术", en: "Refraction Swap" },
  kind: "spell",
  cost: 1,
  colors: "blue",
  rarity: "common",
  collectible: true,
  text: "选择两个友方单位，交换它们的位置。",
  art: "pf1/b01-refraction-swap",
  target: FRIENDLY_UNITS,
  play: [SelectTarget(FRIENDLY_UNITS.not(TARGET)), Swap(TARGET, CHOSEN)],
});
