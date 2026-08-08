// IR 权威类型的守门测试。
//
// 两类断言：
//   1. 架构 §10 的六项规范一致性清理 —— 每项一条，回写规范时照着改
//   2. op / 事件词汇表 —— 数量、前缀、v1 已删项，防止 M2+ 悄悄加回来
//   3. 规范里手写的示例 IR 逐个用权威类型标注一遍 —— 类型表达不了示例即为失败

import { describe, expect, test } from "bun:test";
import type { Act, Aura, Card, CardScript, Enchantment, Intercept, Trigger } from "../index.ts";
import {
  ACT_OP_SET,
  ACT_OPS,
  CARD_OPS,
  COND_OPS,
  DEFAULT_RULES_CONFIG,
  EVENT_NAMES,
  FLAG_NAMES,
  IR_VERSION,
  IR_VERSION_MAJOR,
  NODE_OP_PREFIXES,
  NODE_OPS,
  NUM_OPS,
  SEL_OPS,
  SEL_SIDES,
  SLOT_OPS,
  SLOT_SIDES,
  ZONE_NAMES,
} from "../index.ts";

describe("架构 §10 规范一致性清理", () => {
  test("第 1 项：irVersion 基线定为 2.1.0（v2 §0 的 2.0.0 作废），今天是两次 minor bump 后的 2.3.0", () => {
    // 2.1.0 → 2.2.0：决策 #9 新增 `cond.has_color`（IR §8「新增 op = minor」）。
    // 2.2.0 → 2.3.0：M5/T5 给 `act.strike` 加运行时超集字段 `amount`
    //   —— 既有 bundle 的字节与含义一字未变，缺省语义也没动，理由写在 ir-version.ts。
    // 两次都没碰既有文档的读法，所以 major 恒为 2（engine 的拒载判据不受影响）。
    expect(IR_VERSION).toBe("2.3.0");
    expect(IR_VERSION_MAJOR).toBe(2);
    expect(IR_VERSION.startsWith(`${IR_VERSION_MAJOR}.`)).toBe(true);
  });

  test("第 2 项：RulesConfig 的 heroHp 改名 baseHp", () => {
    expect(DEFAULT_RULES_CONFIG.baseHp).toBe(30);
    expect(Object.hasOwn(DEFAULT_RULES_CONFIG, "heroHp")).toBe(false);
  });

  test("第 3 项：ZoneName 补齐 base / fountain，删掉 hero 旧义", () => {
    expect(ZONE_NAMES).toContain("base");
    expect(ZONE_NAMES).toContain("fountain");
    expect(ZONE_NAMES as readonly string[]).not.toContain("hero");
  });

  test("第 4 项：SlotSide 与 SelSide 是两个取值集，只有后者含 both", () => {
    expect(SLOT_SIDES).toEqual(["friendly", "enemy"]);
    expect(SEL_SIDES).toEqual(["friendly", "enemy", "both"]);
    expect(SLOT_SIDES as readonly string[]).not.toContain("both");
  });

  test("第 5 项：stunned 是 flag，战斗快照条件为 atk > 0 && !stunned", () => {
    expect(FLAG_NAMES).toContain("stunned");
    // 快照条件本身在 M3 的战斗实现里，这里只钉住词汇：没有 stunned flag 就写不出那个条件。
    const stun: Act = {
      op: "act.set_flag",
      target: { op: "sel.target" },
      flag: "stunned",
      value: true,
    };
    expect(stun.op).toBe("act.set_flag");
  });

  test("第 6 项：deploySchedule [2,1] = r1 部署 2 名、r2 部署 1 名，总和 = perDeck", () => {
    const { deploySchedule, perDeck } = DEFAULT_RULES_CONFIG.heroes;
    expect(deploySchedule).toEqual([2, 1]);
    expect(deploySchedule.reduce((a, b) => a + b, 0)).toBe(perDeck);
  });
});

describe("op 词汇表", () => {
  test("每个 op 都带自己家族的前缀（L2 种类校验的前提，IR v1 原则 2）", () => {
    const families = [
      [SEL_OPS, NODE_OP_PREFIXES.sel],
      [SLOT_OPS, NODE_OP_PREFIXES.slot],
      [NUM_OPS, NODE_OP_PREFIXES.num],
      [COND_OPS, NODE_OP_PREFIXES.cond],
      [CARD_OPS, NODE_OP_PREFIXES.card],
      [ACT_OPS, NODE_OP_PREFIXES.act],
    ] as const;
    for (const [ops, prefix] of families) {
      for (const op of ops) expect(op.startsWith(prefix)).toBe(true);
    }
  });

  test("NODE_OPS 是六族之和且无重复", () => {
    const total =
      SEL_OPS.length +
      SLOT_OPS.length +
      NUM_OPS.length +
      COND_OPS.length +
      CARD_OPS.length +
      ACT_OPS.length;
    expect(NODE_OPS.length).toBe(total);
    expect(new Set(NODE_OPS).size).toBe(total);
  });

  test("v2 §3.4 删除的三个 act 不在表里", () => {
    for (const dead of ["act.attack", "act.gain_mana", "act.gain_max_mana"]) {
      expect(Object.hasOwn(ACT_OP_SET, dead)).toBe(false);
    }
  });

  test("v2 §3.4 新增的位置四件套 + 出手 + 改名后的资源 op 齐了", () => {
    for (const op of [
      "act.move_to",
      "act.shift",
      "act.swap",
      "act.strike",
      "act.gain_crystal",
      "act.gain_crystal_cap",
    ] as const) {
      expect(ACT_OPS).toContain(op);
    }
  });

  test("act.set_health 保留（v1 §9 的 TS 类型漏写，§3.4 与 v2 §7 都有）", () => {
    expect(ACT_OPS).toContain("act.set_health");
  });

  test("v2 §3.1 的 slot.* 族六个 op 齐了", () => {
    expect(SLOT_OPS).toEqual([
      "slot.at",
      "slot.of",
      "slot.opposite",
      "slot.shift",
      "slot.random_empty",
      "slot.first_empty",
    ]);
  });
});

