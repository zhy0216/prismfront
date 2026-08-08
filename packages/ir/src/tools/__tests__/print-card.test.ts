// 反编译器（`ir:print`）的验收测试。
//
// 三层，各管一件事：
//
// 1. **文档对照**（`describe("v2 §8 …")` / `describe("IR §10 …")`）
//    六张示例卡 + IR §10 的例子，逐张写出期望文本。这些文本要**人读起来与文档里的
//    TS 源码等价** —— 不要求逐字节（文档写于 v2.1 之前，`colors` 必填、
//    `act.summon.at` 必填、`FRIENDLY_MINIONS` 语义变更等差异见夹具头部的注释），
//    但结构与每个构造器的名字必须对得上。
//
// 2. **逐 op 覆盖**（`SEL_SAMPLES` 等六张表）
//    `Record<XxxOp, 节点>` 的表与 op 联合双向钉死：v2 加一个 op 而这里漏写 → 编译不过。
//    每个样本都填满可选字段，然后过第 3 层的检查。
//
// 3. **不丢字段**（`expectNoDroppedLeaves`）
//    走一遍 IR 的所有标量叶子，逐个断言它出现在产物里。**这是这份测试的核心** ——
//    反编译器最可能的退化不是崩溃，而是"悄悄少打了一个可选字段"（`priority`、`once`、
//    `count`、`spellDamage` 这类），肉眼与快照都不容易发现。
//    刻意被吸收的叶子（默认值、具名常量）在 `ABSORBED_KEYS` 里逐条登记并说明理由 ——
//    以后想再吸收一个字段，就必须显式往那张表里加，加不进去的就是 bug。

import { describe, expect, test } from "bun:test";
import {
  CORE_030_AURA,
  CORE_050_PLAY,
  DIVINE_SHIELD_INTERCEPT,
} from "../../__tests__/fixtures/ir-v1-cards.ts";
import type {
  Act,
  ActOp,
  Card,
  CardOp,
  CardRef,
  Cond,
  CondOp,
  Enchantment,
  Num,
  NumOp,
  Pool,
  Sel,
  SelOp,
  SlotOp,
  SlotRef,
} from "../../types/index.ts";
import {
  findSpecCard,
  findSpecEnchantment,
  SPEC_CARDS,
  SPEC_ENCHANTMENTS,
  specIds,
} from "../examples.ts";
import { type PrintContext, rootContext } from "../format.ts";
import {
  printAura,
  printCard,
  printEnchantment,
  printIntercept,
  printTrigger,
} from "../print-card.ts";
import {
  printAct,
  printActs,
  printCardRef,
  printCond,
  printNum,
  printPool,
  printSel,
  printSlot,
} from "../print-node.ts";

// ── 第 3 层：叶子覆盖 ───────────────────────────────────────────────────────

interface Leaf {
  readonly key: string;
  readonly value: string | number | boolean;
}

function collectLeaves(value: unknown, key: string, out: Leaf[]): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectLeaves(item, key, out);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      collectLeaves(child, childKey, out);
    }
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    out.push({ key, value });
  }
}

/** `op` 永远不用出现：构造器名字本身就是 op（`act.hit` → `Hit`）。 */
const ABSORBED_KEYS: readonly string[] = ["op"];

/**
 * 允许**不出现**在产物里的 `键=值`，逐条都有出处。
 * 想再吸收一个字段就必须往这张表里加一行 —— 加不进去的就是反编译器漏了字段。
 *
 * - `zone=board` —— `zone(side,"board")` 被 `*_UNITS` / `*_MINIONS` 吸收；
 *                   `trigger.zone` / `aura.zone` 的 `"board"` 是 builder 默认值
 * - `zone=base`  —— `ALL_CHARACTERS` = `zone(both, ["board","base"])`，常量名里没有 "base"
 * - `side=both`  —— `both` 侧的具名常量叫 `ALL_*`，词里没有 "both"
 *                   （`friendly` / `enemy` 侧的常量名带着这两个词，仍然严格检查）
 * - `set=pf1`    —— `DEFAULT_CARD_SET`
 * - `attachesTo=minion` / `duration=permanent` —— `defineEnchantment` 的默认值
 * - `show=3` / `pick=1` —— `Discover` 的默认值（IR §10.5 的规范 JSON 显式写了它们，
 *                   打回编写层时省掉才是逆运算）
 */
const ABSORBED_PAIRS: readonly string[] = [
  "zone=board",
  "zone=base",
  "side=both",
  "set=pf1",
  "attachesTo=minion",
  "duration=permanent",
  "show=3",
  "pick=1",
];

function normalize(text: string): string {
  return text.toLowerCase().replaceAll("_", "");
}

