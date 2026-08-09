import { Adjacent, Aura, defineCard, SELF } from "@prismfront/ir";
export const PF1_G09 = defineCard({
  id: "PF1_G09",
  hero: "PF1_HERO_GREEN",
  name: { zh: "林冠长老", en: "Canopy Elder" },
  kind: "minion",
  cost: 5,
  colors: "green",
  rarity: "rare",
  collectible: true,
  atk: 4,
  health: 5,
  text: "相邻友军 +1 攻击。",
  aura: Aura(Adjacent(SELF), { atk: 1 }),
  art: "pf1/g09-canopy-elder",
});
