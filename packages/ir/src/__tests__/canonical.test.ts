// IR §1 原则 1 的守门测试：**IR 是规范形式，糖只存在于编写层**。
//
// > TS 里 `play: Hit(TARGET, 6)` 和 `play: [Hit(TARGET, 6)]` 都合法，编译产出永远是数组。
// > IR 里不存在"两种写法等价"这种事，否则 diff、缓存 key、哈希全部会出问题。
//
// 所以这一组测试的形式统一是：**两种写法 → 同一个字符串**。
// 每条规则一个 describe，规则本身写在 `../builder/canonical.ts` 的头注释里。

import { describe, expect, test } from "bun:test";
import {
  ALL_UNITS,
  At,
  Aura,
  aura,
  Buff,
  Cancel,
  CombatBegan,
  Count,
  canonicalizeAct,
  canonicalizeActs,
  canonicalizeAura,
  canonicalizeCard,
  canonicalizeCardScript,
  canonicalizeCond,
  canonicalizeEnchantment,
  canonicalizeNum,
  canonicalizeSel,
  canonicalizeTrigger,
  canonicalJson,
  Discover,
  defineCard,
  defineEnchantment,
  ENEMY_UNITS,
  EVENT,
  FRIENDLY,
  FRIENDLY_UNITS,
  Hit,
  IsKind,
  IT,
  intercept,
  ModField,
  Nothing,
  on,
  Retarget,
  SELF,
  SetField,
  Struck,
  Summon,
  TARGET,
  trigger,
  UnitsAt,
  when,
  Zone,
} from "../builder/index.ts";
import type { Act, Card, CardScript, Sel } from "../types/index.ts";

/** 一张卡的规范形式 JSON —— 全部断言的公共度量衡。 */
const json = (card: Card): string => canonicalJson(card);

describe("规则 1：单个 → 数组（`play: Hit(...)` ≡ `play: [Hit(...)]`）", () => {
  test("★ play 写单个动作与写数组产出同一份 JSON", () => {
    const single = defineCard({
      id: "T_001",
      name: "测试",
      kind: "spell",
      colors: "red",
      play: Hit(TARGET, 6),
    });
    const array = defineCard({
      id: "T_001",
      name: "测试",
      kind: "spell",
      colors: "red",
      play: [Hit(TARGET, 6)],
    });
    expect(json(single)).toBe(json(array));
    // 并且确实是数组，不是被"归一"成了别的东西
    expect(single.script.play).toHaveLength(1);
  });

  test("deathrattle / triggers / aura 三处同样成立", () => {
    const singles = defineCard({
      id: "T_002",
      name: "测试",
      kind: "minion",
      colors: "green",
      deathrattle: Summon(SELF, "T_TOKEN"),
      triggers: on(CombatBegan(), Buff(SELF, "T_002e")),
      aura: Aura(SELF, { atk: 1 }),
    });
    const arrays = defineCard({
      id: "T_002",
      name: "测试",
      kind: "minion",
      colors: "green",
      deathrattle: [Summon(SELF, "T_TOKEN")],
      triggers: [on(CombatBegan(), Buff(SELF, "T_002e"))],
      auras: [Aura(SELF, { atk: 1 })],
    });
    expect(json(singles)).toBe(json(arrays));
  });

  test("when 的 then / else 分支同样成立", () => {
    const single = canonicalizeAct(when(true, Hit(TARGET, 1), Hit(SELF, 1)));
    const array = canonicalizeAct(when(true, [Hit(TARGET, 1)], [Hit(SELF, 1)]));
    expect(canonicalJson(single)).toBe(canonicalJson(array));
  });

  test("canonicalizeActs 直接吃单个动作", () => {
    expect(canonicalJson(canonicalizeActs(Hit(TARGET, 1)))).toBe(
      canonicalJson(canonicalizeActs([Hit(TARGET, 1)])),
    );
    expect(canonicalizeActs(undefined)).toHaveLength(0);
  });
});

