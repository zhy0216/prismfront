// `eval/` 的验收测试：evalSel / evalNum / evalCond / evalSlot。
//
// 三条被反复钉的性质（对应 M4 任务书 E2 的三项）：
//   1. **穷尽检查**（`assertNever`）—— 编译期保险测不了，这里测它的运行期兜底：
//      喂一个不存在的 op 必须抛，而不是静默当空集跳过。
//   2. **空集合语义统一表**（IR v1 §5.2）—— 每一位单独一条断言，
//      特别是 ★ `num.slot_index → -1` 这个全 IR 唯一的例外。
//   3. **RNG 求值顺序**（IR v1 §5.4）—— 短路（规则 3）、只求值命中分支（规则 4），
//      以及**其余字段一律按签名声明顺序全部求值、不擅自提前返回**（规则 1）这三条，
//      判据不是"结果对不对"，而是**RNG 推进了几次**。
//      所以本文件用 {@link rngDraws} 数 `engine.random_picked` 的条数，
//      而不是去比对随机结果 —— 结果相同、消耗次数不同，回放照样失真。
//      ★ 但「字段谁先谁后」这一支光数条数是**测不出来的**（两种顺序总次数相同），
//        判据必须换成 {@link randomOrigins} 的**序列**，见规则 1 那几条测试。
//
// 盘面一律走 `testkit`（`openGame` / `putUnit`），不写状态字面量。

import { describe, expect, test } from "bun:test";
import type {
  CardData,
  CardId,
  CardKind,
  Cond,
  EntityId,
  Num,
  Pool,
  Sel,
  SlotRef,
} from "@prismfront/ir";
import { peekEventLog } from "../../events/index.ts";
import type { CtxBindings, GameState, PlayerId } from "../../state/index.ts";
import { createCtx, getEntity, getZone, playerData, withCtx } from "../../state/index.ts";
import {
  baseIdOf,
  deckTop,
  handOf,
  openGame,
  putCard,
  putOnSlot,
  putUnit,
  scriptCard,
  setFlag,
} from "../../testkit/index.ts";
import type { CardLookup, EvalEnv } from "../index.ts";
import {
  assertNever,
  createEvalEnv,
  EMPTY_SET,
  evalCardRef,
  evalCond,
  evalEntities,
  evalNum,
  evalSel,
  evalSlot,
  forAll,
  INVALID_SLOT,
  NO_CARDS,
  NO_ENCHANTMENTS,
  resolveSelSides,
  single,
  withIt,
} from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════════════════

/** 造一个求值环境：SELF + 若干上下文覆盖 + 可选卡表。 */
function envOf(
  state: GameState,
  self: EntityId,
  patch: Partial<CtxBindings> = {},
  cards: CardLookup = NO_CARDS,
): EvalEnv {
  return createEvalEnv(state, withCtx(createCtx(self), patch), cards);
}

/**
 * 本段里每一次 RNG 推进的**来源序列**（`origin` 是 `rollInt` 的入参，按发生先后）。
 *
 * 这是「字段谁先求值」唯一有判别力的探针：`sel.random(of, n)` 无论先 `of` 还是先 `n`，
 * 总抽数都一样，只有 origin 的**先后**能把两种实现分开（IR v1 §5.4 规则 1）。
 */
function randomOrigins(state: GameState): string[] {
  return peekEventLog(state)
    .filter((event) => event.name === "engine.random_picked")
    .map((event) => (event.name === "engine.random_picked" ? event.origin : ""));
}

/** 本段里 RNG 被推进了几次（= `engine.random_picked` 的条数，`rollInt` 一一对应）。 */
function rngDraws(state: GameState): number {
  return randomOrigins(state).length;
}

/** 一张最小卡面。`colors` 给两项就是融合卡（v2.1 §11.4）。 */
function cardOf(init: Partial<CardData> = {}): CardData {
  return { name: { zh: "测试卡" }, kind: "minion", colors: ["red"], ...init };
}

/** 一张按 cardId 前缀分类的卡表：`A*` = 红色单位，`B*` = 蓝色法术且是野兽。 */
const TEST_CARDS: CardLookup = (cardId: CardId) => {
  if (cardId.startsWith("A")) {
    return cardOf({ kind: "minion", colors: ["red"] });
  }
  if (cardId.startsWith("B")) {
    return cardOf({ kind: "spell", colors: ["blue", "green"], tribe: "beast" });
  }
  return undefined;
};

/** 把一个实体打到必死（`cond.dead` 的判据是 `isLethal`，见 cond.ts）。 */
function kill(state: GameState, id: EntityId): void {
  const entity = getEntity(state, id);
  if (entity === undefined) {
    throw new Error(`夹具错误：实体 ${id} 不存在`);
  }
  entity.damage = entity.tags.health;
}

/** 常用节点糖，省掉一堆字面量噪声。 */
const SELF: Sel = { op: "sel.self" };
const IT: Sel = { op: "sel.it" };
const board = (side: "friendly" | "enemy" | "both"): Sel => ({
  op: "sel.zone",
  side,
  zone: "board",
});
const at = (side: "friendly" | "enemy", index: Num): SlotRef => ({ op: "slot.at", side, index });
/**
 * `zone(side,"board").where(is_kind(it, kind))` —— IR 的 `*_MINIONS` / `*_HEROES`
 * 展开成的节点树（`ir/src/builder/constants.ts`）。这里照抄形状而不 import 那两个常量，
 * 因为 engine 对 ir 是**纯类型依赖**（架构 §2.2 禁令 1）。
 */
const boardOfKind = (
  side: "friendly" | "enemy" | "both",
  kind: CardKind | readonly CardKind[],
): Sel => ({ op: "sel.where", of: board(side), cond: { op: "cond.is_kind", of: IT, kind } });
const rand = (of: Sel, n?: Num, distinct?: boolean): Sel => ({
  op: "sel.random",
  of,
  ...(n === undefined ? {} : { n }),
  ...(distinct === undefined ? {} : { distinct }),
});
/** 一个必定推进 RNG 的条件（用来观测短路有没有真的跳过右侧）。 */
const RANDOM_COND: Cond = { op: "cond.gte", l: { op: "num.random", lo: 0, hi: 9 }, r: 0 };

/**
 * 三张**只差 `data.kind`** 的卡（v2.1 §11.2 的词汇分化全押在这一个字段上）。
 *
 * 攻血一律由 {@link putCard} 在摆盘时给同一份，于是"英雄被算进随从里"这类错误
 * 不可能被卡面数字的差异遮掩。
 */
const HERO_CARD = scriptCard("K_HERO", {}, { kind: "hero" });
const MINION_CARD = scriptCard("K_MINION", {}, { kind: "minion" });
const TOKEN_CARD = scriptCard("K_TOKEN", {}, { kind: "token" });
/** 上面三张卡的卡表（形状同 {@link TEST_CARDS}，求值器只要这一个函数）。 */
const KIND_CARDS: CardLookup = (cardId: CardId) =>
  [HERO_CARD, MINION_CARD, TOKEN_CARD].find((card) => card.id === cardId)?.data;

// ═══════════════════════════════════════════════════════════════════════════
// ★ 1. 穷尽检查（assertNever）
// ═══════════════════════════════════════════════════════════════════════════