/**
 * 断言 IR 里每个标量叶子都在产物里留下了痕迹。
 *
 * 字符串按"小写 + 去下划线"后做子串匹配 —— 具名常量与助手名是同一个词的另一种拼法
 * （`"friendly"` → `FRIENDLY`、`"combat_began"` → `CombatBegan`、`"minion"` → `IsMinion`）。
 * 负数额外允许绝对值匹配：`act.shift(delta:-1)` 会打成 `Pull(X, 1)`（v2 §7）。
 */
function expectNoDroppedLeaves(node: unknown, text: string): void {
  const leaves: Leaf[] = [];
  collectLeaves(node, "", leaves);
  const haystack = normalize(text);
  for (const leaf of leaves) {
    if (ABSORBED_KEYS.includes(leaf.key) || ABSORBED_PAIRS.includes(`${leaf.key}=${leaf.value}`)) {
      continue;
    }
    const candidates =
      typeof leaf.value === "number" && leaf.value < 0
        ? [String(leaf.value), String(Math.abs(leaf.value))]
        : [String(leaf.value)];
    const found = candidates.some((candidate) => haystack.includes(normalize(candidate)));
    if (!found) {
      throw new Error(
        `反编译器漏掉了字段 ${leaf.key} = ${JSON.stringify(leaf.value)}\n产物：\n${text}`,
      );
    }
  }
}

// ── 第 2 层：逐 op 样本（每张表与 op 联合双向钉死）──────────────────────────

const SELF: Sel = { op: "sel.self" };
const IT: Sel = { op: "sel.it" };
const BOARD: Sel = { op: "sel.zone", side: "friendly", zone: "board" };
const AT_0: SlotRef = { op: "slot.at", side: "friendly", index: 0 };
const POOL: Pool = { op: "card.pool", filter: { op: "cond.is_kind", of: IT, kind: "spell" } };

const SEL_SAMPLES: Record<SelOp, Sel> = {
  "sel.self": SELF,
  "sel.target": { op: "sel.target" },
  "sel.controller": { op: "sel.controller" },
  "sel.opponent": { op: "sel.opponent" },
  "sel.chosen": { op: "sel.chosen" },
  "sel.it": IT,
  "sel.event": { op: "sel.event", field: "source" },
  "sel.entity": { op: "sel.entity", id: 7 },
  "sel.zone": { op: "sel.zone", side: "enemy", zone: ["hand", "deck"] },
  "sel.and": { op: "sel.and", of: [SELF, IT] },
  "sel.or": { op: "sel.or", of: [SELF, IT] },
  "sel.minus": { op: "sel.minus", of: BOARD, exclude: SELF },
  "sel.where": {
    op: "sel.where",
    of: BOARD,
    cond: { op: "cond.has_tribe", of: IT, tribe: "beast" },
  },
  "sel.random": { op: "sel.random", of: BOARD, n: 2, distinct: false },
  "sel.limit": { op: "sel.limit", of: BOARD, n: 3, from: "end" },
  "sel.sort": { op: "sel.sort", of: BOARD, by: "health", dir: "desc" },
  "sel.at": { op: "sel.at", slot: [AT_0, { op: "slot.at", side: "enemy", index: 8 }] },
  "sel.opposite": { op: "sel.opposite", of: SELF },
  "sel.combat_target": { op: "sel.combat_target", of: SELF },
  "sel.attackers_of": { op: "sel.attackers_of", of: SELF },
  "sel.adjacent": { op: "sel.adjacent", of: SELF, dist: 2 },
};

const SLOT_SAMPLES: Record<SlotOp, SlotRef> = {
  "slot.at": AT_0,
  "slot.of": { op: "slot.of", of: SELF },
  "slot.opposite": { op: "slot.opposite", of: AT_0 },
  "slot.shift": { op: "slot.shift", of: AT_0, delta: 2 },
  "slot.random_empty": { op: "slot.random_empty", side: "enemy" },
  "slot.first_empty": { op: "slot.first_empty", side: "friendly", from: "right" },
};

const NUM_SAMPLES: Record<NumOp, Num> = {
  "num.count": { op: "num.count", of: BOARD },
  "num.attr": { op: "num.attr", of: SELF, tag: "direction" },
  "num.sum": { op: "num.sum", of: BOARD, tag: "atk" },
  "num.add": { op: "num.add", of: [1, 2] },
  "num.mul": { op: "num.mul", of: [3, 4] },
  "num.max": { op: "num.max", of: [5, 6] },
  "num.min": { op: "num.min", of: [7, 8] },
  "num.sub": { op: "num.sub", l: 9, r: 10 },
  "num.div": { op: "num.div", l: 11, r: 12 },
  "num.neg": { op: "num.neg", of: { op: "num.count", of: BOARD } },
  "num.clamp": { op: "num.clamp", of: 13, lo: 14, hi: 15 },
  "num.if": { op: "num.if", cond: true, then: 16, else: 17 },
  "num.random": { op: "num.random", lo: 18, hi: 19 },
  "num.tag": { op: "num.tag", tag: "crystal_cap" },
  "num.field": { op: "num.field", field: "amount" },
  "num.slot_index": { op: "num.slot_index", of: SELF },
};