describe("事件表 v2", () => {
  test("v1 的 turn_* / attack* / minion_* 已删", () => {
    for (const dead of [
      "turn_began",
      "turn_ended",
      "mana_spent",
      "attacked",
      "attack_declared",
      "minion_summoned",
      "minion_died",
      "weapon_equipped",
    ]) {
      expect(EVENT_NAMES as readonly string[]).not.toContain(dead);
    }
  });

  test("v2.1 §11.3 的英雄事件在（英雄阵亡不发 unit_died）", () => {
    expect(EVENT_NAMES).toContain("hero_deployed");
    expect(EVENT_NAMES).toContain("hero_died");
    expect(EVENT_NAMES).toContain("unit_died");
  });
});

describe("规范示例可用权威类型表达", () => {
  test("IR v1 §10.1 火球术（目标域用 base 取代旧的 hero 区）", () => {
    const script: CardScript = {
      target: { op: "sel.zone", side: "both", zone: ["board", "base"] },
      play: [{ op: "act.hit", target: { op: "sel.target" }, amount: 6 }],
    };
    expect(JSON.parse(JSON.stringify(script))).toEqual(script);
  });

  test("IR v1 §10.3 野猪王：光环 + sel.minus/where + cond.has_tribe", () => {
    const aura: Aura = {
      affects: {
        op: "sel.minus",
        of: {
          op: "sel.where",
          of: { op: "sel.zone", side: "friendly", zone: "board" },
          cond: { op: "cond.has_tribe", of: { op: "sel.it" }, tribe: "beast" },
        },
        exclude: { op: "sel.self" },
      },
      mods: { atk: 1 },
      zone: "board",
    };
    expect(aura.mods?.atk).toBe(1);
  });

  test("IR v1 §10.4 谜之勇士：costMod + 亡语 + act.when 嵌套（summon 补 at）", () => {
    const script: CardScript = {
      costMod: {
        op: "num.neg",
        of: { op: "num.count", of: { op: "sel.zone", side: "friendly", zone: "board" } },
      },
      deathrattle: [
        {
          op: "act.summon",
          player: { op: "sel.controller" },
          card: "CORE_TOKEN_01",
          // v2 §3.4：规范形式里 at 必填，无位置语义的旧卡补 slot.random_empty（v2 §10 第 3 条）
          at: { op: "slot.random_empty", side: "friendly" },
        },
      ],
      play: [
        {
          op: "act.when",
          cond: {
            op: "cond.gte",
            l: { op: "num.attr", of: { op: "sel.self" }, tag: "atk" },
            r: 3,
          },
          then: [
            {
              op: "act.hit",
              target: {
                op: "sel.random",
                of: { op: "sel.zone", side: "enemy", zone: "board" },
                n: 2,
              },
              amount: {
                op: "num.mul",
                of: [
                  { op: "num.count", of: { op: "sel.zone", side: "friendly", zone: "board" } },
                  2,
                ],
              },
            },
          ],
          else: [{ op: "act.draw", player: { op: "sel.controller" } }],
        },
      ],
    };
    expect(script.play?.length).toBe(1);
  });

  test("IR v1 §10.5 发现：card.pool + act.give + card.of(sel.chosen)，两个子句都表达得出", () => {
    // 文档原文是 `IsSpell().and(HasFaction("mage"))`。faction 已废（v2.1 §11.4），
    // 阵营子句今天由 `cond.has_color` 承接（决策 #9，2.2.0 新增）。
    const play: readonly Act[] = [
      {
        op: "act.discover",
        from: {
          op: "card.pool",
          filter: {
            op: "cond.and",
            of: [
              { op: "cond.is_kind", of: { op: "sel.it" }, kind: "spell" },
              { op: "cond.has_color", of: { op: "sel.it" }, color: "blue" },
            ],
          },
        },
        show: 3,
        pick: 1,
      },
      {
        op: "act.give",
        player: { op: "sel.controller" },
        card: { op: "card.of", of: { op: "sel.chosen" } },
      },
    ];
    expect(play).toHaveLength(2);
  });

  test("IR v1 §10.6 圣盾：拦截器 + num.field + effect.cancel", () => {
    const intercept: Intercept = {
      intercept: "act.hit",
      filter: { target: { op: "sel.self" } },
      cond: {
        op: "cond.and",
        of: [
          { op: "cond.has_flag", of: { op: "sel.self" }, flag: "divine_shield" },
          { op: "cond.gt", l: { op: "num.field", field: "amount" }, r: 0 },
        ],
      },
      effect: { kind: "cancel" },
      then: [
        { op: "act.set_flag", target: { op: "sel.self" }, flag: "divine_shield", value: false },
      ],
      priority: 100,
    };
    expect(intercept.effect.kind).toBe("cancel");
  });

  test("v2 §8.1 斜刺长枪兵：direction 就是一个 Tag（附魔 mods 可写）", () => {
    const ench: Enchantment = {
      id: "GRID_001e",
      attachesTo: "minion",
      mods: { direction: -1 },
      duration: "permanent",
    };
    const card: Card = {
      id: "GRID_001",
      set: "pf1",
      data: {
        name: { zh: "斜刺长枪兵" },
        text: { zh: "战吼：战斗方向变为斜左。" },
        kind: "minion",
        cost: 3,
        colors: ["red"],
        tags: { atk: 3, health: 2 },
      },
      script: { play: [{ op: "act.buff", target: { op: "sel.self" }, ench: "GRID_001e" }] },
    };
    expect(ench.mods?.direction).toBe(-1);
    expect(card.data.colors).toEqual(["red"]);
  });

  test("v2 §8.2 空袭猎手：位置条件光环 cond.occupied(slot.opposite(slot.of(self)))", () => {
    const aura: Aura = {
      affects: { op: "sel.self" },
      mods: { atk: 2 },
      cond: {
        op: "cond.not",
        of: {
          op: "cond.occupied",
          slot: { op: "slot.opposite", of: { op: "slot.of", of: { op: "sel.self" } } },
        },
      },
      zone: "board",
    };
    expect(aura.cond).toBeDefined();
  });

  test("v2 §8.3 裂地冲锋：hit + shift", () => {
    const play: readonly Act[] = [
      { op: "act.hit", target: { op: "sel.target" }, amount: 2 },
      { op: "act.shift", target: { op: "sel.target" }, delta: 1 },
    ];
    expect(play[1]?.op).toBe("act.shift");
  });

  test("v2 §8.4 换位术：select_target 挂起点 + swap", () => {
    const play: readonly Act[] = [
      {
        op: "act.select_target",
        from: {
          op: "sel.minus",
          of: { op: "sel.zone", side: "friendly", zone: "board" },
          exclude: { op: "sel.target" },
        },
      },
      { op: "act.swap", a: { op: "sel.target" }, b: { op: "sel.chosen" } },
    ];
    expect(play[0]?.op).toBe("act.select_target");
  });

  test("v2 §8.5 战地号手：combat_began 触发 + end_of_combat 附魔", () => {
    const trigger: Trigger = {
      on: "combat_began",
      do: [
        {
          op: "act.buff",
          target: { op: "sel.zone", side: "friendly", zone: "board" },
          ench: "GRID_005e",
        },
      ],
    };
    const ench: Enchantment = {
      id: "GRID_005e",
      attachesTo: "minion",
      mods: { atk: 1 },
      duration: "end_of_combat",
    };
    expect(trigger.on).toBe("combat_began");
    expect(ench.duration).toBe("end_of_combat");
  });

  test("v2 §8.6/§8.7 Artifact 四关键词：struck 触发器 + 现有选择器即可写", () => {
    // Retaliate X
    const retaliate: Trigger = {
      on: "struck",
      filter: { target: { op: "sel.self" } },
      do: [{ op: "act.hit", target: { op: "sel.event", field: "source" }, amount: 1 }],
    };
    // Cleave X
    const cleave: Trigger = {
      on: "struck",
      filter: { source: { op: "sel.self" } },
      do: [
        {
          op: "act.hit",
          target: { op: "sel.adjacent", of: { op: "sel.event", field: "target" } },
          amount: 2,
        },
      ],
    };
    // Siege X（打空格时本就直伤基地，is_kind 挡住双重计算）
    const siege: Trigger = {
      on: "struck",
      filter: { source: { op: "sel.self" } },
      do: [
        {
          op: "act.when",
          cond: {
            op: "cond.is_kind",
            of: { op: "sel.event", field: "target" },
            kind: ["minion", "hero"],
          },
          then: [
            {
              op: "act.hit",
              target: { op: "sel.zone", side: "enemy", zone: "base" },
              amount: 1,
            },
          ],
        },
      ],
    };
    // 改箭头（Compel 类）= 带 direction mod 的附魔
    const compel: Act = { op: "act.buff", target: { op: "sel.target" }, ench: "X_e" };
    expect([retaliate, cleave, siege].every((t) => t.on === "struck")).toBe(true);
    expect(compel.op).toBe("act.buff");
  });
});
