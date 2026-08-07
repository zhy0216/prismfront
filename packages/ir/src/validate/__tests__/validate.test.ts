// L1（结构）+ L2（前缀种类）校验器的测试。IR §7 的前两层，L3 是 M11 的事。
//
// 四组：
//   1. 正例 —— 规范里手写的 12 张示例卡（v2 §8 六张 + IR v1 §10 六个）全部通过
//   2. L2 前缀 —— 故意放错前缀，断言报错、**路径**与**期望前缀**都对（M1 完成标志第一条）
//   3. L1 结构 —— 缺字段 / 多字段 / 未知 op / 枚举越界 / 类型错 / 键与 id 不一致 …
//   4. 表由类型驱动 —— 逐个 op 生成最小合法节点，再逐个字段塞入异族节点，
//      保证「加了新 op 却忘了登记种类」这件事一定有测试兜住（另一半由编译器兜，见 schemas.ts）

import { describe, expect, test } from "bun:test";
import type { NodeOp } from "../../types/index.ts";
import { ACT_OPS, COND_OPS, IR_VERSION, NODE_OPS, NUM_OPS, SEL_OPS } from "../../types/index.ts";
import type { FieldKind, FieldSpec, ValidationResult } from "../index.ts";
import {
  assertValidBundle,
  assertValidCard,
  assertValidEnchantment,
  familyPrefixOf,
  formatIssue,
  formatIssues,
  ISSUE_CODES,
  isOptionalSpec,
  kindOfSpec,
  NODE_SCHEMAS,
  STRUCT_SCHEMAS,
  specOf,
  ValidationError,
  validate,
  validateCard,
  validateEnchantment,
  validateL1,
  validateL2,
  validateNode,
} from "../index.ts";
import {
  EXAMPLE_BUNDLE,
  EXAMPLE_ENCHANTMENTS,
  V1_EXAMPLE_CARDS,
  V2_EXAMPLE_CARDS,
} from "./example-cards.ts";

// ── 测试工具 ────────────────────────────────────────────────────────────────

/** 失败时把问题原文打出来，比 `expect(ok).toBe(true)` 好用得多。 */
const expectClean = (result: ValidationResult): void => {
  expect(formatIssues(result.issues)).toBe("");
  expect(result.ok).toBe(true);
};

/** 造一张只有 script 是变量的最小卡，用来放各种故意写坏的片段。 */
const cardWith = (script: unknown): unknown => ({
  id: "GRID_001",
  set: "pf1",
  data: { name: { zh: "测试卡" }, kind: "minion", cost: 1, colors: ["red"] },
  script,
});

const issueAt = (result: ValidationResult, path: string) =>
  result.issues.find((issue) => issue.path === path);

const codesOf = (result: ValidationResult): readonly string[] =>
  result.issues.map((issue) => issue.code);

// ── 1. 正例：规范里的示例卡 ─────────────────────────────────────────────────

describe("正例：规范示例卡的 IR 通过 L1 + L2", () => {
  for (const card of V2_EXAMPLE_CARDS) {
    test(`v2 §8 ${card.id} ${card.data.name.zh}`, () => {
      expectClean(validateCard(card));
    });
  }

  for (const card of V1_EXAMPLE_CARDS) {
    test(`IR v1 §10 ${card.id} ${card.data.name.zh}（已迁移到 2.1.0）`, () => {
      expectClean(validateCard(card));
    });
  }

  for (const enchantment of EXAMPLE_ENCHANTMENTS) {
    test(`附魔 ${enchantment.id}`, () => {
      expectClean(validateEnchantment(enchantment));
    });
  }

  test("整份 bundle（12 张卡 + 3 个附魔）通过", () => {
    expectClean(validate(EXAMPLE_BUNDLE));
  });

  test("分层单跑也通过，且 assertValidBundle 不抛", () => {
    expectClean(validateL1(EXAMPLE_BUNDLE));
    expectClean(validateL2(EXAMPLE_BUNDLE));
    assertValidBundle(EXAMPLE_BUNDLE);
  });

  test("路径以 card.<id> / enchantment.<id> 起头，不是 bundle.cards.<id>", () => {
    const broken = JSON.parse(JSON.stringify(EXAMPLE_BUNDLE)) as {
      cards: Record<string, { script: { play?: unknown } }>;
    };
    // biome-ignore lint/style/noNonNullAssertion: 固定语料，键一定在
    broken.cards.GRID_003!.script.play = [
      { op: "act.hit", target: { op: "num.count", of: { op: "sel.self" } }, amount: 2 },
    ];
    const result = validate(broken);
    expect(result.issues[0]?.path).toBe("card.GRID_003.script.play[0].target");
  });
});

