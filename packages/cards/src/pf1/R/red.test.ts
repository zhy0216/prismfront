// 红卡的单卡测试（架构 §7 测试策略第 1 层：每张卡 3 行，新增卡必须带测试）。
//
// ═══════════════════════════════════════════════════════════════════════════
// R07 与 R09 是一对**只差目标域**的卡，所以两组断言必须成对读
// ═══════════════════════════════════════════════════════════════════════════
// 《数值基准》§4 价格表把直伤拆成两行：「限单位 4/伤」与「任意目标（可打脸）4.5/伤」。
// 在 IR 里这两行的区别只有 `script.target` 一个字段：
//   R07 `ALL_UNITS`     = sel.zone(both, "board")            —— 基地不在域里
//   R09 `ANY_CHARACTER` = sel.zone(both, ["board","base"])   —— 基地在域里
// 所以每张卡两条测试：一条是**伤害真的打出去了**（跑引擎），
// 一条是**目标域逐字对**（钉住那半分钱差价的唯一载体）。
//
// 引擎侧的夹具走 `@prismfront/engine/testkit`（engine 是 devDependency，
// 架构 §2.2 禁令 4：只有测试能用）。盘面不写状态字面量。

import { describe, expect, test } from "bun:test";
import {
  baseIdOf,
  cardFace,
  castCard,
  damageOf,
  fightOnce,
  openGame,
  putUnit,
} from "@prismfront/engine/testkit";
import { PF1_R01, PF1_R07, PF1_R09, RED_CARDS } from "./index.ts";

describe("红 · 燎火汗庭", () => {
  test("PF1_R01 烬鬃斥候 —— 1 费 3/1 净水攻偏（《数值基准》§6 标尺，11 vs 10 +1）", () => {
    expect(PF1_R01.data.cost).toBe(1);
    expect(PF1_R01.data.tags).toEqual({ atk: 3, health: 1 });
    expect(PF1_R01.script).toEqual({});

    // 建局 → 摆上场（净水随从的"打出"就是上场）→ 打一次战斗：
    // 对面空着 ⇒ 出手落在敌方基地上（v2 §4.2），掉的血就是卡面攻击力。
    const state = openGame();
    putUnit(state, 0, 0, cardFace(PF1_R01));
    expect(damageOf(fightOnce(state).state, baseIdOf(state, 1))).toBe(3);
  });

  test("PF1_R07 灼刺 —— 1 费法术，对一个单位打 3 点（《数值基准》§6，12 vs 10 +2 边界）", () => {
    const state = openGame();
    const victim = putUnit(state, 1, 0, { atk: 1, health: 9 });
    expect(damageOf(castCard(state, PF1_R07, { target: victim }).state, victim)).toBe(3);
  });

  test("★ PF1_R07 的「限单位」= 目标域里没有 base 区（不是在 act 里判）", () => {
    expect(PF1_R07.script.target).toEqual({ op: "sel.zone", side: "both", zone: "board" });
  });

  test("PF1_R09 火球术 —— 4 费 6 伤，**能打脸**（《数值基准》§6 + §4 换算示例）", () => {
    const state = openGame();
    const enemyBase = baseIdOf(state, 1);
    expect(damageOf(castCard(state, PF1_R09, { target: enemyBase }).state, enemyBase)).toBe(6);
  });

  test("★ PF1_R09 的「任意目标」= 目标域多了 base 区（与 R07 的唯一区别）", () => {
    expect(PF1_R09.script.target).toEqual({
      op: "sel.zone",
      side: "both",
      zone: ["board", "base"],
    });
  });

  test("全是红色单色卡（色门与色轮 lint 都以 data.colors 为准，v2.1 §11.4）", () => {
    for (const card of RED_CARDS) {
      expect(card.data.colors).toEqual(["red"]);
    }
  });
});
