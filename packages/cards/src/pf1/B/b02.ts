// PF1_B02 引光术 —— 《数值基准》§6 蓝 2 费法术：抽 2（16 vs 15，+1）。
//
// §4 价格表的「抽牌 8/张」这一行就以它为换算示例（2 费抽 2，16 vs 15）。
// §1.2 机制归属表：`act.draw` 是**蓝主色**（绿副色、红禁区），所以它是蓝卡。
//
// ═══════════════════════════════════════════════════════════════════════════
// `Draw(CONTROLLER, 2)`：为什么第一个参数是选择器而不是"玩家号"
// ═══════════════════════════════════════════════════════════════════════════
// IR §3.4 的签名是 `act.draw{player: Sel, count?: Num}` —— `player` 是**选择器**，
// 因为 IR §3.1 里 `sel.controller` 的取值是**实体**（v2.1 §11.2 之后就是那一方的
// base 实体）。引擎侧由 `handlers/targets.ts` 的 `targetPlayers` 反推回玩家并去重。
// 好处是"给双方各抽一张"与"给自己抽一张"是同一个 op 的两种写法，不用两个动作。
//
// `count` 显式写 2（缺省是 1，IR §3.4）。**一条 `count: 2` 而不是两条 `Draw`**：
// 前者是一个动作（`count` 只求值一次、牌库剩 1 张时抽 1 张就停），
// 后者是两个动作、中间会插进流水线的死亡结算与光环重算 —— 卡面写的是"抽 2"，
// 那就该是一件事。
//
// 世界观取名依据：《世界观与背景故事》§11 名词表 —— **引光 = lightdraw = 抽牌**，
// 光种（lightseed）= 手牌。折光学府把光引进来，直译就是这张卡。

import { CONTROLLER, Draw, defineCard } from "@prismfront/ir";

export const PF1_B02 = defineCard({
  id: "PF1_B02",
  name: { zh: "引光术", en: "Lightdraw" },
  kind: "spell",
  cost: 2,
  colors: "blue",
  rarity: "common",
  collectible: true,
  text: "抽 2 张牌。",
  art: "pf1/b02-lightdraw",
  play: Draw(CONTROLLER, 2),
});
