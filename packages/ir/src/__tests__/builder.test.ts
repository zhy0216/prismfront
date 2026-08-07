// builder 糖面的守门测试。
//
// 三块：
//   1. **DSL v2 §7 的糖面清单逐条**——那份清单列了 13 行"糖 → IR"，这里一行一个断言
//   2. **op 覆盖完整性**——每个 op 都得有构造器。用 `satisfies Record<Op, …>` 在编译期钉死
//      （少一个 op：缺少属性；多一个：多余属性），再在运行时校验"键 = 产物的 op"
//   3. **表达力验证**——v2 §8.7 的 Artifact 关键词映射表，四条全部能写出来且不需要新 op

import { describe, expect, test } from "bun:test";
import {
  Add,
  AddToHand,
  Adjacent,
  ALL_CHARACTERS,
  ALL_UNITS,
  All,
  And,
  Any,
  At,
  AttackersOf,
  Attr,
  Aura,
  Buff,
  Cancel,
  CardOf,
  CardPool,
  CHOSEN,
  Clamp,
  COMBAT_TARGET,
  CONTROLLER,
  CombatBegan,
  Count,
  CRYSTAL_CAP,
  CRYSTALS,
  canonicalizeAct,
  canonicalizeCardRef,
  canonicalizeCond,
  canonicalizeNum,
  canonicalizePool,
  canonicalizeSel,
  canonicalizeSlot,
  canonicalJson,
  Destroy,
  Direction,
  Discard,
  Discover,
  Div,
  Draw,
  defineCard,
  defineEnchantment,
  ENEMY,
  ENEMY_BASE,
  ENEMY_UNITS,
  EVENT,
  EVENT_HELPERS,
  Except,
  Exists,
  FATIGUE,
  Field,
  FirstEmptySlot,
  ForEach,
  FRIENDLY,
  FRIENDLY_MINIONS,
  FRIENDLY_UNITS,
  GainArmor,
  GainCrystal,
  GainCrystalCap,
  Give,
  GlobalNum,
  HasFlag,
  HasTag,
  HasTribe,
  Heal,
  Hit,
  Intersect,
  InZone,
  IsDead,
  IsHero,
  IsKind,
  IsMinion,
  IsSpell,
  IsToken,
  IT,
  intercept,
  Limit,
  Max,
  Min,
  ModDirection,
  ModField,
  ModTag,
  Move,
  MoveTo,
  Mul,
  Neg,
  Not,
  Nothing,
  NumIf,
  Occupied,
  OPPONENT,
  OPPOSITE,
  Or,
  on,
  Pull,
  Push,
  Random,
  RandomCard,
  RandomEmptySlot,
  RandomInt,
  Repeat,
  Retarget,
  ROUND,
  SELF,
  SelectTarget,
  SetDirection,
  SetField,
  SetFlag,
  SetHealth,
  SetTag,
  Shift,
  Shuffle,
  Silence,
  SlotIndex,
  SlotOf,
  SlotOpposite,
  SlotShift,
  Sort,
  Steal,
  Strike,
  Struck,
  Sub,
  Sum,
  Summon,
  Swap,
  TARGET,
  Transform,
  toActs,
  toCardRef,
  trigger,
  Union,
  UnitsAt,
  Where,
  when,
  Zone,
} from "../builder/index.ts";
import type {
  Act,
  ActOp,
  CardOp,
  CardRef,
  Cond,
  CondOp,
  Num,
  NumOp,
  Pool,
  Sel,
  SelOp,
  SlotOp,
  SlotRef,
} from "../types/index.ts";
import {
  ACT_OPS,
  CARD_OPS,
  COND_OPS,
  EVENT_NAMES,
  NUM_OPS,
  SEL_OPS,
  SLOT_OPS,
} from "../types/index.ts";