describe("★ 穷尽检查：未知 op 必须抛，而不是静默当空集", () => {
  test("assertNever 自己", () => {
    expect(() => assertNever("不存在的东西" as never)).toThrow(/未知的 IR 节点/);
  });

  test("四个求值器的 default 分支", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    expect(() => evalSel(env, { op: "sel.不存在" } as unknown as Sel)).toThrow(/未知的 IR 节点/);
    expect(() => evalNum(env, { op: "num.不存在" } as unknown as Num)).toThrow(/未知的 IR 节点/);
    expect(() => evalCond(env, { op: "cond.不存在" } as unknown as Cond)).toThrow(/未知的 IR 节点/);
    expect(() => evalSlot(env, { op: "slot.不存在" } as unknown as SlotRef)).toThrow(
      /未知的 IR 节点/,
    );
  });

  test("num.tag 的 GlobalTag 也穷尽", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    expect(() => evalNum(env, { op: "num.tag", tag: "不存在" } as unknown as Num)).toThrow(
      /未知的 IR 节点/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 2. 空集合语义统一表（IR v1 §5.2）
// ═══════════════════════════════════════════════════════════════════════════

describe("★ 空集合语义统一表（IR v1 §5.2）", () => {
  test("表本身就是规范原文的取值", () => {
    expect(EMPTY_SET.actSkipped).toBeNull();
    expect(EMPTY_SET.count).toBe(0);
    expect(EMPTY_SET.attr).toBe(0);
    expect(EMPTY_SET.sum).toBe(0);
    expect(EMPTY_SET.exists).toBe(false);
    expect(EMPTY_SET.all).toBe(true);
    expect(EMPTY_SET.cardRef).toBeNull();
    // ★★ 全 IR 唯一的例外：0 是真实格子，不能当空值用（v2 §3.3）
    expect(EMPTY_SET.slotIndex).toBe(-1);
    expect(INVALID_SLOT).toBeNull();
  });

  test("forAll：空集恒真，非空逐项判定", () => {
    expect(forAll([], () => false)).toBe(EMPTY_SET.all);
    expect(forAll([1, 2], (n) => n > 0)).toBe(true);
    expect(forAll([1, -2], (n) => n > 0)).toBe(false);
  });

  test("num.count / num.attr / num.sum 空集 → 0", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    const empty = board("friendly"); // 战线全空
    expect(evalNum(env, { op: "num.count", of: empty })).toBe(0);
    expect(evalNum(env, { op: "num.attr", of: empty, tag: "atk" })).toBe(0);
    expect(evalNum(env, { op: "num.sum", of: empty, tag: "atk" })).toBe(0);
  });

  test("★ num.slot_index 空集 → -1（全 IR 唯一例外）", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    // 空集
    expect(evalNum(env, { op: "num.slot_index", of: board("friendly") })).toBe(-1);
    // 非单实体
    putUnit(state, 0, 0, { atk: 1, health: 1 });
    putUnit(state, 0, 1, { atk: 1, health: 1 });
    expect(evalNum(env, { op: "num.slot_index", of: board("friendly") })).toBe(-1);
    // 不在场（base 不占格）
    expect(evalNum(env, { op: "num.slot_index", of: SELF })).toBe(-1);
    // 真在场 → 真索引，而且 0 号格必须是 0 而不是"空值"
    const zero = envOf(state, baseIdOf(state, 0), { target: getZone(state, 0, "board")[0] ?? 0 });
    expect(evalNum(zero, { op: "num.slot_index", of: { op: "sel.target" } })).toBe(0);
  });

  test("cond.exists 空集 → false（即使 atLeast 为 0）", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    expect(evalCond(env, { op: "cond.exists", of: board("friendly") })).toBe(false);
    expect(evalCond(env, { op: "cond.exists", of: board("friendly"), atLeast: 0 })).toBe(false);
  });

  test("cond.has_* / cond.is_* 空集 → true（全称量化）", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0), {}, TEST_CARDS);
    const empty = board("friendly");
    expect(evalCond(env, { op: "cond.has_tag", of: empty, tag: "atk" })).toBe(true);
    expect(evalCond(env, { op: "cond.has_flag", of: empty, flag: "stunned" })).toBe(true);
    expect(evalCond(env, { op: "cond.is_kind", of: empty, kind: "minion" })).toBe(true);
    expect(evalCond(env, { op: "cond.has_color", of: empty, color: "red" })).toBe(true);
    expect(evalCond(env, { op: "cond.has_tribe", of: empty, tribe: "beast" })).toBe(true);
    expect(evalCond(env, { op: "cond.in_zone", of: empty, zone: "board" })).toBe(true);
    expect(evalCond(env, { op: "cond.dead", of: empty })).toBe(true);
  });

  test("无效槽：cond.occupied → false，sel.at → 空集", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    const outOfRange = at("friendly", 99);
    expect(evalSlot(env, outOfRange)).toBeNull();
    expect(evalCond(env, { op: "cond.occupied", slot: outOfRange })).toBe(false);
    expect(evalSel(env, { op: "sel.at", slot: outOfRange })).toEqual([]);
    // 有效但空的格同样是 false（判空要用 cond.not 包一层）
    expect(evalCond(env, { op: "cond.occupied", slot: at("friendly", 0) })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 3. RNG 求值顺序（IR v1 §5.4）
// ═══════════════════════════════════════════════════════════════════════════

describe("★ RNG 求值顺序（IR v1 §5.4）", () => {
  test("规则 3｜cond.and 遇 false 停：右侧的 RNG 不消耗", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    expect(evalCond(env, { op: "cond.and", of: [false, RANDOM_COND] })).toBe(false);
    expect(rngDraws(state)).toBe(0);
    // 左侧为真时右侧照常求值 —— 否则"没消耗"只是因为根本没实现
    expect(evalCond(env, { op: "cond.and", of: [true, RANDOM_COND] })).toBe(true);
    expect(rngDraws(state)).toBe(1);
  });

  test("规则 3｜cond.or 遇 true 停：右侧的 RNG 不消耗", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    expect(evalCond(env, { op: "cond.or", of: [true, RANDOM_COND] })).toBe(true);
    expect(rngDraws(state)).toBe(0);
    expect(evalCond(env, { op: "cond.or", of: [false, RANDOM_COND] })).toBe(true);
    expect(rngDraws(state)).toBe(1);
  });

  test("规则 4｜num.if 只求值命中的那个分支", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    const randomNum: Num = { op: "num.random", lo: 100, hi: 199 };
    // 命中 then：else 里的随机一次都不能抽（"先都算出来再选"会抽 2 次）
    expect(evalNum(env, { op: "num.if", cond: true, then: 7, else: randomNum })).toBe(7);
    expect(rngDraws(state)).toBe(0);
    // 命中 else：这时才抽，且只抽一次
    const picked = evalNum(env, { op: "num.if", cond: false, then: randomNum, else: randomNum });
    expect(rngDraws(state)).toBe(1);
    expect(picked).toBeGreaterThanOrEqual(100);
    expect(picked).toBeLessThanOrEqual(199);
  });

  test("规则 1｜sel.random 先 of 后 n：判据是 origin **序列**，不是总次数", () => {
    const state = openGame();
    for (let slot = 0; slot < 3; slot += 1) {
      putUnit(state, 0, slot, { atk: 1, health: 1 });
    }
    const env = envOf(state, baseIdOf(state, 0));
    // of 位与 n 位**各放一个随机节点**，两者 origin 不同 ⇒ 序列能区分先后：
    //   of = sel.random(3 个候选, n=3) → 3 条 origin="sel.random"
    //   n  = num.random(1,1)          → 1 条 origin="num.random"
    //   外层再按 n=1 抽 1 个           → 1 条 origin="sel.random"
    const picked = evalSel(
      env,
      rand(rand(board("friendly"), 3), { op: "num.random", lo: 1, hi: 1 }),
    );
    expect(picked).toHaveLength(1);
    // ⚠ 只数总次数（5）在「先 n 后 of」下**一模一样**，钉不住任何东西 ——
    //   本条曾经就只有一句 `rngDraws === 3`，名字挂着规则 1 却测不到它。
    // 注入：把 `eval/sel.ts` 的 `const count = …` 提到 `const pool = …` 之前 ⇒
    //   序列变成 ["num.random", "sel.random"×4] ⇒ 本条变红（总次数仍是 5）。
    expect(randomOrigins(state)).toEqual([
      "sel.random",
      "sel.random",
      "sel.random",
      "num.random",
      "sel.random",
    ]);
  });

  test("规则 1｜cond.exists 的 atLeast 在**空集判定之前**求值", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0)); // 战线全空 ⇒ of 是空集
    // 空集恒假由统一表钉死（IR v1 §5.2），但 atLeast 里的随机**照抽不误** ——
    // 否则同一张卡在「集合恰好为空」时少推进一次 RNG，而集合空不空随盘面变。
    expect(
      evalCond(env, {
        op: "cond.exists",
        of: board("friendly"),
        atLeast: { op: "num.random", lo: 1, hi: 1 },
      }),
    ).toBe(false);
    // 注入：在 `eval/cond.ts` 的 `const count = …` 之后加
    //   `if (count === 0) { return EMPTY_SET.exists; }` ⇒ 抽数变 0 ⇒ 本条变红。
    expect(rngDraws(state)).toBe(1);
  });

  test("规则 1｜cond.has_tag 的 value 只求值一次（推进次数与集合大小无关）", () => {
    const state = openGame();
    for (let slot = 0; slot < 3; slot += 1) {
      putUnit(state, 0, slot, { atk: 1, health: 1 });
    }
    const env = envOf(state, baseIdOf(state, 0));
    // 3 个实体、value 是随机 ⇒ 逐实体求值会抽 3 次，一次性求值只抽 1 次。
    expect(
      evalCond(env, {
        op: "cond.has_tag",
        of: board("friendly"),
        tag: "atk",
        value: { op: "num.random", lo: 1, hi: 1 },
      }),
    ).toBe(true);
    // 注入：把 `eval/cond.ts` 里的 `value` 挪进 `forAll` 回调内逐实体求值 ⇒
    //   抽数变 3 ⇒ 本条变红（结果仍为 true，只有推进次数会漂）。
    expect(rngDraws(state)).toBe(1);
  });

  test("规则 1｜num.div 的 l / r 都求值（l 为 0 也不短路掉 r）", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    // 0 / 2 = 0，但右侧那次随机必须真的发生：短路只属于规则 3/4，num.div 没有。
    expect(evalNum(env, { op: "num.div", l: 0, r: { op: "num.random", lo: 2, hi: 2 } })).toBe(0);
    // 注入：在 `eval/num.ts` 的 `const l = …` 之后加 `if (l === 0) { return 0; }` ⇒
    //   抽数变 0 ⇒ 本条变红（结果仍是 0）。
    expect(rngDraws(state)).toBe(1);
  });

  test("三个推进 RNG 的节点都下发 engine.random_picked（框架 §4.3）", () => {
    const state = openGame();
    putUnit(state, 0, 0, { atk: 1, health: 1 });
    const env = envOf(state, baseIdOf(state, 0));
    evalSel(env, rand(board("friendly")));
    evalNum(env, { op: "num.random", lo: 0, hi: 3 });
    evalSlot(env, { op: "slot.random_empty", side: "friendly" });
    expect(randomOrigins(state)).toEqual(["sel.random", "num.random", "slot.random_empty"]);
  });

  test("空集 / 无空格一次 RNG 都不抽", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    const before = { ...state.rng };
    expect(evalSel(env, rand(board("friendly")))).toEqual([]);
    expect(evalSel(env, rand(board("friendly"), 0))).toEqual([]);
    // hi < lo ⇒ 区间为空 ⇒ 不抽
    expect(evalNum(env, { op: "num.random", lo: 5, hi: 1 })).toBe(5);
    // 战线摆满 ⇒ 没有空格 ⇒ slot.random_empty 不抽
    for (let slot = 0; slot < state.rules.board.slots; slot += 1) {
      putUnit(state, 0, slot, { atk: 1, health: 1 });
    }
    expect(evalSlot(env, { op: "slot.random_empty", side: "friendly" })).toBeNull();
    expect(rngDraws(state)).toBe(0);
    expect(state.rng).toEqual(before);
  });

  test("lo === hi 仍然抽一次（推进次数与分支无关）", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    expect(evalNum(env, { op: "num.random", lo: 4, hi: 4 })).toBe(4);
    expect(rngDraws(state)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// evalSel：上下文叶子
// ═══════════════════════════════════════════════════════════════════════════

describe("evalSel · 上下文叶子（IR v1 §5.1）", () => {
  test("self / target / it / entity", () => {
    const state = openGame();
    const unit = putUnit(state, 0, 0, { atk: 2, health: 3 });
    const env = envOf(state, unit, { target: baseIdOf(state, 1), it: unit });
    expect(evalSel(env, SELF)).toEqual([unit]);
    expect(evalSel(env, { op: "sel.target" })).toEqual([baseIdOf(state, 1)]);
    expect(evalSel(env, IT)).toEqual([unit]);
    expect(evalSel(env, { op: "sel.entity", id: unit })).toEqual([unit]);
  });

  test("未绑定 / 悬空 id 一律空集", () => {
    const state = openGame();
    const env = envOf(state, 999_999);
    expect(evalSel(env, SELF)).toEqual([]);
    expect(evalSel(env, { op: "sel.target" })).toEqual([]);
    expect(evalSel(env, IT)).toEqual([]);
    expect(evalSel(env, { op: "sel.entity", id: 999_999 })).toEqual([]);
    // 悬空 SELF ⇒ 连"友方是谁"都问不出来 ⇒ 区域选择器也是空集
    expect(evalSel(env, board("friendly"))).toEqual([]);
    expect(evalSel(env, { op: "sel.controller" })).toEqual([]);
    expect(resolveSelSides(env, "both")).toEqual([]);
  });

  test("chosen：实体 id 取得到，卡 id 取不到（IR v1 §6.1）", () => {
    const state = openGame();
    const unit = putUnit(state, 0, 0, { atk: 1, health: 1 });
    expect(evalSel(envOf(state, unit, { chosen: unit }), { op: "sel.chosen" })).toEqual([unit]);
    expect(evalSel(envOf(state, unit, { chosen: "A7" }), { op: "sel.chosen" })).toEqual([]);
    expect(evalSel(envOf(state, unit), { op: "sel.chosen" })).toEqual([]);
  });

  test("controller / opponent 取的是 base 实体（v2.1 §11.2）", () => {
    const state = openGame();
    const unit = putUnit(state, 1, 0, { atk: 1, health: 1 });
    const env = envOf(state, unit);
    expect(evalSel(env, { op: "sel.controller" })).toEqual([baseIdOf(state, 1)]);
    expect(evalSel(env, { op: "sel.opponent" })).toEqual([baseIdOf(state, 0)]);
  });

  test("event：仅在有事件绑定时有值，字段缺失给空集", () => {
    const state = openGame();
    const unit = putUnit(state, 0, 0, { atk: 1, health: 1 });
    expect(evalSel(envOf(state, unit), { op: "sel.event", field: "target" })).toEqual([]);
    const bound = envOf(state, unit, {
      event: { name: "damaged", source: null, target: unit, amount: 1 },
    });
    expect(evalSel(bound, { op: "sel.event", field: "target" })).toEqual([unit]);
    expect(evalSel(bound, { op: "sel.event", field: "source" })).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// evalSel：区域、组合、过滤
// ═══════════════════════════════════════════════════════════════════════════

describe("evalSel · 区域与组合", () => {
  test("sel.zone：board 按格序 0→8（v2 §3.2），both 是 [友方, 敌方]", () => {
    const state = openGame();
    const third = putUnit(state, 0, 5, { atk: 1, health: 1 });
    const first = putUnit(state, 0, 1, { atk: 1, health: 1 });
    const enemy = putUnit(state, 1, 3, { atk: 1, health: 1 });
    const env = envOf(state, first);
    // 摆放顺序是 5 → 1，枚举顺序必须是 1 → 5（格序，不是上场序）
    expect(evalSel(env, board("friendly"))).toEqual([first, third]);
    expect(evalSel(env, board("enemy"))).toEqual([enemy]);
    expect(evalSel(env, board("both"))).toEqual([first, third, enemy]);
  });

  test("sel.zone：区域列表 + 去重", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    const hand = handOf(state, 0);
    expect(evalSel(env, { op: "sel.zone", side: "friendly", zone: "hand" })).toEqual([...hand]);
    expect(evalSel(env, { op: "sel.zone", side: "friendly", zone: ["hand", "hand"] })).toEqual([
      ...hand,
    ]);
    expect(evalSel(env, { op: "sel.zone", side: "friendly", zone: ["base", "hand"] })).toEqual([
      baseIdOf(state, 0),
      ...hand,
    ]);
  });

  test("sel.and 保持 of[0] 的顺序；空 of 得空集", () => {
    const state = openGame();
    const a = putUnit(state, 0, 0, { atk: 1, health: 1 });
    const b = putUnit(state, 0, 1, { atk: 1, health: 1 });
    const env = envOf(state, a);
    const both: Sel = { op: "sel.and", of: [board("friendly"), { op: "sel.entity", id: b }] };
    expect(evalSel(env, both)).toEqual([b]);
    expect(evalSel(env, { op: "sel.and", of: [] })).toEqual([]);
    expect(evalSel(env, { op: "sel.and", of: [board("friendly")] })).toEqual([a, b]);
  });

  test("sel.or 去重并按 playOrder 升序", () => {
    const state = openGame();
    const late = putUnit(state, 0, 8, { atk: 1, health: 1 });
    const early = putUnit(state, 0, 0, { atk: 1, health: 1 });
    const env = envOf(state, early);
    // `late` 先上场 ⇒ playOrder 更小 ⇒ 排前面（与格序 0→8 相反，正好能区分两种口径）
    expect(
      evalSel(env, {
        op: "sel.or",
        of: [{ op: "sel.entity", id: early }, board("friendly"), { op: "sel.entity", id: late }],
      }),
    ).toEqual([late, early]);
  });

  test("sel.minus 差集", () => {
    const state = openGame();
    const a = putUnit(state, 0, 0, { atk: 1, health: 1 });
    const b = putUnit(state, 0, 1, { atk: 1, health: 1 });
    const env = envOf(state, a);
    expect(
      evalSel(env, {
        op: "sel.minus",
        of: board("friendly"),
        exclude: { op: "sel.entity", id: a },
      }),
    ).toEqual([b]);
  });

  test("sel.where 逐个求值，sel.it 绑到候选且不污染外层 ctx", () => {
    const state = openGame();
    const weak = putUnit(state, 0, 0, { atk: 1, health: 1 });
    putUnit(state, 0, 1, { atk: 5, health: 1 });
    const env = envOf(state, weak, { it: weak });
    const filtered = evalSel(env, {
      op: "sel.where",
      of: board("friendly"),
      cond: { op: "cond.lte", l: { op: "num.attr", of: IT, tag: "atk" }, r: 1 },
    });
    expect(filtered).toEqual([weak]);
    // 外层 ctx 没有被改写
    expect(env.ctx.it).toBe(weak);
    expect(withIt(env, 42).ctx.it).toBe(42);
  });

  test("sel.limit：start / end / n<=0", () => {
    const state = openGame();
    const a = putUnit(state, 0, 0, { atk: 1, health: 1 });
    const b = putUnit(state, 0, 1, { atk: 1, health: 1 });
    const c = putUnit(state, 0, 2, { atk: 1, health: 1 });
    const env = envOf(state, a);
    expect(evalSel(env, { op: "sel.limit", of: board("friendly"), n: 2 })).toEqual([a, b]);
    expect(evalSel(env, { op: "sel.limit", of: board("friendly"), n: 2, from: "end" })).toEqual([
      b,
      c,
    ]);
    expect(evalSel(env, { op: "sel.limit", of: board("friendly"), n: 99, from: "end" })).toEqual([
      a,
      b,
      c,
    ]);
    expect(evalSel(env, { op: "sel.limit", of: board("friendly"), n: 0 })).toEqual([]);
  });

  test("sel.sort：升序 / 降序，同值按 playOrder 稳定", () => {
    const state = openGame();
    const big = putUnit(state, 0, 0, { atk: 5, health: 1 });
    const tieFirst = putUnit(state, 0, 1, { atk: 2, health: 1 });
    const tieSecond = putUnit(state, 0, 2, { atk: 2, health: 1 });
    const env = envOf(state, big);
    expect(evalSel(env, { op: "sel.sort", of: board("friendly"), by: "atk" })).toEqual([
      tieFirst,
      tieSecond,
      big,
    ]);
    expect(evalSel(env, { op: "sel.sort", of: board("friendly"), by: "atk", dir: "desc" })).toEqual(
      [big, tieFirst, tieSecond],
    );
  });

  test("evalEntities 与 evalSel 顺序一致；single 只认单元素", () => {
    const state = openGame();
    const a = putUnit(state, 0, 0, { atk: 1, health: 1 });
    const b = putUnit(state, 0, 1, { atk: 1, health: 1 });
    const env = envOf(state, a);
    expect(evalEntities(env, board("friendly")).map((entity) => entity.id)).toEqual([a, b]);
    expect(single(evalEntities(env, SELF))?.id).toBe(a);
    expect(single(evalEntities(env, board("friendly")))).toBeUndefined();
    expect(single([])).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 选择器词汇分化：*_UNITS（含英雄）/ *_MINIONS（排除英雄）（v2.1 §11.2）
// ═══════════════════════════════════════════════════════════════════════════
// IR 侧这两个常量差的只有**一层 `sel.where(cond.is_kind(it,"minion"))`**
// （`ir/src/builder/constants.ts` 文件头第 2 条），于是分化成不成立完全取决于
// 求值器里 kind 过滤到底生不生效 —— 而这一支的两种写错方式症状截然不同：
//   · `cond.is_kind` 恒真 ⇒ `*_MINIONS` 退回 `*_UNITS` ⇒ v2 §8.4 那批写「友方随从」的
//     老卡把英雄一起选中。★ 盘面上**看不出任何异常**（英雄本来就在 `*_UNITS` 里），
//     这是本节存在的理由；
//   · 恒假 / 卡表没接进来 ⇒ `*_MINIONS` 筛成空集 ⇒ 那批卡整类静默失效。
// 所以本节一律**成对**摆盘：同一格宽、同一份攻血，只有 `data.kind` 不同。
// 光环那一侧的同一件事由 `resolve/__tests__/auras.test.ts` 钉住（`affects` 里的
// 卡面查询必须经 `deps.cards`，否则同样退化成空集）。

describe("★ 选择器词汇分化：*_UNITS 含英雄 / *_MINIONS 排除英雄（v2.1 §11.2）", () => {
  test("同一条战线：UNITS 三个全要，MINIONS 只剩随从，HEROES 只剩英雄", () => {
    const state = openGame();
    const hero = putCard(state, 0, 0, HERO_CARD, { atk: 3, health: 6 });
    const minion = putCard(state, 0, 1, MINION_CARD, { atk: 3, health: 6 });
    const token = putCard(state, 0, 2, TOKEN_CARD, { atk: 3, health: 6 });
    const env = envOf(state, minion, {}, KIND_CARDS);

    // `FRIENDLY_UNITS` 不带过滤 ⇒ 英雄照样在里面（v2.1 §11.2：英雄占格参战）。
    expect(evalSel(env, board("friendly"))).toEqual([hero, minion, token]);
    // ★ 写错（kind 过滤没生效）会读到三个 —— 光环 / 群体伤害会连英雄一起吃。
    expect(evalSel(env, boardOfKind("friendly", "minion"))).toEqual([minion]);
    // 写错（恒假 / 卡表没传进来）会读到空集：那批卡整类失效。
    expect(evalSel(env, boardOfKind("friendly", "hero"))).toEqual([hero]);
    expect(evalSel(env, boardOfKind("friendly", "token"))).toEqual([token]);
  });

  test("kind 给列表是存在量化：列全三种就恰好补回 UNITS", () => {
    const state = openGame();
    const hero = putCard(state, 0, 0, HERO_CARD, { atk: 3, health: 6 });
    const minion = putCard(state, 0, 1, MINION_CARD, { atk: 3, health: 6 });
    const token = putCard(state, 0, 2, TOKEN_CARD, { atk: 3, health: 6 });
    const env = envOf(state, minion, {}, KIND_CARDS);

    // 写错（`kind` 当成单值、只比第一项）会读到 [minion]。
    expect(evalSel(env, boardOfKind("friendly", ["minion", "token"]))).toEqual([minion, token]);
    // ★ 列全三种 ⇒ 与不带过滤的 `*_UNITS` 逐项相同。这一条钉住"过滤器真的读了
    //   每个实体的 `data.kind`"，而不是写死了一句"随从放行、别的一律挡掉"。
    expect(evalSel(env, boardOfKind("friendly", ["minion", "hero", "token"]))).toEqual([
      hero,
      minion,
      token,
    ]);
  });

  test("多出来的一层 where 不改枚举顺序：both 仍是 [友方, 敌方] + 格序", () => {
    const state = openGame();
    const myHero = putCard(state, 0, 0, HERO_CARD, { atk: 3, health: 6 });
    const myMinion = putCard(state, 0, 4, MINION_CARD, { atk: 3, health: 6 });
    const theirMinion = putCard(state, 1, 2, MINION_CARD, { atk: 3, health: 6 });
    const theirHero = putCard(state, 1, 7, HERO_CARD, { atk: 3, health: 6 });
    const env = envOf(state, myMinion, {}, KIND_CARDS);

    // 顺序是语义的一部分（本文件头）：`sel.where` 只筛不排，`ALL_MINIONS` 因此与
    // `ALL_UNITS` 同序。写错（where 里重排 / side 换算错位）会读到相反的两方顺序。
    expect(evalSel(env, board("both"))).toEqual([myHero, myMinion, theirMinion, theirHero]);
    expect(evalSel(env, boardOfKind("both", "minion"))).toEqual([myMinion, theirMinion]);
    // 敌方英雄同样被滤掉 —— 分化对两侧对称（`ENEMY_MINIONS` 不吃敌方英雄）。
    expect(evalSel(env, boardOfKind("enemy", "minion"))).toEqual([theirMinion]);
    expect(evalSel(env, boardOfKind("both", "hero"))).toEqual([myHero, theirHero]);
  });

  test("没有卡表 ⇒ *_MINIONS 是空集（查不到卡 ⇒ 无法确认是随从）", () => {
    const state = openGame();
    const hero = putCard(state, 0, 0, HERO_CARD, { atk: 3, health: 6 });
    const minion = putCard(state, 0, 1, MINION_CARD, { atk: 3, health: 6 });
    const env = envOf(state, minion); // NO_CARDS

    // `*_UNITS` 不读卡面 ⇒ 退化形态下照旧全给。
    expect(evalSel(env, board("friendly"))).toEqual([hero, minion]);
    // ★ 写错（查不到卡就放行）会读到 [hero, minion] —— 英雄被当成随从，
    //   而且只在**不带卡表**的形态下显形（M2~M4 的流水线全跑在这个形态上）。
    //   退化方向取"不放行"，与 `cond.is_kind` 的既有语义同源（见下方 NO_CARDS 一节）。
    expect(evalSel(env, boardOfKind("friendly", "minion"))).toEqual([]);
    expect(evalSel(env, boardOfKind("friendly", "hero"))).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// evalSel：随机（IR v1 §5.3 规则 3）
// ═══════════════════════════════════════════════════════════════════════════

describe("evalSel · sel.random（★ IR v1 §5.3 规则 3：一次性求值）", () => {
  test("distinct 默认 true：一次抽 n 个互不重复，恰好消耗 n 次 RNG", () => {
    const state = openGame();
    for (let slot = 0; slot < 5; slot += 1) {
      putUnit(state, 0, slot, { atk: 1, health: 1 });
    }
    const env = envOf(state, baseIdOf(state, 0));
    const picked = evalSel(env, rand(board("friendly"), 3));
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
    expect(rngDraws(state)).toBe(3);
  });

  test("n 超过候选数时抽满全部（不会多抽也不会报错）", () => {
    const state = openGame();
    const a = putUnit(state, 0, 0, { atk: 1, health: 1 });
    const b = putUnit(state, 0, 1, { atk: 1, health: 1 });
    const env = envOf(state, baseIdOf(state, 0));
    const picked = evalSel(env, rand(board("friendly"), 9));
    expect([...picked].sort()).toEqual([a, b].sort());
    expect(rngDraws(state)).toBe(2);
  });

  test("distinct: false 允许重复", () => {
    const state = openGame();
    const only = putUnit(state, 0, 0, { atk: 1, health: 1 });
    const env = envOf(state, baseIdOf(state, 0));
    expect(evalSel(env, rand(board("friendly"), 3, false))).toEqual([only, only, only]);
    expect(rngDraws(state)).toBe(3);
  });

  test("同种子同结果，换种子结果会变（确定性）", () => {
    const pick = (seed: number): EntityId[] => {
      const state = openGame({ seed });
      for (let slot = 0; slot < 9; slot += 1) {
        putUnit(state, 0, slot, { atk: 1, health: 1 });
      }
      return evalSel(envOf(state, baseIdOf(state, 0)), rand(board("friendly"), 4));
    };
    expect(pick(7)).toEqual(pick(7));
    expect(pick(7)).not.toEqual(pick(12345));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// evalSel：位置相关（DSL v2 §3.2）
// ═══════════════════════════════════════════════════════════════════════════

describe("evalSel · 位置相关（DSL v2 §3.2）", () => {
  test("sel.at：有人 → 该实体，空格 / 无效槽 → 空集，多槽去重", () => {
    const state = openGame();
    const unit = putUnit(state, 0, 2, { atk: 1, health: 1 });
    const env = envOf(state, unit);
    expect(evalSel(env, { op: "sel.at", slot: at("friendly", 2) })).toEqual([unit]);
    expect(evalSel(env, { op: "sel.at", slot: at("friendly", 3) })).toEqual([]);
    expect(evalSel(env, { op: "sel.at", slot: [at("friendly", 2), at("friendly", 2)] })).toEqual([
      unit,
    ]);
  });

  test("sel.opposite：正对面那一格，不看 direction", () => {
    const state = openGame();
    const mine = putUnit(state, 0, 4, { atk: 1, health: 1, direction: 3 });
    const facing = putUnit(state, 1, 4, { atk: 1, health: 1 });
    putUnit(state, 1, 7, { atk: 1, health: 1 });
    const env = envOf(state, mine);
    expect(evalSel(env, { op: "sel.opposite", of: SELF })).toEqual([facing]);
    // 不在场的实体没有对面
    expect(evalSel(env, { op: "sel.opposite", of: { op: "sel.controller" } })).toEqual([]);
  });

  test("sel.combat_target：按 direction 解析，指空格 → 敌方基地", () => {
    const state = openGame();
    const straight = putUnit(state, 0, 4, { atk: 1, health: 1 });
    const skewed = putUnit(state, 0, 0, { atk: 1, health: 1, direction: 4 });
    const target = putUnit(state, 1, 4, { atk: 1, health: 1 });
    const intoAir = putUnit(state, 0, 8, { atk: 1, health: 1 });
    const env = envOf(state, straight);
    expect(
      evalSel(env, { op: "sel.combat_target", of: { op: "sel.entity", id: straight } }),
    ).toEqual([target]);
    expect(evalSel(env, { op: "sel.combat_target", of: { op: "sel.entity", id: skewed } })).toEqual(
      [target],
    );
    expect(
      evalSel(env, { op: "sel.combat_target", of: { op: "sel.entity", id: intoAir } }),
    ).toEqual([baseIdOf(state, 1)]);
    // 不在场 → 没有战斗目标
    expect(evalSel(env, { op: "sel.combat_target", of: { op: "sel.controller" } })).toEqual([]);
  });

  test("sel.attackers_of 是 sel.combat_target 的逆：谁在瞄我", () => {
    const state = openGame();
    const victim = putUnit(state, 1, 4, { atk: 1, health: 1 });
    const straight = putUnit(state, 0, 4, { atk: 1, health: 1 });
    const skewed = putUnit(state, 0, 2, { atk: 1, health: 1, direction: 2 });
    // 瞄 0 号格（那里是空格）⇒ 不算瞄 victim，但算瞄敌方基地
    const intoEmpty = putUnit(state, 0, 0, { atk: 1, health: 1 });
    const env = envOf(state, victim);
    // 枚举按敌方格序 0→8
    expect(evalSel(env, { op: "sel.attackers_of", of: SELF })).toEqual([skewed, straight]);
    // 基地也能问"谁在瞄我"：方向指空格与指出界的那些都算（v2 §4.3）
    const intoAir = putUnit(state, 0, 8, { atk: 1, health: 1, direction: 1 });
    const baseEnv = envOf(state, victim, { target: baseIdOf(state, 1) });
    expect(evalSel(baseEnv, { op: "sel.attackers_of", of: { op: "sel.target" } })).toEqual([
      intoEmpty,
      intoAir,
    ]);
  });

  test("sel.adjacent：位置相邻（v2 §3.2 语义变更），dist 默认 1、不含自己", () => {
    const state = openGame();
    const left = putUnit(state, 0, 0, { atk: 1, health: 1 });
    const middle = putUnit(state, 0, 1, { atk: 1, health: 1 });
    const right = putUnit(state, 0, 2, { atk: 1, health: 1 });
    const far = putUnit(state, 0, 4, { atk: 1, health: 1 });
    putUnit(state, 1, 1, { atk: 1, health: 1 }); // 敌方同索引不算相邻（同侧才算）
    const env = envOf(state, middle);
    expect(evalSel(env, { op: "sel.adjacent", of: SELF })).toEqual([left, right]);
    expect(evalSel(env, { op: "sel.adjacent", of: SELF, dist: 3 })).toEqual([left, right, far]);
    expect(evalSel(env, { op: "sel.adjacent", of: SELF, dist: 0 })).toEqual([]);
    // 多个源 ⇒ 去重（left 与 middle 都把 middle/left 数一遍，结果各出现一次）
    expect(
      evalSel(env, {
        op: "sel.adjacent",
        of: {
          op: "sel.or",
          of: [
            { op: "sel.entity", id: left },
            { op: "sel.entity", id: middle },
          ],
        },
      }),
    ).toEqual([middle, left, right]);
    // 源自己不算自己的邻居：left 与 right 隔着 middle，结果只有 middle
    expect(
      evalSel(env, {
        op: "sel.adjacent",
        of: {
          op: "sel.or",
          of: [
            { op: "sel.entity", id: left },
            { op: "sel.entity", id: right },
          ],
        },
      }),
    ).toEqual([middle]);
    // 不在场的实体没有邻居
    expect(evalSel(env, { op: "sel.adjacent", of: { op: "sel.controller" } })).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// evalSlot（DSL v2 §3.1）
// ═══════════════════════════════════════════════════════════════════════════

describe("evalSlot（DSL v2 §3.1）", () => {
  test("slot.at：相对侧别换算成绝对玩家，越界 → 无效槽", () => {
    const state = openGame();
    const mine = putUnit(state, 1, 0, { atk: 1, health: 1 });
    const env = envOf(state, mine);
    expect(evalSlot(env, at("friendly", 3))).toEqual({ player: 1, index: 3 });
    expect(evalSlot(env, at("enemy", 3))).toEqual({ player: 0, index: 3 });
    expect(evalSlot(env, at("friendly", -1))).toBeNull();
    expect(evalSlot(env, at("friendly", 9))).toBeNull();
    expect(evalSlot(envOf(state, 999_999), at("friendly", 0))).toBeNull();
  });

  test("slot.of：非单实体或不在场 → 无效槽", () => {
    const state = openGame();
    const unit = putUnit(state, 0, 6, { atk: 1, health: 1 });
    putUnit(state, 0, 7, { atk: 1, health: 1 });
    const env = envOf(state, unit);
    expect(evalSlot(env, { op: "slot.of", of: SELF })).toEqual({ player: 0, index: 6 });
    expect(evalSlot(env, { op: "slot.of", of: board("friendly") })).toBeNull();
    expect(evalSlot(env, { op: "slot.of", of: { op: "sel.controller" } })).toBeNull();
  });

  test("slot.opposite / slot.shift", () => {
    const state = openGame();
    const unit = putUnit(state, 0, 1, { atk: 1, health: 1 });
    const env = envOf(state, unit);
    const own: SlotRef = { op: "slot.of", of: SELF };
    expect(evalSlot(env, { op: "slot.opposite", of: own })).toEqual({ player: 1, index: 1 });
    expect(evalSlot(env, { op: "slot.shift", of: own, delta: 2 })).toEqual({ player: 0, index: 3 });
    // 出界 → 无效槽（不 clamp、不回绕）
    expect(evalSlot(env, { op: "slot.shift", of: own, delta: -5 })).toBeNull();
    // 无效槽向上传播
    expect(evalSlot(env, { op: "slot.opposite", of: at("friendly", 99) })).toBeNull();
    expect(evalSlot(env, { op: "slot.shift", of: at("friendly", 99), delta: 0 })).toBeNull();
  });

  test("slot.first_empty：left / right / 无空格", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    putUnit(state, 0, 0, { atk: 1, health: 1 });
    putUnit(state, 0, 8, { atk: 1, health: 1 });
    expect(evalSlot(env, { op: "slot.first_empty", side: "friendly" })).toEqual({
      player: 0,
      index: 1,
    });
    expect(evalSlot(env, { op: "slot.first_empty", side: "friendly", from: "right" })).toEqual({
      player: 0,
      index: 7,
    });
    for (let slot = 1; slot < 8; slot += 1) {
      putUnit(state, 0, slot, { atk: 1, health: 1 });
    }
    expect(evalSlot(env, { op: "slot.first_empty", side: "friendly" })).toBeNull();
    expect(
      evalSlot(envOf(state, 999_999), { op: "slot.first_empty", side: "friendly" }),
    ).toBeNull();
  });

  test("slot.random_empty：只落在空格上，且推进 RNG", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    for (let slot = 0; slot < 8; slot += 1) {
      putUnit(state, 0, slot, { atk: 1, health: 1 });
    }
    expect(evalSlot(env, { op: "slot.random_empty", side: "friendly" })).toEqual({
      player: 0,
      index: 8,
    });
    expect(rngDraws(state)).toBe(1);
    expect(
      evalSlot(envOf(state, 999_999), { op: "slot.random_empty", side: "friendly" }),
    ).toBeNull();
  });

  test("cond.occupied 读的是同一个坐标", () => {
    const state = openGame();
    const unit = putUnit(state, 0, 5, { atk: 1, health: 1 });
    const env = envOf(state, unit);
    expect(evalCond(env, { op: "cond.occupied", slot: { op: "slot.of", of: SELF } })).toBe(true);
    expect(evalCond(env, { op: "cond.occupied", slot: at("enemy", 5) })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// evalNum
// ═══════════════════════════════════════════════════════════════════════════

describe("evalNum（IR v1 §3.2 / DSL v2 §3.3）", () => {
  test("字面数字不包装（IR v1 原则 4）", () => {
    const state = openGame();
    expect(evalNum(envOf(state, baseIdOf(state, 0)), 6)).toBe(6);
  });

  test("count / attr / sum", () => {
    const state = openGame();
    const a = putUnit(state, 0, 0, { atk: 2, health: 4 });
    putUnit(state, 0, 1, { atk: 3, health: 5 });
    const env = envOf(state, a);
    expect(evalNum(env, { op: "num.count", of: board("friendly") })).toBe(2);
    expect(evalNum(env, { op: "num.attr", of: SELF, tag: "atk" })).toBe(2);
    // 非单元素 → 0（IR v1 §3.2）
    expect(evalNum(env, { op: "num.attr", of: board("friendly"), tag: "atk" })).toBe(0);
    expect(evalNum(env, { op: "num.sum", of: board("friendly"), tag: "atk" })).toBe(5);
    expect(evalNum(env, { op: "num.sum", of: board("friendly"), tag: "health" })).toBe(9);
  });

  test("变参算术：add / mul / max / min，含空列表的单位元", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    expect(evalNum(env, { op: "num.add", of: [1, 2, 3] })).toBe(6);
    expect(evalNum(env, { op: "num.add", of: [] })).toBe(0);
    expect(evalNum(env, { op: "num.mul", of: [2, 3, 4] })).toBe(24);
    expect(evalNum(env, { op: "num.mul", of: [] })).toBe(1);
    expect(evalNum(env, { op: "num.max", of: [1, 9, 4] })).toBe(9);
    expect(evalNum(env, { op: "num.min", of: [3, -2, 4] })).toBe(-2);
    // 空列表不能是 ±Infinity（那是状态与事件的禁用值）
    expect(evalNum(env, { op: "num.max", of: [] })).toBe(0);
    expect(evalNum(env, { op: "num.min", of: [] })).toBe(0);
    // 全负数时不能被单位元 0 污染
    expect(evalNum(env, { op: "num.max", of: [-5, -3] })).toBe(-3);
  });

  test("sub / div（向下取整、除零得 0）/ neg / clamp", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    expect(evalNum(env, { op: "num.sub", l: 7, r: 2 })).toBe(5);
    expect(evalNum(env, { op: "num.div", l: 7, r: 2 })).toBe(3);
    expect(evalNum(env, { op: "num.div", l: -7, r: 2 })).toBe(-4);
    expect(evalNum(env, { op: "num.div", l: 7, r: 0 })).toBe(0);
    expect(evalNum(env, { op: "num.neg", of: 4 })).toBe(-4);
    expect(evalNum(env, { op: "num.clamp", of: 9, lo: 0, hi: 5 })).toBe(5);
    expect(evalNum(env, { op: "num.clamp", of: -9, lo: 0, hi: 5 })).toBe(0);
    expect(evalNum(env, { op: "num.clamp", of: 3, lo: 0, hi: 5 })).toBe(3);
  });

  test("num.tag：round / crystals / crystal_cap / fatigue（v2 §3.3）", () => {
    const state = openGame();
    const unit = putUnit(state, 1, 0, { atk: 1, health: 1 });
    playerData(state, 1).fatigue = 3;
    const env = envOf(state, unit);
    expect(evalNum(env, { op: "num.tag", tag: "round" })).toBe(state.round);
    expect(evalNum(env, { op: "num.tag", tag: "crystals" })).toBe(playerData(state, 1).crystals);
    expect(evalNum(env, { op: "num.tag", tag: "crystal_cap" })).toBe(
      playerData(state, 1).crystalCap,
    );
    expect(evalNum(env, { op: "num.tag", tag: "fatigue" })).toBe(3);
    // 悬空 SELF ⇒ 问不出是谁的资源 ⇒ 0；round 仍然读得到
    const dangling = envOf(state, 999_999);
    expect(evalNum(dangling, { op: "num.tag", tag: "crystals" })).toBe(0);
    expect(evalNum(dangling, { op: "num.tag", tag: "round" })).toBe(state.round);
  });

  test("num.field 在拦截器之外退化成 0（M5 扩展 EvalEnv）", () => {
    const state = openGame();
    expect(evalNum(envOf(state, baseIdOf(state, 0)), { op: "num.field", field: "amount" })).toBe(0);
  });

  test("num.random 落在闭区间内", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    for (let i = 0; i < 40; i += 1) {
      const value = evalNum(env, { op: "num.random", lo: -2, hi: 2 });
      expect(value).toBeGreaterThanOrEqual(-2);
      expect(value).toBeLessThanOrEqual(2);
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// evalCond
// ═══════════════════════════════════════════════════════════════════════════

describe("evalCond（IR v1 §3.3 / DSL v2 §3.3）", () => {
  test("字面布尔不包装 + not", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    expect(evalCond(env, true)).toBe(true);
    expect(evalCond(env, { op: "cond.not", of: false })).toBe(true);
  });

  test("cond.exists：默认 atLeast=1，可指定", () => {
    const state = openGame();
    putUnit(state, 0, 0, { atk: 1, health: 1 });
    putUnit(state, 0, 1, { atk: 1, health: 1 });
    const env = envOf(state, baseIdOf(state, 0));
    expect(evalCond(env, { op: "cond.exists", of: board("friendly") })).toBe(true);
    expect(evalCond(env, { op: "cond.exists", of: board("friendly"), atLeast: 2 })).toBe(true);
    expect(evalCond(env, { op: "cond.exists", of: board("friendly"), atLeast: 3 })).toBe(false);
  });

  test("六个比较 op", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    expect(evalCond(env, { op: "cond.eq", l: 2, r: 2 })).toBe(true);
    expect(evalCond(env, { op: "cond.ne", l: 2, r: 2 })).toBe(false);
    expect(evalCond(env, { op: "cond.gt", l: 3, r: 2 })).toBe(true);
    expect(evalCond(env, { op: "cond.gte", l: 2, r: 2 })).toBe(true);
    expect(evalCond(env, { op: "cond.lt", l: 3, r: 2 })).toBe(false);
    expect(evalCond(env, { op: "cond.lte", l: 2, r: 2 })).toBe(true);
  });

  test("cond.and / cond.or 的空列表是各自的单位元", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    expect(evalCond(env, { op: "cond.and", of: [] })).toBe(true);
    expect(evalCond(env, { op: "cond.or", of: [] })).toBe(false);
    expect(evalCond(env, { op: "cond.and", of: [true, true] })).toBe(true);
    expect(evalCond(env, { op: "cond.or", of: [false, false] })).toBe(false);
  });

  test("cond.has_tag：给 value 比相等，不给就是「非 0」；全称量化", () => {
    const state = openGame();
    const two = putUnit(state, 0, 0, { atk: 2, health: 1 });
    putUnit(state, 0, 1, { atk: 0, health: 1 });
    const env = envOf(state, two);
    expect(evalCond(env, { op: "cond.has_tag", of: SELF, tag: "atk" })).toBe(true);
    expect(evalCond(env, { op: "cond.has_tag", of: SELF, tag: "atk", value: 2 })).toBe(true);
    expect(evalCond(env, { op: "cond.has_tag", of: SELF, tag: "atk", value: 3 })).toBe(false);
    // 全称量化：场上有一个 atk=0 的 ⇒ 假
    expect(evalCond(env, { op: "cond.has_tag", of: board("friendly"), tag: "atk" })).toBe(false);
  });

  test("cond.has_flag / in_zone / dead", () => {
    const state = openGame();
    const stunned = putUnit(state, 0, 0, { atk: 1, health: 2 });
    setFlag(state, stunned, "stunned");
    const env = envOf(state, stunned);
    expect(evalCond(env, { op: "cond.has_flag", of: SELF, flag: "stunned" })).toBe(true);
    expect(evalCond(env, { op: "cond.has_flag", of: SELF, flag: "divine_shield" })).toBe(false);
    expect(evalCond(env, { op: "cond.in_zone", of: SELF, zone: "board" })).toBe(true);
    expect(evalCond(env, { op: "cond.in_zone", of: SELF, zone: "hand" })).toBe(false);
    expect(evalCond(env, { op: "cond.dead", of: SELF })).toBe(false);
    kill(state, stunned);
    expect(evalCond(env, { op: "cond.dead", of: SELF })).toBe(true);
  });

  test("cond.is_kind / has_color / has_tribe 读卡面数据", () => {
    const state = openGame();
    // openGame 的两副牌前缀分别是 A / B（testkit 的 makeTestDeck）
    const mine = putUnit(state, 0, 0, { atk: 1, health: 1 });
    const theirs = putUnit(state, 1, 0, { atk: 1, health: 1 });
    const env = envOf(state, mine, { target: theirs }, TEST_CARDS);
    expect(evalCond(env, { op: "cond.is_kind", of: SELF, kind: "minion" })).toBe(true);
    expect(evalCond(env, { op: "cond.is_kind", of: SELF, kind: ["spell", "token"] })).toBe(false);
    expect(evalCond(env, { op: "cond.has_color", of: SELF, color: "red" })).toBe(true);
    expect(evalCond(env, { op: "cond.has_color", of: SELF, color: ["blue", "green"] })).toBe(false);
    expect(evalCond(env, { op: "cond.has_tribe", of: SELF, tribe: "beast" })).toBe(false);
    const enemy: Sel = { op: "sel.target" };
    expect(evalCond(env, { op: "cond.is_kind", of: enemy, kind: "spell" })).toBe(true);
    expect(evalCond(env, { op: "cond.has_tribe", of: enemy, tribe: "beast" })).toBe(true);
    // ★ 融合卡（colors 长度 2）同时命中它的两个颜色（决策 #9 / 《数值基准》§6.2）
    expect(evalCond(env, { op: "cond.has_color", of: enemy, color: "blue" })).toBe(true);
    expect(evalCond(env, { op: "cond.has_color", of: enemy, color: "green" })).toBe(true);
    expect(evalCond(env, { op: "cond.has_color", of: enemy, color: "red" })).toBe(false);
  });

  test("没有卡表时：非空集合一律不满足（查不到 ⇒ 无法确认满足）", () => {
    const state = openGame();
    const mine = putUnit(state, 0, 0, { atk: 1, health: 1 });
    const env = envOf(state, mine); // NO_CARDS
    expect(evalCond(env, { op: "cond.is_kind", of: SELF, kind: "minion" })).toBe(false);
    expect(evalCond(env, { op: "cond.has_color", of: SELF, color: "red" })).toBe(false);
    expect(evalCond(env, { op: "cond.has_tribe", of: SELF, tribe: "beast" })).toBe(false);
    expect(NO_CARDS("随便什么卡")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 与既有子系统的接缝
// ═══════════════════════════════════════════════════════════════════════════

describe("接缝", () => {
  test("sel.combat_target 与战斗快照同源（rules/combat.ts 的 combatTargetOf）", () => {
    const state = openGame();
    // 摆一排朝向各异的单位，逐个比对求值器与真实战斗的目标
    const attackers: EntityId[] = [];
    for (let slot = 0; slot < 3; slot += 1) {
      attackers.push(putUnit(state, 0, slot, { atk: 1, health: 9, direction: slot - 1 }));
    }
    putUnit(state, 1, 0, { atk: 0, health: 9 });
    putUnit(state, 1, 1, { atk: 0, health: 9 });
    const env = envOf(state, baseIdOf(state, 0));
    const viaEval = attackers.map(
      (id) => evalSel(env, { op: "sel.combat_target", of: { op: "sel.entity", id } })[0],
    );
    // 手算：slot0 direction -1 → 敌方 -1 格（出界）→ 敌方 base；
    //       slot1 direction 0 → 敌方 1 格；slot2 direction 1 → 敌方 3 格（空）→ base
    const enemyRow = state.slots[1];
    expect(viaEval).toEqual([baseIdOf(state, 1), enemyRow[1] ?? 0, baseIdOf(state, 1)]);
  });

  test("求值不改状态（除 RNG 与随机事件）", () => {
    const state = openGame();
    putUnit(state, 0, 0, { atk: 1, health: 1 });
    const env = envOf(state, baseIdOf(state, 0));
    const before = JSON.stringify(state);
    evalSel(env, board("both"));
    evalNum(env, { op: "num.sum", of: board("both"), tag: "health" });
    evalCond(env, { op: "cond.exists", of: board("both") });
    evalSlot(env, { op: "slot.first_empty", side: "friendly" });
    expect(JSON.stringify(state)).toBe(before);
  });

  test("摆在牌库 / 手牌里的实体也能被区域选择器枚举到", () => {
    const state = openGame();
    const top = deckTop(state, 0);
    const env = envOf(state, baseIdOf(state, 0));
    expect(evalSel(env, { op: "sel.zone", side: "friendly", zone: "deck" })[0]).toBe(top);
    // 上场之后它就从 deck 移到 board（三条位置一致性不变量）
    putOnSlot(state, 0, top, 4);
    expect(evalSel(env, { op: "sel.zone", side: "friendly", zone: "deck" })[0]).not.toBe(top);
    expect(evalSel(env, board("friendly"))).toEqual([top]);
  });
});

test("createEvalEnv 的缺省两张表是 NO_CARDS / NO_ENCHANTMENTS", () => {
  const state = openGame();
  const env = createEvalEnv(state, createCtx(baseIdOf(state, 0)));
  expect(env.cards).toBe(NO_CARDS);
  expect(env.enchantments).toBe(NO_ENCHANTMENTS);
  expect(env.enchantments("随便什么附魔")).toBeUndefined();
  expect(env.state).toBe(state);
});

// ═══════════════════════════════════════════════════════════════════════════
// evalCardRef —— CardRef 求值（E4 补入，IR v1 §3.1 末表）
// ═══════════════════════════════════════════════════════════════════════════

describe("evalCardRef", () => {
  test("字面 CardId 原样返回（引用完整性是编写期 L3 的事，不在运行期查）", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    expect(evalCardRef(env, "PF1_ANY")).toBe("PF1_ANY");
  });

  test("card.of：单实体给它的 cardId；空集与多元素都给 null（整个动作跳过）", () => {
    const state = openGame();
    const one = putUnit(state, 0, 0, { atk: 1, health: 1 });
    const env = envOf(state, one);

    expect(evalCardRef(env, { op: "card.of", of: SELF })).toBe(getEntity(state, one)?.cardId ?? "");
    expect(evalCardRef(env, { op: "card.of", of: board("enemy") })).toBe(EMPTY_SET.cardRef);
    putUnit(state, 0, 1, { atk: 1, health: 1 });
    expect(evalCardRef(env, { op: "card.of", of: board("friendly") })).toBe(EMPTY_SET.cardRef);
  });

  test("★ card.random：推进 RNG、候选按 cardId **去重**、空候选一次都不抽", () => {
    const state = openGame();
    const self = putUnit(state, 0, 0, { atk: 1, health: 1 });
    const env = envOf(state, self);

    // 候选为空 ⇒ null，且一条 random_picked 都没有。
    const before = rngDraws(state);
    expect(evalCardRef(env, { op: "card.random", from: board("enemy") })).toBe(EMPTY_SET.cardRef);
    expect(rngDraws(state)).toBe(before);

    // 候选非空 ⇒ 抽一次。
    const picked = evalCardRef(env, { op: "card.random", from: board("friendly") });
    expect(picked).toBe(getEntity(state, self)?.cardId ?? "");
    expect(rngDraws(state)).toBe(before + 1);

    // 同一张卡出现两次不该让它的候选权重翻倍：去重之后池子还是 1 ⇒ nextInt(_, 1)。
    const twice: Sel = { op: "sel.or", of: [SELF, SELF] };
    expect(evalCardRef(env, { op: "card.random", from: twice })).toBe(
      getEntity(state, self)?.cardId ?? "",
    );
  });

  test("card.random{from: card.pool}：E4 求不出全卡池 ⇒ 空候选 ⇒ null，且不抽随机", () => {
    const state = openGame();
    const env = envOf(state, putUnit(state, 0, 0, { atk: 1, health: 1 }));
    const before = rngDraws(state);

    const pool: Pool = {
      op: "card.pool",
      filter: { op: "cond.is_kind", of: SELF, kind: "minion" },
    };
    expect(evalCardRef(env, { op: "card.random", from: pool })).toBe(EMPTY_SET.cardRef);
    expect(rngDraws(state)).toBe(before);
  });

  test("穷尽检查：未知的 card.* 同样抛，而不是静默当空", () => {
    const state = openGame();
    const env = envOf(state, baseIdOf(state, 0));
    expect(() => evalCardRef(env, { op: "card.???" } as never)).toThrow(/未知的 IR 节点/);
  });
});

test("PlayerId 侧别换算：friendly / enemy / both", () => {
  const state = openGame();
  const unit = putUnit(state, 1, 0, { atk: 1, health: 1 });
  const env = envOf(state, unit);
  const both: PlayerId[] = resolveSelSides(env, "both");
  expect(resolveSelSides(env, "friendly")).toEqual([1]);
  expect(resolveSelSides(env, "enemy")).toEqual([0]);
  expect(both).toEqual([1, 0]);
});
