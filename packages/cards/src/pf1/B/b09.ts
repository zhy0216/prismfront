import { CONTROLLER, Draw, defineCard, OPPOSITE, SELF, SetFlag } from "@prismfront/ir";
export const PF1_B09 = defineCard({
  id: "PF1_B09",
  hero: "PF1_HERO_BLUE",
  name: { zh: "霜镜先知", en: "Frostglass Seer" },
  kind: "minion",
  cost: 5,
  colors: "blue",
  rarity: "rare",
  collectible: true,
  atk: 3,
  health: 4,
  text: "战吼：眩晕正对面并抽 1。",
  play: [SetFlag(OPPOSITE(SELF), "stunned", true), Draw(CONTROLLER)],
  art: "pf1/b09-frostglass-seer",
});
