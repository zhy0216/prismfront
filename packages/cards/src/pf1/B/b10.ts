import { CONTROLLER, CombatEnded, Draw, defineCard, on } from "@prismfront/ir";
export const PF1_B10 = defineCard({
  id: "PF1_B10",
  hero: "PF1_HERO_BLUE",
  name: { zh: "战术记录员", en: "Tactical Recorder" },
  kind: "minion",
  cost: 6,
  colors: "blue",
  rarity: "epic",
  collectible: true,
  atk: 4,
  health: 6,
  text: "每次战斗后抽 1。",
  triggers: on(CombatEnded(), Draw(CONTROLLER)),
  art: "pf1/b10-tactical-recorder",
});
