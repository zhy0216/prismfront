// `collectOps` 的测试 —— `bundle.opsUsed`（IR §2.1）的收集器。
//
// 四件事要钉住：
//   1. 收的是**真正出现在树里**的 op，藏多深都要收到
//   2. `opsUsed` 字段本身不算数（它是 op 名字的清单，不是节点）—— 否则收集器会自我证明
//   3. 未知 op 不收（`opsUsed` 的类型是 `NodeOp[]`）
//   4. 收集不产出 issue，校验也不受收集影响（两条路各跑各的）

import { describe, expect, test } from "bun:test";
import type { Bundle, Card } from "../../types/index.ts";
import { collectOps, validate } from "../index.ts";
import { EXAMPLE_BUNDLE } from "./example-cards.ts";

/** 节点埋在 `act.when.then` 里的一张卡：浅层遍历会漏掉 `num.count` 与 `sel.zone`。 */
const NESTED: Card = {
  id: "OPS_001",
  set: "pf1",
  data: { name: { zh: "嵌套测试" }, kind: "spell", cost: 1, colors: ["blue"] },
  script: {
    play: [
      {
        op: "act.when",
        cond: {
          op: "cond.gte",
          l: { op: "num.count", of: { op: "sel.zone", side: "friendly", zone: "board" } },
          r: 2,
        },
        then: [{ op: "act.draw", player: { op: "sel.controller" }, count: 1 }],
      },
    ],
  },
};

describe("collectOps", () => {
  test("藏在 act.when.then 里的 op 一个都不漏", () => {
    expect([...collectOps(NESTED, "cardDoc")].sort()).toEqual([
      "act.draw",
      "act.when",
      "cond.gte",
      "num.count",
      "sel.controller",
      "sel.zone",
    ]);
  });

  test("整份 bundle 扫出来的集合 = 该 bundle 自己声明的 opsUsed", () => {
    expect([...collectOps(EXAMPLE_BUNDLE, "bundle")].sort()).toEqual([...EXAMPLE_BUNDLE.opsUsed]);
  });

  test("★ 不把 opsUsed 字段自己算进去（否则收集器在自我证明）", () => {
    const lying: Bundle = { ...EXAMPLE_BUNDLE, cards: {}, enchantments: {} };
    expect(lying.opsUsed.length).toBeGreaterThan(0);
    expect([...collectOps(lying, "bundle")]).toEqual([]);
  });

  test("未知 op 不收（opsUsed 只装 NodeOp）", () => {
    const broken = { op: "act.nuke", target: { op: "sel.self" } };
    expect([...collectOps(broken, "act")]).toEqual([]);
  });

  test("into 可跨多次调用累积（逐卡收集就是这么用的）", () => {
    const acc = collectOps(NESTED, "cardDoc");
    collectOps({ op: "sel.self" }, "sel", acc);
    expect(acc.has("sel.self")).toBe(true);
    expect(acc.has("act.when")).toBe(true);
  });

  test("收集不产出 issue，也不影响 validate 的结论", () => {
    collectOps(EXAMPLE_BUNDLE, "bundle");
    expect(validate(EXAMPLE_BUNDLE).issues).toEqual([]);
  });
});
