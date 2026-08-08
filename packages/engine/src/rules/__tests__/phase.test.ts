// 相位机的单元测试（M3 任务书第 1~4 项）。
//
// 走查测试（`src/__tests__/walkthrough.test.ts`）跑的是"一局对战长什么样"，
// 本文件逐条钉住相位机自己的**规则**：
//   1. 相位序列 mulligan → round_start → deploy(若有) → actions → combat → round_end
//   2. 水晶：`cap = min(initial + (round-1)*growth, capMax)`，每回合回满
//   3. 行动交替：`priority` 换手、`consecutivePasses`、★ pass 不锁定、双 pass → combat
//   4. initiative 四种策略全部实现 + 首回合先手随机且与策略正交
//
// 注：本文件**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1）。

import { expect, test } from "bun:test";
import type { CardId, InitiativeRule, RulesConfig } from "@prismfront/ir";
import type { GameEvent } from "../../events/index.ts";
import { pushAct } from "../../resolve/index.ts";
import type { GameState, PlayerId } from "../../state/index.ts";
import { createCtx, getEntity, getZone } from "../../state/index.ts";
import {
  expectOk,
  handOf,
  passOnce,
  passThroughCombat,
  playCard,
  putUnit,
  setFace,
  startMatch,
} from "../../testkit/index.ts";
import type { Intent } from "../index.ts";
import {
  apply,
  createGame,
  crystalCapFor,
  deployCountFor,
  deployQuotaOf,
  needsDeploy,
  nextInitiative,
} from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════════════════

const BASE_RULES: RulesConfig = {
  board: { slots: 9 },
  crystals: { initial: 5, growth: 1, capMax: 10 },
  pass: { combatAfterConsecutivePasses: 2 },
  initiative: "alternate",
  baseHp: 30,
  deck: { size: 30, maxCopies: 2, startingHand: 4, drawPerRound: 1, fatigue: true },
  playerActions: ["play_card"],
  actionSeconds: 30,
  reconnectSeconds: 90,
  heroes: { perDeck: 3, deploySchedule: [2, 1], respawnDelay: 1 },
};

/** 30 张：起手 4 张之后还剩 26 张，跑十几个回合也不会撞上疲劳。 */
const DECK_SIZE = 30;

function makeDeck(prefix: string): readonly CardId[] {
  const cards: CardId[] = [];
  for (let i = 1; i <= DECK_SIZE; i += 1) {
    cards.push(`${prefix}${i}`);
  }
  return cards;
}

const DECKS: readonly [readonly CardId[], readonly CardId[]] = [makeDeck("A"), makeDeck("B")];

function rulesWith(patch: Partial<RulesConfig>): RulesConfig {
  return { ...BASE_RULES, ...patch };
}

/**
 * 建局 + 起手调度，停在第 1 回合的 `actions` 相位。
 *
 * 所有牌都写成 1/1、0 费：本文件断言的是**相位与计数**，不希望被"水晶不够"
 * 或"0 血单位一上场就死"这类盘面细节干扰。
 */
function openedGame(rules: RulesConfig = BASE_RULES, firstPlayer: PlayerId = 0): GameState {
  const start = createGame(rules, DECKS, 0x51ee, { shuffle: false, firstPlayer });
  for (const player of [0, 1] as const) {
    for (const id of [...getZone(start, player, "deck"), ...handOf(start, player)]) {
      setFace(start, id, { atk: 1, health: 1, cost: 0 });
    }
  }
  return startMatch(start).state;
}

function namesOf(events: readonly GameEvent[]): string[] {
  return events.map((event) => event.name);
}

/** 让当前 `priority` 方打出手里的第一张牌到第 `slot` 格。 */
function playFirst(state: GameState, slot: number): GameState {
  const card = handOf(state, state.priority)[0];
  if (card === undefined) {
    throw new Error("夹具错误：手牌是空的");
  }
  return playCard(state, card, slot).state;
}

/**
 * 让当前 `priority` 方**真的花掉** `cost` 点水晶打出一张牌（卡面费用当场写上）。
 *
 * {@link openedGame} 给每张牌写的是 0 费 —— 于是"每回合回满"与"每回合按 `growth`
 * 补一点"在状态里长得**一模一样**，一颗水晶都没花过的对局分不开这两种实现。
 * 本函数是让两者分叉的唯一手段：调用方给的 `cost` 恒大于 `growth`。
 * 顺带把「记账段扣的是 `tags.cost`」也钉住（扣 0 / 扣固定值 / 扣到上限都会红）。
 */
