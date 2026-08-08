// ★★★ 求值语义三条铁规（IR v1 §5.3）—— 三条规则各一条对照测试 ★★★
//
// 规范原话：「**三条规则，是整份规范最容易出错的地方**」，并要求
// 「TS builder 应该在类型层面尽量把它们区分开，**code review checklist 必须有这一条**」。
// checklist 写在 `handlers/index.ts` 的文件头；本文件是它的可执行版本。
// 风险登记册把「`Repeat` vs `.random(n)` 求值时机混淆」列为 **M4 起的长期风险**，
// 影响是「卡牌行为静默错误」—— 静默是关键：写混了不会抛错、不会少事件，
// 只会让一张卡的手感悄悄变成另一张卡。所以这三条必须由测试而不是由自觉来守。
//
// ┌──────────┬────────────────────────┬──────────────────────────────────────┐
// │ 规则 1   │ 动作内快照             │ target 求值一次，动作全程冻结        │
// │ 规则 2   │ act.repeat 每轮重求    │ 奥术飞弹：三发**可能打同一个**       │
// │ 规则 3   │ sel.random(n) 一次性   │ 多重射击：一次选 n 个**互不重复**    │
// └──────────┴────────────────────────┴──────────────────────────────────────┘
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 为什么"数 RNG 次数"抓不到规则 2/3 写混 ★
// ═══════════════════════════════════════════════════════════════════════════
// `repeat(3, hit(random(1), 1))` 与 `hit(random(3), 1)` **都推进 3 次 RNG**。
// 所以判据只能是**结果里能不能出现重复**：
//   - 规则 2 写成规则 3（把 repeat 的目标提前求一次值冻住）⇒ 三发必打同一个，
//     或三发必打三个不同的 —— 两种都与"独立重抽"的分布不同；
//   - 规则 3 写成规则 2（在外层循环里每次抽一个）⇒ 多重射击会打重复目标。
// 下面两条测试各用**钉死的种子**把这件事变成确定性断言，并一起断言 RNG 次数 ——
// 次数相同这一点本身就是"光数次数没用"的证据，所以它也写成断言。

import { describe, expect, test } from "bun:test";
import type { Act, CardData, CardId, EntityId, Num, Sel, SlotRef } from "@prismfront/ir";
import type { CardLookup } from "../../eval/index.ts";
import type { GameEvent } from "../../events/index.ts";
import type { ResolveDeps } from "../../resolve/index.ts";
import type { GameState } from "../../state/index.ts";
import { getEntity } from "../../state/index.ts";
import type { Step } from "../../testkit/index.ts";
import { openGame, putUnit, runActs } from "../../testkit/index.ts";
import { ACT_HANDLERS } from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════════════════

const IT: Sel = { op: "sel.it" };
const OPPONENT: Sel = { op: "sel.opponent" };
const ENEMY_BOARD: Sel = { op: "sel.zone", side: "enemy", zone: "board" };
const entity = (id: EntityId): Sel => ({ op: "sel.entity", id });

/**
 * 「**还活着的**敌方战线」—— 规则 1 那条 `act.hit` 测试的目标集合。
 *
 * 为什么不能直接用 {@link ENEMY_BOARD}：本引擎的死亡是流水线第 ⑤ 步**批量**结算的
 * （框架 §4.1 时序规则 3），handler 执行期间没有任何单位会离开战线 ——
 * `sel.zone` 的结果在一个动作之内**不可能**缩短，那样的目标冻不冻结结果都一样，
 * 测不出规则 1。而 `cond.dead` 判的是**血量归零**（`eval/cond.ts`：与死亡结算
 * 同一个谓词，不问在不在场），于是一个成员**挨到致死伤害的那一刻**就掉出本集合，
 * 「列表中途缩短」在一次 `act.hit` 之内就真的会发生 —— 这才分得出"冻住"与"重求"。
 */
const LIVING_ENEMIES: Sel = {
  op: "sel.where",
  of: ENEMY_BOARD,
  cond: { op: "cond.not", of: { op: "cond.dead", of: IT } },
};

