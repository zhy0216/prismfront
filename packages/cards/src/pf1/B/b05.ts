import { Destroy, defineCard, ENEMY_UNITS, TARGET } from "@prismfront/ir";
export const PF1_B05 = defineCard({
  id: "PF1_B05",
  hero: "PF1_HERO_BLUE",
  name: { zh: "虚空抹除", en: "Null Erasure" },
  kind: "spell",
  cost: 4,
  colors: "blue",
  rarity: "epic",
  collectible: true,
  target: ENEMY_UNITS,
  play: Destroy(TARGET),
  art: "pf1/b05-null-erasure",
});
