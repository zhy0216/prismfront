// 蓝卡的单卡测试（架构 §7 测试策略第 1 层：每张卡 3 行，新增卡必须带测试）。
//
// ═══════════════════════════════════════════════════════════════════════════
// B01 是全卡表第一张带**挂起点**的卡，所以它的测试比别的多一步
// ═══════════════════════════════════════════════════════════════════════════
// `act.select_target`（IR §6.1）会让结算**停在半路**等玩家指第二个目标：
//   castCard(…)   → 结算跑到挂起点停住，`pendingInput` 置上
//   respondNow(…) → 把选择交回去，栈顶那条 `act.swap` 接着跑
// 这两步就是真实对局里"客户端弹出选择框 → 玩家点了一下"的全部，
// 不是测试特权（`respondNow` 走的是 `apply({t:"respond"})` 这个正规入口）。
//
// 引擎侧的夹具走 `@prismfront/engine/testkit`（engine 是 devDependency，
// 架构 §2.2 禁令 4：只有测试能用）。盘面不写状态字面量。

import { describe, expect, test } from "bun:test";
import {
  castCard,
  eventNames,
  handOf,
  openGame,
  putUnit,
  respondNow,
  slotOf,
} from "@prismfront/engine/testkit";
import { BLUE_CARDS, PF1_B01, PF1_B02 } from "./index.ts";

describe("蓝 · 折光学府", () => {
  test("PF1_B01 换位术 —— 1 费，两个友方单位真的换了位置（《数值基准》§6，8 vs 10 −2）", () => {
    const state = openGame();
    const [a, b] = [
      putUnit(state, 0, 0, { atk: 1, health: 1 }),
      putUnit(state, 0, 4, { atk: 2, health: 2 }),
    ];
    const done = respondNow(castCard(state, PF1_B01, { target: a }).state, b);

    // ★ 承重的是**盘面**这两条，不是事件流：`handlers/move.ts` 的 `swapHandler` 在调
    //   `swapSlots` **之前**就把两个 `fromSlot` 存下来，两条 `unit_moved` 完全由那对快照
    //   拼出 —— 把 `swapSlots` 改成直接 `return true`（谎报成功、一格不动），
    //   下面那条事件断言**一字不差地照样绿**。事件是意图的复述，盘面才是效果的回读。
    expect([slotOf(done.state, a), slotOf(done.state, b)]).toEqual([4, 0]);

    // 事件流单独钉一遍：`act.swap` 发两条 `unit_moved`（v2 §5：换位是两个单位各动了一下），
    // 顺序按签名字段 a、b。这条钉的是"这张卡接对了 act.swap 与两个目标"。
    expect(done.events.filter((event) => event.name === "unit_moved")).toEqual([
      { name: "unit_moved", target: a, fromSlot: 0, toSlot: 4 },
      { name: "unit_moved", target: b, fromSlot: 4, toSlot: 0 },
    ]);
  });

  test("★ PF1_B01 的第二个目标是挂起点：选完之前结算停住，且不能选中第一个", () => {
    const state = openGame();
    const a = putUnit(state, 0, 0, { atk: 1, health: 1 });
    const b = putUnit(state, 0, 4, { atk: 2, health: 2 });
    const cast = castCard(state, PF1_B01, { target: a });

    // 候选域是 `FRIENDLY_UNITS.not(TARGET)` ⇒ 只剩 b（自己跟自己换位不是一次选择）。
    expect(cast.state.pendingInput?.options).toEqual([b]);
    expect(eventNames(cast.events)).toEqual([]);
  });

  test("PF1_B02 引光术 —— 2 费真的抽到 2 张（《数值基准》§6 + §4 抽牌 8/张）", () => {
    const state = openGame();
    const before = handOf(state, 0).length;
    const step = castCard(state, PF1_B02);

    // `card_drawn` 逐张发（v2 §5），条数就是"抽了几张"的直接判据。
    expect(eventNames(step.events)).toEqual(["card_drawn", "card_drawn"]);
    // 手牌净增 3 = 抽到的 2 张 + `castCard` 放进去的法术本身（法术从手上打出）。
    expect(handOf(step.state, 0).length).toBe(before + 3);
  });

  test("全是蓝色单色卡（色门与色轮 lint 都以 data.colors 为准，v2.1 §11.4）", () => {
    for (const card of BLUE_CARDS) {
      expect(card.data.colors).toEqual(["blue"]);
    }
  });
});