function spendOn(state: GameState, cost: number, slot: number): GameState {
  const player = state.priority;
  const card = handOf(state, player)[0];
  if (card === undefined) {
    throw new Error("夹具错误：手牌是空的");
  }
  setFace(state, card, { cost });
  const before = state.players[player].crystals;
  const next = playCard(state, card, slot).state;
  expect([cost, next.players[player].crystals]).toEqual([cost, before - cost]);
  return next;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 相位序列
// ═══════════════════════════════════════════════════════════════════════════

test("相位序列：mulligan → round_start → actions → combat → round_end → round_start", () => {
  const start = createGame(BASE_RULES, DECKS, 1, { shuffle: false, firstPlayer: 0 });
  expect(start.phase).toBe("mulligan");
  expect(start.round).toBe(0);

  // 起手调度之后相位机一路跑到 actions —— round_start 是**自动相位**，不等意图。
  const r1 = startMatch(start).state;
  expect(r1.phase).toBe("actions");
  expect(r1.round).toBe(1);

  // 双 pass 之后 combat / round_end / round_start 三个自动相位一口气跑完，停在 actions。
  const r2 = passThroughCombat(r1);
  expect(namesOf(r2.events)).toEqual([
    "player_passed",
    "player_passed",
    "combat_began",
    "combat_ended",
    "round_ended",
    "round_began",
    "crystal_gained",
    "crystal_gained",
    "card_drawn",
    "card_drawn",
  ]);
  expect(r2.state.phase).toBe("actions");
  expect(r2.state.round).toBe(2);
  // 自动相位跑完栈必须是空的（战斗第 ① 步"结算栈完全清空"的前提）。
  expect(r2.state.stack).toEqual([]);
  expect(r2.state.eventLog).toEqual([]);
});

test("没有英雄的对局不经过 deploy 相位（『若有』的判据是真的有得部署）", () => {
  const r1 = openedGame();
  // 排期说 r1 要部署 2 名，但复燃泉是空的 ⇒ 不进 deploy。
  expect(deployQuotaOf(r1)).toBe(2);
  expect(needsDeploy(r1)).toBe(false);
  expect(r1.phase).toBe("actions");
  expect(apply(r1, { t: "deploy", player: 0, picks: [[], []] })).toEqual({
    ok: false,
    code: "wrong_phase",
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1b. 起手调度真的换牌（`applyMulligan` 的非空 toss 那一支）
// ═══════════════════════════════════════════════════════════════════════════

/** 某方手上 + 牌库里的全部牌张（升序）—— 换牌只在这两个区之间搬运，集合必须守恒。 */
function cardsOf(state: GameState, player: PlayerId): number[] {
  return [...handOf(state, player), ...getZone(state, player, "deck")].sort((a, b) => a - b);
}

test("★ 起手调度真的换牌：塞回牌库 → 洗牌（消耗 RNG）→ 补抽同样张数", () => {
  // 全仓此前**没有一条非空 toss 跑通过** —— 走查里那两条非空用例都是被拒的负例，
  // 于是 `applyMulligan` 里真正换牌的那一支零运行时覆盖。它会 `shuffleZone` 消耗 RNG，
  // 直接决定「同 seed 同意图流 ⇒ 同终局」与 M8 的 golden replay：
  // 这条路径静默坏掉，历史回放会失真而没有任何测试变红。
  const start = createGame(BASE_RULES, DECKS, 0x51ee, { shuffle: false, firstPlayer: 0 });
  const [first, , third] = handOf(start, 0);
  if (first === undefined || third === undefined) {
    throw new Error("夹具错误：起手牌不足 3 张");
  }
  const before = cardsOf(start, 0);

  // 对照组：双方都不换。两份状态的差别**只有** p0 那一次 toss。
  const kept = startMatch(start).state;
  const swapped = expectOk(
    apply(start, { t: "mulligan", player: 0, toss: [[first, third], []] }),
  ).state;

  // (1) 换掉的两张确实不在手里了。
  //     ⚠ 塞回去的牌**有可能被洗回牌库顶再摸回来**（换个种子就会撞上），所以这里
  //       钉住 `0x51ee`；真正与种子无关的守恒性质是下面的 (3)。
  expect(handOf(swapped, 0)).not.toContain(first);
  expect(handOf(swapped, 0)).not.toContain(third);

  // (2) 手牌张数不变：换 2 张就补抽 2 张（末尾的 +1 是 round_start 的每回合抽牌）。
  expect(handOf(swapped, 0)).toHaveLength(
    BASE_RULES.deck.startingHand + BASE_RULES.deck.drawPerRound,
  );
  expect(handOf(swapped, 0)).toHaveLength(handOf(kept, 0).length);

  // (3) 这一方的牌张集合不重不漏 —— 塞回 / 洗 / 补抽这三步不许凭空造牌，也不许吞牌。
  expect(cardsOf(swapped, 0)).toEqual(before);

  // (4) 随机流真的被推进了（洗牌走 `nextInt`）：不换牌的对照组一次 RNG 都不消耗。
  expect(swapped.rng).not.toEqual(kept.rng);
  //     只洗**换过牌的那一方**：p1 交的是空 toss，它的牌库顺序两边逐字相同。
  expect(getZone(swapped, 1, "deck")).toEqual(getZone(kept, 1, "deck"));
  expect(getZone(swapped, 0, "deck")).not.toEqual(getZone(kept, 0, "deck"));

  // (5) 相位照常落到第 1 回合的 actions（换牌那一支不该改变相位推进）。
  expect([swapped.phase, swapped.round]).toEqual(["actions", 1]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. 水晶（v2 §4.1：cap = min(initial + (round-1)*growth, capMax)，每回合回满）
// ═══════════════════════════════════════════════════════════════════════════

test("水晶：上限按公式递增并封顶 capMax，且每回合**花掉之后**照样回满", () => {
  let state = openedGame();
  // r1：min(5 + 0, 10) = 5
  expect(state.players[0].crystalCap).toBe(5);
  expect(state.players[0].crystals).toBe(5);

  const expected = [5, 6, 7, 8, 9, 10, 10, 10];
  for (let round = 1; round <= expected.length; round += 1) {
    const cap = expected[round - 1] ?? 0;
    expect([round, state.round, state.players[0].crystalCap]).toEqual([round, round, cap]);
    // ★ 上一回合双方各花掉 3 点（恒 > growth），这一回合仍然**回满**到 cap。
    //   这条断言是"回满"与"按 growth 补差额"唯一分得开的地方：只要一颗水晶都没花过，
    //   两种实现产出的状态逐字相同（`crystal_gained` 的事件流也相同）。
    expect(state.players[0].crystals).toBe(cap);
    expect(state.players[1].crystals).toBe(cap);
    // 纯函数版本的公式与相位机写进状态的值必须一致。
    expect(crystalCapFor(state, round)).toBe(cap);
    if (round < expected.length) {
      // 双方各打一张 3 费牌，都落在自己那一行的 0 号格 ⇒ 战斗里对撞同归于尽，
      // 盘面不会越堆越满，也不会有单位越过空格去啃对方 base（那会引入无关的伤害）。
      state = spendOn(state, 3, 0);
      state = spendOn(state, 3, 0);
      expect([state.players[0].crystals, state.players[1].crystals]).toEqual([cap - 3, cap - 3]);
      state = passThroughCombat(state).state;
    }
  }
});

test("crystal_gained 的 amount 是**这次多出来的**，涨不动就不发事件", () => {
  const rules = rulesWith({ crystals: { initial: 5, growth: 0, capMax: 5 } });
  const r1 = openedGame(rules);
  // r1：0 → 5，发一条 amount 5。
  expect(r1.players[0].crystals).toBe(5);

  // r2：上限不涨（growth 0）、上一轮一颗没花 ⇒ 回满等于没变，不该发事件。
  const r2 = passThroughCombat(r1);
  expect(namesOf(r2.events)).toEqual([
    "player_passed",
    "player_passed",
    "combat_began",
    "combat_ended",
    "round_ended",
    "round_began",
    "card_drawn",
    "card_drawn",
  ]);
  // 「没发事件」不等于「没回满」：回满这件事照样发生了，只是数值没变。
  expect([r2.state.players[0].crystals, r2.state.players[1].crystals]).toEqual([5, 5]);

  // 花掉 3 点之后再过一回合，才会发一条 amount 3。
  const spent = playFirst(r2.state, 0);
  spent.players[0].crystals = 2;
  const r3 = passThroughCombat(spent);
  const gained = r3.events.filter((event) => event.name === "crystal_gained");
  expect(gained).toEqual([{ name: "crystal_gained", player: spent.players[0].baseId, amount: 3 }]);
  // ★ 事件说 +3、状态却没动，上面那条照样全绿 —— 所以状态必须单独断言一次。
  expect(r3.state.players[0].crystals).toBe(5);
  expect(r3.state.players[0].crystalCap).toBe(5);
});

test("★ 水晶公式的三个参数各自可辨：initial / growth / capMax 都真的读配置", () => {
  // 全仓其余用例的 `crystals` 全是默认的 5/1/10，而唯一的非默认配置是上一条测试的
  // `{initial:5, growth:0, capMax:5}` —— growth 与 capMax 在那份参数下互相遮蔽
  // （上限恒等于 initial，三个字面量随便换成谁都算不出别的数）。
  // 于是把 `crystalCapFor` 里的 `initial` 写死成 5、`growth` 写死成 1、
  // `capMax` 写死成 10（任一单点），整套测试都不会红。
  // 3/2/7 让三者互不遮蔽：initial 变 ⇒ r1 错；growth 变 ⇒ r2 错；capMax 变 ⇒ r3 起错。
  const rules = rulesWith({ crystals: { initial: 3, growth: 2, capMax: 7 } });
  let state = openedGame(rules);

  // 纯函数：min(3 + (round - 1) * 2, 7)。r3 已经封顶，r4 只是继续封着。
  const caps = [3, 5, 7, 7];
  for (let round = 1; round <= caps.length; round += 1) {
    expect([round, crystalCapFor(state, round)]).toEqual([round, caps[round - 1] ?? 0]);
  }

  // 实跑到 r3：相位机写进**状态**的值与公式一致，且双方一致。
  for (let round = 1; round <= 3; round += 1) {
    const cap = caps[round - 1] ?? 0;
    expect([round, state.round, state.players[0].crystalCap, state.players[0].crystals]).toEqual([
      round,
      round,
      cap,
      cap,
    ]);
    expect([state.players[1].crystalCap, state.players[1].crystals]).toEqual([cap, cap]);
    if (round < 3) {
      state = passThroughCombat(state).state;
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. 行动交替（v2 §4.1：priority 换手 / consecutivePasses / ★ pass 不锁定）
// ═══════════════════════════════════════════════════════════════════════════

test("priority 每次行动与每次 pass 都换手，回合开始时回到先手方", () => {
  let state = openedGame();
  expect(state.priority).toBe(0);

  state = playFirst(state, 0);
  expect(state.priority).toBe(1);
  state = playFirst(state, 0);
  expect(state.priority).toBe(0);

  state = passOnce(state).state;
  expect(state.priority).toBe(1);
  expect(state.consecutivePasses).toBe(1);

  // 下一回合先手换到 p1（alternate），priority 随之从 p1 开始。
  state = passOnce(state).state;
  expect(state.round).toBe(2);
  expect(state.initiative).toBe(1);
  expect(state.priority).toBe(1);
});

test("★ pass 不锁定：对手行动之后计数清零，先 pass 的一方还能继续行动", () => {
  let state = openedGame();

  state = passOnce(state).state; // p0 pass
  expect(state.consecutivePasses).toBe(1);
  expect(state.firstPasser).toBe(0);
  expect(state.priority).toBe(1);
  expect(state.round).toBe(1); // 还没进战斗

  state = playFirst(state, 0); // p1 行动 ⇒ 计数清零
  expect(state.consecutivePasses).toBe(0);
  expect(state.priority).toBe(0);
  expect(state.round).toBe(1);

  state = playFirst(state, 1); // 先 pass 过的 p0 照样能打牌
  expect(state.consecutivePasses).toBe(0);
  expect(getZone(state, 0, "board")).toHaveLength(1);

  // `firstPasser` 记的是"本回合第一个 pass 的人"，不会被后来的行动抹掉。
  expect(state.firstPasser).toBe(0);

  // ★ 把"清零"的**后果**也跑出来：清零之后再 pass 一次只是第 1 次，不该立刻进战斗。
  //   「计数字段是 0」与「这一回合还没结束」是两件事：相位机只要在计数之外还留了
  //   任何一点「本回合有人 pass 过」的痕迹（比如改成按 `firstPasser` 判开打），
  //   上面那条 `consecutivePasses === 0` 照样是绿的，而这一次 pass 会当场把回合打完。
  const again = passOnce(state);
  expect(namesOf(again.events)).not.toContain("combat_began");
  expect(again.state.round).toBe(1);
  expect(again.state.consecutivePasses).toBe(1);
});

test("双 pass 的阈值读配置，不写死 2", () => {
  const rules = rulesWith({ pass: { combatAfterConsecutivePasses: 3 } });
  let state = openedGame(rules);

  state = passOnce(state).state;
  expect(state.consecutivePasses).toBe(1);
  state = passOnce(state).state;
  expect(state.consecutivePasses).toBe(2);
  expect(state.round).toBe(1); // 两次还不够

  const third = passOnce(state);
  expect(namesOf(third.events)).toContain("combat_began");
  expect(third.state.round).toBe(2);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. initiative 四种策略 + 首回合随机
// ═══════════════════════════════════════════════════════════════════════════

/** 跑 `rounds` 个回合（每回合直接双 pass），记下每个回合的 `initiative`。 */
function initiativeSeries(rules: RulesConfig, rounds: number, firstPlayer?: PlayerId): PlayerId[] {
  const options = firstPlayer === undefined ? { shuffle: false } : { shuffle: false, firstPlayer };
  const start = createGame(rules, DECKS, 0x51ee, options);
  let state = startMatch(start).state;
  const series: PlayerId[] = [state.initiative];
  for (let i = 1; i < rounds; i += 1) {
    state = passThroughCombat(state).state;
    series.push(state.initiative);
  }
  return series;
}

test("initiative = alternate（默认）：每回合轮换", () => {
  expect(BASE_RULES.initiative).toBe("alternate");
  expect(initiativeSeries(BASE_RULES, 5, 0)).toEqual([0, 1, 0, 1, 0]);
  expect(initiativeSeries(BASE_RULES, 5, 1)).toEqual([1, 0, 1, 0, 1]);
});

test("initiative = fixed_first：固定为**首回合掷出来的那一方**，不是固定 p0", () => {
  const rules = rulesWith({ initiative: "fixed_first" });
  expect(initiativeSeries(rules, 4, 0)).toEqual([0, 0, 0, 0]);
  expect(initiativeSeries(rules, 4, 1)).toEqual([1, 1, 1, 1]);
});

test("initiative = first_passer：本回合先 pass 的一方拿下回合先手（Artifact 式）", () => {
  const rules = rulesWith({ initiative: "first_passer" });
  let state = openedGame(rules, 0);
  expect(state.initiative).toBe(0);

  // r1：p0 先 pass ⇒ r2 先手是 p0。
  state = passThroughCombat(state).state;
  expect(state.round).toBe(2);
  expect(state.initiative).toBe(0);
  expect(state.priority).toBe(0);
  expect(state.firstPasser).toBeNull(); // 新回合重置

  // r2：p0 先行动、p1 先 pass ⇒ r3 先手换成 p1。
  state = playFirst(state, 0);
  expect(state.priority).toBe(1);
  state = passOnce(state).state;
  expect(state.firstPasser).toBe(1);
  state = passOnce(state).state; // p0 也 pass ⇒ 进战斗
  expect(state.round).toBe(3);
  expect(state.initiative).toBe(1);
});

test("first_passer 的退化分支：本回合没人 pass ⇒ **维持原先手**（不是恒 0、也不是换手）", () => {
  // `state.firstPasser ?? state.initiative` 这一行的 100% 行覆盖是被**非 null** 那半边
  // 顺带盖掉的：上面那条测试跑到的每一次调用 `firstPasser` 都有值。
  // 于是把 `?? state.initiative` 改成 `?? 0` 或 `?? opponentOf(state.initiative)`，
  // 全部相位测试照常绿 —— 只能在这里纯函数级地把它钉住。
  // 两个先手位都要钉：只钉 p0 的话 `?? 0` 那种改法仍然是绿的。
  const rules = rulesWith({ initiative: "first_passer" });
  for (const seat of [0, 1] as const) {
    const state = openedGame(rules, seat);
    expect([seat, state.initiative, state.firstPasser]).toEqual([seat, seat, null]);
    expect([seat, nextInitiative(state, "first_passer")]).toEqual([seat, seat]);
  }
});

test("initiative = random_each_round：走 nextInt 并发 engine.random_picked", () => {
  const rules = rulesWith({ initiative: "random_each_round" });
  const state = openedGame(rules, 0);
  expect(state.initiative).toBe(0); // 首回合是钉住的，不受策略影响

  const next = passThroughCombat(state);
  const picks = next.events.filter((event) => event.name === "engine.random_picked");
  expect(picks).toHaveLength(1);
  expect(picks[0]).toEqual({
    name: "engine.random_picked",
    origin: "initiative", // RANDOM_SOURCES 里给它留的那一格
    max: 2,
    result: next.state.initiative,
  });
  // 随机流真的被推进了（否则"随机"只是个说法）。
  expect(next.state.rng).not.toEqual(state.rng);

  // 事件顺序：round_began 是这一段的标题，随机结果紧随其后。
  const names = namesOf(next.events);
  expect(names.indexOf("engine.random_picked")).toBe(names.indexOf("round_began") + 1);
});

test("首回合先手随机、消耗 RNG，且与 initiative 策略正交（v2 §36）", () => {
  // 不钉 firstPlayer ⇒ 掷一次，消耗 RNG（对照组把两个消耗点都关掉）。
  const rolled = createGame(BASE_RULES, [[], []], 0x1234, { shuffle: false });
  const pinned = createGame(BASE_RULES, [[], []], 0x1234, { shuffle: false, firstPlayer: 0 });
  expect(rolled.rng).not.toEqual(pinned.rng);

  // 四种策略在**同一个种子**下掷出同一个首回合先手 —— 掷这件事不属于任何一种策略。
  const rules: readonly InitiativeRule[] = [
    "alternate",
    "first_passer",
    "random_each_round",
    "fixed_first",
  ];
  for (const rule of rules) {
    const game = createGame(rulesWith({ initiative: rule }), [[], []], 0x1234, { shuffle: false });
    expect([rule, game.initiative, game.priority]).toEqual([
      rule,
      rolled.initiative,
      rolled.initiative,
    ]);
    expect(game.rng).toEqual(rolled.rng);
  }

  // 掷出来的确实两边都可能 —— 恒返回 0 的"随机"同样能让上面几条全绿。
  const seen = new Set<PlayerId>();
  for (let seed = 0; seed < 32; seed += 1) {
    seen.add(createGame(BASE_RULES, [[], []], seed, { shuffle: false }).initiative);
  }
  expect([...seen].sort()).toEqual([0, 1]);
});

// ═══════════════════════════════════════════════════════════════════════════
// deploy 相位（v2.1 §11.3）
// ═══════════════════════════════════════════════════════════════════════════

const HEROES: readonly [readonly CardId[], readonly CardId[]] = [
  ["H_A1", "H_A2", "H_A3"],
  ["H_B1", "H_B2", "H_B3"],
];

/** 英雄实体 id：base ×2 + 双方牌库各 30 张之后才轮到英雄。 */
const P0_HERO = 2 + DECK_SIZE * 2 + 1;
const P1_HERO = P0_HERO + 3;

/** 带英雄的一局，停在第 1 回合的 `deploy` 相位。 */
function deployGame(): GameState {
  const start = createGame(BASE_RULES, DECKS, 0x51ee, {
    shuffle: false,
    firstPlayer: 0,
    heroes: HEROES,
  });
  for (const id of Object.keys(start.entities)) {
    setFace(start, Number(id), { health: 9 });
  }
  return startMatch(start).state;
}

test("deploy：排期说要部署就进 deploy 相位，部署完进 actions", () => {
  const state = deployGame();
  expect(state.phase).toBe("deploy");
  expect(deployQuotaOf(state)).toBe(2); // deploySchedule[0]

  const picks: Intent = {
    t: "deploy",
    player: 0,
    picks: [
      [
        { hero: P0_HERO, slot: 0 },
        { hero: P0_HERO + 1, slot: 1 },
      ],
      [
        { hero: P1_HERO, slot: 3 },
        { hero: P1_HERO + 1, slot: 4 },
      ],
    ],
  };
  const deployed = expectOk(apply(state, picks));

  expect(namesOf(deployed.events)).toEqual([
    "hero_deployed",
    "hero_deployed",
    "hero_deployed",
    "hero_deployed",
  ]);
  expect(deployed.events[0]).toEqual({
    name: "hero_deployed",
    player: state.players[0].baseId,
    target: P0_HERO,
    cardId: "H_A1",
    slot: 0,
  });
  expect(deployed.state.phase).toBe("actions");
  expect(deployed.state.slots[0][0]).toBe(P0_HERO);
  expect(deployed.state.slots[1][4]).toBe(P1_HERO + 1);
  // 上了场就不再是"等待复活"的状态。
  expect(getEntity(deployed.state, P0_HERO)?.respawnAt).toBeNull();
  // 泉里还剩第 3 名，r2 的排期正好是 1 名。
  expect(getZone(deployed.state, 0, "fountain")).toEqual([P0_HERO + 2]);

  const r2 = passThroughCombat(deployed.state).state;
  expect(r2.round).toBe(2);
  expect(r2.phase).toBe("deploy");
  expect(deployQuotaOf(r2)).toBe(1);
});

test("deploy 的校验：名数必须刚好、格位不能撞、英雄必须在自己的复燃泉里", () => {
  const state = deployGame();
  const cases: readonly [string, Intent][] = [
    [
      "invalid_choice",
      { t: "deploy", player: 0, picks: [[{ hero: P0_HERO, slot: 0 }], []] }, // 少了
    ],
    [
      "slot_occupied",
      {
        t: "deploy",
        player: 0,
        picks: [
          [
            { hero: P0_HERO, slot: 0 },
            { hero: P0_HERO + 1, slot: 0 }, // 撞同一格
          ],
          [
            { hero: P1_HERO, slot: 3 },
            { hero: P1_HERO + 1, slot: 4 },
          ],
        ],
      },
    ],
    [
      "wrong_zone",
      {
        t: "deploy",
        player: 0,
        picks: [
          [
            { hero: P0_HERO, slot: 0 },
            { hero: P1_HERO, slot: 1 }, // 拿了对面的英雄
          ],
          [
            { hero: P1_HERO, slot: 3 },
            { hero: P1_HERO + 1, slot: 4 },
          ],
        ],
      },
    ],
    [
      "invalid_slot",
      {
        t: "deploy",
        player: 0,
        picks: [
          [
            { hero: P0_HERO, slot: 0 },
            { hero: P0_HERO + 1, slot: 99 },
          ],
          [
            { hero: P1_HERO, slot: 3 },
            { hero: P1_HERO + 1, slot: 4 },
          ],
        ],
      },
    ],
  ];
  for (const [code, intent] of cases) {
    expect([code, apply(state, intent)]).toEqual([code, { ok: false, code }]);
  }
  // deploy 相位不收行动意图。
  expect(apply(state, { t: "pass", player: 0 })).toEqual({ ok: false, code: "wrong_phase" });
});

/** 把某方战线从 `from` 号格起摆满 —— 单位一律 0 atk，免得推进回合时搅进战斗伤害。 */
function fillBoard(state: GameState, player: PlayerId, from = 0): void {
  for (let slot = from; slot < BASE_RULES.board.slots; slot += 1) {
    putUnit(state, player, slot, { atk: 0, health: 9 });
  }
}

test("★ 战线站满 ⇒ 该方本回合部署 0 名，相位机不会卡死在 deploy", () => {
  const state = deployGame();
  expect(state.phase).toBe("deploy");
  fillBoard(state, 0);
  fillBoard(state, 1);

  // 排期照旧说要部署 2 名、泉里也确实有 3 名等着 —— 但**一格都没有**。
  expect(deployQuotaOf(state)).toBe(2);
  expect([deployCountFor(state, 0), deployCountFor(state, 1)]).toEqual([0, 0]);

  // ★ 这就是那个死锁：`checkDeploy` 要求名数**刚好**、每格还要为空。
  //   名数不看空格的话，空 picks 判 `invalid_choice`、任何格判 `slot_occupied`、
  //   `pass` / `play_card` 判 `wrong_phase` —— 只有认输能走出这个相位。
  const out = expectOk(apply(state, { t: "deploy", player: 0, picks: [[], []] }));
  expect(out.state.phase).toBe("actions");

  // 下一个 round_start 干脆不再进 deploy：`needsDeploy` 读的是同一个名数。
  const r2 = passThroughCombat(out.state).state;
  expect(r2.round).toBe(2);
  expect(deployQuotaOf(r2)).toBe(1); // 排期还有一名要上
  expect(needsDeploy(r2)).toBe(false); // 但没地方站
  expect(r2.phase).toBe("actions");
});

test("部署名数是 min(排期, 泉里可用, 空格数) 三者取小，不是「满 / 不满」两态", () => {
  const state = deployGame();
  fillBoard(state, 0, 1); // p0 只留 0 号格

  expect(deployCountFor(state, 0)).toBe(1); // min(2, 3, 1)
  expect(deployCountFor(state, 1)).toBe(2); // p1 战线全空 ⇒ 还是排期的 2 名

  const deployed = expectOk(
    apply(state, {
      t: "deploy",
      player: 0,
      picks: [
        [{ hero: P0_HERO, slot: 0 }],
        [
          { hero: P1_HERO, slot: 3 },
          { hero: P1_HERO + 1, slot: 4 },
        ],
      ],
    }),
  );
  expect(deployed.state.slots[0][0]).toBe(P0_HERO);
  expect(deployed.state.phase).toBe("actions");
});

// ═══════════════════════════════════════════════════════════════════════════
// 终局（v2 §4.1 的 `over`）
// ═══════════════════════════════════════════════════════════════════════════

test("★ 终局之后结算栈必须是空的（残留条目会跟着状态进快照/投影/回放）", () => {
  // 疲劳是"一次记账压多条动作"的现成来源：`drawForRound` 把双方的 `act.hit` 整批压栈，
  // 而第一条就打穿了 p0 的 base ⇒ `resolve()` 判出胜负当场停下，p1 那条留在栈上。
  const rules = rulesWith({
    baseHp: 1,
    deck: { size: 0, maxCopies: 2, startingHand: 0, drawPerRound: 1, fatigue: true },
  });
  const start = createGame(rules, [[], []], 0x51ee, { shuffle: false, firstPlayer: 0 });

  const opened = startMatch(start);

  expect(opened.state.winner).toBe(1); // 先手方 p0 先抽、先疲劳、先归零
  expect(opened.state.phase).toBe("over");
  // ★ 这里修复前是 1：一条属于**已经结束**的对局的 `act.hit` 跟着状态进快照 / 投影 /
  //   回放，之后任何一次 `resolve()` / `resume()` 都会把它弹出来执行一次。
  expect(opened.state.stack).toEqual([]);
  expect(opened.state.eventLog).toEqual([]);
});

test("认输同样收口到清栈（两个写 winner 的站点共用 advancePhases 这一处）", () => {
  // ⚠ 这一条对「清栈」**不承重**：走公共 API 时 `apply` 的每一段都跑到栈空才交出状态，
  //   所以认输那一刻栈本来就是空的 —— 把 `concludeMatch` 改成空实现它照样绿。
  //   它钉住的只是「认输这条支路也走到了同一个收口」（winner / phase 一起写对）。
  //   真正让清栈承重的是上面那条（base 打穿）与下面那条（人为脏栈）。
  const state = openedGame();
  const conceded = expectOk(apply(state, { t: "concede", player: 0 }));

  expect(conceded.state.winner).toBe(1);
  expect(conceded.state.phase).toBe("over");
  expect(conceded.state.stack).toEqual([]);
});

test("★ 认输时栈上还剩着东西 ⇒ 照样清空，且那条残留不许被执行", () => {
  // 人为把栈弄脏，站位「终局那一刻还没跑完的连锁」。
  // 与上面 base 打穿那条造出来的形态相同（那边靠疲劳把两条 `act.hit` 整批压栈、
  // 第一条就判出胜负），只是这边直接压 —— 对 `concludeMatch` 来说两者完全同形，
  // 而认输走的是另一条写 `winner` 的支路，正好补上它那一侧的防线。
  const state = openedGame();
  const unit = putUnit(state, 0, 0, { atk: 1, health: 9 });
  pushAct(state, { op: "act.draw", player: { op: "sel.controller" } }, createCtx(unit));
  expect(state.stack).toHaveLength(1);
  const deckBefore = getZone(state, 0, "deck").length;

  const conceded = expectOk(apply(state, { t: "concede", player: 0 }));

  expect(conceded.state.winner).toBe(1);
  expect(conceded.state.phase).toBe("over");
  // ★ 这就是 `concludeMatch` 那一行：残留条目不许跟着状态进快照 / 投影 / 回放，
  //   否则之后任何一次 `resolve()` / `resume()` 都会把它弹出来执行一次。
  expect(conceded.state.stack).toEqual([]);
  // ★ 而且它**没被执行**：终局之后不该再有后续时序（`resolve()` 的偏离 B ——
  //   `winner` 非空时循环在 pop 之前就 break）。少了那道判断，这里会多抽一张牌。
  expect(namesOf(conceded.events)).toEqual([]);
  expect(getZone(conceded.state, 0, "deck")).toHaveLength(deckBefore);
});

// ═══════════════════════════════════════════════════════════════════════════
// 附魔存续期（v2 §3.5：round_end / combat 结束时剥离）
// ═══════════════════════════════════════════════════════════════════════════

test("回合结束剥 end_of_round、战斗结束剥 end_of_combat，permanent 留着", () => {
  const state = playFirst(openedGame(), 0);
  const unit = getZone(state, 0, "board")[0];
  expect(unit).toBeDefined();
  if (unit === undefined) {
    return;
  }
  const entity = getEntity(state, unit);
  expect(entity).toBeDefined();
  if (entity === undefined) {
    return;
  }
  entity.enchantments = [
    { ench: "E_ROUND", source: unit, duration: "end_of_round" },
    { ench: "E_COMBAT", source: unit, duration: "end_of_combat" },
    { ench: "E_FOREVER", source: unit, duration: "permanent" },
    { ench: "E_ALIVE", source: unit, duration: "while_source_alive" },
  ];

  const next = passThroughCombat(state).state;
  const after = getEntity(next, unit);
  // 两个到期的都剥掉了；permanent 与 while_source_alive 留着
  // （后者的剥离时机是"source 死亡"，落在死亡结算而不是相位机）。
  expect(after?.enchantments.map((e) => e.ench)).toEqual(["E_FOREVER", "E_ALIVE"]);
});