describe("规则 2：键序固定（= 规范签名的字段声明顺序，op 永远第一）", () => {
  test("手写节点的键序被重排成规范键序", () => {
    // 故意把键写反：先 amount 后 target，op 放最后
    const scrambled = { amount: 6, target: { op: "sel.target" }, op: "act.hit" } as Act;
    expect(canonicalJson(canonicalizeAct(scrambled))).toBe(
      canonicalJson(canonicalizeAct(Hit(TARGET, 6))),
    );
    expect(Object.keys(canonicalizeAct(scrambled))).toEqual(["op", "target", "amount"]);
  });

  test("builder 产物本身就是规范键序（不依赖事后重排）", () => {
    expect(Object.keys(Hit(TARGET, 6))).toEqual(["op", "target", "amount"]);
    expect(Object.keys(Summon(SELF, "X"))).toEqual(["op", "player", "card", "at"]);
    expect(Object.keys(Discover(ALL_UNITS))).toEqual(["op", "from", "show", "pick"]);
  });

  test("编写层字段的书写顺序不影响产物", () => {
    const a = defineCard({
      id: "T_003",
      name: "测试",
      kind: "minion",
      colors: "blue",
      atk: 1,
      health: 2,
      cost: 3,
      play: Hit(TARGET, 1),
    });
    const b = defineCard({
      play: Hit(TARGET, 1),
      health: 2,
      cost: 3,
      colors: "blue",
      atk: 1,
      kind: "minion",
      name: "测试",
      id: "T_003",
    });
    expect(json(a)).toBe(json(b));
  });

  test("自由映射按词汇表声明顺序排：mods / tags / colors / filter", () => {
    const ench = defineEnchantment({ id: "T_e", mods: { health: 1, direction: -1, atk: 2 } });
    expect(Object.keys(ench.mods ?? {})).toEqual(["atk", "health", "direction"]);

    const card = defineCard({
      id: "T_004",
      name: "测试",
      kind: "minion",
      colors: ["green", "red"],
      tags: { health: 4, atk: 3 },
    });
    expect(card.data.colors).toEqual(["red", "green"]);
    expect(Object.keys(card.data.tags ?? {})).toEqual(["atk", "health"]);

    const t = canonicalizeTrigger(
      trigger({ on: "struck", filter: { player: SELF, target: SELF, source: SELF }, do: [] }),
    );
    expect(Object.keys(t.filter ?? {})).toEqual(["source", "target", "player"]);
  });
});

describe("规则 3：缺省不写；只有规范要求处才显式化默认值", () => {
  test("空 script 段一律不出现", () => {
    const bare = defineCard({ id: "T_005", name: "测试", kind: "minion", colors: "red" });
    expect(canonicalJson(bare.script)).toBe("{}");
    expect(Object.hasOwn(bare.script, "play")).toBe(false);
    expect(Object.hasOwn(bare.script, "triggers")).toBe(false);
  });

  test("null 与空数组等同于缺省（IR §2.2：省略等价于空数组 / null）", () => {
    const withNulls: CardScript = {
      target: null,
      requires: null,
      play: [],
      deathrattle: [],
      triggers: [],
      intercepts: [],
      auras: [],
      costMod: null,
      chooseOne: [],
    };
    expect(canonicalJson(canonicalizeCardScript(withNulls))).toBe("{}");
  });

  test("字面 false / 0 不是缺省，必须留下（IR §1 原则 4：字面量不包装）", () => {
    const card = defineCard({
      id: "T_006",
      name: "测试",
      kind: "spell",
      colors: "blue",
      requires: false,
      costMod: 0,
      play: Hit(TARGET, 0),
    });
    expect(card.script.requires).toBe(false);
    expect(card.script.costMod).toBe(0);
  });

  test("act.summon.at 必填：省略时补 slot.random_empty(friendly)（v2 §3.4 / §7）", () => {
    expect(canonicalJson(Summon(SELF, "X"))).toContain('"at":{"op":"slot.random_empty"');
    // 显式给了就用给的那个
    expect(canonicalJson(Summon(SELF, "X", At(FRIENDLY, 4)))).toContain(
      '"at":{"op":"slot.at","side":"friendly","index":4}',
    );
  });

  test("act.discover.show / pick 显式写出 3 / 1（IR §10.5 的规范 JSON 就是这样）", () => {
    expect(canonicalJson(Discover(ALL_UNITS))).toContain('"show":3,"pick":1');
  });

  test("trigger.zone 与 aura.zone 补默认 board（IR §4.1 / §4.3）", () => {
    expect(canonicalizeTrigger(on(Struck(SELF), Hit(EVENT.source, 1))).zone).toBe("board");
    expect(canonicalizeAura(Aura(SELF, { atk: 1 })).zone).toBe("board");
    // 显式给了就不覆盖
    expect(canonicalizeTrigger(trigger({ on: "unit_died", zone: "graveyard", do: [] })).zone).toBe(
      "graveyard",
    );
  });

  test("act.draw.count / sel.random.distinct 缺省时不写（对齐 IR §10.4 的 JSON）", () => {
    expect(canonicalJson(canonicalizeSel(ENEMY_UNITS.random(2)))).toBe(
      '{"op":"sel.random","of":{"op":"sel.zone","side":"enemy","zone":"board"},"n":2}',
    );
  });
});