describe("DSL v2 §7 糖面清单 —— 逐条比对", () => {
  test("At(FRIENDLY, 4) → slot.at", () => {
    expect(canonicalJson(At(FRIENDLY, 4))).toBe('{"op":"slot.at","side":"friendly","index":4}');
  });

  test("SlotOf(SELF) → slot.of", () => {
    expect(canonicalJson(SlotOf(SELF))).toBe('{"op":"slot.of","of":{"op":"sel.self"}}');
  });

  test("OPPOSITE(SELF) → sel.opposite", () => {
    expect(canonicalJson(OPPOSITE(SELF))).toBe('{"op":"sel.opposite","of":{"op":"sel.self"}}');
  });

  test("COMBAT_TARGET(SELF) → sel.combat_target", () => {
    expect(canonicalJson(COMBAT_TARGET(SELF))).toBe(
      '{"op":"sel.combat_target","of":{"op":"sel.self"}}',
    );
  });

  test("AttackersOf(SELF) → sel.attackers_of", () => {
    expect(canonicalJson(AttackersOf(SELF))).toBe(
      '{"op":"sel.attackers_of","of":{"op":"sel.self"}}',
    );
  });

  test("Adjacent(SELF) → sel.adjacent（dist 默认 1，缺省不写）", () => {
    expect(canonicalJson(Adjacent(SELF))).toBe('{"op":"sel.adjacent","of":{"op":"sel.self"}}');
    expect(canonicalJson(Adjacent(SELF, 2))).toBe(
      '{"op":"sel.adjacent","of":{"op":"sel.self"},"dist":2}',
    );
  });

  test("Push(X, 1) / Pull(X, 1) → act.shift(delta = +1 / -1)", () => {
    expect(Push(TARGET, 1).delta).toBe(1);
    expect(Pull(TARGET, 1).delta).toBe(-1);
    // 不给距离时默认 1 格
    expect(Push(TARGET).delta).toBe(1);
    expect(Pull(TARGET).delta).toBe(-1);
  });

  test("Pull 的距离是数值节点时用 num.neg 取负（字面量才能直接写负号）", () => {
    expect(canonicalJson(Pull(TARGET, Count(FRIENDLY_UNITS)).delta)).toBe(
      '{"op":"num.neg","of":{"op":"num.count","of":{"op":"sel.zone","side":"friendly","zone":"board"}}}',
    );
  });

  test('Summon(CONTROLLER, "id") → at 自动补 slot.random_empty(friendly)', () => {
    expect(canonicalJson(Summon(CONTROLLER, "id"))).toBe(
      '{"op":"act.summon","player":{"op":"sel.controller"},"card":"id","at":{"op":"slot.random_empty","side":"friendly"}}',
    );
  });

  test('Summon(CONTROLLER, "id", At(FRIENDLY, Num)) → at 用给定的格', () => {
    expect(canonicalJson(Summon(CONTROLLER, "id", At(FRIENDLY, Count(FRIENDLY_UNITS))))).toContain(
      '"at":{"op":"slot.at","side":"friendly","index":{"op":"num.count"',
    );
  });

  test("Strike(SELF, COMBAT_TARGET(SELF)) → act.strike", () => {
    expect(canonicalJson(Strike(SELF, COMBAT_TARGET(SELF)))).toBe(
      '{"op":"act.strike","attacker":{"op":"sel.self"},"target":{"op":"sel.combat_target","of":{"op":"sel.self"}}}',
    );
  });

  test("defineCard({...}) → data / script 二分（IR §1 原则 6）", () => {
    const card = defineCard({
      id: "S_001",
      name: "糖面测试",
      kind: "minion",
      cost: 2,
      atk: 2,
      health: 2,
      colors: "red",
      play: Hit(TARGET, 1),
    });
    expect(Object.keys(card)).toEqual(["id", "set", "data", "script"]);
    expect(card.data.tags).toEqual({ atk: 2, health: 2 });
    expect(card.script.play).toHaveLength(1);
  });

  test('defineEnchantment({ id, direction: -1, duration: "end_of_combat" })', () => {
    expect(
      canonicalJson(defineEnchantment({ id: "S_001e", direction: -1, duration: "end_of_combat" })),
    ).toBe(
      '{"id":"S_001e","attachesTo":"minion","mods":{"direction":-1},"duration":"end_of_combat"}',
    );
  });
});