const COND_SAMPLES: Record<CondOp, Cond> = {
  "cond.exists": { op: "cond.exists", of: BOARD, atLeast: 2 },
  "cond.eq": { op: "cond.eq", l: 20, r: 21 },
  "cond.ne": { op: "cond.ne", l: 22, r: 23 },
  "cond.gt": { op: "cond.gt", l: { op: "num.field", field: "amount" }, r: 0 },
  "cond.gte": { op: "cond.gte", l: { op: "num.attr", of: SELF, tag: "atk" }, r: 3 },
  "cond.lt": { op: "cond.lt", l: 24, r: 25 },
  "cond.lte": { op: "cond.lte", l: 26, r: 27 },
  "cond.and": { op: "cond.and", of: [true, false] },
  "cond.or": { op: "cond.or", of: [true, false] },
  "cond.not": { op: "cond.not", of: { op: "cond.occupied", slot: AT_0 } },
  "cond.has_tag": { op: "cond.has_tag", of: SELF, tag: "armor", value: 28 },
  "cond.has_flag": { op: "cond.has_flag", of: SELF, flag: "divine_shield" },
  "cond.is_kind": { op: "cond.is_kind", of: SELF, kind: ["weapon", "hero_power"] },
  // 色表形式（存在量化）刻意不走 IsRed / IsBlue 别名，别名形式由 §10.5 的用例覆盖
  "cond.has_color": { op: "cond.has_color", of: SELF, color: ["red", "blue"] },
  "cond.has_tribe": { op: "cond.has_tribe", of: IT, tribe: "beast" },
  "cond.in_zone": { op: "cond.in_zone", of: SELF, zone: "graveyard" },
  "cond.dead": { op: "cond.dead", of: SELF },
  "cond.occupied": { op: "cond.occupied", slot: AT_0 },
};

const CARD_REF_SAMPLES: Record<CardOp, CardRef | Pool> = {
  "card.of": { op: "card.of", of: SELF },
  "card.random": { op: "card.random", from: POOL },
  "card.pool": POOL,
};

const ACT_SAMPLES: Record<ActOp, Act> = {
  "act.hit": { op: "act.hit", target: SELF, amount: 6, spellDamage: true },
  "act.heal": { op: "act.heal", target: SELF, amount: 2 },
  "act.set_health": { op: "act.set_health", target: SELF, value: 5 },
  "act.gain_armor": { op: "act.gain_armor", target: SELF, amount: 3 },
  "act.draw": { op: "act.draw", player: { op: "sel.controller" }, count: 2 },
  "act.give": { op: "act.give", player: { op: "sel.controller" }, card: "CORE_TOKEN_01", count: 2 },
  "act.shuffle": {
    op: "act.shuffle",
    player: { op: "sel.controller" },
    card: { op: "card.of", of: SELF },
    count: 3,
  },
  "act.discard": { op: "act.discard", target: SELF },
  "act.move": { op: "act.move", target: SELF, zone: "graveyard", side: "opposite", pos: 1 },
  "act.steal": { op: "act.steal", target: SELF, to: { op: "sel.controller" } },
  "act.summon": {
    op: "act.summon",
    player: { op: "sel.controller" },
    card: "CORE_TOKEN_01",
    at: { op: "slot.random_empty", side: "friendly" },
    count: 2,
  },
  "act.destroy": { op: "act.destroy", target: SELF },
  "act.transform": { op: "act.transform", target: SELF, card: "CORE_TOKEN_02" },
  "act.buff": { op: "act.buff", target: SELF, ench: "GRID_001e" },
  "act.silence": { op: "act.silence", target: SELF },
  "act.set_tag": { op: "act.set_tag", target: SELF, tag: "direction", value: 1 },
  "act.mod_tag": { op: "act.mod_tag", target: SELF, tag: "armor", delta: 2 },
  "act.set_flag": { op: "act.set_flag", target: SELF, flag: "divine_shield", value: false },
  "act.move_to": { op: "act.move_to", target: SELF, to: AT_0 },
  "act.shift": { op: "act.shift", target: SELF, delta: -1 },
  "act.swap": { op: "act.swap", a: SELF, b: { op: "sel.target" } },
  "act.strike": { op: "act.strike", attacker: SELF, target: { op: "sel.target" } },
  "act.gain_crystal": { op: "act.gain_crystal", player: { op: "sel.controller" }, amount: 1 },
  "act.gain_crystal_cap": {
    op: "act.gain_crystal_cap",
    player: { op: "sel.controller" },
    amount: 1,
  },
  "act.when": {
    op: "act.when",
    cond: true,
    then: [{ op: "act.nothing" }],
    else: [{ op: "act.destroy", target: SELF }],
  },
  "act.repeat": { op: "act.repeat", n: 3, do: [{ op: "act.nothing" }] },
  "act.for_each": { op: "act.for_each", of: BOARD, do: [{ op: "act.silence", target: IT }] },
  "act.discover": { op: "act.discover", from: POOL, show: 5, pick: 2 },
  "act.select_target": { op: "act.select_target", from: BOARD, optional: true },
  "act.nothing": { op: "act.nothing" },
};