describe("规则 4：单元素集合退化为标量", () => {
  test("zone / kind / slot 三处", () => {
    expect(canonicalJson(canonicalizeSel(Zone("both", ["board"])))).toBe(
      '{"op":"sel.zone","side":"both","zone":"board"}',
    );
    expect(canonicalJson(canonicalizeCond(IsKind(IT, ["spell"])))).toBe(
      '{"op":"cond.is_kind","of":{"op":"sel.it"},"kind":"spell"}',
    );
    expect(canonicalJson(canonicalizeSel(UnitsAt([At(FRIENDLY, 0)])))).toBe(
      canonicalJson(canonicalizeSel(UnitsAt(At(FRIENDLY, 0)))),
    );
  });

  test("多元素集合按词汇表顺序去重", () => {
    expect(canonicalJson(canonicalizeSel(Zone("both", ["base", "board", "board"])))).toBe(
      '{"op":"sel.zone","side":"both","zone":["board","base"]}',
    );
    expect(canonicalJson(canonicalizeCond(IsKind(IT, ["token", "minion", "minion"])))).toBe(
      '{"op":"cond.is_kind","of":{"op":"sel.it"},"kind":["minion","token"]}',
    );
  });
});

describe("幂等与稳定性", () => {
  const rich = defineCard({
    id: "T_007",
    name: { zh: "全字段", en: "Everything" },
    text: "测试用",
    kind: "minion",
    cost: 5,
    colors: ["red", "blue"],
    rarity: "legendary",
    tribe: "beast",
    art: "pf1/test",
    collectible: true,
    atk: 4,
    health: 4,
    target: ALL_UNITS,
    requires: Count(FRIENDLY_UNITS).gte(1),
    play: [when(Count(ENEMY_UNITS).gt(0), Hit(TARGET, 2), Summon(SELF, "T_TOKEN"))],
    deathrattle: Summon(SELF, "T_TOKEN"),
    triggers: [on(Struck(SELF), Hit(EVENT.source, 1))],
    aura: Aura(FRIENDLY_UNITS.not(SELF), { atk: 1 }),
    costMod: Count(FRIENDLY_UNITS).negate(),
  });

  test("canonicalizeCard 是幂等的", () => {
    expect(json(canonicalizeCard(rich))).toBe(json(rich));
    expect(json(canonicalizeCard(canonicalizeCard(rich)))).toBe(json(rich));
  });

  test("同一份源多次求值产出同一份 JSON（缓存 key / 哈希的前提）", () => {
    const again = defineCard({
      id: "T_007",
      name: { zh: "全字段", en: "Everything" },
      text: "测试用",
      kind: "minion",
      cost: 5,
      colors: ["red", "blue"],
      rarity: "legendary",
      tribe: "beast",
      art: "pf1/test",
      collectible: true,
      atk: 4,
      health: 4,
      target: ALL_UNITS,
      requires: Count(FRIENDLY_UNITS).gte(1),
      play: [when(Count(ENEMY_UNITS).gt(0), Hit(TARGET, 2), Summon(SELF, "T_TOKEN"))],
      deathrattle: Summon(SELF, "T_TOKEN"),
      triggers: [on(Struck(SELF), Hit(EVENT.source, 1))],
      aura: Aura(FRIENDLY_UNITS.not(SELF), { atk: 1 }),
      costMod: Count(FRIENDLY_UNITS).negate(),
    });
    expect(json(again)).toBe(json(rich));
  });

  test("JSON round-trip 后仍是同一份规范形式（产物是纯数据）", () => {
    const parsed = JSON.parse(json(rich)) as Card;
    expect(json(canonicalizeCard(parsed))).toBe(json(rich));
  });

  test("附魔同样幂等", () => {
    const ench = defineEnchantment({
      id: "T_e2",
      atk: 1,
      health: 1,
      flags: "divine_shield",
      duration: "end_of_round",
      auras: Aura(SELF, { atk: 1 }),
      triggers: on(Struck(SELF), Hit(EVENT.source, 1)),
    });
    expect(canonicalJson(canonicalizeEnchantment(ench))).toBe(canonicalJson(ench));
    expect(ench.flags).toEqual(["divine_shield"]);
  });
});