describe("op 覆盖完整性 —— 每个 op 都有构造器", () => {
  // `satisfies Record<Op, …>` 在编译期钉死：漏一个 op 报"缺少属性"，多一个报"多余属性"。
  // 运行时再断言"键 = 产物的 op"，防止构造器返回错误的 op。

  const SEL_BY_OP = {
    "sel.self": SELF,
    "sel.target": TARGET,
    "sel.controller": CONTROLLER,
    "sel.opponent": OPPONENT,
    "sel.chosen": CHOSEN,
    "sel.it": IT,
    "sel.event": EVENT.source,
    "sel.zone": Zone(FRIENDLY, "board"),
    "sel.and": Intersect(SELF, TARGET),
    "sel.or": Union(FRIENDLY_UNITS, ENEMY_UNITS),
    "sel.minus": Except(FRIENDLY_UNITS, SELF),
    "sel.where": Where(FRIENDLY_UNITS, IsKind(IT, "minion")),
    "sel.random": Random(ENEMY_UNITS, 2, true),
    "sel.limit": Limit(ENEMY_UNITS, 1, "end"),
    "sel.sort": Sort(ENEMY_UNITS, "atk", "desc"),
    "sel.at": UnitsAt(At(FRIENDLY, 0)),
    "sel.opposite": OPPOSITE(SELF),
    "sel.combat_target": COMBAT_TARGET(SELF),
    "sel.attackers_of": AttackersOf(SELF),
    "sel.adjacent": Adjacent(SELF),
    // `sel.entity` 刻意没有构造器：它属于 IR §5.6 的运行时超集，
    // 由引擎绑定时生成，编写层写出来即校验错误。见下面单独一条断言。
  } as const satisfies Record<Exclude<SelOp, "sel.entity">, Sel>;

  const SLOT_BY_OP = {
    "slot.at": At(FRIENDLY, 4),
    "slot.of": SlotOf(SELF),
    "slot.opposite": SlotOpposite(At(FRIENDLY, 4)),
    "slot.shift": SlotShift(At(FRIENDLY, 4), 1),
    "slot.random_empty": RandomEmptySlot(ENEMY),
    "slot.first_empty": FirstEmptySlot(FRIENDLY, "right"),
  } as const satisfies Record<SlotOp, SlotRef>;

  const NUM_BY_OP = {
    "num.count": Count(FRIENDLY_UNITS),
    "num.attr": Attr(SELF, "atk"),
    "num.sum": Sum(FRIENDLY_UNITS, "health"),
    "num.add": Add(1, 2),
    "num.mul": Mul(2, 3),
    "num.max": Max(1, 2),
    "num.min": Min(1, 2),
    "num.sub": Sub(3, 1),
    "num.div": Div(6, 2),
    "num.neg": Neg(1),
    "num.clamp": Clamp(5, 0, 3),
    "num.if": NumIf(true, 1, 2),
    "num.random": RandomInt(1, 3),
    "num.tag": GlobalNum("round"),
    "num.field": Field("amount"),
    "num.slot_index": SlotIndex(SELF),
  } as const satisfies Record<NumOp, Num>;

  const COND_BY_OP = {
    "cond.exists": Exists(FRIENDLY_UNITS, 2),
    "cond.eq": Count(FRIENDLY_UNITS).eq(1),
    "cond.ne": Count(FRIENDLY_UNITS).ne(1),
    "cond.gt": Count(FRIENDLY_UNITS).gt(1),
    "cond.gte": Count(FRIENDLY_UNITS).gte(1),
    "cond.lt": Count(FRIENDLY_UNITS).lt(1),
    "cond.lte": Count(FRIENDLY_UNITS).lte(1),
    "cond.and": And(true, false),
    "cond.or": Or(true, false),
    "cond.not": Not(true),
    "cond.has_tag": HasTag(SELF, "atk", 3),
    "cond.has_flag": HasFlag(SELF, "divine_shield"),
    "cond.is_kind": IsKind(IT, "minion"),
    "cond.has_tribe": HasTribe(IT, "beast"),
    "cond.in_zone": InZone(SELF, "graveyard"),
    "cond.dead": IsDead(SELF),
    "cond.occupied": Occupied(SlotOf(SELF).opposite()),
  } as const satisfies Record<CondOp, Cond>;

  const CARD_BY_OP = {
    "card.of": CardOf(CHOSEN),
    "card.random": RandomCard(CardPool(IsSpell())),
    "card.pool": CardPool(IsSpell()),
  } as const satisfies Record<CardOp, CardRef | Pool>;

  const ACT_BY_OP = {
    "act.hit": Hit(TARGET, 1, true),
    "act.heal": Heal(TARGET, 1),
    "act.set_health": SetHealth(TARGET, 1),
    "act.gain_armor": GainArmor(TARGET, 1),
    "act.draw": Draw(CONTROLLER, 2),
    "act.give": Give(CONTROLLER, "X", 2),
    "act.shuffle": Shuffle(CONTROLLER, "X", 2),
    "act.discard": Discard(TARGET),
    "act.move": Move(TARGET, "hand", "opposite", 0),
    "act.steal": Steal(TARGET, CONTROLLER),
    "act.summon": Summon(CONTROLLER, "X", At(FRIENDLY, 0), 2),
    "act.destroy": Destroy(TARGET),
    "act.transform": Transform(TARGET, "X"),
    "act.buff": Buff(SELF, "Xe"),
    "act.silence": Silence(TARGET),
    "act.set_tag": SetTag(TARGET, "atk", 1),
    "act.mod_tag": ModTag(TARGET, "atk", 1),
    "act.set_flag": SetFlag(TARGET, "stunned", true),
    "act.move_to": MoveTo(TARGET, At(FRIENDLY, 1)),
    "act.shift": Shift(TARGET, 1),
    "act.swap": Swap(TARGET, CHOSEN),
    "act.strike": Strike(SELF, COMBAT_TARGET(SELF)),
    "act.gain_crystal": GainCrystal(CONTROLLER, 1),
    "act.gain_crystal_cap": GainCrystalCap(CONTROLLER, 1),
    "act.when": when(true, Nothing()),
    "act.repeat": Repeat(3, Nothing()),
    "act.for_each": ForEach(FRIENDLY_UNITS, Nothing()),
    "act.discover": Discover(CardPool(IsSpell()), 3, 1),
    "act.select_target": SelectTarget(ENEMY_UNITS, true),
    "act.nothing": Nothing(),
  } as const satisfies Record<ActOp, Act>;

  /** 把节点交给本族的规范化函数。表里的值类型已由 `satisfies` 保证，这里的收窄是安全的。 */
  type Family = readonly [
    name: string,
    table: Readonly<Record<string, { op: string }>>,
    vocabulary: readonly string[],
    canonicalize: (node: { op: string }) => unknown,
  ];

  const canonicalizeCardFamily = (node: { op: string }): unknown =>
    node.op === "card.pool" ? canonicalizePool(node as Pool) : canonicalizeCardRef(node as CardRef);

  const families: readonly Family[] = [
    [
      "sel",
      SEL_BY_OP,
      SEL_OPS.filter((op) => op !== "sel.entity"),
      (n) => canonicalizeSel(n as Sel),
    ],
    ["slot", SLOT_BY_OP, SLOT_OPS, (n) => canonicalizeSlot(n as SlotRef)],
    ["num", NUM_BY_OP, NUM_OPS, (n) => canonicalizeNum(n as Num)],
    ["cond", COND_BY_OP, COND_OPS, (n) => canonicalizeCond(n as Cond)],
    ["card", CARD_BY_OP, CARD_OPS, canonicalizeCardFamily],
    ["act", ACT_BY_OP, ACT_OPS, (n) => canonicalizeAct(n as Act)],
  ];

  for (const [family, table, vocabulary] of families) {
    test(`${family}.* 的每个 op 都有构造器，且构造器产出的 op 与之对应`, () => {
      expect(Object.keys(table).sort()).toEqual([...vocabulary].sort());
      for (const [op, node] of Object.entries(table)) {
        expect(node.op).toBe(op);
      }
    });
  }

  for (const [family, table, , canonicalize] of families) {
    test(`${family}.* 的每个构造器产物本身就是规范形式（规范化是它的不动点）`, () => {
      for (const node of Object.values(table)) {
        expect(canonicalJson(canonicalize(node))).toBe(canonicalJson(node));
      }
    });
  }

  test("sel.entity 刻意不给构造器（IR §5.6 运行时超集，编写层禁用），但规范化仍认它", () => {
    expect(SEL_OPS).toContain("sel.entity");
    expect(Object.keys(SEL_BY_OP)).not.toContain("sel.entity");
    // 运行时超集是引擎绑定时生成的，printer / differ 仍要处理，所以规范化不能拒绝它。
    expect(canonicalJson(canonicalizeSel({ op: "sel.entity", id: 7 }))).toBe(
      '{"op":"sel.entity","id":7}',
    );
  });
});