/** `sel.random(of, n?)`：n 省略即 1（IR v1 §3.1）。 */
const random = (of: Sel, n?: Num): Sel => ({
  op: "sel.random",
  of,
  ...(n === undefined ? {} : { n }),
});

const hit = (target: Sel, amount: Num): Act => ({ op: "act.hit", target, amount });
const repeat = (n: Num, ...acts: Act[]): Act => ({ op: "act.repeat", n, do: acts });
const forEach = (of: Sel, ...acts: Act[]): Act => ({ op: "act.for_each", of, do: acts });

/** 一张 1/1 的随从卡（规则 1 的"循环中途新上场"用它）。 */
const TOKEN: CardId = "PF1_TIMING_TOKEN";
const CARDS: CardLookup = (cardId: CardId): CardData | undefined =>
  cardId === TOKEN
    ? { name: { zh: "计时侍从" }, kind: "minion", colors: ["blue"], tags: { atk: 1, health: 9 } }
    : undefined;
const BUNDLE_DEPS: ResolveDeps = { handlers: ACT_HANDLERS, cards: CARDS };

const enemyFirstEmpty: SlotRef = { op: "slot.first_empty", side: "enemy" };

/**
 * 开局 + p0 的 0 号格一个 2/9 当 SELF + p1 战线上 `count` 个 1/9。
 *
 * 敌方单位血厚（9 血）是有意的：本文件测的是**打了谁、打了几次**，
 * 一旦有人中途死掉，后续的随机候选集就变了，断言会同时被两件事影响。
 */
function board(count: number, seed = 1): { state: GameState; self: EntityId; foes: EntityId[] } {
  const state = openGame({ seed });
  const self = putUnit(state, 0, 0, { atk: 2, health: 9 });
  const foes: EntityId[] = [];
  for (let slot = 0; slot < count; slot += 1) {
    foes.push(putUnit(state, 1, slot, { atk: 1, health: 9 }));
  }
  return { state, self, foes };
}

/** 这一段里 RNG 被推进了几次（`rollInt` 与 `engine.random_picked` 一一对应）。 */
function rngDraws(events: readonly GameEvent[]): number {
  return events.filter((event) => event.name === "engine.random_picked").length;
}

/**
 * 一个会让 `repeat(3, random(1))` **打出重复目标**的种子（实测 seed=2 ⇒ 伤害分布 [2,0,1]）。
 *
 * 3 个候选里独立抽 3 次、恰好全不重复的概率是 `3!/3³ = 6/27 ≈ 22%`，
 * 也就是说绝大多数种子都能满足；钉死一个只是为了让断言确定
 * （架构 §6.1：引擎确定性 ⇒ 同种子同结果，测试不该靠概率）。
 * ⚠ 换 RNG 算法或改 `sel.random` 的抽法都会让这个种子失效 —— 那时该做的是
 *   重新挑一个能产出重复的种子，**不是**把这条断言放宽。
 */
const SEED_WITH_DUPLICATE = 2;

/** 每个目标各挨了几点伤害（按 `foes` 的顺序）。 */
function damages(step: Step, foes: readonly EntityId[]): number[] {
  return foes.map((id) => getEntity(step.state, id)?.damage ?? -1);
}

// ═══════════════════════════════════════════════════════════════════════════
// ★ 规则 1｜动作内快照：target 求值一次，动作全程冻结
// ═══════════════════════════════════════════════════════════════════════════