describe("其余 script 段：intercepts / chooseOne / 带 flags 的光环", () => {
  test("拦截器四种 effect 都能规范化，键序为 intercept, filter, cond, effect, then, priority", () => {
    const card = defineCard({
      id: "T_009",
      name: "拦截测试",
      kind: "minion",
      colors: "blue",
      intercepts: [
        intercept({ intercept: "act.hit", filter: { target: SELF }, effect: Cancel() }),
        intercept({ intercept: "act.hit", effect: SetField("amount", 1), priority: 5 }),
        intercept({ intercept: "act.heal", effect: ModField("amount", -1) }),
        intercept({ intercept: "act.hit", cond: true, effect: Retarget(SELF), then: Nothing() }),
      ],
    });
    expect(card.script.intercepts).toHaveLength(4);
    expect(canonicalJson(card.script.intercepts)).toBe(
      canonicalJson(canonicalizeCard(card).script.intercepts),
    );
    expect(canonicalJson(card.script.intercepts?.[3])).toBe(
      '{"intercept":"act.hit","cond":true,"effect":{"kind":"retarget","to":{"op":"sel.self"}},"then":[{"op":"act.nothing"}]}',
    );
  });

  test("chooseOne 的每个选项也走规范化（键序 id, text, target, play）", () => {
    const card = defineCard({
      id: "T_010",
      name: "抉择测试",
      kind: "spell",
      colors: "green",
      chooseOne: [
        { id: "a", text: { zh: "打一下" }, target: ENEMY_UNITS, play: [Hit(TARGET, 2)] },
        { id: "b", text: { zh: "什么都不做" }, play: [] },
      ],
    });
    expect(canonicalJson(card.script.chooseOne)).toBe(
      '[{"id":"a","text":{"zh":"打一下"},"target":{"op":"sel.zone","side":"enemy","zone":"board"},"play":[{"op":"act.hit","target":{"op":"sel.target"},"amount":2}]},{"id":"b","text":{"zh":"什么都不做"},"play":[]}]',
    );
  });

  test("光环的 flags 按 FLAG_NAMES 顺序排，空数组不写，单个 flag 归一成数组", () => {
    const withFlags = canonicalizeAura({
      affects: SELF,
      flags: ["silenced", "divine_shield"],
      zone: "board",
    });
    expect(withFlags.flags).toEqual(["divine_shield", "silenced"]);
    expect(Object.hasOwn(canonicalizeAura({ affects: SELF, flags: [] }), "flags")).toBe(false);
    expect(aura({ affects: SELF, flags: "divine_shield" }).flags).toEqual(["divine_shield"]);
  });

  test("附魔的扁平属性字段全部落到 mods（atk / health / cost / direction / armor）", () => {
    const ench = defineEnchantment({
      id: "T_e3",
      atk: 1,
      health: 2,
      cost: -1,
      direction: 1,
      armor: 3,
    });
    expect(ench.mods).toEqual({ atk: 1, health: 2, cost: -1, direction: 1, armor: 3 });
  });
});

describe("糖不渗漏：链式方法挂在原型上，不进产物", () => {
  test("链式节点的自有属性只有数据", () => {
    expect(Object.keys(SELF)).toEqual(["op"]);
    expect(Object.keys(FRIENDLY_UNITS.where(IsKind(IT, "minion")))).toEqual(["op", "of", "cond"]);
  });

  test("链式节点直接 JSON.stringify 就已经是规范形式", () => {
    const chained: Sel = FRIENDLY_UNITS.not(SELF).where(IsKind(IT, "minion"));
    expect(JSON.stringify(chained)).toBe(canonicalJson(canonicalizeSel(chained)));
  });

  test("defineCard 的产物每一层都是普通对象（没有链式原型跟进来）", () => {
    const card = defineCard({
      id: "T_008",
      name: "测试",
      kind: "spell",
      colors: "red",
      target: FRIENDLY_UNITS.not(SELF),
      play: Hit(TARGET, Count(FRIENDLY_UNITS).times(2)),
    });
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item);
        }
        return;
      }
      if (typeof value === "object" && value !== null) {
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
        for (const item of Object.values(value)) {
          walk(item);
        }
      }
    };
    walk(card);
  });

  test("规范化不改变字面量的包装状态（数字仍是数字）", () => {
    expect(canonicalizeNum(6)).toBe(6);
    expect(canonicalizeCond(true)).toBe(true);
  });
});
