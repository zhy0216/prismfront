import { defineCard } from "@prismfront/ir";
import { Retaliate } from "../../keywords/index.ts";
export const PF1_G06 = defineCard({
  id: "PF1_G06",
  hero: "PF1_HERO_GREEN",
  name: { zh: "荆棘卫士", en: "Thorn Guardian" },
  kind: "minion",
  cost: 2,
  colors: "green",
  rarity: "common",
  collectible: true,
  atk: 1,
  health: 4,
  text: "Retaliate 2。",
  triggers: Retaliate(2),
  art: "pf1/g06-thorn-guardian",
});
