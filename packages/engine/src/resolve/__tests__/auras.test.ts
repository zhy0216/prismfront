// 光环重算与附魔存续期的单元测试（M5/T3：`resolve/auras.ts` 的两个 Σ）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 测的是框架 §4.1 时序规则 4 的那条等式，一个加数都不能少
// ═══════════════════════════════════════════════════════════════════════════
//   tags  = base      + Σ附魔.mods  + Σ生效光环.mods
//   flags = baseFlags + Σ附魔.flags + Σ生效光环.flags
// 外加 IR v1 §4.3 的四个字段（`affects` / `mods` / `flags` / `cond` / `zone`）、
// IR v1 §2.3 的两个附魔来源（卡的 `script.auras` + **附魔自带的 `script.auras`**）、
// 以及 v2 §3.5 的四种 `duration`。
//
// ═══════════════════════════════════════════════════════════════════════════
// 每条测试都要有**判别力**：不只断言"加上了"，还要断言"不该加的没加"
// ═══════════════════════════════════════════════════════════════════════════
// 光环测试最容易写成空壳：摆一张卡、断言某个单位 atk 变了 —— 而"把光环加给了所有人"
// 同样能让它变。所以本文件的盘面一律**成对**摆（一个该吃到的 + 一个不该吃到的），
// 每条断言旁边写明「写错了会读到什么」。
//
// ★ 三条"声明式"的正面验收（这是本条目存在的理由，不是附带）：
//   1. 光环源离场 ⇒ 加成自动消失，**引擎里没有任何一行"减回去"的代码**；
//   2. 位置条件光环（v2 §8.2 空袭猎手）**无需触发器**就生效 —— 本文件里那张卡
//      `script` 上一条 `triggers` 都没有，测试也一条事件都没有喂给它；
//   3. `direction` 走同一条管线（v2 §2.3）—— 光环批量改方向是免费的，
//      `resolve/auras.ts` 里 grep 不到 `direction`。
//
// 注：本文件**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1）。

import { expect, test } from "bun:test";
import type { Act, Aura, Card, Enchantment, EntityId, Sel } from "@prismfront/ir";
import { NO_DEPS } from "../../handlers/index.ts";
import { stripEnchantments } from "../../rules/index.ts";
import type { GameState, PlayerId } from "../../state/index.ts";
import { getZone } from "../../state/index.ts";
import {
  baseIdOf,
  cardDeps,
  damageOf,
  enchantsOf,
  eventNames,
  fightOnce,
  flagOf,
  openGame,
  passThroughCombat,
  putCard,
  putCardInHand,
  putUnit,
  runActs,
  scriptCard,
  tagOf,
} from "../../testkit/index.ts";
import type { ResolveDeps, TriggerDeps } from "../index.ts";
import { AuraRandomError, refreshAuras } from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════════════════

/** 友方战线（`sel.zone` 的 side 是相对 SELF 的，IR v1 §3.1）。 */
const FRIENDLY_BOARD: Sel = { op: "sel.zone", side: "friendly", zone: "board" };
/** 光环宿主自己。 */
const SELF: Sel = { op: "sel.self" };
/** 友军（不含自己）—— 野猪王式光环的受影响集合（IR v1 §10.3）。 */
const OTHER_FRIENDLIES: Sel = { op: "sel.minus", of: FRIENDLY_BOARD, exclude: SELF };
/**
 * 友方**随从** —— IR 的 `FRIENDLY_MINIONS` 展开式（v2.1 §11.2 的词汇分化）：
 * 比 `FRIENDLY_UNITS` 多一层 `sel.where(cond.is_kind(it,"minion"))`，把英雄滤掉。
 * 形状照抄 `ir/src/builder/constants.ts`，不 import 那个常量（禁令 1，见文件头）。
 */
const FRIENDLY_MINIONS: Sel = {
  op: "sel.where",
  of: FRIENDLY_BOARD,
  cond: { op: "cond.is_kind", of: { op: "sel.it" }, kind: "minion" },
};

/** 造一张只带光环的测试卡。 */
function auraCard(id: string, ...auras: Aura[]): Card {
  return scriptCard(id, { auras });
}

/** 打一个具体实体 `amount` 点（`sel.entity` 是 IR v1 §5.6 的运行时超集，测试可用）。 */
function hit(target: EntityId, amount: number): Act {
  return { op: "act.hit", target: { op: "sel.entity", id: target }, amount };
}

/** 给一个具体实体挂一条附魔。 */
function buff(target: EntityId, ench: string): Act {
  return { op: "act.buff", target: { op: "sel.entity", id: target }, ench };
}

/**
 * 跑一步**空动作**，把状态推过完整的六步流水线一次。
 *
 * 用它而不是直接调 `refreshAuras`，是为了让断言同时覆盖**接线** ——
 * `resolve.ts` 第 ⑥ 步把 `deps` 传下去这件事若断了，直接调 SUT 的测试照样绿。
 */
function tick(state: GameState, self: EntityId, deps: ResolveDeps): GameState {
  return runActs(state, [{ op: "act.nothing" }], self, deps).state;
}

/** 某方墓地里有没有这个实体（死亡结算的可观测面）。 */
function inGraveyard(state: GameState, player: PlayerId, id: EntityId): boolean {
  return getZone(state, player, "graveyard").includes(id);
}

// ═══════════════════════════════════════════════════════════════════════════
// Σ附魔（IR v1 §2.3）
// ═══════════════════════════════════════════════════════════════════════════

