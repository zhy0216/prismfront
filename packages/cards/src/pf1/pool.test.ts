import { describe, expect, test } from "bun:test";
import { DEFAULT_RULES_CONFIG, validateL3 } from "@prismfront/ir";
import { buildBundle, validateConstructedDeck, validateHeroPoolFloor } from "../index.ts";
import { PF1_HERO_BLUE, PF1_HERO_GREEN, PF1_HERO_RED } from "./heroes/index.ts";
import { PF1_CARDS, PF1_ENCHANTMENTS } from "./index.ts";

const BUNDLE = buildBundle({ cards: PF1_CARDS, enchantments: PF1_ENCHANTMENTS });
const NON_HEROES = PF1_CARDS.filter((card) => card.data.kind !== "hero");

describe("PF1 M11 complete pool", () => {
  test("33 owned cards and three pure-body heroes", () => {
    expect(NON_HEROES).toHaveLength(33);
    expect([PF1_HERO_RED.data.tags, PF1_HERO_GREEN.data.tags, PF1_HERO_BLUE.data.tags]).toEqual([
      { atk: 5, health: 4 },
      { atk: 4, health: 6 },
      { atk: 3, health: 6 },
    ]);
    expect(
      [PF1_HERO_RED, PF1_HERO_GREEN, PF1_HERO_BLUE].every((hero) => hero.script.play === undefined),
    ).toBe(true);
  });

  test("every collectible card is owned by its same-colour hero", () => {
    const heroColors = new Map(
      [PF1_HERO_RED, PF1_HERO_GREEN, PF1_HERO_BLUE].map((hero) => [hero.id, hero.data.colors[0]]),
    );
    for (const card of NON_HEROES) {
      expect(card.data.hero).toBeDefined();
      expect(card.data.colors).toContain(heroColors.get(card.data.hero ?? ""));
    }
  });

  test("full bundle passes L3 and every hero clears the quota pool floor", () => {
    expect(validateL3(BUNDLE).issues).toEqual([]);
    expect(() => validateHeroPoolFloor(BUNDLE, DEFAULT_RULES_CONFIG)).not.toThrow();
  });

  test("hero with fewer than 4 owned kinds fails the quota pool floor", () => {
    const hero = PF1_HERO_RED;
    const owned = NON_HEROES.filter((card) => card.data.hero === hero.id);
    expect(owned.length).toBeGreaterThan(3);
    const threeKinds = owned.slice(0, 3);
    const thin = buildBundle({
      cards: [hero, ...NON_HEROES.filter((card) => card.data.hero !== hero.id), ...threeKinds],
      enchantments: PF1_ENCHANTMENTS,
    });
    expect(() => validateHeroPoolFloor(thin, DEFAULT_RULES_CONFIG)).toThrow(
      `专属卡种类 ${threeKinds.length} < 4`,
    );
  });

  test("constructed deck enforces 10 cards per hero and maxCopies=3", () => {
    const heroes = [PF1_HERO_RED.id, PF1_HERO_GREEN.id, PF1_HERO_BLUE.id];
    const deck = heroes.flatMap((hero) => {
      const ids = NON_HEROES.filter((card) => card.data.hero === hero).map((card) => card.id);
      const [a, b, c, d] = ids;
      if (a === undefined || b === undefined || c === undefined || d === undefined)
        throw new Error("fixture");
      return [a, a, a, b, b, b, c, c, c, d];
    });
    expect(() => validateConstructedDeck(BUNDLE, DEFAULT_RULES_CONFIG, heroes, deck)).not.toThrow();
    expect(() =>
      validateConstructedDeck(BUNDLE, DEFAULT_RULES_CONFIG, heroes, [
        ...deck.slice(0, 9),
        deck[0] ?? "",
        ...deck.slice(10),
      ]),
    ).toThrow("maxCopies");
  });
});