function expectSane(text: string): void {
  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toContain("[object Object]");
  expect(text).not.toContain("undefined");
}

/** `card.pool` 不是 `CardRef` 的成员（它只出现在 `from` 位），所以要分派一下。 */
function printAnyCardRef(node: CardRef | Pool, ctx: PrintContext): string {
  if (typeof node === "string") {
    return printCardRef(node, ctx);
  }
  return node.op === "card.pool" ? printPool(node, ctx) : printCardRef(node, ctx);
}

/** 按 id 取示例卡；取不到直接失败（比在每个用例里做非空断言干净）。 */
function specCard(cardId: string): Card {
  const found = findSpecCard(cardId);
  if (found === undefined) {
    throw new Error(`没有这张示例卡：${cardId}`);
  }
  return found;
}

/** 按 id 取示例附魔。 */
function specEnchantment(enchantId: string): Enchantment {
  const found = findSpecEnchantment(enchantId);
  if (found === undefined) {
    throw new Error(`没有这个示例附魔：${enchantId}`);
  }
  return found;
}

describe("逐 op 覆盖：每个 op 都打得出、且不丢字段", () => {
  for (const [op, node] of Object.entries(SEL_SAMPLES)) {
    test(`sel：${op}`, () => {
      const text = printSel(node, rootContext());
      expectSane(text);
      expectNoDroppedLeaves(node, text);
    });
  }
  for (const [op, node] of Object.entries(SLOT_SAMPLES)) {
    test(`slot：${op}`, () => {
      const text = printSlot(node, rootContext());
      expectSane(text);
      expectNoDroppedLeaves(node, text);
    });
  }
  for (const [op, node] of Object.entries(NUM_SAMPLES)) {
    test(`num：${op}`, () => {
      const text = printNum(node, rootContext());
      expectSane(text);
      expectNoDroppedLeaves(node, text);
    });
  }
  for (const [op, node] of Object.entries(COND_SAMPLES)) {
    test(`cond：${op}`, () => {
      const text = printCond(node, rootContext());
      expectSane(text);
      expectNoDroppedLeaves(node, text);
    });
  }
  for (const [op, node] of Object.entries(CARD_REF_SAMPLES)) {
    test(`card：${op}`, () => {
      const text = printAnyCardRef(node, rootContext());
      expectSane(text);
      expectNoDroppedLeaves(node, text);
    });
  }
  for (const [op, node] of Object.entries(ACT_SAMPLES)) {
    test(`act：${op}`, () => {
      const text = printAct(node, rootContext());
      expectSane(text);
      expectNoDroppedLeaves(node, text);
    });
  }
});

// ── 第 1 层：文档对照 ───────────────────────────────────────────────────────

describe("v2 §8 的六张示例卡 —— 打回去要和文档源码读起来一样", () => {
  test("§8.1 斜刺长枪兵：direction 即 Tag，play 写单个动作", () => {
    expect(printCard(specCard("GRID_001"))).toBe(`defineCard({
  id: "GRID_001",
  name: "斜刺长枪兵",
  text: "战吼：战斗方向变为斜左。",
  kind: "minion",
  cost: 3,
  colors: "red",
  atk: 3,
  health: 2,
  play: Buff(SELF, "GRID_001e"),
});`);
  });

  test("§8.1 的附魔：与文档源码逐字一致", () => {
    expect(printEnchantment(specEnchantment("GRID_001e"))).toBe(
      `defineEnchantment({ id: "GRID_001e", direction: -1 });`,
    );
  });

  test("§8.2 空袭猎手：位置条件光环打回位置参数形式的 Aura(...)", () => {
    expect(printCard(specCard("GRID_002"))).toContain(
      "aura: Aura(SELF, { atk: 2 }, Not(Occupied(SlotOf(SELF).opposite()))),",
    );
  });

  test("§8.3 裂地冲锋：Push 与 ENEMY_MINIONS 都还原了", () => {
    const text = printCard(specCard("GRID_003"));
    expect(text).toContain("target: ENEMY_MINIONS,");
    expect(text).toContain("play: [Hit(TARGET, 2), Push(TARGET, 1)],");
  });

  test("§8.4 换位术：链式 .not() 与挂起点", () => {
    expect(printCard(specCard("GRID_004"))).toContain(
      "play: [SelectTarget(FRIENDLY_MINIONS.not(TARGET)), Swap(TARGET, CHOSEN)],",
    );
  });

  test("§8.5 战地号手：on(CombatBegan(), ...) + end_of_combat 附魔", () => {
    expect(printCard(specCard("GRID_005"))).toContain(
      'triggers: [on(CombatBegan(), Buff(FRIENDLY_MINIONS, "GRID_005e"))],',
    );
    expect(printEnchantment(specEnchantment("GRID_005e"))).toBe(
      `defineEnchantment({ id: "GRID_005e", atk: 1, duration: "end_of_combat" });`,
    );
  });

  test("§8.6 荆棘卫士：Struck(SELF) 的选择器简写与 EVENT.source", () => {
    expect(printCard(specCard("GRID_006"))).toContain(
      "triggers: [on(Struck(SELF), Hit(EVENT.source, 1))],",
    );
  });
});

