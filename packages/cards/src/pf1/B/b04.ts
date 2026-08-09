import { defineCard, ENEMY_UNITS, Push, SetFlag, TARGET } from "@prismfront/ir";
export const PF1_B04 = defineCard({
  id: "PF1_B04",
  hero: "PF1_HERO_BLUE",
  name: { zh: "强制折射", en: "Forced Refraction" },
  kind: "spell",
  cost: 2,
  colors: "blue",
  rarity: "rare",
  collectible: true,
  target: ENEMY_UNITS,
  play: [Push(TARGET, 1), SetFlag(TARGET, "stunned", true)],
  art: "pf1/b04-forced-refraction",
});
