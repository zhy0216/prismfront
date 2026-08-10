// 预构筑的合法性：三套都必须通过构筑校验
// （30 张、每英雄恰好 10 张、同名 ≤ maxCopies、卡归属所选英雄）。

import { describe, expect, test } from "bun:test";
import { DEFAULT_RULES_CONFIG } from "@prismfront/ir";
import { buildBundle, validateConstructedDeck } from "../index.ts";
import { PF1_CARDS, PF1_ENCHANTMENTS } from "./index.ts";
import { PF1_PRESETS, PRESET_HEROES, PRESET_NAMES, presetDeck } from "./presets.ts";

const BUNDLE = buildBundle({ cards: PF1_CARDS, enchantments: PF1_ENCHANTMENTS });

describe("PF1 预构筑", () => {
  test("每套展开后都是合法构筑：30 张、每英雄 10 张、同名不超限", () => {
    for (const name of PRESET_NAMES) {
      const deck = presetDeck(name);
      expect(deck).toHaveLength(DEFAULT_RULES_CONFIG.deck.size);
      expect(() =>
        validateConstructedDeck(BUNDLE, DEFAULT_RULES_CONFIG, PRESET_HEROES[0], deck),
      ).not.toThrow();
      for (const { hero, kinds } of PF1_PRESETS[name]) {
        expect(PRESET_HEROES[0]).toContain(hero);
        const heroCopies = kinds.reduce((sum, [, copies]) => sum + copies, 0);
        expect(heroCopies).toBe(10);
        for (const [, copies] of kinds) {
          expect(copies <= DEFAULT_RULES_CONFIG.deck.maxCopies).toBe(true);
        }
      }
    }
  });

  test("双方英雄阵容一致且三名互不相同（allowDuplicates=false）", () => {
    expect(PRESET_HEROES[0]).toEqual(PRESET_HEROES[1]);
    expect(new Set(PRESET_HEROES[0]).size).toBe(PRESET_HEROES[0].length);
  });
});
