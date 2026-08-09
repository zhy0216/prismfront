import { ANY_CHARACTER, defineCard, Hit, TARGET } from "@prismfront/ir";
export const PF1_R08 = defineCard({
  id: "PF1_R08",
  hero: "PF1_HERO_RED",
  name: { zh: "焚界烈焰", en: "Worldfire" },
  kind: "spell",
  cost: 3,
  colors: "red",
  rarity: "rare",
  collectible: true,
  target: ANY_CHARACTER,
  play: Hit(TARGET, 4),
  art: "pf1/r08-worldfire",
});
