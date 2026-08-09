import { Buff, defineCard, defineEnchantment, FRIENDLY_UNITS, TARGET } from "@prismfront/ir";
export const PF1_G10_ENCH = defineEnchantment({
  id: "PF1_G10_ENCH",
  attachesTo: "minion",
  atk: 2,
  health: 2,
  duration: "permanent",
});
export const PF1_G10 = defineCard({
  id: "PF1_G10",
  hero: "PF1_HERO_GREEN",
  name: { zh: "繁茂祝福", en: "Verdant Blessing" },
  kind: "spell",
  cost: 1,
  colors: "green",
  rarity: "common",
  collectible: true,
  target: FRIENDLY_UNITS,
  play: Buff(TARGET, PF1_G10_ENCH.id),
  art: "pf1/g10-verdant-blessing",
});