test("Σ附魔：mods 加进生效值，卡面值 base 一动不动", () => {
  const ench: Enchantment = {
    id: "E_PLUS",
    attachesTo: "minion",
    mods: { atk: 2, health: 3 },
    duration: "permanent",
  };
  const deps = cardDeps([], [ench]);
  const state = openGame();
  const buffed = putUnit(state, 0, 0, { atk: 1, health: 4 });
  // ★ 成对：同一张卡面的第二个单位**不挂**附魔，用来钉住"没有给全场加"。
  const plain = putUnit(state, 0, 1, { atk: 1, health: 4 });

  const after = runActs(state, [buff(buffed, "E_PLUS")], buffed, deps).state;

  // 写错（Σ附魔 没接上）会读到 1 / 4：与卡面完全相同。
  expect(tagOf(after, buffed, "atk")).toBe(3);
  expect(tagOf(after, buffed, "health")).toBe(7);
  // 写错（handler 去写了 base）会读到 3 / 7：那样 `act.silence` 就再也剥不掉。
  expect(after.entities[buffed]?.base.atk).toBe(1);
  expect(after.entities[buffed]?.base.health).toBe(4);
  // 加血只加**上限**不治疗（`state/entity.ts` 的血量记账）。
  expect(damageOf(after, buffed)).toBe(0);
  // 写错（加给了所有人）会读到 3 / 7。
  expect(tagOf(after, plain, "atk")).toBe(1);
  expect(tagOf(after, plain, "health")).toBe(4);
});

test("★ Σ附魔：flags 并进生效掩码，剥离之后**必须复位**（flags 同样是重算不是增量）", () => {
  const ench: Enchantment = {
    id: "E_SHIELD",
    attachesTo: "minion",
    flags: ["divine_shield"],
    // 取一档会被剥的存续期：光是"加得上"证明不了规则 4，还得证明"掉得下来"。
    duration: "end_of_round",
  };
  const deps = cardDeps([], [ench]);
  const state = openGame();
  const shielded = putUnit(state, 0, 0, { atk: 1, health: 4 });
  const plain = putUnit(state, 0, 1, { atk: 1, health: 4 });

  const after = runActs(state, [buff(shielded, "E_SHIELD")], shielded, deps).state;

  // 写错（Σ附魔.flags 漏了）会读到 false —— 附魔授予的辉膜整类卡失效。
  expect(flagOf(after, shielded, "divine_shield")).toBe(true);
  // 卡面标志位不动：`act.silence` 复位到它（`state/entity.ts`）。
  expect(after.entities[shielded]?.baseFlags).toBe(0);
  expect(flagOf(after, plain, "divine_shield")).toBe(false);

  stripEnchantments(after, "end_of_round", deps);

  // ★ 写错（flags 从上一次的 `flags` 起算而不是复位到 `baseFlags`）会读到 true：
  //   那正是规则 4 想根除的"失效时忘了减回去"，而且只在标志位这一支上显形。
  expect(flagOf(after, shielded, "divine_shield")).toBe(false);
});