describe("链式糖", () => {
  test("sel 链：and / or 连写会摊平成一个变参节点", () => {
    const flat = SELF.and(TARGET).and(CHOSEN);
    expect(flat.op).toBe("sel.and");
    expect(canonicalJson(flat)).toBe(
      '{"op":"sel.and","of":[{"op":"sel.self"},{"op":"sel.target"},{"op":"sel.chosen"}]}',
    );
    expect(canonicalJson(SELF.or(TARGET).or(CHOSEN))).toContain('"of":[{"op":"sel.self"}');
  });

  test("sel 链：where / not / random / limit / sort / 位置四件套", () => {
    expect(FRIENDLY_UNITS.where(IsKind(IT, "minion")).op).toBe("sel.where");
    expect(FRIENDLY_UNITS.not(SELF).op).toBe("sel.minus");
    expect(FRIENDLY_UNITS.random().op).toBe("sel.random");
    expect(FRIENDLY_UNITS.limit(2).op).toBe("sel.limit");
    expect(FRIENDLY_UNITS.sort("atk").op).toBe("sel.sort");
    expect(SELF.opposite().op).toBe("sel.opposite");
    expect(SELF.combatTarget().op).toBe("sel.combat_target");
    expect(SELF.attackersOf().op).toBe("sel.attackers_of");
    expect(SELF.adjacent(2).op).toBe("sel.adjacent");
  });

  test("slot 链：SlotOf(SELF).opposite().shift(1)", () => {
    expect(canonicalJson(SlotOf(SELF).opposite().shift(1))).toBe(
      '{"op":"slot.shift","of":{"op":"slot.opposite","of":{"op":"slot.of","of":{"op":"sel.self"}}},"delta":1}',
    );
  });

  test("num 链：算术摊平 + 比较", () => {
    const count = '{"op":"num.count","of":{"op":"sel.zone","side":"friendly","zone":"board"}}';
    // 连写 times 摊平成一个三元变参 num.mul，而不是 mul(mul(count,2),3)
    expect(canonicalJson(Count(FRIENDLY_UNITS).times(2).times(3))).toBe(
      `{"op":"num.mul","of":[${count},2,3]}`,
    );
    expect(canonicalJson(Count(FRIENDLY_UNITS).plus(1).plus(2))).toBe(
      `{"op":"num.add","of":[${count},1,2]}`,
    );
    expect(Count(FRIENDLY_UNITS).minus(1).op).toBe("num.sub");
    expect(Count(FRIENDLY_UNITS).dividedBy(2).op).toBe("num.div");
    expect(Count(FRIENDLY_UNITS).negate().op).toBe("num.neg");
    expect(Count(FRIENDLY_UNITS).clamp(0, 3).op).toBe("num.clamp");
    expect(Attr(SELF, "atk").gte(3).op).toBe("cond.gte");
  });

  test("cond 链：and / or 摊平，not 取反", () => {
    const spell = '{"op":"cond.is_kind","of":{"op":"sel.it"},"kind":"spell"}';
    const beast = '{"op":"cond.has_tribe","of":{"op":"sel.it"},"tribe":"beast"}';
    const minion = '{"op":"cond.is_kind","of":{"op":"sel.it"},"kind":"minion"}';
    expect(canonicalJson(IsSpell().and(HasTribe(IT, "beast")).and(true))).toBe(
      `{"op":"cond.and","of":[${spell},${beast},true]}`,
    );
    expect(canonicalJson(IsSpell().or(IsMinion()))).toBe(
      `{"op":"cond.or","of":[${spell},${minion}]}`,
    );
    expect(IsSpell().not().op).toBe("cond.not");
  });
});

