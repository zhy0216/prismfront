import { describe, expect, test } from "bun:test";
import { validateCard, validateL3 } from "../index.ts";
import { EXAMPLE_BUNDLE, V2_EXAMPLE_CARDS } from "./example-cards.ts";

const baseCard = V2_EXAMPLE_CARDS.find((card) => card.id === "GRID_001");
if (baseCard === undefined) throw new Error("缺少 GRID_001 测试卡");

const bundleWith = (script: unknown) => ({
  ...EXAMPLE_BUNDLE,
  cards: {
    [baseCard.id]: {
      ...baseCard,
      data: { ...baseCard.data, kind: "token", colors: [], collectible: false, hero: undefined },
      script,
    },
  },
  enchantments: {},
});

const issueAt = (result: ReturnType<typeof validateL3>, path: string) =>
  result.issues.find((issue) => issue.path === path);

describe("L3 v2 语义校验", () => {
  test("slot.at 的字面量 index 在 0 到 8 时通过", () => {
    const result = validateL3(
      bundleWith({
        play: [
          {
            op: "act.move_to",
            target: { op: "sel.self" },
            to: { op: "slot.at", side: "friendly", index: 8 },
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("slot.at 的字面量 index 越界时报错，表达式 index 跳过", () => {
    const bad = validateL3(
      bundleWith({
        play: [
          {
            op: "act.move_to",
            target: { op: "sel.self" },
            to: { op: "slot.at", side: "friendly", index: 9 },
          },
        ],
      }),
    );
    expect(issueAt(bad, "card.GRID_001.script.play[0].to.index")?.message).toContain("[0, 8]");

    const good = validateL3(
      bundleWith({
        play: [
          {
            op: "act.move_to",
            target: { op: "sel.self" },
            to: {
              op: "slot.at",
              side: "friendly",
              index: { op: "num.slot_index", of: { op: "sel.self" } },
            },
          },
        ],
      }),
    );
    expect(good.ok).toBe(true);
  });

  test("act.shift 的字面量 delta 为 0 告警，非零通过", () => {
    const warning = validateL3(
      bundleWith({ play: [{ op: "act.shift", target: { op: "sel.self" }, delta: 0 }] }),
    );
    expect(issueAt(warning, "card.GRID_001.script.play[0].delta")?.severity).toBe("warning");

    const valid = validateL3(
      bundleWith({ play: [{ op: "act.shift", target: { op: "sel.self" }, delta: 1 }] }),
    );
    expect(valid.ok).toBe(true);
  });

  test("已删除 trigger.on 报错并给出迁移映射，合法事件通过", () => {
    const deleted = [
      ["turn_began", "round_began"],
      ["turn_ended", "round_ended"],
      ["minion_summoned", "unit_summoned"],
      ["minion_died", "unit_died"],
      ["mana_spent", undefined],
      ["weapon_equipped", undefined],
      ["attacked", undefined],
      ["attack_declared", "struck"],
    ] as const;
    for (const [event, replacement] of deleted) {
      const bad = validateL3(bundleWith({ triggers: [{ on: event, do: [] }] }));
      const hit = bad.issues.find((issue) => issue.path === "card.GRID_001.script.triggers[0].on");
      expect(hit).toBeDefined();
      if (replacement !== undefined) expect(hit?.message).toContain(replacement);
    }

    const good = validateL3(bundleWith({ triggers: [{ on: "round_began", do: [] }] }));
    expect(good.ok).toBe(true);
  });

  test("非 minion 附魔使用 direction 告警，minion 附魔通过", () => {
    const bad = validateL3({
      ...bundleWith({}),
      enchantments: {
        TEST_e: {
          id: "TEST_e",
          attachesTo: "spell",
          mods: { direction: 1 },
          duration: "permanent",
        },
      },
    });
    expect(issueAt(bad, "enchantment.TEST_e.mods.direction")?.severity).toBe("warning");

    const good = validateL3({
      ...bundleWith({}),
      enchantments: {
        TEST_e: {
          id: "TEST_e",
          attachesTo: "minion",
          mods: { direction: 1 },
          duration: "permanent",
        },
      },
    });
    expect(good.ok).toBe(true);
  });
});

describe("L3 资源上限", () => {
  test("单卡节点数 512 以内通过，513 个节点报错", () => {
    const make = (count: number) => ({
      play: Array.from({ length: count }, () => ({ op: "act.nothing" })),
    });
    expect(validateL3(bundleWith(make(512))).ok).toBe(true);
    expect(issueAt(validateL3(bundleWith(make(513))), "card.GRID_001")).toBeDefined();
  });

  test("表达式深度 32 以内通过，33 层报错", () => {
    const make = (depth: number) => {
      let expression: unknown = true;
      for (let index = 0; index < depth; index += 1)
        expression = { op: "cond.not", of: expression };
      return { requires: expression };
    };
    expect(validateL3(bundleWith(make(32))).ok).toBe(true);
    expect(issueAt(validateL3(bundleWith(make(33))), "card.GRID_001")).toBeDefined();
  });

  test("表达式深度只计表达式节点，动作容器嵌套不增加深度", () => {
    const make = (actionNesting: number) => {
      let inner: unknown = { op: "act.nothing" };
      for (let index = 0; index < actionNesting; index += 1)
        inner = { op: "act.when", cond: true, then: [inner] };
      let expression: unknown = true;
      for (let index = 0; index < 32; index += 1) expression = { op: "cond.not", of: expression };
      return { requires: expression, play: [inner] };
    };
    // 32 层表达式外面再套 32 层 act.when：动作容器不计表达式深度，仍应通过。
    expect(validateL3(bundleWith(make(32))).ok).toBe(true);
    // 表达式本身 33 层时仍然报错。
    const over = () => {
      let expression: unknown = true;
      for (let index = 0; index < 33; index += 1) expression = { op: "cond.not", of: expression };
      return { requires: expression };
    };
    expect(issueAt(validateL3(bundleWith(over())), "card.GRID_001")).toBeDefined();
  });

  test("act.repeat.n 字面量不超过 64 通过，65 报错", () => {
    const make = (n: number) => ({ play: [{ op: "act.repeat", n, do: [] }] });
    expect(validateL3(bundleWith(make(64))).ok).toBe(true);
    expect(
      issueAt(validateL3(bundleWith(make(65))), "card.GRID_001.script.play[0].n"),
    ).toBeDefined();
  });

  test("单卡拦截器数量不限——链长由引擎运行时按实际应用层数强制", () => {
    // IR §7 的「拦截器链长度 ≤ 8」计的是运行时真正应用了几条拦截器
    // （engine MAX_INTERCEPT_CHAIN）；静态看单卡 intercepts 数组长度会误报
    // （多个拦截器可能只有一条命中），因此 bundle 校验对数量不设上限。
    const make = (count: number) => ({
      intercepts: Array.from({ length: count }, () => ({
        intercept: "act.hit",
        effect: { kind: "cancel" },
      })),
    });
    expect(validateL3(bundleWith(make(9))).ok).toBe(true);
  });
});

describe("L1 英雄卡约束", () => {
  test("hero 必须恰好一个颜色、不得有 cost、collectible 必须为 false", () => {
    const card = {
      ...baseCard,
      data: {
        ...baseCard.data,
        kind: "hero",
        colors: ["red", "blue"],
        cost: 1,
        collectible: true,
      },
    };
    const result = validateCard(card);
    expect(result.issues.some((issue) => issue.path === "card.GRID_001.data.colors")).toBe(true);
    expect(result.issues.some((issue) => issue.path === "card.GRID_001.data.cost")).toBe(true);
    expect(result.issues.some((issue) => issue.path === "card.GRID_001.data.collectible")).toBe(
      true,
    );
  });

  test("合法 hero 的颜色、cost 与 collectible 约束通过", () => {
    const { cost: _cost, ...heroData } = baseCard.data;
    const card = {
      ...baseCard,
      data: { ...heroData, kind: "hero", colors: ["red"], collectible: false },
    };
    expect(validateCard(card).ok).toBe(true);
  });
});