describe("IR §10 的例子 —— v1 基座那一半糖", () => {
  test("§10.1 火球术：ANY_CHARACTER 打成同义的 ALL_CHARACTERS，双语文案打成对象", () => {
    const text = printCard(specCard("CORE_001"));
    expect(text).toContain('set: "core",');
    expect(text).toContain('name: { zh: "火球术", en: "Fireball" },');
    expect(text).toContain("target: ALL_CHARACTERS,");
    expect(text).toContain("play: Hit(TARGET, 6),");
  });

  test("§10.2 光明守护者：on(Healed(ALL_CHARACTERS), ...)", () => {
    expect(printCard(specCard("CORE_020"))).toContain(
      'triggers: [on(Healed(ALL_CHARACTERS), Buff(SELF, "CORE_020e"))],',
    );
  });

  test("§10.3 野猪王：链式 .not().where() 与 Aura 的位置参数形式", () => {
    expect(printAura(CORE_030_AURA, rootContext())).toBe(
      'Aura(FRIENDLY_UNITS.not(SELF).where(HasTribe(IT, "beast")), { atk: 1 })',
    );
  });

  test("§10.4 谜之勇士：.gte() / .negate() 还原，.times() 打成变参 Mul", () => {
    const text = printCard(specCard("CORE_040"));
    expect(text).toContain("costMod: Count(FRIENDLY_UNITS).negate(),");
    // `act.summon.at` 在 v2 §3.4 起是规范形式的必填项，**永远显式打出来**：
    // 把随机落点显式化正是那条规定的理由（RNG 顺序可审计）。
    expect(text).toContain(
      'deathrattle: Summon(CONTROLLER, "CORE_TOKEN_01", RandomEmptySlot(FRIENDLY)),',
    );
    expect(text).toContain('Attr(SELF, "atk").gte(3),');
    expect(text).toContain("Hit(ENEMY_UNITS.random(2), Mul(Count(FRIENDLY_UNITS), 2)),");
    expect(text).toContain("Draw(CONTROLLER),");
  });

  test("§10.5 发现：Discover 的默认 show/pick 省掉，card.of 打成 CardOf，颜色打成 IsBlue()", () => {
    // `.and()` 是摊平型链式方法，按 names.ts 的还原策略打成变参 `And(...)`（不还原成链式）
    expect(printActs(CORE_050_PLAY, rootContext())).toBe(
      "[Discover(CardPool(And(IsSpell(), IsBlue()))), Give(CONTROLLER, CardOf(CHOSEN))]",
    );
  });

  test("§10.6 圣盾：拦截器的完整形状", () => {
    expect(printIntercept(DIVINE_SHIELD_INTERCEPT, rootContext())).toBe(`intercept({
  intercept: "act.hit",
  filter: { target: SELF },
  cond: And(HasFlag(SELF, "divine_shield"), Field("amount").gt(0)),
  effect: Cancel(),
  then: SetFlag(SELF, "divine_shield", false),
  priority: 100,
})`);
  });
});

// ── 整卡级：不丢字段 + 纯函数 ───────────────────────────────────────────────

describe("整卡反编译", () => {
  for (const card of SPEC_CARDS) {
    test(`${card.id} 的每个字段都留下了痕迹`, () => {
      const text = printCard(card);
      expectSane(text);
      expectNoDroppedLeaves(card, text);
    });
  }

  for (const ench of SPEC_ENCHANTMENTS) {
    test(`${ench.id} 的每个字段都留下了痕迹`, () => {
      const text = printEnchantment(ench);
      expectSane(text);
      expectNoDroppedLeaves(ench, text);
    });
  }

  test("是纯函数：不改输入，重复调用结果相同", () => {
    const card = specCard("GRID_001");
    const before = JSON.stringify(card);
    const first = printCard(card);
    const second = printCard(card);
    expect(second).toBe(first);
    expect(JSON.stringify(card)).toBe(before);
  });

  test("产物是可以贴回 .ts 的语句：以 defineCard({ 开头、以 }); 收尾", () => {
    for (const card of SPEC_CARDS) {
      const text = printCard(card);
      expect(text.startsWith("defineCard({")).toBe(true);
      expect(text.endsWith("});")).toBe(true);
    }
  });

  test("width 收窄会折行，放宽会收成一行", () => {
    const card = specCard("GRID_001");
    const narrow = printCard(card, { width: 20 });
    const wide = printCard(card, { width: 10_000 });
    expect(narrow.split("\n").length).toBeGreaterThan(wide.split("\n").length);
    expect(wide.split("\n")).toHaveLength(1);
  });
});

