import {
  CHOSEN,
  defineCard,
  ENEMY_UNITS,
  FRIENDLY_UNITS,
  SelectTarget,
  Strike,
  TARGET,
} from "@prismfront/ir";
export const PF1_G11 = defineCard({
  id: "PF1_G11",
  hero: "PF1_HERO_GREEN",
  name: { zh: "林间决斗", en: "Verdant Duel" },
  kind: "spell",
  cost: 2,
  colors: "green",
  rarity: "rare",
  collectible: true,
  target: FRIENDLY_UNITS,
  play: [SelectTarget(ENEMY_UNITS), Strike(TARGET, CHOSEN)],
  art: "pf1/g11-verdant-duel",
});
