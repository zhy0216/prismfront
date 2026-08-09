import { defineCard, ENEMY_UNITS, Hit } from "@prismfront/ir";
export const PF1_R11 = defineCard({
  id: "PF1_R11",
  hero: "PF1_HERO_RED",
  name: { zh: "赤焰风暴", en: "Crimson Storm" },
  kind: "spell",
  cost: 3,
  colors: "red",
  rarity: "rare",
  collectible: true,
  target: ENEMY_UNITS,
  play: Hit(ENEMY_UNITS, 2),
  art: "pf1/r11-crimson-storm",
});