// ── 全字段：`CardSpec` / `EnchantmentSpec` 的每一个字段都要打得出来 ──────────
//
// 文档里的九张示例卡填不满 `CardSpec`（没有一张同时带 rarity / art / chooseOne /
// intercepts / 多个 aura / 完整形式的 trigger）。这张手写的 IR 把每个可选字段都填上，
// 于是"少打一个字段"这类退化在这里也会被 `expectNoDroppedLeaves` 抓住。

const FULL_CARD: Card = {
  id: "FULL_001",
  set: "core",
  data: {
    name: { zh: "全字段", en: "Everything" },
    text: { zh: "把 CardSpec 的每个字段都填上。", en: "Every field set." },
    kind: "spell",
    cost: 7,
    colors: ["red", "blue"],
    rarity: "legendary",
    tribe: "beast",
    art: "pf1/full",
    collectible: false,
    tags: { atk: 1, health: 2, cost: 3, direction: -1, armor: 4 },
  },
  script: {
    target: { op: "sel.zone", side: "both", zone: ["board", "base"] },
    requires: { op: "cond.exists", of: BOARD },
    play: [{ op: "act.nothing" }],
    deathrattle: [{ op: "act.nothing" }, { op: "act.silence", target: SELF }],
    triggers: [
      // 简写形式：没有 cond / once，zone 是默认的 "board"
      { on: "combat_began", zone: "board", do: [{ op: "act.nothing" }] },
      // 完整形式：cond + once + 非默认 zone；filter 有多个键 → 事件助手收对象
      {
        on: "struck",
        filter: { source: SELF, player: { op: "sel.controller" } },
        cond: true,
        once: true,
        zone: "hand",
        do: [{ op: "act.nothing" }],
      },
    ],
    intercepts: [
      { intercept: "act.heal", effect: { kind: "set_field", field: "amount", value: 0 } },
      { intercept: "act.draw", effect: { kind: "mod_field", field: "count", delta: 1 } },
      { intercept: "act.hit", effect: { kind: "retarget", to: SELF } },
    ],
    auras: [
      { affects: SELF, mods: { atk: 2 }, zone: "board" },
      // flags + 非默认 zone → 完整形式 aura({...})
      { affects: BOARD, flags: ["divine_shield", "stunned"], cond: true, zone: "graveyard" },
      // 有 cond 没 mods → 位置参数会留下空洞，同样退回完整形式
      { affects: SELF, cond: false, zone: "board" },
    ],
    costMod: { op: "num.neg", of: 2 },
    chooseOne: [
      { id: "a", text: { zh: "甲", en: "A" }, target: BOARD, play: [{ op: "act.nothing" }] },
      {
        id: "b",
        text: { zh: "乙" },
        play: [{ op: "act.nothing" }, { op: "act.destroy", target: SELF }],
      },
    ],
  },
};

const FULL_ENCHANTMENT: Enchantment = {
  id: "FULL_001e",
  attachesTo: "spell",
  mods: { atk: 1, health: 2, cost: 3, direction: -1, armor: 4 },
  flags: ["divine_shield", "silenced"],
  duration: "while_source_alive",
  script: {
    triggers: [{ on: "round_began", zone: "board", do: [{ op: "act.nothing" }] }],
    auras: [{ affects: SELF, mods: { atk: 1 }, zone: "board" }],
  },
};

/** builder 的默认值全部命中 → 产物里一个默认值都不该出现。 */
const MINIMAL_ENCHANTMENT: Enchantment = {
  id: "MIN_001e",
  attachesTo: "minion",
  duration: "permanent",
};

