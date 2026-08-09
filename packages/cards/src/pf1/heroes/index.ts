import type { Card } from "@prismfront/ir";
import { defineCard } from "@prismfront/ir";

export const PF1_HERO_RED = defineCard({
  id: "PF1_HERO_RED",
  name: { zh: "燎火汗王", en: "Ember Khan" },
  kind: "hero",
  colors: "red",
  rarity: "legendary",
  collectible: false,
  atk: 5,
  health: 4,
  art: "pf1/hero-red",
});

export const PF1_HERO_GREEN = defineCard({
  id: "PF1_HERO_GREEN",
  name: { zh: "翠冠贤者", en: "Verdant Sage" },
  kind: "hero",
  colors: "green",
  rarity: "legendary",
  collectible: false,
  atk: 4,
  health: 6,
  art: "pf1/hero-green",
});

export const PF1_HERO_BLUE = defineCard({
  id: "PF1_HERO_BLUE",
  name: { zh: "折光导师", en: "Refraction Master" },
  kind: "hero",
  colors: "blue",
  rarity: "legendary",
  collectible: false,
  atk: 3,
  health: 6,
  art: "pf1/hero-blue",
});

export const PF1_HEROES: readonly Card[] = [PF1_HERO_RED, PF1_HERO_GREEN, PF1_HERO_BLUE];
