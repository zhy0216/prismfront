import { defineCard, SELF, SetDirection } from "@prismfront/ir";
export const PF1_R04 = defineCard({
  id: "PF1_R04",
  hero: "PF1_HERO_RED",
  name: { zh: "斜刺长枪兵", en: "Slant Spearman" },
  kind: "minion",
  cost: 2,
  colors: "red",
  rarity: "rare",
  collectible: true,
  atk: 4,
  health: 3,
  text: "斜打：方向 ±1。",
  chooseOne: [
    { id: "left", text: { zh: "方向 -1" }, play: [SetDirection(SELF, -1)] },
    { id: "right", text: { zh: "方向 +1" }, play: [SetDirection(SELF, 1)] },
  ],
  art: "pf1/r04-slant-spearman",
});