describe("全字段卡", () => {
  test("每个字段都留下了痕迹", () => {
    const text = printCard(FULL_CARD);
    expectSane(text);
    expectNoDroppedLeaves(FULL_CARD, text);
  });

  test("data 段打回扁平的编写层字段", () => {
    const text = printCard(FULL_CARD);
    expect(text).toContain('name: { zh: "全字段", en: "Everything" },');
    expect(text).toContain('colors: ["red", "blue"],');
    expect(text).toContain('rarity: "legendary",');
    expect(text).toContain('tribe: "beast",');
    expect(text).toContain('art: "pf1/full",');
    expect(text).toContain("collectible: false,");
    expect(text).toContain("atk: 1,");
    expect(text).toContain("health: 2,");
    // atk / health 之外的 tag 留在 tags:，键序照 TAG_KEYS
    expect(text).toContain("tags: { cost: 3, direction: -1, armor: 4 },");
  });

  test("触发器：有 cond / once / 非默认 zone 时退回完整形式，多键 filter 打成对象", () => {
    const text = printCard(FULL_CARD);
    expect(text).toContain("on(CombatBegan(), Nothing()),");
    expect(text).toContain("on: Struck({ source: SELF, player: CONTROLLER }),");
    expect(text).toContain("once: true,");
    expect(text).toContain('zone: "hand",');
  });

  test("拦截器：四种 effect 都有对应构造器", () => {
    const text = printCard(FULL_CARD);
    expect(text).toContain('intercept({ intercept: "act.heal", effect: SetField("amount", 0) }),');
    expect(text).toContain('intercept({ intercept: "act.draw", effect: ModField("count", 1) }),');
    expect(text).toContain('intercept({ intercept: "act.hit", effect: Retarget(SELF) }),');
  });

  test("光环：多个时用 auras:，带 flags / 非默认 zone 时退回 aura({...})", () => {
    const text = printCard(FULL_CARD);
    expect(text).toContain("auras: [");
    expect(text).toContain("Aura(SELF, { atk: 2 }),");
    expect(text).toContain('flags: ["divine_shield", "stunned"],');
    expect(text).toContain('zone: "graveyard",');
    expect(text).toContain("aura({ affects: SELF, cond: false }),");
  });

  test("chooseOne：带 target 与不带 target 两种选项", () => {
    const text = printCard(FULL_CARD);
    expect(text).toContain('{ id: "a", text: { zh: "甲", en: "A" }, target: FRIENDLY_UNITS');
    // ★ text 必须打成对象、play 必须打成数组 —— chooseOne 是唯一没有 builder 糖层的位置，
    //   `CardSpec.chooseOne` 收的是裸 IR（ChooseOneOption.text: LocalizedText、
    //   play: readonly Act[]），塌成 `text: "乙"` / `play: Nothing()` 会丢文案且贴回去编译不过。
    expect(text).toContain('{ id: "b", text: { zh: "乙" }, play: [Nothing(), Destroy(SELF)] },');
  });

  test("★ chooseOne 单元素 play 不塌成裸动作（贴回去要是 readonly Act[]）", () => {
    const text = printCard(FULL_CARD);
    expect(text).toContain(
      '{ id: "a", text: { zh: "甲", en: "A" }, target: FRIENDLY_UNITS, play: [Nothing()] }',
    );
    expect(text).not.toContain("play: Nothing() }");
  });

  test("附魔：五个扁平 mod + flags + 非默认 attachesTo / duration + 自带脚本", () => {
    const text = printEnchantment(FULL_ENCHANTMENT);
    expectSane(text);
    expectNoDroppedLeaves(FULL_ENCHANTMENT, text);
    expect(text).toContain('attachesTo: "spell",');
    expect(text).toContain('flags: ["divine_shield", "silenced"],');
    expect(text).toContain('duration: "while_source_alive",');
    expect(text).toContain("triggers: [on(RoundBegan(), Nothing())],");
    expect(text).toContain("auras: [Aura(SELF, { atk: 1 })],");
  });

  test("附魔：默认值全部省掉", () => {
    expect(printEnchantment(MINIMAL_ENCHANTMENT)).toBe(`defineEnchantment({ id: "MIN_001e" });`);
  });

  test("单个 flag 打成字符串（builder 的 flags 收 `FlagName | FlagName[]`）", () => {
    expect(printAura({ affects: SELF, flags: ["stunned"], zone: "graveyard" }, rootContext())).toBe(
      'aura({ affects: SELF, flags: "stunned", zone: "graveyard" })',
    );
  });

  test("光环完整形式里 mods 与 flags 并存", () => {
    expect(
      printAura(
        { affects: SELF, mods: { atk: 1 }, flags: ["stunned"], zone: "board" },
        rootContext(),
      ),
    ).toBe('aura({ affects: SELF, mods: { atk: 1 }, flags: "stunned" })');
  });

  test("空过滤器等同于没有过滤器", () => {
    expect(
      printTrigger(
        { on: "combat_began", filter: {}, zone: "board", do: [{ op: "act.nothing" }] },
        rootContext(),
      ),
    ).toBe("on(CombatBegan(), Nothing())");
  });

  test("折行宽度是真的守住了（`emitObjectCall` 的 head 也算进宽度）", () => {
    for (const card of [...SPEC_CARDS, FULL_CARD]) {
      for (const line of printCard(card, { width: 100 }).split("\n")) {
        expect(line.length).toBeLessThanOrEqual(100);
      }
    }
    for (const ench of [...SPEC_ENCHANTMENTS, FULL_ENCHANTMENT]) {
      for (const line of printEnchantment(ench, { width: 100 }).split("\n")) {
        expect(line.length).toBeLessThanOrEqual(100);
      }
    }
  });
});

