import { defineCard } from "@prismfront/ir";
import { Cleave } from "../../keywords/index.ts";
export const PF1_R05 = defineCard({
  id: "PF1_R05",
  hero: "PF1_HERO_RED",
  name: { zh: "裂阵斧手", en: "Linebreaker" },
  kind: "minion",
  cost: 3,
  colors: "red",
  rarity: "rare",
  collectible: true,
  atk: 3,
  health: 1,
  text: "Cleave。",
  triggers: Cleave(1),
  art: "pf1/r05-linebreaker",
});
