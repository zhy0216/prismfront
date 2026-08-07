// printCard / printEnchantment 的**真 round-trip** 测试。
//
// 为什么需要它：tools/__tests__/print-card.test.ts 是「人工手写期望文本」的对照测试，
// 它只能证明输出长得像预期，证明不了输出**贴回 .ts 里还能编译、还能产出同一份 IR**。
// 两个真实 bug 就是这样溜过去的（chooseOne 的 text 被塌成裸字符串、play 被塌成裸动作）：
// 对照测试把错误输出写成了期望值，反而把 bug 锁死。
//
// 这条测试走的是闭环：
//   IR --printCard--> TS 文本 --(用 builder 的真实导出求值)--> IR' --canonicalJson--> 比对
// printer 少打一个字段、打错一个塌缩形式，这里都会红。
//
// 已知且**有意**的例外只有一个：`sel.entity`（IR §5.6 的运行时超集）。
// printer 把它打成 `Entity(id)`，而编写层刻意没有这个构造器，所以它不可贴回。
// 详见 tools/print-node.ts 的注释。本测试的语料不含 sel.entity。

import { describe, expect, test } from "bun:test";
import {
  GRID_001,
  GRID_001E,
  GRID_002,
  GRID_003,
  GRID_004,
  GRID_005,
  GRID_005E,
  GRID_006,
} from "../../__tests__/fixtures/grid-cards.ts";
import { canonicalJson } from "../../builder/canonical.ts";
import * as builder from "../../builder/index.ts";
import type { Card, Enchantment } from "../../types/index.ts";
import { printCard, printEnchantment } from "../print-card.ts";

/**
 * 把 printer 的产物当成真正的编写层源码求值。
 *
 * 做法：把 builder 的**全部导出**作为形参名注入一个函数体，再把打印出来的
 * `defineCard({...});` 去掉结尾分号当表达式返回。
 * 这等价于「把这段文本粘回一个 import 了 builder 的 .ts 文件里」——
 * 也就是 `ir:print` 这个命令承诺的用途（IR §11：调试与 admin 展示）。
 *
 * 任何 printer 用到、而 builder 没导出的名字，会在这里直接 ReferenceError。
 */
function evalAsSource<T>(source: string): T {
  const names = Object.keys(builder);
  const values = names.map((name) => (builder as Record<string, unknown>)[name]);
  const expression = source.trim().replace(/;$/, "");
  // 用 new Function 而不是 eval：这正是本测试的目的 —— 把产物当源码执行，验证它真的可贴回。
  const factory = new Function(...names, `"use strict"; return (${expression});`);
  return factory(...values) as T;
}

const CARDS: readonly (readonly [string, Card])[] = [
  ["GRID_001 斜刺长枪兵（v2 §8.1）", GRID_001],
  ["GRID_002 空袭猎手（v2 §8.2）", GRID_002],
  ["GRID_003 裂地冲锋（v2 §8.3）", GRID_003],
  ["GRID_004 换位术（v2 §8.4）", GRID_004],
  ["GRID_005 战地号手（v2 §8.5）", GRID_005],
  ["GRID_006 荆棘卫士（v2 §8.6）", GRID_006],
];

const ENCHANTMENTS: readonly (readonly [string, Enchantment])[] = [
  ["GRID_001e 斜左附魔", GRID_001E],
  ["GRID_005e 号角附魔（end_of_combat）", GRID_005E],
];

describe("printCard round-trip：产物可贴回，且产出同一份规范形式", () => {
  for (const [label, card] of CARDS) {
    test(label, () => {
      const source = printCard(card);
      const rebuilt = evalAsSource<Card>(source);
      expect(canonicalJson(rebuilt)).toBe(canonicalJson(card));
    });
  }
});

describe("printEnchantment round-trip", () => {
  for (const [label, ench] of ENCHANTMENTS) {
    test(label, () => {
      const source = printEnchantment(ench);
      const rebuilt = evalAsSource<Enchantment>(source);
      expect(canonicalJson(rebuilt)).toBe(canonicalJson(ench));
    });
  }
});

describe("round-trip 是真的在做功（反例自检）", () => {
  test("printer 少打一个字段，round-trip 必须红", () => {
    // 手工模拟「printer 漏掉 health」：从产物里删掉那一行，比对必须失败。
    const source = printCard(GRID_001);
    expect(source).toContain("health: 2,");
    const damaged = source.replace("  health: 2,\n", "");
    const rebuilt = evalAsSource<Card>(damaged);
    expect(canonicalJson(rebuilt)).not.toBe(canonicalJson(GRID_001));
  });

  test("chooseOne 的 text 塌成裸字符串会被 round-trip 抓住", () => {
    // 这正是本轮修掉的 bug：ChooseOneOption.text 是必填 LocalizedText，
    // 塌成 `text: "乙"` 会丢结构。这里直接构造受损文本验证闭环有效。
    const card = builder.defineCard({
      id: "RT_001",
      name: "回环检验",
      kind: "spell",
      colors: "blue",
      cost: 1,
      chooseOne: [
        { id: "a", text: { zh: "甲" }, play: [builder.Nothing()] },
        { id: "b", text: { zh: "乙" }, play: [builder.Nothing()] },
      ],
    });
    const source = printCard(card);
    // 正向：现在打的是对象形式，能贴回且等价
    expect(source).toContain('text: { zh: "甲" }');
    expect(canonicalJson(evalAsSource<Card>(source))).toBe(canonicalJson(card));
    // 反向：塌成裸字符串的旧行为会让求值结果不再等价
    const damaged = source.replace('text: { zh: "甲" }', 'text: "甲"');
    expect(canonicalJson(evalAsSource<Card>(damaged))).not.toBe(canonicalJson(card));
  });
});