// ── 别名还原的边界（`names.ts` 顶部那三档策略的具体落点）─────────────────────

describe("别名还原的边界", () => {
  test("act.shift：字面量正负 → Push / Pull，节点 delta → Shift", () => {
    const ctx = rootContext();
    expect(printAct({ op: "act.shift", target: SELF, delta: 2 }, ctx)).toBe("Push(SELF, 2)");
    expect(printAct({ op: "act.shift", target: SELF, delta: -2 }, ctx)).toBe("Pull(SELF, 2)");
    // delta 是节点时符号未知，只能打回基础构造器
    expect(
      printAct({ op: "act.shift", target: SELF, delta: { op: "num.tag", tag: "round" } }, ctx),
    ).toBe("Shift(SELF, ROUND)");
    // 字面量 0 既不是 Push 也不是 Pull（v2 §9：literal 0 是笔误，L3 会告警）
    expect(printAct({ op: "act.shift", target: SELF, delta: 0 }, ctx)).toBe("Shift(SELF, 0)");
  });

  test('tag === "direction" 才走 Direction / SetDirection / ModDirection', () => {
    const ctx = rootContext();
    expect(printAct({ op: "act.set_tag", target: SELF, tag: "atk", value: 5 }, ctx)).toBe(
      'SetTag(SELF, "atk", 5)',
    );
    expect(printAct({ op: "act.set_tag", target: SELF, tag: "direction", value: 1 }, ctx)).toBe(
      "SetDirection(SELF, 1)",
    );
    expect(printAct({ op: "act.mod_tag", target: SELF, tag: "direction", delta: -1 }, ctx)).toBe(
      "ModDirection(SELF, -1)",
    );
    expect(printNum({ op: "num.attr", of: SELF, tag: "direction" }, ctx)).toBe("Direction(SELF)");
    expect(printNum({ op: "num.attr", of: SELF, tag: "armor" }, ctx)).toBe('Attr(SELF, "armor")');
  });

  test("cond.is_kind：给了 of 就打出来，of 是 IT 才省略（IR §10.5 的 IsSpell()）", () => {
    const ctx = rootContext();
    expect(
      printCond(
        { op: "cond.is_kind", of: { op: "sel.event", field: "target" }, kind: "minion" },
        ctx,
      ),
    ).toBe("IsMinion(EVENT.target)");
    expect(printCond({ op: "cond.is_kind", of: IT, kind: "spell" }, ctx)).toBe("IsSpell()");
    // weapon / hero_power 没有谓词别名，退回 IsKind
    expect(printCond({ op: "cond.is_kind", of: SELF, kind: "weapon" }, ctx)).toBe(
      'IsKind(SELF, "weapon")',
    );
  });

  test("具名常量只认完全一致的节点树，差一点就退回通用形式", () => {
    const ctx = rootContext();
    // cond 的 of 不是 IT → 不是 FRIENDLY_MINIONS
    expect(
      printSel(
        { op: "sel.where", of: BOARD, cond: { op: "cond.is_kind", of: SELF, kind: "minion" } },
        ctx,
      ),
    ).toBe("FRIENDLY_UNITS.where(IsMinion(SELF))");
    // 完全一致 → 还原成具名常量
    expect(
      printSel(
        { op: "sel.where", of: BOARD, cond: { op: "cond.is_kind", of: IT, kind: "minion" } },
        ctx,
      ),
    ).toBe("FRIENDLY_MINIONS");
    // 没有对应常量的区域组合 → Zone(side, zone)
    expect(printSel({ op: "sel.zone", side: "enemy", zone: "fountain" }, ctx)).toBe(
      'Zone(ENEMY, "fountain")',
    );
  });

  test("sel.at 收单个格子也收一组格子", () => {
    const ctx = rootContext();
    expect(printSel({ op: "sel.at", slot: AT_0 }, ctx)).toBe("UnitsAt(At(FRIENDLY, 0))");
    expect(printSel({ op: "sel.at", slot: [AT_0] }, ctx)).toBe("UnitsAt([At(FRIENDLY, 0)])");
  });
});

// ── examples.ts（M1 脚手架）的查表 ──────────────────────────────────────────

describe("示例卡查表", () => {
  test("六张 GRID 卡 + 三张 CORE 卡都能按 id 查到", () => {
    for (const id of ["GRID_001", "GRID_006", "CORE_001", "CORE_020", "CORE_040"]) {
      expect(findSpecCard(id)?.id).toBe(id);
    }
  });

  test("查不到返回 undefined —— 命令行据此非 0 退出", () => {
    expect(findSpecCard("NOPE_999")).toBeUndefined();
  });

  test("specIds 覆盖全部卡与附魔", () => {
    expect(specIds()).toHaveLength(SPEC_CARDS.length + SPEC_ENCHANTMENTS.length);
    expect(specIds()).toContain("GRID_001e");
  });
});