describe("量化糖：Any / All（IR §3.3 的全称量化陷阱）", () => {
  test("Any(of, cond) = 存在量化 = exists(where(of, cond))", () => {
    expect(canonicalJson(Any(FRIENDLY_UNITS, HasTribe(IT, "beast")))).toBe(
      canonicalJson(Exists(Where(FRIENDLY_UNITS, HasTribe(IT, "beast")))),
    );
  });

  test("Any(of) 省略条件时退化为 exists(of)", () => {
    expect(canonicalJson(Any(FRIENDLY_UNITS))).toBe(canonicalJson(Exists(FRIENDLY_UNITS)));
  });

  test("All(of, cond) = 全称量化 = not(exists(where(of, not(cond))))：空集为真", () => {
    expect(canonicalJson(All(FRIENDLY_UNITS, HasTribe(IT, "beast")))).toBe(
      canonicalJson(Not(Exists(Where(FRIENDLY_UNITS, Not(HasTribe(IT, "beast")))))),
    );
  });
});

describe("事件助手（DSL v2 §5 事件表）", () => {
  test("v2 §5 的每个事件名都有助手，且产出的 on 与之对应", () => {
    expect(Object.keys(EVENT_HELPERS).sort()).toEqual([...EVENT_NAMES].sort());
    for (const name of EVENT_NAMES) {
      expect(EVENT_HELPERS[name]().on).toBe(name);
    }
  });

  test("选择器简写 = { target: sel }（v2 §8.6 荆棘卫士行末注释的定义）", () => {
    expect(canonicalJson(Struck(SELF))).toBe(
      '{"on":"struck","filter":{"target":{"op":"sel.self"}}}',
    );
  });

  test("要按出手者过滤时给完整 filter（v2 §8.7 Cleave / Siege）", () => {
    expect(canonicalJson(Struck({ source: SELF }))).toBe(
      '{"on":"struck","filter":{"source":{"op":"sel.self"}}}',
    );
  });

  test("on(事件, 动作...) 收多个动作，也收数组", () => {
    const many = on(CombatBegan(), Hit(TARGET, 1), [Hit(TARGET, 2), Nothing()]);
    expect(many.do).toHaveLength(3);
  });

  test("trigger({...}) 的完整形式：cond / once / zone 都能给", () => {
    const t = trigger({
      on: CombatBegan(),
      cond: true,
      once: true,
      zone: "hand",
      do: Nothing(),
    });
    expect(canonicalJson(t)).toBe(
      '{"on":"combat_began","cond":true,"once":true,"zone":"hand","do":[{"op":"act.nothing"}]}',
    );
  });

  test("trigger 的 filter 可以直接给，也可以由事件助手带过来", () => {
    expect(canonicalJson(trigger({ on: "struck", filter: { target: SELF }, do: [] }))).toBe(
      canonicalJson(trigger({ on: Struck(SELF), do: [] })),
    );
  });
});

