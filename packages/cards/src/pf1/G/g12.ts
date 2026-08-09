import {
  Buff,
  CONTROLLER,
  Draw,
  defineCard,
  defineEnchantment,
  FRIENDLY_UNITS,
  Heal,
  TARGET,
} from "@prismfront/ir";
export const PF1_G12_ENCH = defineEnchantment({
  id: "PF1_G12_ENCH",
  attachesTo: "minion",
  health: 2,
  duration: "permanent",
});
export const PF1_G12 = defineCard({
  id: "PF1_G12",
  hero: "PF1_HERO_GREEN",
  name: { zh: "回春祷言", en: "Renewing Prayer" },
  kind: "spell",
  cost: 3,
  colors: "green",
  rarity: "rare",
  collectible: true,
  target: FRIENDLY_UNITS,
  play: [Heal(TARGET, 6), Buff(TARGET, PF1_G12_ENCH.id), Draw(CONTROLLER)],
  art: "pf1/g12-renewing-prayer",
});