test("Σ附魔：查不到定义的附魔静默贡献 0（换过 bundle 的旧存档）", () => {
  const ench: Enchantment = {
    id: "E_PLUS",
    attachesTo: "minion",
    mods: { atk: 2 },
    duration: "permanent",
  };
  const state = openGame();
  const unit = putUnit(state, 0, 0, { atk: 1, health: 4 });
  const buffed = runActs(state, [buff(unit, "E_PLUS")], unit, cardDeps([], [ench])).state;
  expect(tagOf(buffed, unit, "atk")).toBe(3);

  // 同一份状态换成一张**空**附魔表重算：实例还挂着，但加成查不到了。
  refreshAuras(buffed, NO_DEPS);

  // 写错（查不到就抛 / 就把整条实例当成 0 攻）会红在这一行或上一行。
  expect(tagOf(buffed, unit, "atk")).toBe(1);
  expect(enchantsOf(buffed, unit)).toEqual(["E_PLUS"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Σ光环：affects / mods / flags（IR v1 §4.3、§10.3 野猪王）
// ═══════════════════════════════════════════════════════════════════════════

test("Σ光环：affects 决定谁吃到 —— 自己不吃、敌方不吃（野猪王式）", () => {
  const lord = auraCard("AURA_LORD", { affects: OTHER_FRIENDLIES, mods: { atk: 1 } });
  const deps = cardDeps([lord]);
  const state = openGame();
  const host = putCard(state, 0, 0, lord, { atk: 3, health: 4 });
  const ally = putUnit(state, 0, 1, { atk: 2, health: 4 });
  const enemy = putUnit(state, 1, 0, { atk: 2, health: 4 });

  const after = tick(state, host, deps);

  // 写错（Σ光环 没接上）会读到 2。
  expect(tagOf(after, ally, "atk")).toBe(3);
  // 写错（`sel.minus` 那一段被忽略、或 affects 恒取全场）会读到 4。
  expect(tagOf(after, host, "atk")).toBe(3);
  // 写错（side 换算错了 / affects 恒取全场）会读到 3。
  expect(tagOf(after, enemy, "atk")).toBe(2);
});

test("Σ光环：flags 同样走这条管线（授予辉膜），光环源一走盾就没", () => {
  const lord = auraCard("AURA_SHIELDER", { affects: OTHER_FRIENDLIES, flags: ["divine_shield"] });
  const deps = cardDeps([lord]);
  const state = openGame();
  const host = putCard(state, 0, 0, lord, { atk: 1, health: 2 });
  const ally = putUnit(state, 0, 1, { atk: 1, health: 4 });

  const after = tick(state, host, deps);

  expect(flagOf(after, ally, "divine_shield")).toBe(true);
  // 自己不在 affects 里 ⇒ 不该有盾（写错会读到 true）。
  expect(flagOf(after, host, "divine_shield")).toBe(false);

  const gone = runActs(after, [hit(host, 2)], ally, deps).state;

  // 写错（flags 做增量而不是复位到 baseFlags）会读到 true。
  expect(flagOf(gone, ally, "divine_shield")).toBe(false);
});

test("★ 光环源离场 ⇒ 加成自动消失（声明式：引擎里没有一行『减回去』）", () => {
  const lord = auraCard("AURA_LORD", { affects: OTHER_FRIENDLIES, mods: { atk: 1 } });
  const deps = cardDeps([lord]);
  const state = openGame();
  const host = putCard(state, 0, 0, lord, { atk: 1, health: 2 });
  const ally = putUnit(state, 0, 1, { atk: 2, health: 4 });

  const boosted = tick(state, host, deps);
  expect(tagOf(boosted, ally, "atk")).toBe(3);

  // 把光环源打死 —— 一步之内：死亡结算搬走它，光环重算把加成算没。
  const after = runActs(boosted, [hit(host, 2)], ally, deps).state;

  expect(inGraveyard(after, 0, host)).toBe(true);
  // 写错（增量式实现：加的时候 +1，失效时忘了 −1）会读到 3。
  expect(tagOf(after, ally, "atk")).toBe(2);
});

test("★ v2 §8.2 空袭猎手：位置条件光环无需触发器 —— 对面空就 +2，站人就没有", () => {
  // 这张卡的 `script` 上**一条 triggers 都没有**，下面也一条事件都没喂给它。
  const hunter = auraCard("GRID_AIR_HUNTER", {
    affects: SELF,
    mods: { atk: 2 },
    cond: {
      op: "cond.not",
      of: {
        op: "cond.occupied",
        slot: { op: "slot.opposite", of: { op: "slot.of", of: SELF } },
      },
    },
  });
  const deps = cardDeps([hunter]);

  // ── 对面空：+2 生效，战斗时打出 2+2 = 4 点 ────────────────────────────────
  const openField = openGame();
  const soloHunter = putCard(openField, 0, 0, hunter, { atk: 2, health: 9 });
  const enemyBase = baseIdOf(openField, 1);
  const solo = fightOnce(openField, deps);
  expect(tagOf(solo.state, soloHunter, "atk")).toBe(4);
  // 写错（cond 恒真 / 恒假、或光环在快照之前没算上）会读到 2。
  expect(damageOf(solo.state, enemyBase)).toBe(4);

  // ── 对面站人：同一张卡、同一格，只差对面那一格 ────────────────────────────
  const blocked = openGame();
  const blockedHunter = putCard(blocked, 0, 0, hunter, { atk: 2, health: 9 });
  const wall = putUnit(blocked, 1, 0, { atk: 0, health: 9 });
  const walled = fightOnce(blocked, deps);

  // 写错（cond 被忽略）会读到 4 / 4。
  expect(tagOf(walled.state, blockedHunter, "atk")).toBe(2);
  expect(damageOf(walled.state, wall)).toBe(2);
});

test("★ direction 走同一条管线：光环改方向是免费的（v2 §2.3）", () => {
  const bender = auraCard("AURA_BENDER", { affects: SELF, mods: { direction: -1 } });
  const deps = cardDeps([bender]);
  const state = openGame();
  // 站 1 号格：方向 0 打对面 1 号格，方向 −1 打对面 0 号格。
  const host = putCard(state, 0, 1, bender, { atk: 3, health: 9 });
  const left = putUnit(state, 1, 0, { atk: 0, health: 9 });
  const straight = putUnit(state, 1, 1, { atk: 0, health: 9 });

  const after = fightOnce(state, deps);

  expect(tagOf(after.state, host, "direction")).toBe(-1);
  // 写错（mods 里的 direction 被特判掉 / 战斗快照读 base.direction）会读到 0 / 3。
  expect(damageOf(after.state, left)).toBe(3);
  expect(damageOf(after.state, straight)).toBe(0);
});

test("★ 附魔也能改方向：Buff(TARGET, ench) 带 direction mod（v2 §8.1 / §8.7 改箭头）", () => {
  const turn: Enchantment = {
    id: "E_TURN",
    attachesTo: "minion",
    mods: { direction: -1 },
    duration: "permanent",
  };
  const deps = cardDeps([], [turn]);
  const state = openGame();
  const shooter = putUnit(state, 0, 1, { atk: 3, health: 9 });
  const left = putUnit(state, 1, 0, { atk: 0, health: 9 });
  const straight = putUnit(state, 1, 1, { atk: 0, health: 9 });

  const buffed = runActs(state, [buff(shooter, "E_TURN")], shooter, deps).state;
  const after = fightOnce(buffed, deps);

  // 写错（附魔的 mods 里 direction 被特判掉）会读到 0 / 0 / 3。
  expect(tagOf(after.state, shooter, "direction")).toBe(-1);
  expect(damageOf(after.state, left)).toBe(3);
  expect(damageOf(after.state, straight)).toBe(0);
});

test('Σ光环：zone 默认 board —— 躺在手牌里的卡不发光环，写 zone:"hand" 的才发', () => {
  const inHandAura: Aura = { affects: SELF, mods: { cost: -1 }, zone: "hand" };
  const onBoardAura: Aura = { affects: SELF, mods: { cost: -1 } };
  const discount = auraCard("AURA_HAND", inHandAura);
  const boardOnly = auraCard("AURA_BOARD", onBoardAura);
  const deps = cardDeps([discount, boardOnly]);
  const state = openGame();
  const cheap = putCardInHand(state, 0, discount, { atk: 1, health: 1, cost: 3 });
  const notCheap = putCardInHand(state, 0, boardOnly, { atk: 1, health: 1, cost: 3 });
  const anchor = putUnit(state, 0, 0, { atk: 1, health: 4 });

  const after = tick(state, anchor, deps);

  // 写错（只遍历场上实体）会读到 3 —— 费用修正整类卡失效（IR v1 §10.4）。
  expect(tagOf(after, cheap, "cost")).toBe(2);
  // 写错（zone 被忽略）会读到 2 —— 牌库/手牌里的卡在给全场发光环。
  expect(tagOf(after, notCheap, "cost")).toBe(3);
});

test("Σ光环：第二个来源 —— 附魔自带的 script.auras（IR v1 §2.3）", () => {
  const ench: Enchantment = {
    id: "E_BANNER",
    attachesTo: "minion",
    duration: "permanent",
    script: { auras: [{ affects: OTHER_FRIENDLIES, mods: { atk: 1 } }] },
  };
  const deps = cardDeps([], [ench]);
  const state = openGame();
  const host = putUnit(state, 0, 0, { atk: 1, health: 4 });
  const ally = putUnit(state, 0, 1, { atk: 2, health: 4 });
  const enemy = putUnit(state, 1, 0, { atk: 2, health: 4 });

  const after = runActs(state, [buff(host, "E_BANNER")], host, deps).state;

  // 写错（只看卡的 script.auras，漏了附魔那一支）会读到 2。
  expect(tagOf(after, ally, "atk")).toBe(3);
  expect(tagOf(after, host, "atk")).toBe(1);
  expect(tagOf(after, enemy, "atk")).toBe(2);
});

test("★ Σ光环：affects 里读**卡面**的那一支要走 deps.cards（IR v1 §10.3 野猪王同款）", () => {
  // 「给场上所有蓝色友军 +1 攻」。`cond.has_color` 读的是 `data.colors` 这个**卡面**字段
  // （`eval/card.ts`），不是实体 tag —— 它只能经 `deps.cards` 拿到。
  // IR v1 §10.3 的野猪王用 `cond.has_tribe` 筛 affects，是同一支的另一种写法。
  const banner = auraCard("AURA_BLUE_BANNER", {
    affects: {
      op: "sel.where",
      of: FRIENDLY_BOARD,
      cond: { op: "cond.has_color", of: { op: "sel.it" }, color: "blue" },
    },
    mods: { atk: 1 },
  });
  const blue = scriptCard("T_BLUE", {}, { colors: ["blue"] });
  const red = scriptCard("T_RED", {}, { colors: ["red"] });
  const deps = cardDeps([banner, blue, red]);
  const state = openGame();
  const host = putCard(state, 0, 0, banner, { atk: 1, health: 4 });
  const blueAlly = putCard(state, 0, 1, blue, { atk: 2, health: 4 });
  // ★ 成对：同一格宽、同一份卡面数字，只有颜色不同。
  const redAlly = putCard(state, 0, 2, red, { atk: 2, health: 4 });

  const after = tick(state, host, deps);

  // 写错（`grantAura` 造求值环境时没把 `deps.cards` 传进去）会读到 2：
  // 卡表查不到 ⇒ `cond.has_color` 对非空集恒假（`NO_CARDS` 的退化语义）⇒
  // `sel.where` 筛成空集 ⇒ 谁都没吃到加成，而盘面上看不出任何异常。
  expect(tagOf(after, blueAlly, "atk")).toBe(3);
  // 写错（affects 恒取全场 / has_color 恒真）会读到 3。
  expect(tagOf(after, redAlly, "atk")).toBe(2);
  // 宿主是红色（`scriptCard` 的缺省色），同样不该吃到。
  expect(tagOf(after, host, "atk")).toBe(1);
});

test("★ 写「友方随从」的光环不吃英雄，同一条写「友方单位」才吃（v2.1 §11.2 词汇分化）", () => {
  // v2.1 §11.2 起英雄占格参战，`*_UNITS`（含英雄）与 `*_MINIONS`（排除英雄）分化开。
  // 这条分化的**全部**意义就在光环上：v2 §8.4 那批写「友方随从」的老卡因此自动正确 ——
  // 引擎里没有任何一行"光环要不要跳过英雄"的特判，它只是 `affects` 多了一层 `where`。
  const heroCard = scriptCard("T_HERO", {}, { kind: "hero" });
  const minionCard = scriptCard("T_MINION", {}, { kind: "minion" });
  const minionLord = auraCard("AURA_MINIONS", { affects: FRIENDLY_MINIONS, mods: { atk: 1 } });
  const unitLord = auraCard("AURA_UNITS", { affects: FRIENDLY_BOARD, mods: { atk: 1 } });
  const deps = cardDeps([heroCard, minionCard, minionLord, unitLord]);

  /** 同一个盘面、同一份攻血，**只换宿主那张卡** —— 差别只可能出在那层 `where` 上。 */
  const run = (lord: Card): { allyAtk: number; heroAtk: number } => {
    const state = openGame();
    const host = putCard(state, 0, 0, lord, { atk: 0, health: 9 });
    const ally = putCard(state, 0, 1, minionCard, { atk: 2, health: 4 });
    const heroUnit = putCard(state, 0, 2, heroCard, { atk: 2, health: 9 });
    const after = tick(state, host, deps);
    return { allyAtk: tagOf(after, ally, "atk"), heroAtk: tagOf(after, heroUnit, "atk") };
  };

  const minionsOnly = run(minionLord);
  expect(minionsOnly.allyAtk).toBe(3);
  // ★ 本条目的全部内容在这一行：写错（`cond.is_kind` 的 kind 过滤没生效 ⇒
  //   `FRIENDLY_MINIONS` 退回 `FRIENDLY_UNITS`）会读到 3 —— 老卡静默地把英雄一起加强，
  //   而盘面上看不出任何异常（英雄本来就该在 `*_UNITS` 里，多加一个不报错）。
  expect(minionsOnly.heroAtk).toBe(2);

  // 对照：同一条 +1 攻写成「友方单位」时英雄**必须**吃到。这一半证明上面那个 2 是被
  // `kind` 滤出来的，而不是光环压根没接上 / 英雄不在 `affects` 的取值域里。
  const allUnits = run(unitLord);
  expect(allUnits.allyAtk).toBe(3);
  expect(allUnits.heroAtk).toBe(3);
});

test("★ 两趟重算：光环看不见别的光环的加成（结果与枚举顺序无关）", () => {
  // BOOST 给自己 +2 攻（base 2 ⇒ 生效 4）。
  const boost = auraCard("AURA_BOOST", { affects: SELF, mods: { atk: 2 } });
  // PICKY 给「atk ≥ 4 的友军」加 5 血 —— 它求值时看到的应当是**第 1 趟**的盘面（atk 2）。
  const picky = auraCard("AURA_PICKY", {
    affects: {
      op: "sel.where",
      of: FRIENDLY_BOARD,
      cond: { op: "cond.gte", l: { op: "num.attr", of: { op: "sel.it" }, tag: "atk" }, r: 4 },
    },
    mods: { health: 5 },
  });
  const deps = cardDeps([boost, picky]);
  const state = openGame();
  const boosted = putCard(state, 0, 0, boost, { atk: 2, health: 4 });
  const judge = putCard(state, 0, 1, picky, { atk: 0, health: 4 });

  const after = tick(state, judge, deps);

  expect(tagOf(after, boosted, "atk")).toBe(4);
  // 写错（求一条加一条 ⇒ 级联）会读到 9：PICKY 看见了 BOOST 加完之后的 4 攻。
  expect(tagOf(after, boosted, "health")).toBe(4);
  // judge 自己 0 攻，两种实现下都不该吃到（钉住"不是恒加全场"）。
  expect(tagOf(after, judge, "health")).toBe(4);
});

// ═══════════════════════════════════════════════════════════════════════════
// 确定性防线：光环重算不得消耗 RNG（IR v1 §5.4 规则 5）
// ═══════════════════════════════════════════════════════════════════════════

test("★ affects 里出现 sel.random ⇒ AuraRandomError（重算不得消耗 RNG）", () => {
  const rolling = auraCard("AURA_ROLL", {
    affects: { op: "sel.random", of: FRIENDLY_BOARD },
    mods: { atk: 1 },
  });
  const deps = cardDeps([rolling]);
  const state = openGame();
  putCard(state, 0, 0, rolling, { atk: 1, health: 4 });
  putUnit(state, 0, 1, { atk: 1, health: 4 });

  let caught: unknown = null;
  try {
    refreshAuras(state, deps);
  } catch (error) {
    caught = error;
  }

  // 写错（防线没接）会读到 false：随机流的推进次数从此随盘面细节漂移，回放静默失真。
  expect(caught instanceof AuraRandomError).toBe(true);
  // 抛错前排空事件日志（`events/log.ts` 的不变量，抛错路径也不例外）。
  expect(state.eventLog).toHaveLength(0);
});

test("★ cond 里出现 num.random ⇒ 同样抛，错误上带着宿主与排空的事件", () => {
  const rolling = auraCard("AURA_COIN", {
    affects: SELF,
    mods: { atk: 1 },
    cond: { op: "cond.gte", l: { op: "num.random", lo: 0, hi: 1 }, r: 0 },
  });
  const deps = cardDeps([rolling]);
  const state = openGame();
  const host = putCard(state, 0, 0, rolling, { atk: 1, health: 4 });

  let caught: AuraRandomError | null = null;
  try {
    refreshAuras(state, deps);
  } catch (error) {
    caught = error instanceof AuraRandomError ? error : null;
  }

  // 写错（只守 affects 不守 cond）会读到 null —— 而 L3 恰恰只点名了 cond。
  expect(caught?.owner).toBe(host);
  expect(eventNames(caught?.events ?? [])).toEqual(["engine.random_picked"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 附魔的四种 duration（IR v1 §2.3 / v2 §3.5）
// ═══════════════════════════════════════════════════════════════════════════

/** 四条 +1 攻的附魔，各占一种存续期 —— 于是"剥错了哪一档"直接体现在 atk 上。 */
const DURATION_ENCHANTS: readonly Enchantment[] = [
  { id: "E_PERM", attachesTo: "minion", mods: { atk: 1 }, duration: "permanent" },
  { id: "E_ROUND", attachesTo: "minion", mods: { atk: 1 }, duration: "end_of_round" },
  { id: "E_COMBAT", attachesTo: "minion", mods: { atk: 1 }, duration: "end_of_combat" },
  { id: "E_SOURCE", attachesTo: "minion", mods: { atk: 1 }, duration: "while_source_alive" },
];

test("四种 duration：stripEnchantments 按档剥离，并当场重算生效值", () => {
  const deps: TriggerDeps = cardDeps([], DURATION_ENCHANTS);
  const state = openGame();
  const unit = putUnit(state, 0, 0, { atk: 0, health: 9 });
  const buffs = DURATION_ENCHANTS.map((ench) => buff(unit, ench.id));
  const loaded = runActs(state, buffs, unit, cardDeps([], DURATION_ENCHANTS)).state;
  // 四条 +1 攻全挂上（0 攻的靶子 ⇒ 生效 atk 就是"还剩几条"）。
  expect(tagOf(loaded, unit, "atk")).toBe(4);

  stripEnchantments(loaded, "end_of_combat", deps);
  // 两条一起断言：只读实例列表则"剥了但忘了重算"照样绿，只读 atk 则反过来。
  expect(enchantsOf(loaded, unit)).toEqual(["E_PERM", "E_ROUND", "E_SOURCE"]);
  expect(tagOf(loaded, unit, "atk")).toBe(3);

  stripEnchantments(loaded, "end_of_round", deps);
  expect(enchantsOf(loaded, unit)).toEqual(["E_PERM", "E_SOURCE"]);
  expect(tagOf(loaded, unit, "atk")).toBe(2);

  // `permanent` 与 `while_source_alive` 都不吃相位剥离（写错会读到 1 或 0）。
  stripEnchantments(loaded, "permanent", deps);
  expect(enchantsOf(loaded, unit)).toEqual(["E_SOURCE"]);
});

test("end_of_combat 在战斗第 ⑤ 步剥离，end_of_round 在回合末剥离，permanent 全程留着", () => {
  const deps = cardDeps([], DURATION_ENCHANTS);
  const state = openGame();
  const unit = putUnit(state, 0, 0, { atk: 0, health: 9 });
  const loaded = runActs(
    state,
    [buff(unit, "E_PERM"), buff(unit, "E_COMBAT"), buff(unit, "E_ROUND")],
    unit,
    deps,
  ).state;
  expect(tagOf(loaded, unit, "atk")).toBe(3);

  // `passThroughCombat` 一路跑到下一回合，途中经过战斗第 ⑤ 步与 round_end。
  const after = passThroughCombat(loaded, deps).state;

  // 写错（相位机没接上剥离，或剥完没重算）会读到三条 / atk 3。
  expect(enchantsOf(after, unit)).toEqual(["E_PERM"]);
  expect(tagOf(after, unit, "atk")).toBe(1);
});

test("★ while_source_alive：来源阵亡即剥离，同一档之外的附魔一条都不动", () => {
  const deps = cardDeps([], DURATION_ENCHANTS);
  const state = openGame();
  const source = putUnit(state, 0, 0, { atk: 0, health: 2 });
  const target = putUnit(state, 0, 1, { atk: 0, health: 9 });
  const loaded = runActs(
    state,
    [buff(target, "E_SOURCE"), buff(target, "E_PERM")],
    source,
    deps,
  ).state;
  expect(tagOf(loaded, target, "atk")).toBe(2);

  // 打死来源 —— 死亡结算把它搬进墓地，同一次结算里剥掉依附它的那一条。
  const after = runActs(loaded, [hit(source, 2)], target, deps).state;

  expect(inGraveyard(after, 0, source)).toBe(true);
  // 写错（这一档没接）会读到两条 / atk 2；写错（连 permanent 一起剥了）会读到空 / atk 0。
  expect(enchantsOf(after, target)).toEqual(["E_PERM"]);
  expect(tagOf(after, target, "atk")).toBe(1);
});

test("while_source_alive：来源只是被弹回手牌（仍然活着）⇒ 附魔留着", () => {
  const deps = cardDeps([], DURATION_ENCHANTS);
  const state = openGame();
  const source = putUnit(state, 0, 0, { atk: 0, health: 4 });
  const target = putUnit(state, 0, 1, { atk: 0, health: 9 });
  const loaded = runActs(state, [buff(target, "E_SOURCE")], source, deps).state;

  const bounced = runActs(
    loaded,
    [{ op: "act.move", target: { op: "sel.entity", id: source }, zone: "hand" }],
    target,
    deps,
  ).state;

  // 写错（判据取"不在场上"而不是"已阵亡"）会读到空数组 / atk 0：
  // 一次弹回手牌顺手清掉一堆本该留下的 buff。
  expect(enchantsOf(bounced, target)).toEqual(["E_SOURCE"]);
  expect(tagOf(bounced, target, "atk")).toBe(1);
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ M5/T3 拍板：相位机一律「先剥离 + 重算，再发事件 / 排触发器」
// ═══════════════════════════════════════════════════════════════════════════
// 这条拍板的**全部**可观测面是：`queueTriggers` 里那次 `cond` 求值看到的是剥离/重算
// 之前还是之后的盘面。两个落点各钉一条 —— 两次注入（把 `stripEnchantments` /
// `refreshAuras` 挪到 `queueTriggers` 之后）都只会红下面对应的那一条。
// ⚠ `resolve/deaths.ts` 的死亡结算**不在**这一节里：它的口径不同（本波亡语的 `cond`
//   看不到本波死者带来的光环变化），理由与它为什么不能统一见那个文件的 `processDeaths`，
//   语义由本文件最后那条「亡语的 cond 看到的是中间盘面」钉住。

/** 给自己盖一个一眼可辨的印记。取 `atk` 而不是被 `cond` 读的那个 tag，免得自证。 */
const MARK_ATK: Act = { op: "act.set_tag", target: SELF, tag: "atk", value: 7 };

/** 「每当战斗结束，若我 armor ≥ 5」—— `cond` 读的是**生效值**，剥离算不算数在这里可见。 */
const COMBAT_END_WATCHER: Card = scriptCard("AURA_CE_WATCH", {
  triggers: [
    {
      on: "combat_ended",
      cond: { op: "cond.gte", l: { op: "num.attr", of: SELF, tag: "armor" }, r: 5 },
      do: [MARK_ATK],
    },
  ],
});

/** 两条 +5 armor 的附魔，**只差存续期** —— 于是差别只可能出在"剥没剥"上。 */
const PLATE_COMBAT: Enchantment = {
  id: "E_PLATE_COMBAT",
  attachesTo: "minion",
  mods: { armor: 5 },
  duration: "end_of_combat",
};
const PLATE_PERM: Enchantment = {
  id: "E_PLATE_PERM",
  attachesTo: "minion",
  mods: { armor: 5 },
  duration: "permanent",
};

test("★ 拍板：`end_of_combat` 剥离排在 `combat_ended` 的触发器排队**之前**", () => {
  const deps = cardDeps([COMBAT_END_WATCHER], [PLATE_COMBAT, PLATE_PERM]);
  /** 同一张卡、同一条触发器、同一个盘面，只差挂哪一条附魔。 */
  const fight = (ench: string): { state: GameState; unit: EntityId } => {
    const state = openGame();
    // atk 0 ⇒ 谁都不出手，战斗只走"进出"两步，没有别的事件掺和进来。
    const unit = putCard(state, 0, 0, COMBAT_END_WATCHER, { atk: 0, health: 9 });
    const loaded = runActs(state, [buff(unit, ench)], unit, deps).state;
    expect(tagOf(loaded, unit, "armor")).toBe(5);
    return { state: passThroughCombat(loaded, deps).state, unit };
  };

  // 对照：`permanent` 不吃战斗末剥离 ⇒ `cond` 那一刻 armor 仍是 5 ⇒ 印记落下。
  // 这一半证明触发器本身是接上的，于是下一半的 0 只能解释成"剥离先发生了"。
  const kept = fight("E_PLATE_PERM");
  expect(tagOf(kept.state, kept.unit, "atk")).toBe(7);

  const stripped = fight("E_PLATE_COMBAT");
  // ★ 判别力全在这一行：`stripEnchantments(state, "end_of_combat", deps)` 若挪到
  //   `queueTriggers` **之后**（拍板之前那种排法），`cond` 会读到剥离前的 armor 5
  //   ⇒ 触发器照跑 ⇒ 读到 7。
  expect(tagOf(stripped.state, stripped.unit, "atk")).toBe(0);
  // 剥离本身确实发生了（两条一起断言，同上面 duration 那几条的规矩）。
  expect(enchantsOf(stripped.state, stripped.unit)).toEqual([]);
  expect(tagOf(stripped.state, stripped.unit, "armor")).toBe(0);
});

/**
 * 「第 2 回合起我 +5 攻」+「每当回合开始，若我 atk ≥ 5 就盖印记」。
 *
 * 光环的 `cond` 读的是全局量 `round` —— 而 `round` 是相位机**在流水线之外**改的
 * （`beginRound` 的第一行），所以这条光环的生效时刻**只**由 `runStep` 里那次重算决定。
 */
const ROUND_TWO_LORD: Card = scriptCard("AURA_ROUND_2", {
  auras: [
    {
      affects: SELF,
      mods: { atk: 5 },
      cond: { op: "cond.gte", l: { op: "num.tag", tag: "round" }, r: 2 },
    },
  ],
  triggers: [
    {
      on: "round_began",
      cond: { op: "cond.gte", l: { op: "num.attr", of: SELF, tag: "atk" }, r: 5 },
      do: [{ op: "act.set_tag", target: SELF, tag: "armor", value: 7 }],
    },
  ],
});

test("★ 拍板：`runStep` 的光环重算排在相位事件的触发器排队**之前**", () => {
  const deps = cardDeps([ROUND_TWO_LORD]);
  const state = openGame();
  const host = putCard(state, 0, 1, ROUND_TWO_LORD, { atk: 0, health: 9 });

  // 第 1 回合：光环的 cond 不成立 ⇒ 生效 atk 还是卡面的 0。
  const first = tick(state, host, deps);
  expect(tagOf(first, host, "atk")).toBe(0);

  // 一路打到第 2 回合的 round_start。`beginRound` 先把 `round` 改成 2、发 `round_began`，
  // 然后 `runStep` **先**重算光环（atk 0 ⇒ 5）、**后**把 `round_began` 交给 `queueTriggers`。
  const second = passThroughCombat(first, deps).state;

  expect(second.round).toBe(2);
  expect(tagOf(second, host, "atk")).toBe(5);
  // ★ 判别力全在这一行：`refreshAuras` 若挪到 `queueTriggers` **之后**，触发器的 `cond`
  //   会读到重算前的 atk（第 1 回合的 0）⇒ 不触发 ⇒ 读到 0。
  //   上一行照样绿（那次重算最终还是跑了），所以只有这一行拦得住。
  expect(tagOf(second, host, "armor")).toBe(7);
});

// ═══════════════════════════════════════════════════════════════════════════
// 与死亡结算的接缝（v2 §4.2 第 ④ 步：光环重算在不动点循环**里面**）
// ═══════════════════════════════════════════════════════════════════════════

test("★ 掉光环致死：光环源阵亡后，靠它撑血量的单位在**同一次**结算里跟着死", () => {
  const lord = auraCard("AURA_WARDEN", { affects: OTHER_FRIENDLIES, mods: { health: 2 } });
  const deps = cardDeps([lord]);
  const state = openGame();
  const host = putCard(state, 0, 0, lord, { atk: 0, health: 2 });
  const ally = putUnit(state, 0, 1, { atk: 0, health: 1 });

  // 先给 ally 吃 2 点：生效血量 1+2=3，扛得住。
  const damaged = runActs(state, [hit(ally, 2)], host, deps).state;
  expect(tagOf(damaged, ally, "health")).toBe(3);
  expect(inGraveyard(damaged, 0, ally)).toBe(false);

  // 一步：打死光环源。ally 掉了 +2 血上限 ⇒ 2 >= 1 ⇒ 本次结算就该判死。
  const step = runActs(damaged, [hit(host, 2)], ally, deps);

  expect(inGraveyard(step.state, 0, host)).toBe(true);
  // 写错（判死前不重算）会读到 false：ally 要等下一次弹栈，而栈此刻已经空了 ——
  // 它会带着 −1 血活下去，直到某个无关的动作把它捎带判死。
  expect(inGraveyard(step.state, 0, ally)).toBe(true);
  // 两条 `unit_died` 都在这一段事件流里（顺序即因果：先源后从）。
  expect(eventNames(step.events).filter((name) => name === "unit_died")).toHaveLength(2);
});

test("★ 减血上限的附魔当场致死（判死之前要先把派生属性算准）", () => {
  const wither: Enchantment = {
    id: "E_WITHER",
    attachesTo: "minion",
    mods: { health: -2 },
    duration: "permanent",
  };
  const deps = cardDeps([], [wither]);
  const state = openGame();
  const victim = putUnit(state, 0, 0, { atk: 0, health: 3 });
  const caster = putUnit(state, 0, 1, { atk: 0, health: 9 });

  const damaged = runActs(state, [hit(victim, 2)], caster, deps).state;
  expect(inGraveyard(damaged, 0, victim)).toBe(false);

  // 这一步只挂附魔：生效上限 3−2=1，已受伤害 2 ⇒ 当场致死。
  const step = runActs(damaged, [buff(victim, "E_WITHER")], caster, deps);

  // 写错（`processDeaths` 读到重算前的 `tags.health`）会读到 false —— 而这一步之后
  // 栈就空了，它会带着 −1 血活下去。
  expect(inGraveyard(step.state, 0, victim)).toBe(true);
  expect(eventNames(step.events)).toContain("unit_died");
});

test("光环撑起来的血量上限扛得住伤害（判死读的是生效值不是卡面值）", () => {
  const lord = auraCard("AURA_WARDEN", { affects: OTHER_FRIENDLIES, mods: { health: 3 } });
  const deps = cardDeps([lord]);
  const state = openGame();
  const host = putCard(state, 0, 0, lord, { atk: 0, health: 9 });
  const ally = putUnit(state, 0, 1, { atk: 0, health: 2 });

  const after = runActs(state, [hit(ally, 4)], host, deps).state;

  // 写错（判死读 base.health）会读到 true：4 >= 2。
  expect(inGraveyard(after, 0, ally)).toBe(false);
  expect(tagOf(after, ally, "health")).toBe(5);
  expect(damageOf(after, ally)).toBe(4);
});

test("★ 亡语的 cond 看到的是「死者已进墓地、但它的光环还没算掉」的中间盘面", () => {
  // 光环源自带亡语：活着时给友军 +5 攻；死时若「友军 atk ≥ 5」就抽一张牌。
  const lord = scriptCard("AURA_LAST_WORD", {
    auras: [{ affects: OTHER_FRIENDLIES, mods: { atk: 5 } }],
    triggers: [
      {
        on: "unit_died",
        filter: { target: SELF },
        zone: "graveyard",
        cond: { op: "cond.gte", l: { op: "num.attr", of: FRIENDLY_BOARD, tag: "atk" }, r: 5 },
        do: [{ op: "act.draw", player: { op: "sel.controller" } }],
      },
    ],
  });
  const deps = cardDeps([lord]);
  const state = openGame();
  const host = putCard(state, 0, 0, lord, { atk: 0, health: 2 });
  const ally = putUnit(state, 0, 1, { atk: 0, health: 9 });

  const boosted = tick(state, host, deps);
  expect(tagOf(boosted, ally, "atk")).toBe(5);

  // 一步：打死光环源。`processDeaths` 的循环体是「剥离 → 重算 → 收集本波 → 移墓地 →
  // 排队触发器」，所以本波死者带来的光环变化要等**下一轮**开头那次重算才落地。
  const step = runActs(boosted, [hit(host, 2)], ally, deps);

  // ★ 事件流的第三条就是本条的全部内容：亡语**触发了** —— 它的 `cond` 求值发生在
  //   「host 已经躺进墓地」之后、「掉光环的那次重算」之前，于是它读到的 ally 是 5 攻。
  //   把重算插到 `queueTriggers` **之前**（即让亡语看到结算后的盘面）的实现会读到
  //   `["damaged", "unit_died"]` —— 那正是与 `rules/phase.ts` 三处口径统一的排法，
  //   而框架 §4.1 / v2 §4.2 第 ④ 步的原文顺序是「统一死亡结算 → 亡语 → 光环重算」，
  //   亡语排在重算**之前**。取规范原文，两条路径的口径因此**有意不同**
  //   （完整论证在 `resolve/deaths.ts` 的 `processDeaths`）。
  expect(eventNames(step.events)).toEqual(["damaged", "unit_died", "card_drawn"]);
  expect(inGraveyard(step.state, 0, host)).toBe(true);
  // 而这一步结算完，ally 的 atk 已经是 0 —— cond 看到的那个 5 是**中间**盘面上的值。
  expect(tagOf(step.state, ally, "atk")).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 退化形态：不接 bundle 时两个 Σ 都是空和（M2~M4 的行为逐字不变）
// ═══════════════════════════════════════════════════════════════════════════

test("不接卡表/附魔表 ⇒ tags = base、flags = baseFlags（语义正确的退化，不是占位）", () => {
  const lord = auraCard("AURA_LORD", { affects: FRIENDLY_BOARD, mods: { atk: 5 } });
  const state = openGame();
  const host = putCard(state, 0, 0, lord, { atk: 1, health: 4 });

  refreshAuras(state, NO_DEPS);

  const entity = state.entities[host];
  expect(tagOf(state, host, "atk")).toBe(1);
  expect(entity?.tags).toEqual(entity?.base ?? {});
  expect(entity?.flags).toBe(entity?.baseFlags ?? -1);
  // ★ **值相等但不是同一个对象**：两者共用一个对象时，任何一处「写完 base 顺手把 tags
  //   对齐」的原地写都会静默改掉卡面值，而 `act.silence` 的复位目标正是卡面值。
  //   写错（`entity.tags = entity.base`）会读到 true —— 上面两条断言照样绿。
  expect(entity?.tags === entity?.base).toBe(false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 与战斗批次的接缝（v2 §4.2 第 ③ 步：逐击也跑第 ⑥ 步）
// ═══════════════════════════════════════════════════════════════════════════

test("★ 批次中途挂上加攻附魔 ⇒ 逐击第 ⑥ 步当场重算，但那一击仍按冻结值打出", () => {
  // 这条钉的是**两件事**，缺一条都会让另一条失去判别力：
  //   1. 战斗第 ③ 步逐击跑的第 ⑥ 步 `refreshAuras(state, deps)` **真的带着 bundle**
  //      —— 唯一的可观测面是 rager 的生效 atk 在这一批里从 2 变成 5；
  //   2. 变了也**改不了已经冻结的那一击**（v2 §4.2 第 ② 步）——
  //      冻结值随 `act.strike.amount` 走完管线（M5/T5）。
  // 拦截器的 `then` 是这条路的入口：它入栈后被 `rules/combat.ts` 的 `harvest` 收进
  // 本地链条，在这一批出手里就跑掉，于是附魔在 rager 自己出手**之前**就挂上了。
  //
  // ⚠ M5/T5 之前这里断言的是一道运行时哨兵会抛 `StrikeAmountDriftError`
  //   （那时冻结值送不进管线，只能把坏掉的批次拦停）。哨兵已随 T5 删除。
  const rage: Enchantment = {
    id: "E_RAGE",
    attachesTo: "minion",
    mods: { atk: 3 },
    duration: "permanent",
  };
  const rager = scriptCard("PF_RAGER", {
    intercepts: [
      {
        intercept: "act.hit",
        filter: { target: SELF },
        effect: { kind: "set_field", field: "amount", value: 0 },
        then: [{ op: "act.buff", target: SELF, ench: "E_RAGE" }],
      },
    ],
  });
  const deps = cardDeps([rager], [rage]);
  // p1 先手 ⇒ 快照顺序 [p1 格 0→8, p0 格 0→8]：p1 先打中 rager，rager 之后才轮到出手。
  const state = openGame({ firstPlayer: 1 });
  const ragerId = putCard(state, 0, 0, rager, { atk: 2, health: 9 });
  const poker = putUnit(state, 1, 0, { atk: 1, health: 9 });

  const step = fightOnce(state, deps);

  // ① 附魔真的挂上并算进了生效值：写错（第 ⑥ 步不带 bundle ⇒ 附魔加成算不出来）
  //    会读到 2 —— 而那时盘面上看不出任何异常，"生效值在批次中途变了"被静默吞掉。
  //    两个一起读（同本文件别处的规矩）：只读实例列表，"挂了但没算进去"照样绿。
  expect(enchantsOf(step.state, ragerId)).toEqual(["E_RAGE"]);
  expect(tagOf(step.state, ragerId, "atk")).toBe(5);
  // ② 但 rager 那一击打的是冻结的 2，不是 5。
  //    `rules/combat.ts` 的 `strikeActOf` 里删掉 `amount:` 那一行会读到 5。
  expect(damageOf(step.state, poker)).toBe(2);
  // 拦截器把落到 rager 头上那一击的 amount 改成了 0 ⇒ rager 一点伤都没吃。
  expect(damageOf(step.state, ragerId)).toBe(0);
});