describe("卡牌引用糖", () => {
  test("AddToHand 的第二参是选择器时包成 card.of（IR §10.5）", () => {
    expect(AddToHand(CONTROLLER, CHOSEN).card).toEqual({
      op: "card.of",
      of: { op: "sel.chosen" },
    });
  });

  test("AddToHand 的第二参是字面 id 时原样保留", () => {
    expect(AddToHand(CONTROLLER, "X", 2).card).toBe("X");
    expect(AddToHand(CONTROLLER, "X", 2).count).toBe(2);
  });

  test("toCardRef 对已经是 card.* 的引用原样放行", () => {
    const ofNode = CardOf(CHOSEN);
    expect(toCardRef(ofNode)).toBe(ofNode);
    const randomNode = RandomCard(ENEMY_UNITS);
    expect(toCardRef(randomNode)).toBe(randomNode);
  });
});

describe("拦截器糖（IR §4.2）", () => {
  test("四种 effect 都有构造器", () => {
    expect(Cancel()).toEqual({ kind: "cancel" });
    expect(SetField("amount", 1)).toEqual({ kind: "set_field", field: "amount", value: 1 });
    expect(ModField("amount", -1)).toEqual({ kind: "mod_field", field: "amount", delta: -1 });
    expect(Retarget(SELF)).toEqual({ kind: "retarget", to: { op: "sel.self" } });
  });

  test("最小形式的拦截器：只有 intercept 与 effect", () => {
    expect(canonicalJson(intercept({ intercept: "act.hit", effect: Cancel() }))).toBe(
      '{"intercept":"act.hit","effect":{"kind":"cancel"}}',
    );
  });
});

