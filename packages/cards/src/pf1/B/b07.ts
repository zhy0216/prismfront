import { CONTROLLER, Draw, defineCard } from "@prismfront/ir";
export const PF1_B07 = defineCard({
  id: "PF1_B07",
  hero: "PF1_HERO_BLUE",
  name: { zh: "记忆学者", en: "Memory Scholar" },
  kind: "minion",
  cost: 3,
  colors: "blue",
  rarity: "common",
  collectible: true,
  atk: 2,
  health: 3,
  text: "战吼：抽 1。",
  play: Draw(CONTROLLER),
  art: "pf1/b07-memory-scholar",
});
