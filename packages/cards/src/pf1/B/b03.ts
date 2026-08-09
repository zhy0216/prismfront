import { CONTROLLER, Draw, defineCard, ENEMY_UNITS, Silence, TARGET } from "@prismfront/ir";
export const PF1_B03 = defineCard({
  id: "PF1_B03",
  hero: "PF1_HERO_BLUE",
  name: { zh: "静默洞见", en: "Silencing Insight" },
  kind: "spell",
  cost: 2,
  colors: "blue",
  rarity: "rare",
  collectible: true,
  target: ENEMY_UNITS,
  play: [Silence(TARGET), Draw(CONTROLLER)],
  art: "pf1/b03-silencing-insight",
});
