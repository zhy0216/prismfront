import { Buff, CombatEnded, defineCard, defineEnchantment, on, SELF } from "@prismfront/ir";
export const PF1_G08_ENCH = defineEnchantment({
  id: "PF1_G08_ENCH",
  attachesTo: "minion",
  atk: 1,
  health: 1,
  duration: "permanent",
});
export const PF1_G08 = defineCard({
  id: "PF1_G08",
  hero: "PF1_HERO_GREEN",
  name: { zh: "战后新生", en: "Battlebloom" },
  kind: "minion",
  cost: 4,
  colors: "green",
  rarity: "rare",
  collectible: true,
  atk: 3,
  health: 3,
  text: "每次战斗后成长 +1/+1。",
  triggers: on(CombatEnded(), Buff(SELF, PF1_G08_ENCH.id)),
  art: "pf1/g08-battlebloom",
});