describe("★ 规则 1｜动作内快照（IR v1 §5.3）", () => {
  test("打第一个致死后列表不缩短，剩下的照打", () => {
    // 规范给的正是这个例子：`hit(enemy board, 3)` 打一排 1/1 —— 但目标**不能**照抄成
    // `sel.zone`，那样这条测试是空壳（谁死了都要等第 ⑤ 步才离场，集合根本缩不了）。
    // 目标写成 {@link LIVING_ENEMIES}：第一个挨满 3 点的那一刻集合就少一个成员，
    // 于是"求值一次冻住"与"每打一下重求"在这一个动作之内分得出来。
    const state = openGame();
    const self = putUnit(state, 0, 0, { atk: 2, health: 9 });
    const foes = [0, 1, 2].map((slot) => putUnit(state, 1, slot, { atk: 1, health: 1 }));

    const step = runActs(state, [hit(LIVING_ENEMIES, 3)], self);

    // 三个各挨一下：列表在动作开始那一刻定死，中途谁致死都不影响后面几下。
    expect(damages(step, foes)).toEqual([3, 3, 3]);
    expect(step.events.filter((event) => event.name === "damaged")).toHaveLength(3);
    expect(step.events.filter((event) => event.name === "unit_died")).toHaveLength(3);
    for (const foe of foes) {
      expect(getEntity(step.state, foe)?.zone).toBe("p1:graveyard");
    }
  });

  test("act.for_each：循环**中途新上场**的单位不会被迭代到", () => {
    // 这是规则 1 最能咬人的形态：`act.for_each` 的 `do` 是逐条压栈、逐步结算的，
    // 循环体里召唤出来的单位**确实**站到了战线上 —— 若 `of` 每轮重求，它会被打到，
    // 极端情况下还会自我延续成死循环。快照冻住之后，迭代次数在循环开始那一刻就定了。
    const { state, self, foes } = board(1);

    const step = runActs(
      state,
      [
        forEach(
          ENEMY_BOARD,
          { op: "act.summon", player: OPPONENT, card: TOKEN, at: enemyFirstEmpty },
          hit(IT, 1),
        ),
      ],
      self,
      BUNDLE_DEPS,
    );

    // 只迭代了 1 次：召唤 1 个 + 打 1 下。
    expect(step.events.filter((event) => event.name === "unit_summoned")).toHaveLength(1);
    expect(damages(step, foes)).toEqual([1]);
    // 新上场的那个确实在战线上（所以"没被打到"不是因为它没上场）。
    const spawned = step.state.slots[1][1];
    expect(typeof spawned).toBe("number");
    expect(typeof spawned === "number" ? getEntity(step.state, spawned)?.damage : -1).toBe(0);
  });

  test("act.for_each：中途**离场**的成员不会让剩下的少跑（列表不缩短）", () => {
    const { state, self, foes } = board(3);
    // 循环体第一件事是把**整条**敌方战线清掉（destroy 的目标是 `ENEMY_BOARD` 而不是
    // `IT`）：第 1 轮跑完 3 个全进墓地，`sel.zone{side:"enemy"}` 从此为空。
    // 若 `of` 每轮重求，第 2、3 轮就没有成员可迭代了 —— 快照冻住之后照跑三轮。
    // ⚠ 写成 `destroy IT` 测不出东西：那只消灭**当前成员**，而当前成员正是"重求"时
    //   本来就会被跳过的那一个，两种实现的结果一模一样。
    const step = runActs(
      state,
      [forEach(ENEMY_BOARD, { op: "act.destroy", target: ENEMY_BOARD }, hit(IT, 1))],
      self,
    );

    expect(step.events.filter((event) => event.name === "unit_died")).toHaveLength(3);
    // 三个成员各自被 `act.hit` 打到一次（即使那时它已经躺在墓地里）。
    expect(step.events.filter((event) => event.name === "damaged")).toHaveLength(3);
    expect(damages(step, foes)).toEqual([10, 10, 10]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 规则 2｜act.repeat 每轮重新求值（奥术飞弹）
// ═══════════════════════════════════════════════════════════════════════════

describe("★ 规则 2｜act.repeat 每轮重新求值（IR v1 §5.3）", () => {
  test("repeat(3, hit(random(1), 1))：三次独立抽 ⇒ 钉死的种子下**确实打中了重复目标**", () => {
    // 判据不是"随机结果是多少"，而是**能不能出现重复** —— 只有每轮重新求值才可能。
    // 种子钉死（`openGame({seed})` 本身一次 RNG 都不消耗，见 testkit）。
    const { state, self, foes } = board(3, SEED_WITH_DUPLICATE);

    const step = runActs(state, [repeat(3, hit(random(ENEMY_BOARD), 1))], self);
    const dealt = damages(step, foes);

    expect(dealt.reduce((sum, one) => sum + one, 0)).toBe(3); // 三发都落地了
    // ★ 有人挨了两下以上 ⇒ 三次抽样彼此独立。写成规则 3 的形态（一次抽 3 个互不重复）
    //   分布会变成 [1,1,1]，这一条当场红。
    expect(Math.max(...dealt)).toBeGreaterThan(1);
    // ★ 另一种写错法是把 `do` 的目标**提前求一次值冻住**（三发全打同一个）：分布是
    //   [3,0,0]，max 仍然是 3 —— 上面那条照样绿，承重的是这一条（RNG 只推进了 1 次）。
    expect(rngDraws(step.events)).toBe(3);
  });

  test("repeat 的 `n` 本身只求值一次（它是本动作的字段，受规则 1 管）", () => {
    // `n: num.random(3,3)` 是一个必定推进 RNG 的常量表达式：只该抽一次。
    const { state, self } = board(1);
    const step = runActs(
      state,
      [repeat({ op: "num.random", lo: 3, hi: 3 }, hit(entity(self), 1))],
      self,
    );

    expect(getEntity(step.state, self)?.damage).toBe(3);
    expect(rngDraws(step.events)).toBe(1); // 轮数抽一次，三轮里一次都不再抽
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 规则 3｜sel.random(n) 一次性求值（多重射击）
// ═══════════════════════════════════════════════════════════════════════════

describe("★ 规则 3｜sel.random(n) 一次性求值（IR v1 §5.3）", () => {
  test("hit(random(3), 1)：一次选 3 个**互不重复**，各挨 1 点", () => {
    // 候选 4 个、抽 3 个：抽中的每个恰好 1 点，剩下 1 个 0 点。
    // 若写成"外层循环里每次再抽一个"，同一个目标可能被抽中两次 ⇒ 出现 2 点。
    const { state, self, foes } = board(4, SEED_WITH_DUPLICATE);

    const step = runActs(state, [hit(random(ENEMY_BOARD, 3), 1)], self);
    const dealt = damages(step, foes);

    expect(dealt.filter((one) => one === 1)).toHaveLength(3);
    expect(dealt.filter((one) => one === 0)).toHaveLength(1);
    expect(Math.max(...dealt)).toBe(1); // ★ 没有任何一个挨了两下
    expect(rngDraws(step.events)).toBe(3);
  });

  test("n 超过候选数：抽满整池就停，**不会**重复选（distinct 默认 true）", () => {
    const { state, self, foes } = board(3);

    const step = runActs(state, [hit(random(ENEMY_BOARD, 9), 1)], self);

    expect(damages(step, foes)).toEqual([1, 1, 1]);
    expect(rngDraws(step.events)).toBe(3); // min(n, 池子大小)
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 规则 2 vs 规则 3：同一个种子、同一个盘面、同样的 RNG 次数，结果不同
// ═══════════════════════════════════════════════════════════════════════════

test("★★ 两个写法长得像、语义完全不同：RNG 次数相同，结果分布不同 ★★", () => {
  // 这一条是 review checklist 那一项的可执行形态，也是风险登记册那条风险的探针。
  const bullets = board(3, SEED_WITH_DUPLICATE);
  const volley = board(3, SEED_WITH_DUPLICATE);

  // 奥术飞弹：重复**做这件事**，每次重新选目标。
  const arcane = runActs(bullets.state, [repeat(3, hit(random(ENEMY_BOARD), 1))], bullets.self);
  // 多重射击：一次**选 3 个**，选完就定了。
  const multishot = runActs(volley.state, [hit(random(ENEMY_BOARD, 3), 1)], volley.self);

  // 消耗的随机次数一模一样 —— 所以"数随机次数"分不出这两个写法。
  expect(rngDraws(arcane.events)).toBe(rngDraws(multishot.events));
  // 分得出来的是**分布**：飞弹会重复，射击不会。
  expect(damages(arcane, bullets.foes).sort()).not.toEqual([1, 1, 1]);
  expect(damages(multishot, volley.foes)).toEqual([1, 1, 1]);
});
