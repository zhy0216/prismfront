// M12 三套预构筑（决策 #7/#12 定案，见 todos/M12-平衡闭环.md）：
// 配额制下每名英雄恰好 10 张、同名 ≤3，英雄阵容恒为红+绿+蓝。
// 三套按曲线与份数策略区分，监控对象是每卡 pick 率与份数分布。
//
// 构造规则（validateConstructedDeck 强制）：30 张、每英雄恰好 10 张、
// 每张卡 hero ∈ 所选英雄、同名 ≤ maxCopies。

import type { CardId } from "@prismfront/ir";

export type PresetName = "concentrated" | "spread" | "mixed";

export const PRESET_NAMES = [
  "concentrated",
  "spread",
  "mixed",
] as const satisfies readonly PresetName[];

/**
 * 三套预构筑的每色 10 张清单（每色恰好 10 张槽位，含份数）。
 */
export const PF1_PRESETS: Record<
  PresetName,
  { readonly hero: CardId; readonly kinds: readonly (readonly [CardId, number])[] }[]
> = {
  // 低曲线抢节奏：每色 3 种 × 3 份 + 1 种 × 1 份，抽得极稳。
  concentrated: [
    {
      hero: "PF1_HERO_RED",
      kinds: [
        ["PF1_R01", 3],
        ["PF1_R02", 3],
        ["PF1_R04", 3],
        ["PF1_R10", 1],
      ],
    },
    {
      hero: "PF1_HERO_GREEN",
      kinds: [
        ["PF1_G01", 3],
        ["PF1_G02", 3],
        ["PF1_G03", 3],
        ["PF1_G10", 1],
      ],
    },
    {
      hero: "PF1_HERO_BLUE",
      kinds: [
        ["PF1_B06", 3],
        ["PF1_B07", 3],
        ["PF1_B08", 3],
        ["PF1_B02", 1],
      ],
    },
  ],
  // 覆盖全曲线：每色 8-10 种 × 1-2 份，后期强、起手方差大。
  spread: [
    {
      hero: "PF1_HERO_RED",
      kinds: [
        ["PF1_R01", 1],
        ["PF1_R02", 1],
        ["PF1_R03", 1],
        ["PF1_R04", 1],
        ["PF1_R05", 1],
        ["PF1_R06", 1],
        ["PF1_R07", 1],
        ["PF1_R08", 1],
        ["PF1_R09", 2],
      ],
    },
    {
      hero: "PF1_HERO_GREEN",
      kinds: [
        ["PF1_G01", 1],
        ["PF1_G02", 1],
        ["PF1_G03", 1],
        ["PF1_G04", 1],
        ["PF1_G05", 1],
        ["PF1_G06", 1],
        ["PF1_G07", 1],
        ["PF1_G09", 1],
        ["PF1_G10", 1],
        ["PF1_G12", 1],
      ],
    },
    {
      hero: "PF1_HERO_BLUE",
      kinds: [
        ["PF1_B01", 1],
        ["PF1_B02", 1],
        ["PF1_B03", 1],
        ["PF1_B04", 1],
        ["PF1_B05", 1],
        ["PF1_B06", 1],
        ["PF1_B07", 1],
        ["PF1_B08", 1],
        ["PF1_B09", 1],
        ["PF1_B10", 1],
      ],
    },
  ],
  // 每色压 2 张关键牌 × 3 份，其余摊开。
  mixed: [
    {
      hero: "PF1_HERO_RED",
      kinds: [
        ["PF1_R03", 3],
        ["PF1_R09", 3],
        ["PF1_R01", 1],
        ["PF1_R02", 1],
        ["PF1_R04", 1],
        ["PF1_R07", 1],
      ],
    },
    {
      hero: "PF1_HERO_GREEN",
      kinds: [
        ["PF1_G03", 3],
        ["PF1_G04", 3],
        ["PF1_G01", 1],
        ["PF1_G02", 1],
        ["PF1_G10", 1],
        ["PF1_G12", 1],
      ],
    },
    {
      hero: "PF1_HERO_BLUE",
      kinds: [
        ["PF1_B05", 3],
        ["PF1_B10", 3],
        ["PF1_B02", 1],
        ["PF1_B07", 1],
        ["PF1_B08", 1],
        ["PF1_B09", 1],
      ],
    },
  ],
};

/** 把一份预构筑展开成 30 张的卡组 id 列表（每英雄 10 张）。 */
export function presetDeck(preset: PresetName): readonly CardId[] {
  const deck: CardId[] = [];
  for (const color of PF1_PRESETS[preset]) {
    for (const [cardId, copies] of color.kinds) {
      for (let index = 0; index < copies; index += 1) deck.push(cardId);
    }
  }
  return deck;
}

/** 预构筑固定的英雄阵容（决策 #11 下 PF1 阵容唯一）。 */
export const PRESET_HEROES: readonly [readonly CardId[], readonly CardId[]] = [
  ["PF1_HERO_RED", "PF1_HERO_GREEN", "PF1_HERO_BLUE"],
  ["PF1_HERO_RED", "PF1_HERO_GREEN", "PF1_HERO_BLUE"],
];