// ── 2. L2 前缀种类（M1 完成标志第一条）─────────────────────────────────────

describe("L2 种类：前缀放错就报错，且指出路径与期望前缀", () => {
  test("num.* 放进 act.hit 的 target 位（IR §7 点名的例子）", () => {
    const result = validateCard(
      cardWith({
        play: [{ op: "act.hit", target: { op: "num.count", of: { op: "sel.self" } }, amount: 6 }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue?.layer).toBe("L2");
    expect(issue?.code).toBe(ISSUE_CODES.wrongSort);
    expect(issue?.path).toBe("card.GRID_001.script.play[0].target");
    expect(issue?.expected).toContain("sel.");
    expect(issue?.actual).toBe("num.count");
    // 错误信息里路径与期望前缀都要有 —— 写卡的人看这一行就够定位
    expect(issue?.message).toContain("card.GRID_001.script.play[0].target");
    expect(issue?.message).toContain("sel.*");
  });

  test("sel.* 放进 amount 位（该位置只接受 number 或 num.*）", () => {
    const result = validateCard(
      cardWith({
        play: [{ op: "act.hit", target: { op: "sel.target" }, amount: { op: "sel.self" } }],
      }),
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe("card.GRID_001.script.play[0].amount");
    expect(result.issues[0]?.expected).toContain("num.");
    expect(result.issues[0]?.message).toContain("sel.self");
  });

  test("cond.* 放进 SlotRef 位（act.move_to.to）", () => {
    const result = validateCard(
      cardWith({
        play: [
          {
            op: "act.move_to",
            target: { op: "sel.self" },
            to: { op: "cond.dead", of: { op: "sel.self" } },
          },
        ],
      }),
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe("card.GRID_001.script.play[0].to");
    expect(result.issues[0]?.expected).toContain("slot.");
  });

  test("slot.* 放进 sel 位（act.hit.target）", () => {
    const result = validateCard(
      cardWith({
        play: [{ op: "act.hit", target: { op: "slot.at", side: "enemy", index: 0 }, amount: 1 }],
      }),
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe(ISSUE_CODES.wrongSort);
    expect(result.issues[0]?.actual).toBe("slot.at");
  });

  test("sel.* 放进 CardRef 位（act.give.card）", () => {
    const result = validateCard(
      cardWith({
        play: [{ op: "act.give", player: { op: "sel.controller" }, card: { op: "sel.chosen" } }],
      }),
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe("card.GRID_001.script.play[0].card");
    expect(result.issues[0]?.expected).toContain("card.of");
  });

  test("act.discover.from 只接受 sel.* 或 card.pool：card.of 不行，card.pool 行", () => {
    const bad = validateCard(
      cardWith({ play: [{ op: "act.discover", from: { op: "card.of", of: { op: "sel.self" } } }] }),
    );
    expect(bad.issues).toHaveLength(1);
    expect(bad.issues[0]?.code).toBe(ISSUE_CODES.wrongSort);
    expect(bad.issues[0]?.expected).toContain("card.pool");

    const good = validateCard(
      cardWith({
        play: [
          {
            op: "act.discover",
            from: {
              op: "card.pool",
              filter: { op: "cond.is_kind", of: { op: "sel.it" }, kind: "spell" },
            },
          },
        ],
      }),
    );
    expectClean(good);
  });

  test("act.* 放进 cond 位（act.when.cond）", () => {
    const result = validateCard(
      cardWith({ play: [{ op: "act.when", cond: { op: "act.nothing" }, then: [] }] }),
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe("card.GRID_001.script.play[0].cond");
    expect(result.issues[0]?.expected).toContain("cond.");
  });

  test("嵌套深处也报得准（光环里的 cond.occupied.slot）", () => {
    const result = validateCard(
      cardWith({
        auras: [
          {
            affects: { op: "sel.self" },
            mods: { atk: 2 },
            cond: { op: "cond.not", of: { op: "cond.occupied", slot: { op: "sel.self" } } },
          },
        ],
      }),
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe("card.GRID_001.script.auras[0].cond.of.slot");
  });

  test("种类错的节点，它自己内部的结构错误也一并报出来（一趟修完）", () => {
    const result = validateCard(
      cardWith({
        play: [{ op: "act.hit", target: { op: "num.count" }, amount: 1 }],
      }),
    );
    expect(codesOf(result)).toContain(ISSUE_CODES.wrongSort);
    expect(codesOf(result)).toContain(ISSUE_CODES.missingField);
    expect(issueAt(result, "card.GRID_001.script.play[0].target.of")?.code).toBe(
      ISSUE_CODES.missingField,
    );
  });

  test("两层互不串味：L1 单跑不报种类错，L2 单跑不报结构错", () => {
    // 同时含一个 L1 错（多余字段）和一个 L2 错（num.* 进 target 位）
    const broken = cardWith({
      play: [
        {
          op: "act.hit",
          target: { op: "num.count", of: { op: "sel.self" } },
          amount: 1,
          bogus: true,
        },
      ],
    });
    expect(codesOf(validateCard(broken, { layers: ["L1"] }))).toEqual([ISSUE_CODES.unknownField]);
    expect(codesOf(validateCard(broken, { layers: ["L2"] }))).toEqual([ISSUE_CODES.wrongSort]);
    expect(validateCard(broken).issues).toHaveLength(2);
  });
});

// ── 3. L1 结构 ─────────────────────────────────────────────────────────────

describe("L1 结构：字段存在性、类型、枚举值", () => {
  test("必填字段缺失", () => {
    const result = validateCard(
      cardWith({ play: [{ op: "act.hit", target: { op: "sel.self" } }] }),
    );
    expect(result.ok).toBe(false);
    const issue = issueAt(result, "card.GRID_001.script.play[0].amount");
    expect(issue?.code).toBe(ISSUE_CODES.missingField);
    expect(issue?.message).toContain("必填字段缺失");
  });

  test("可选字段省略不报错（act.hit.spellDamage）", () => {
    expectClean(
      validateCard(cardWith({ play: [{ op: "act.hit", target: { op: "sel.self" }, amount: 1 }] })),
    );
  });

  test("字段名拼错 → 多余字段 + 必填缺失", () => {
    const result = validateCard(
      cardWith({ play: [{ op: "act.hit", targt: { op: "sel.self" }, amount: 1 }] }),
    );
    expect(issueAt(result, "card.GRID_001.script.play[0].targt")?.code).toBe(
      ISSUE_CODES.unknownField,
    );
    expect(issueAt(result, "card.GRID_001.script.play[0].target")?.code).toBe(
      ISSUE_CODES.missingField,
    );
  });

  test("未知 op", () => {
    const result = validateCard(
      cardWith({ play: [{ op: "act.nuke", target: { op: "sel.self" } }] }),
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe(ISSUE_CODES.unknownOp);
    expect(result.issues[0]?.message).toContain("act.nuke");
  });

  test("v1 已删的取值报枚举错：zone 的 hero（架构 §10 第 3 项）", () => {
    const result = validateCard(
      cardWith({ target: { op: "sel.zone", side: "both", zone: ["board", "hero"] } }),
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe(ISSUE_CODES.badEnum);
    expect(result.issues[0]?.path).toBe("card.GRID_001.script.target.zone[1]");
    expect(result.issues[0]?.expected).toContain("base");
  });

  test("v1 已删的事件名报枚举错：trigger.on 的 minion_died", () => {
    const result = validateCard(cardWith({ triggers: [{ on: "minion_died", do: [] }] }));
    expect(result.issues[0]?.code).toBe(ISSUE_CODES.badEnum);
    expect(result.issues[0]?.path).toBe("card.GRID_001.script.triggers[0].on");
  });

  test("类型错：amount 写成字符串", () => {
    const result = validateCard(
      cardWith({ play: [{ op: "act.hit", target: { op: "sel.self" }, amount: "6" }] }),
    );
    expect(result.issues[0]?.code).toBe(ISSUE_CODES.badType);
    expect(result.issues[0]?.actual).toContain("6");
  });

  test("act.set_flag.value 是 boolean 而不是 Num：给数字或 num.* 都报结构错", () => {
    const withNumber = validateCard(
      cardWith({
        play: [{ op: "act.set_flag", target: { op: "sel.self" }, flag: "stunned", value: 1 }],
      }),
    );
    expect(withNumber.issues[0]?.code).toBe(ISSUE_CODES.badType);

    const withNode = validateCard(
      cardWith({
        play: [
          {
            op: "act.set_flag",
            target: { op: "sel.self" },
            flag: "stunned",
            value: { op: "num.count", of: { op: "sel.self" } },
          },
        ],
      }),
    );
    expect(withNode.issues[0]?.code).toBe(ISSUE_CODES.badType);
  });

  test("数组位置给了单个节点", () => {
    const result = validateCard(cardWith({ play: { op: "act.nothing" } }));
    expect(result.issues[0]?.code).toBe(ISSUE_CODES.badType);
    expect(result.issues[0]?.path).toBe("card.GRID_001.script.play");
  });

  test("null：可空字段接受（IR §2.2 省略 ≡ null），不可空字段拒绝", () => {
    expectClean(validateCard(cardWith({ target: null, requires: null, costMod: null })));
    const result = validateCard(cardWith({ play: null }));
    expect(result.issues[0]?.code).toBe(ISSUE_CODES.badType);
  });

  test("空字符串一律视为漏填", () => {
    const result = validateCard(
      cardWith({ play: [{ op: "act.buff", target: { op: "sel.self" }, ench: "" }] }),
    );
    expect(result.issues[0]?.code).toBe(ISSUE_CODES.badString);
  });

  test("非整数与非有限数", () => {
    const fraction = validateEnchantment({
      id: "X_e",
      attachesTo: "minion",
      mods: { atk: 1.5 },
      duration: "permanent",
    });
    expect(fraction.issues[0]?.code).toBe(ISSUE_CODES.badNumber);

    const infinite = validateCard(
      cardWith({
        play: [{ op: "act.hit", target: { op: "sel.self" }, amount: Number.POSITIVE_INFINITY }],
      }),
    );
    expect(infinite.issues[0]?.code).toBe(ISSUE_CODES.badNumber);
  });

  test("键值表的键受限：mods 只能是 TagKey，trigger.filter 只能是事件实体字段", () => {
    const mods = validateEnchantment({
      id: "X_e",
      attachesTo: "minion",
      mods: { speed: 1 },
      duration: "permanent",
    });
    expect(mods.issues[0]?.code).toBe(ISSUE_CODES.unknownField);

    const filter = validateCard(
      cardWith({ triggers: [{ on: "struck", filter: { slot: { op: "sel.self" } }, do: [] }] }),
    );
    expect(filter.issues[0]?.code).toBe(ISSUE_CODES.unknownField);
    expect(filter.issues[0]?.path).toBe("card.GRID_001.script.triggers[0].filter.slot");
  });

  test("intercept.effect 按 kind 判别，未知 kind 报枚举错", () => {
    const result = validateCard(
      cardWith({ intercepts: [{ intercept: "act.hit", effect: { kind: "reflect" } }] }),
    );
    expect(result.issues[0]?.code).toBe(ISSUE_CODES.badEnum);
    expect(result.issues[0]?.path).toBe("card.GRID_001.script.intercepts[0].effect.kind");
    expect(result.issues[0]?.expected).toContain("cancel");
  });

  test("intercept.intercept 只能是 act.* 的 op", () => {
    const result = validateCard(
      cardWith({ intercepts: [{ intercept: "sel.self", effect: { kind: "cancel" } }] }),
    );
    expect(result.issues[0]?.code).toBe(ISSUE_CODES.badEnum);
  });

  test("bundle 层：irVersion 形状、createdAt 形状、cards 的键与 id 一致", () => {
    const badVersion = validate({ ...EXAMPLE_BUNDLE, irVersion: "2.1" });
    expect(badVersion.issues[0]?.code).toBe(ISSUE_CODES.badString);
    expect(badVersion.issues[0]?.path).toBe("bundle.irVersion");

    const badDate = validate({ ...EXAMPLE_BUNDLE, createdAt: "2026年8月7日" });
    expect(badDate.issues[0]?.code).toBe(ISSUE_CODES.badString);

    const mismatched = validate({
      ...EXAMPLE_BUNDLE,
      cards: { WRONG_KEY: V2_EXAMPLE_CARDS[0] },
      enchantments: {},
      opsUsed: [],
    });
    expect(mismatched.issues[0]?.code).toBe(ISSUE_CODES.keyMismatch);
    expect(mismatched.issues[0]?.path).toBe("card.WRONG_KEY.id");
  });

  test("bundle 层：opsUsed 只能装已知 op", () => {
    const result = validate({ ...EXAMPLE_BUNDLE, opsUsed: ["act.hit", "act.nuke"] });
    expect(result.issues[0]?.code).toBe(ISSUE_CODES.badEnum);
    expect(result.issues[0]?.path).toBe("bundle.opsUsed[1]");
  });

  test("根本不是对象", () => {
    for (const value of [null, 42, "bundle", [], true]) {
      const result = validate(value);
      expect(result.ok).toBe(false);
      expect(result.issues[0]?.code).toBe(ISSUE_CODES.badType);
      expect(result.issues[0]?.path).toBe("bundle");
    }
  });

  test("节点位置给了没有 op 的对象 / op 不是字符串", () => {
    const noOp = validateNode({ target: { op: "sel.self" } }, "act");
    expect(noOp.issues[0]?.code).toBe(ISSUE_CODES.missingOp);

    const numericOp = validateNode({ op: 7 }, "act");
    expect(numericOp.issues[0]?.code).toBe(ISSUE_CODES.badType);
    expect(numericOp.issues[0]?.path).toBe("node.op");
  });

  test("各种形状错误都落到 bad-type，路径指到出错的那个位置", () => {
    const cases: readonly (readonly [string, unknown, string])[] = [
      // 联合位置：SlotRef | SlotRef[] 给了数字
      [
        "sel.at.slot",
        cardWith({ target: { op: "sel.at", slot: 7 } }),
        "card.GRID_001.script.target.slot",
      ],
      // 枚举位置给了非字符串
      [
        "cond.in_zone.zone",
        cardWith({ requires: { op: "cond.in_zone", of: { op: "sel.self" }, zone: 3 } }),
        "card.GRID_001.script.requires.zone",
      ],
      // struct 位置给了标量
      ["card.data", { id: "X", set: "pf1", data: 7, script: {} }, "card.X.data"],
      // tagged 位置给了标量
      [
        "intercept.effect",
        cardWith({ intercepts: [{ intercept: "act.hit", effect: 7 }] }),
        "card.GRID_001.script.intercepts[0].effect",
      ],
      // map 位置给了数组
      [
        "trigger.filter",
        cardWith({ triggers: [{ on: "struck", filter: [], do: [] }] }),
        "card.GRID_001.script.triggers[0].filter",
      ],
      // boolean 位置给了字符串
      [
        "trigger.once",
        cardWith({ triggers: [{ on: "struck", once: "yes", do: [] }] }),
        "card.GRID_001.script.triggers[0].once",
      ],
    ];
    for (const [label, value, path] of cases) {
      const result = validateCard(value);
      expect(`${label}:${result.issues[0]?.code}`).toBe(`${label}:${ISSUE_CODES.badType}`);
      expect(`${label}:${result.issues[0]?.path}`).toBe(`${label}:${path}`);
    }
  });

  test("字面量进联合位（requires: true / costMod: 5）合法，缺判别字段与整数位写错则不合法", () => {
    expectClean(validateCard(cardWith({ requires: true, costMod: 5 })));

    const noKind = validateCard(cardWith({ intercepts: [{ intercept: "act.hit", effect: {} }] }));
    expect(noKind.issues[0]?.code).toBe(ISSUE_CODES.missingField);
    expect(noKind.issues[0]?.path).toBe("card.GRID_001.script.intercepts[0].effect.kind");

    const priority = validateCard(
      cardWith({
        intercepts: [{ intercept: "act.hit", effect: { kind: "cancel" }, priority: "high" }],
      }),
    );
    expect(priority.issues[0]?.code).toBe(ISSUE_CODES.badType);
    expect(priority.issues[0]?.path).toBe("card.GRID_001.script.intercepts[0].priority");
  });

  test("CardRef 字面量不能是空串", () => {
    const result = validateCard(
      cardWith({ play: [{ op: "act.give", player: { op: "sel.controller" }, card: "" }] }),
    );
    expect(result.issues[0]?.code).toBe(ISSUE_CODES.badString);
  });

  test("值缺失（undefined）在任何位置都报错，不会被当成省略", () => {
    const result = validateNode(undefined, "sel");
    expect(result.issues[0]?.code).toBe(ISSUE_CODES.badType);
    expect(result.issues[0]?.actual).toBe("缺失");
  });

  test("null 位（可空字段联合里的那一支）只接受 null", () => {
    expectClean(validateNode(null, "null"));
    expect(validateNode(7, "null").issues[0]?.code).toBe(ISSUE_CODES.badType);
  });

  test("附魔的断言入口：assertValidEnchantment", () => {
    assertValidEnchantment(EXAMPLE_ENCHANTMENTS[0]);
    let caught: unknown;
    try {
      assertValidEnchantment({ id: "X_e", attachesTo: "minion" });
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof ValidationError).toBe(true);
    expect((caught as ValidationError).issues[0]?.path).toBe("enchantment.X_e.duration");
  });

  test("嵌套过深时报护栏错误而不是把栈打爆", () => {
    let deep: unknown = true;
    for (let i = 0; i < 300; i += 1) deep = { op: "cond.not", of: deep };
    const result = validateNode(deep, "cond");
    expect(codesOf(result)).toContain(ISSUE_CODES.tooDeep);
  });
});

// ── 4. 表由 T1 的类型驱动 ───────────────────────────────────────────────────

const NODE_KIND_BY_PREFIX: Readonly<Record<string, FieldKind>> = {
  "sel.": "sel",
  "slot.": "slot",
  "num.": "num",
  "cond.": "cond",
  "act.": "act",
  "card.": "card",
};

/** 某个 op 该放在哪种位置上（`card.pool` 只在 `selOrPool` 位置合法）。 */
const kindForOp = (op: string): FieldKind => {
  if (op === "card.pool") return "selOrPool";
  const kind = NODE_KIND_BY_PREFIX[familyPrefixOf(op)];
  if (kind === undefined) throw new Error(`${op} 的族没有登记`);
  return kind;
};

/** 按 schema 合成一个「最小合法值」：必填字段填满，可选字段一律省略。 */
const sampleFor = (kind: FieldKind): unknown => {
  if (kind === "irVersion") return IR_VERSION;
  if (kind === "isoDate") return "2026-08-07T09:00:00.000Z";
  const spec = specOf(kind);
  switch (spec.form) {
    case "node": {
      if (spec.literal === "number") return 1;
      if (spec.literal === "boolean") return true;
      if (spec.literal === "string") return "CORE_TOKEN_01";
      const [first] = spec.ops;
      if (first === undefined) throw new Error(`${kind} 没有可用的 op`);
      return sampleNode(first);
    }
    case "list":
      return [sampleFor(spec.of)];
    case "union": {
      const [first] = spec.of;
      if (first === undefined) throw new Error(`${kind} 的联合是空的`);
      return sampleFor(first);
    }
    case "enum":
      return spec.values[0];
    case "scalar":
      return spec.type === "int" ? 1 : spec.type === "boolean" ? true : "x";
    case "struct":
      return sampleObject(STRUCT_SCHEMAS[kind as keyof typeof STRUCT_SCHEMAS], {});
    case "tagged":
      return { [spec.tag]: "cancel" };
    case "map":
      return {};
    case "null":
      return null;
    default:
      throw new Error(`没有为 ${kind} 准备样本`);
  }
};

const sampleObject = (
  schema: Readonly<Record<string, FieldSpec>>,
  seed: Record<string, unknown>,
): Record<string, unknown> => {
  const value: Record<string, unknown> = { ...seed };
  for (const [key, spec] of Object.entries(schema)) {
    if (isOptionalSpec(spec)) continue;
    value[key] = sampleFor(kindOfSpec(spec));
  }
  return value;
};

const sampleNode = (op: NodeOp): Record<string, unknown> => sampleObject(NODE_SCHEMAS[op], { op });

/** 这个字段位置吃不吃节点？吃的话给出期望的种类与路径后缀。 */
const nodePositionOf = (spec: FieldSpec): { kind: FieldKind; suffix: string } | undefined => {
  const kind = kindOfSpec(spec);
  const resolved = specOf(kind);
  if (resolved.form === "node") return { kind, suffix: "" };
  if (resolved.form === "list" && specOf(resolved.of).form === "node") {
    return { kind: resolved.of, suffix: "[0]" };
  }
  if (resolved.form === "union") {
    for (const member of resolved.of) {
      if (specOf(member).form === "node") return { kind: member, suffix: "" };
    }
  }
  return undefined;
};

/** 一个**必然放错**的节点：sel 位塞 num.*，其余位塞 sel.self。 */
const foreignNodeFor = (kind: FieldKind): Record<string, unknown> =>
  kind === "sel" || kind === "selOrPool"
    ? { op: "num.count", of: { op: "sel.self" } }
    : { op: "sel.self" };

describe("「字段 → 种类」表由 T1 的类型驱动", () => {
  test("每个 op 都登记了字段表，且没有多登记", () => {
    expect(Object.keys(NODE_SCHEMAS).sort()).toEqual([...NODE_OPS].sort());
  });

  test("KIND_SPECS 的节点族与 types/ops.ts 的 op 全集一致", () => {
    const nodeOpsOf = (kind: FieldKind): readonly string[] => {
      const spec = specOf(kind);
      return spec.form === "node" ? [...spec.ops].sort() : [];
    };
    expect(nodeOpsOf("sel")).toEqual([...SEL_OPS].sort());
    expect(nodeOpsOf("num")).toEqual([...NUM_OPS].sort());
    expect(nodeOpsOf("cond")).toEqual([...COND_OPS].sort());
    expect(nodeOpsOf("act")).toEqual([...ACT_OPS].sort());
    // 卡牌引用位不接受 card.pool（那是发现/随机的卡池，只在 selOrPool 位合法）
    expect(nodeOpsOf("card")).toEqual(["card.of", "card.random"]);
    expect(nodeOpsOf("selOrPool")).toContain("card.pool");
  });

  test("每个 op 的最小合法节点都能过校验（覆盖全部 op，新增 op 自动纳入）", () => {
    const failures: string[] = [];
    for (const op of NODE_OPS) {
      const result = validateNode(sampleNode(op), kindForOp(op));
      if (!result.ok) failures.push(`${op}\n${formatIssues(result.issues)}`);
    }
    expect(failures.join("\n")).toBe("");
  });

  test("每个节点字段塞入异族节点都会报 L2 错，且路径指到该字段", () => {
    const failures: string[] = [];
    let checked = 0;
    for (const op of NODE_OPS) {
      for (const [key, spec] of Object.entries(NODE_SCHEMAS[op])) {
        const position = nodePositionOf(spec);
        if (position === undefined) continue;
        checked += 1;
        const node = sampleNode(op);
        const foreign = foreignNodeFor(position.kind);
        node[key] = position.suffix === "" ? foreign : [foreign];
        const result = validateNode(node, kindForOp(op));
        const path = `node.${key}${position.suffix}`;
        const hit = result.issues.find(
          (issue) => issue.path === path && issue.code === ISSUE_CODES.wrongSort,
        );
        if (hit === undefined) {
          failures.push(`${op}.${key} 未报 wrong-sort：\n${formatIssues(result.issues)}`);
        }
      }
    }
    // 数字本身不重要，但它保证这个循环真的在检查东西（而不是一个字段都没匹配上）
    expect(checked).toBeGreaterThan(60);
    expect(failures.join("\n")).toBe("");
  });

  test("合成的 bundle / card 结构也自洽（struct 表覆盖到）", () => {
    expectClean(validate(sampleFor("bundle")));
    expectClean(validateCard(sampleFor("cardDoc")));
  });
});

// ── 5. 错误对象本身 ─────────────────────────────────────────────────────────

describe("错误对象：带路径与原因，不是一个布尔", () => {
  test("formatIssue 带层、代码与整句说明", () => {
    const result = validateCard(
      cardWith({
        play: [{ op: "act.hit", target: { op: "num.count", of: { op: "sel.self" } }, amount: 1 }],
      }),
    );
    // biome-ignore lint/style/noNonNullAssertion: 上一行必然产生一条问题
    const line = formatIssue(result.issues[0]!);
    expect(line).toContain("[L2 wrong-sort]");
    expect(line).toContain("card.GRID_001.script.play[0].target");
  });

  test("assertValidCard 失败时抛 ValidationError，issues 原样带着", () => {
    let caught: unknown;
    try {
      assertValidCard(cardWith({ play: [{ op: "act.hit", target: { op: "sel.self" } }] }));
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof ValidationError).toBe(true);
    const error = caught as ValidationError;
    expect(error.issues[0]?.code).toBe(ISSUE_CODES.missingField);
    expect(error.message).toContain("card.GRID_001");
  });

  test("validateNode 可以单独校验一个节点，默认路径是 node", () => {
    const result = validateNode({ op: "sel.self" }, "num");
    expect(result.issues[0]?.path).toBe("node");
    expect(result.issues[0]?.layer).toBe("L2");
  });

  test("path 选项可以换根前缀（M4 构建流程按自己的语境报错）", () => {
    const result = validateNode({ op: "sel.self" }, "num", {
      path: "cards/pf1/R/fireball.ts:play",
    });
    expect(result.issues[0]?.path).toBe("cards/pf1/R/fireball.ts:play");
  });

  test("非标识符的键用方括号引号，路径不会有歧义", () => {
    const result = validate({
      ...EXAMPLE_BUNDLE,
      cards: { "weird id": { ...V2_EXAMPLE_CARDS[0], id: "weird id", set: 7 } },
      enchantments: {},
      opsUsed: [],
    });
    expect(result.issues[0]?.path).toBe('card["weird id"].set');
  });
});
