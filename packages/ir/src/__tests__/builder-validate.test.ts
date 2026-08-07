// 交叉测试：**builder 的产物必须能过自己的校验器**。
//
// 为什么单独立一条：T3（builder）与 T5（校验器）各自有完整的测试，但两边用的是
// 两套互不相认的语料 —— builder 侧是 __tests__/fixtures/（builder 产物），
// 校验器侧是 validate/__tests__/example-cards.ts（手写 IR）。
// 两套都绿，并不能推出「用 builder 写出来的卡能过校验」这条最基本的集成性质。
//
// 这条测试把 v2 §8 的六张示例卡装成一个真 Bundle 走一遍 validate()，
// 顺带钉住 opsUsed 与 bundle 结构。builder 的规范化只要与校验器的期望产生分歧，
// 这里就会红 —— 而那种分歧在 M4（cards 真正开始编译）时会变成成片的构建失败。

import { describe, expect, test } from "bun:test";
import type { Bundle, Card, Enchantment, NodeOp } from "../types/index.ts";
import { IR_VERSION } from "../types/index.ts";
import { validate } from "../validate/index.ts";
import {
  GRID_001,
  GRID_001E,
  GRID_005E,
  GRID_CARDS,
  GRID_ENCHANTMENTS,
} from "./fixtures/grid-cards.ts";

/** 收集一份 IR 里用到的全部 op（`bundle.opsUsed` 的来源，IR v1 §2.1）。 */
function collectOps(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectOps(item, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.op === "string") out.add(record.op);
    for (const child of Object.values(record)) collectOps(child, out);
  }
}

function bundleOf(cards: readonly Card[], enchantments: readonly Enchantment[]): Bundle {
  const ops = new Set<string>();
  collectOps(cards, ops);
  collectOps(enchantments, ops);
  return {
    irVersion: IR_VERSION,
    bundleId: "pf1-test-0001",
    // 固定时间戳：bundle 要可复现，测试里不许取当前时间。
    createdAt: "2026-08-07T00:00:00.000Z",
    opsUsed: [...ops].sort() as readonly NodeOp[],
    cards: Object.fromEntries(cards.map((card) => [card.id, card])),
    enchantments: Object.fromEntries(enchantments.map((ench) => [ench.id, ench])),
  };
}

describe("builder 产物 → validate（L1 + L2 集成）", () => {
  test("v2 §8 六张示例卡 + 两个附魔装成 bundle 后校验全过", () => {
    const result = validate(bundleOf(GRID_CARDS, GRID_ENCHANTMENTS));
    // 失败时把 issue 原样打出来，别让人再去猜哪一张卡。
    expect(result.issues.map((issue) => `${issue.path}: ${issue.message}`)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("逐张单独校验也要过（定位到具体是哪张卡的问题）", () => {
    for (const card of GRID_CARDS) {
      const enchantments = GRID_ENCHANTMENTS.filter((e) => e.id.startsWith(card.id));
      const result = validate(bundleOf([card], enchantments));
      expect({ card: card.id, issues: result.issues.map((i) => i.path) }).toEqual({
        card: card.id,
        issues: [],
      });
    }
  });

  test("★ 这条交叉测试是真的在做功：往 bundle 里塞一张坏卡必须红", () => {
    const broken = {
      ...GRID_001,
      // num.* 放进只接受 sel.* 的 target 位置 —— L2 前缀检查该抓住它。
      script: {
        play: [{ op: "act.hit", target: { op: "num.count", of: { op: "sel.self" } }, amount: 1 }],
      },
    } as unknown as Card;
    const result = validate(bundleOf([broken], [GRID_001E]));
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.some((issue) => issue.path.includes("GRID_001"))).toBe(true);
  });

  test("opsUsed 收集到的 op 与卡面实际使用一致（GRID_001 抽样）", () => {
    const bundle = bundleOf([GRID_001], [GRID_001E]);
    // v2 §8.1：play: Buff(SELF, "GRID_001e") → act.buff + sel.self
    expect(bundle.opsUsed).toContain("act.buff");
    expect(bundle.opsUsed).toContain("sel.self");
  });

  test("附魔单独装 bundle 也过（end_of_combat 这类 v2 新 duration）", () => {
    const result = validate(bundleOf([], [GRID_001E, GRID_005E]));
    expect(result.issues.map((issue) => issue.message)).toEqual([]);
  });
});
