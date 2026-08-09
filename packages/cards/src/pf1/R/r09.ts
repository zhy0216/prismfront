// PF1_R09 火球术 —— 《数值基准》§6 红 4 费法术：6 伤（任意目标）（27 vs 25，+2 ✓）。
//
// §6 直接把它写成「= 火球术」，§4 价格表的「伤害（任意目标，可打脸）4.5/伤」
// 也拿它当换算示例（**4 费 6 伤 = 火球术**）。所以卡名就用「火球术」——
// 它在这套数值体系里是一个**基准名**，改名等于让文档和卡表对不上号。
//
// ═══════════════════════════════════════════════════════════════════════════
// 目标域 = `ANY_CHARACTER`：与 R07 的唯一区别，也是那 0.5/伤 差价的全部来源
// ═══════════════════════════════════════════════════════════════════════════
// `ANY_CHARACTER` = `ALL_CHARACTERS` = `sel.zone(both, ["board","base"])`
// （IR §3.1 的具名常量；IR §10.1 的火球术示例用的就是这个名字）。
// 比 R07 的 `ALL_UNITS` 多的那个 `"base"` 就是"可以打脸"——
// 于是"能不能打脸"在 IR 里是**一个区域名的有无**，而不是某个 act 里的一句判断。
//
// 世界观取名依据：光学主题（《命名与主题》§2）—— 焚曜的碎屑聚成一束打出去；
// 中文保留通用名「火球术」，英文用 Fireball，不另造词。

import { ANY_CHARACTER, defineCard, Hit, TARGET } from "@prismfront/ir";

export const PF1_R09 = defineCard({
  id: "PF1_R09",
  hero: "PF1_HERO_RED",
  name: { zh: "火球术", en: "Fireball" },
  kind: "spell",
  cost: 4,
  colors: "red",
  rarity: "common",
  collectible: true,
  text: "造成 6 点伤害。",
  art: "pf1/r09-fireball",
  target: ANY_CHARACTER,
  play: Hit(TARGET, 6),
});
