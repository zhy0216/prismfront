import { defineCard, ENEMY_UNITS, Hit, Push, TARGET } from "@prismfront/ir";
export const PF1_R10 = defineCard({
  id: "PF1_R10",
  hero: "PF1_HERO_RED",
  name: { zh: "冲击余烬", en: "Impact Ember" },
  kind: "spell",
  cost: 2,
  colors: "red",
  rarity: "rare",
  collectible: true,
  target: ENEMY_UNITS,
  play: [Hit(TARGET, 2), Push(TARGET, 1)],
  art: "pf1/r10-impact-ember",
});
