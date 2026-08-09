import { defineCard, FirstEmptySlot, FRIENDLY, MoveTo, SELF } from "@prismfront/ir";
export const PF1_B06 = defineCard({
  id: "PF1_B06",
  hero: "PF1_HERO_BLUE",
  name: { zh: "跃迁学徒", en: "Warp Apprentice" },
  kind: "minion",
  cost: 2,
  colors: "blue",
  rarity: "common",
  collectible: true,
  atk: 1,
  health: 4,
  text: "战吼：移动到任意空格。",
  play: MoveTo(SELF, FirstEmptySlot(FRIENDLY)),
  art: "pf1/b06-warp-apprentice",
});
