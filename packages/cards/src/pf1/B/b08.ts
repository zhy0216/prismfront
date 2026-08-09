import { defineCard, OPPOSITE, Pull, SELF } from "@prismfront/ir";
export const PF1_B08 = defineCard({
  id: "PF1_B08",
  hero: "PF1_HERO_BLUE",
  name: { zh: "逆向牵引", en: "Inversion Pull" },
  kind: "minion",
  cost: 3,
  colors: "blue",
  rarity: "rare",
  collectible: true,
  atk: 2,
  health: 4,
  text: "战吼：推拉对面单位。",
  play: Pull(OPPOSITE(SELF), 1),
  art: "pf1/b08-inversion-pull",
});