describe("DSL v2 §8.7 Artifact 关键词映射 —— 表达力验证（均无需新 op）", () => {
  test("Retaliate X：被出手命中时反打 X", () => {
    const t = on(Struck({ target: SELF }), Hit(EVENT.source, 2));
    expect(t.on).toBe("struck");
    expect(canonicalJson(t.filter)).toBe('{"target":{"op":"sel.self"}}');
  });

  test("Cleave X：命中单位时溅射其相邻 X", () => {
    const t = on(Struck({ source: SELF }), Hit(Adjacent(EVENT.target), 1));
    expect(canonicalJson(t.do)).toBe(
      '[{"op":"act.hit","target":{"op":"sel.adjacent","of":{"op":"sel.event","field":"target"}},"amount":1}]',
    );
  });

  test("Siege X：命中单位时额外打基地 X（ENEMY_HERO 已更名 ENEMY_BASE）", () => {
    const t = on(Struck({ source: SELF }), when(IsMinion(EVENT.target), Hit(ENEMY_BASE, 2)));
    expect(canonicalJson(t.do)).toContain('{"op":"sel.zone","side":"enemy","zone":"base"}');
  });

  test("改箭头（Compel 类）：Buff + 带 direction 的附魔（v2 §2.3）", () => {
    const ench = defineEnchantment({ id: "COMPELe", direction: 1, duration: "end_of_round" });
    expect(ench.mods).toEqual({ direction: 1 });
    expect(canonicalJson(Buff(TARGET, "COMPELe"))).toBe(
      '{"op":"act.buff","target":{"op":"sel.target"},"ench":"COMPELe"}',
    );
  });
});

describe("具名常量（IR §3.1 对照表 + v2.1 §11.2 词汇分化）", () => {
  test("*_UNITS 是 board 全体（含英雄），*_MINIONS 多一层 is_kind 过滤", () => {
    expect(canonicalJson(FRIENDLY_UNITS)).toBe(
      '{"op":"sel.zone","side":"friendly","zone":"board"}',
    );
    expect(canonicalJson(FRIENDLY_MINIONS)).toBe(
      '{"op":"sel.where","of":{"op":"sel.zone","side":"friendly","zone":"board"},"cond":{"op":"cond.is_kind","of":{"op":"sel.it"},"kind":"minion"}}',
    );
  });

  test("ENEMY_BASE = zone(enemy, base)（v1 的 ENEMY_HERO 改名，架构 §10 第 3 项）", () => {
    expect(canonicalJson(ENEMY_BASE)).toBe('{"op":"sel.zone","side":"enemy","zone":"base"}');
  });

  test("ALL_CHARACTERS = 双方 board + base（v1 写的是 board + hero）", () => {
    expect(canonicalJson(ALL_CHARACTERS)).toBe(
      '{"op":"sel.zone","side":"both","zone":["board","base"]}',
    );
  });

  test("num 的全局量常量", () => {
    expect(canonicalJson([ROUND, CRYSTALS, CRYSTAL_CAP, FATIGUE])).toBe(
      '[{"op":"num.tag","tag":"round"},{"op":"num.tag","tag":"crystals"},{"op":"num.tag","tag":"crystal_cap"},{"op":"num.tag","tag":"fatigue"}]',
    );
  });

  test("方向读写的别名都落在普通 Tag 上（v2 §2.3：direction 不是新机制）", () => {
    expect(canonicalJson(Direction(SELF))).toBe(
      '{"op":"num.attr","of":{"op":"sel.self"},"tag":"direction"}',
    );
    expect(SetDirection(TARGET, -1).tag).toBe("direction");
    expect(ModDirection(TARGET, 1).tag).toBe("direction");
  });

  test("谓词糖的默认参数是 IT（卡池筛选场景）", () => {
    expect(canonicalJson(IsSpell())).toBe(canonicalJson(IsKind(IT, "spell")));
    expect(canonicalJson(IsMinion())).toBe(canonicalJson(IsKind(IT, "minion")));
    expect(canonicalJson(IsHero())).toBe(canonicalJson(IsKind(IT, "hero")));
    expect(canonicalJson(IsToken())).toBe(canonicalJson(IsKind(IT, "token")));
  });

  test("toActs 是公开的归一化入口", () => {
    expect(toActs(Nothing())).toHaveLength(1);
    expect(toActs([Nothing(), Nothing()])).toHaveLength(2);
    expect(toActs(undefined)).toHaveLength(0);
  });

  test("Aura 的完整形式与位置参数形式一致", () => {
    expect(canonicalJson(Aura(SELF, { atk: 1 }, true))).toBe(
      '{"affects":{"op":"sel.self"},"mods":{"atk":1},"cond":true,"zone":"board"}',
    );
    expect(canonicalJson(Aura(ALL_UNITS))).toBe(
      '{"affects":{"op":"sel.zone","side":"both","zone":"board"},"zone":"board"}',
    );
  });
});
