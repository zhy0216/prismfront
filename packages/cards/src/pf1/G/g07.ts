import {
  Buff,
  Cancel,
  defineCard,
  defineEnchantment,
  Field,
  HasFlag,
  intercept,
  SELF,
  SetFlag,
} from "@prismfront/ir";
export const PF1_G07_ENCH = defineEnchantment({
  id: "PF1_G07_ENCH",
  attachesTo: "minion",
  flags: "divine_shield",
  duration: "permanent",
});
export const PF1_G07 = defineCard({
  id: "PF1_G07",
  hero: "PF1_HERO_GREEN",
  name: { zh: "圣枝护卫", en: "Divine Bough" },
  kind: "minion",
  cost: 3,
  colors: "green",
  rarity: "rare",
  collectible: true,
  atk: 3,
  health: 2,
  text: "圣盾。",
  play: Buff(SELF, PF1_G07_ENCH.id),
  intercepts: intercept({
    intercept: "act.hit",
    filter: { target: SELF },
    cond: HasFlag(SELF, "divine_shield").and(Field("amount").gt(0)),
    effect: Cancel(),
    // biome-ignore lint/suspicious/noThenProperty: `then` is the normative IR field name.
    then: SetFlag(SELF, "divine_shield", false),
    priority: 100,
  }),
  art: "pf1/g07-divine-bough",
});
