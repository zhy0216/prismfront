// 绿卡的单卡测试（架构 §7 测试策略第 1 层：每张卡 3 行，新增卡必须带测试）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 净水卡要测什么 —— 不是"数字写对了"，是"这副身板真的打得出那么多"
// ═══════════════════════════════════════════════════════════════════════════
// G01–G05 是《数值基准》§8 第 1 条的**标尺卡，永不改**，全套定价公式以它们为刻度，
// 所以卡面三个数字必须逐字钉住。但只钉数字是不够的：数字对、上场之后打不出伤害，
// 卡表照样是坏的。所以每张卡还要真的**摆上场打一次战斗** —— 对面空着，
// 出手落在敌方基地上（v2 §4.2：目标格越界或为空 → 敌方基地），基地掉的血就该等于卡面攻击力。
//
// 引擎侧的夹具走 `@prismfront/engine/testkit`（engine 是 devDependency，
// 架构 §2.2 禁令 4：**只有测试能用**，`src/` 的其余文件一行都不许 import 它）。
// 盘面不写状态字面量，卡面也不手抄一遍 —— `cardFace(卡)` 直接取这张卡自己的数值，
// 抄错了断言照样绿是最坏的情形。

import { describe, expect, test } from "bun:test";
import {
  baseIdOf,
  cardFace,
  damageOf,
  fightOnce,
  openGame,
  putUnit,
} from "@prismfront/engine/testkit";
import type { Card } from "@prismfront/ir";
import { GREEN_CARDS, PF1_G01, PF1_G02, PF1_G03, PF1_G04, PF1_G05 } from "./index.ts";

/**
 * 一张净水随从的完整验收：卡面三个数字 + **上场之后真的打得出那么多伤害**。
 *
 * 三步 = 建局 → 打出这张卡（净水随从的"打出"就是上场）→ 断言血量。
 * `putUnit` 落在与真实上场同一条 `placeOnSlot` 上（testkit 的说明），
 * 所以这不是"绕过引擎的假上场"。
 */
function expectVanilla(card: Card, cost: number, atk: number, health: number): void {
  expect(card.data.cost).toBe(cost);
  expect(card.data.tags).toEqual({ atk, health });
  expect(card.script).toEqual({});

  const state = openGame();
  putUnit(state, 0, 0, cardFace(card));
  expect(damageOf(fightOnce(state).state, baseIdOf(state, 1))).toBe(atk);
}

describe("绿 · 翠冠议会", () => {
  test("PF1_G01 新芽树裔 —— 1 费 2/2 净水（《数值基准》§6 标尺，10 = 10 ✓）", () => {
    expectVanilla(PF1_G01, 1, 2, 2);
  });

  test("PF1_G02 巡林木灵 —— 2 费 3/3 净水（《数值基准》§6 标尺，15 = 15 ✓）", () => {
    expectVanilla(PF1_G02, 2, 3, 3);
  });

  test("PF1_G03 林海巨兽 —— 3 费 4/4 净水（《数值基准》§6 全游戏基准，20 = 20 ✓）", () => {
    expectVanilla(PF1_G03, 3, 4, 4);
  });

  test("PF1_G04 苔背巨鹿 —— 4 费 5/5 净水（《数值基准》§6 标尺，25 = 25 ✓）", () => {
    expectVanilla(PF1_G04, 4, 5, 5);
  });

  test("PF1_G05 擎天古木 —— 6 费 7/7 净水（《数值基准》§6 标尺，35 = 35 ✓）", () => {
    expectVanilla(PF1_G05, 6, 7, 7);
  });

  test("五张标尺连成一条线：净水曲线恒为 (c+1)/(c+1)（《数值基准》§1.1 绿的形状）", () => {
    // 一条式子把 §6 绿净水那五行整体钉住：任何一张被改动，这里立刻红。
    // §6 绿表**没有 5 费净水**（那一格给了 G09 光环卡），所以费用序列有跳档。
    expect(
      GREEN_CARDS.slice(0, 5).map((card) => [
        card.data.cost,
        card.data.tags?.atk,
        card.data.tags?.health,
      ]),
    ).toEqual([
      [1, 2, 2],
      [2, 3, 3],
      [3, 4, 4],
      [4, 5, 5],
      [6, 7, 7],
    ]);
  });

  test("全是绿色单色卡（色门与色轮 lint 都以 data.colors 为准，v2.1 §11.4）", () => {
    for (const card of GREEN_CARDS) {
      expect(card.data.colors).toEqual(["green"]);
    }
  });
});
