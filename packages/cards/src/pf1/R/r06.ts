import { defineCard } from "@prismfront/ir";
import { Siege } from "../../keywords/index.ts";
export const PF1_R06 = defineCard({
  id: "PF1_R06",
  hero: "PF1_HERO_RED",
  name: { zh: "攻城巨兽", en: "Siege Behemoth" },
  kind: "minion",
  cost: 4,
  colors: "red",
  rarity: "rare",
  collectible: true,
  atk: 5,
  health: 3,
  text: "Siege 1。",
  triggers: Siege(1),
  art: "pf1/r06-siege-behemoth",
});
