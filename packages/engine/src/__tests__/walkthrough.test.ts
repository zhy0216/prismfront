// 走查测试：一局对战从建局跑到第 2 回合，链路逐环断言。
//
// ═══════════════════════════════════════════════════════════════════════════
// M2 → M3：验的还是同一条链，驱动方式换成了相位机
// ═══════════════════════════════════════════════════════════════════════════
// M2 的走查是「抽牌 → 放单位到格 → 手动 strike → 死亡」，四步各由一条**临时 intent**
// 直接驱动。M3 把 intent 集换成了真的那一套（`rules/intent.ts` 的文件头列了去向）：
//   抽牌   → 不再是玩家动作，是 `round_start` 的一步（v2 §4.1）
//   上场   → `play_card`（多了扣水晶、查费用）
//   出手   → 不再有意图能直接触发；战斗阶段的快照（v2 §4.2）与卡牌效果才能出手
//   死亡   → 不变，流水线第 ⑤ 步
// **链路本身与断言强度一个都没减**：还是逐步同时断言**状态**与**事件流**
// （只断言状态会漏掉"事件没发或发重了"，只断言事件会漏掉"状态没改对"）。
//
// 「出手」这一步用 `testkit` 的 `strikeNow` 驱动 —— 它压的是与战斗快照**同一条**
// `act.strike → act.hit` 管线，只是绕开了"哪个相位允许出手"这层外壳。
// 这里刻意保留单向出手：战斗阶段是**双向同时**结算的（v2 §4.2，测试在
// `rules/__tests__/combat.test.ts`），而本文件要断言的性质之一正是
// 「单向出手时攻击方毫发无伤」—— 那件事只有绕开战斗才测得到。
//
// 这条链同时经过：
//   建局 / 掷先手 / 洗牌（rng/）→ 起手调度与相位推进（rules/phase）
//   → intent 校验与 clone（rules/apply）→ 结算栈（resolve/push）
//   → 六步流水线（resolve/resolve）→ 临时 handler（handlers/）
//   → 死亡结算与 base 判负（resolve/deaths）→ 事件流排空（events/log）
// 中间任何一环断了，本文件就红。
//
// 注：本文件**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1：engine 对 ir
// 只能是纯类型依赖），规则参数用本文件的字面量夹具。

import { expect, test } from "bun:test";
import type { CardId, RulesConfig } from "@prismfront/ir";
import type { GameEvent } from "../events/index.ts";
import type { Intent } from "../rules/index.ts";
import { apply, createGame, DEFAULT_RULES, runMatch } from "../rules/index.ts";
import type { GameState, PlayerId } from "../state/index.ts";
import { baseOf, cloneState, currentHealth, getEntity, getZone, isOver } from "../state/index.ts";
import {
  expectOk,
  handOf,
  passOnce,
  playCard,
  setDeckFaces,
  setFace,
  startMatch,
  strikeNow,
} from "../testkit/index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════════════════

const RULES: RulesConfig = {
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

/** 8 张：起手发 4 张之后牌库还剩 4 张，够跑几个回合而不撞上疲劳。 */
const DECK_SIZE = 8;

function makeDeck(prefix: string): readonly CardId[] {
  const cards: CardId[] = [];
  for (let i = 1; i <= DECK_SIZE; i += 1) {
    cards.push(`${prefix}${i}`);
  }
  return cards;
}

const P0_DECK = makeDeck("PF_A");
const P1_DECK = makeDeck("PF_B");

// 实体 id 的分配顺序是写死的（`state/create.ts`：p0 base → p1 base → p0 牌库 → p1 牌库），
// 且**与种子无关** —— 洗牌只动 `zones` 里的 id 顺序，不动实体身份。
const P0_BASE = 1;
const P1_BASE = 2;
/** 不洗牌时 p0 起手的第一张（牌库列表的第 1 张）。 */
const P0_CARD = 3;
/** 不洗牌时 p1 起手的第一张。 */
const P1_CARD = 11;

/**
 * 建一局并推进到第 1 回合的 `actions` 相位。
 *
 * - **不洗牌 + 钉先手 p0**：走查要盘面完全可预测，且这两项各自都消耗 RNG（见 `create-game.ts`）。
 * - 双方各摆一张有数值的单位牌：p0 是 3/2（2 费），p1 是 2/4（3 费，挨得住一击）。
 * - 其余的牌给 1/1、0 费，免得手里留一堆 0 血牌把死亡结算搅乱。
 */
function walkthroughGame(): GameState {
  const start = createGame(RULES, [P0_DECK, P1_DECK], 0x9f1, { shuffle: false, firstPlayer: 0 });
  for (const player of [0, 1] as const) {
    setDeckFaces(start, player, { atk: 1, health: 1, cost: 0 });
    for (const id of handOf(start, player)) {
      setFace(start, id, { atk: 1, health: 1, cost: 0 });
    }
  }
  setFace(start, P0_CARD, { atk: 3, health: 2, cost: 2 });
  setFace(start, P1_CARD, { atk: 2, health: 4, cost: 3 });
  return start;
}

function namesOf(events: readonly GameEvent[]): string[] {
  return events.map((event) => event.name);
}

// ═══════════════════════════════════════════════════════════════════════════
// 走查本体
// ═══════════════════════════════════════════════════════════════════════════

test("走查：起手 → 回合开始（水晶 + 抽牌）→ 打牌上场 → 出手 → 死亡", () => {
  const start = walkthroughGame();

  // ── ⓪ 建局：起手牌已经发好，停在 mulligan 相位 ─────────────────────────────
  expect(start.phase).toBe("mulligan");
  expect(start.round).toBe(0);
  expect(handOf(start, 0)).toEqual([3, 4, 5, 6]);
  expect(getZone(start, 0, "deck")).toEqual([7, 8, 9, 10]);
  expect(start.eventLog).toEqual([]); // 建局不发事件

  // ── ① 起手调度（双方都不换）→ 相位机一口气跑完第 1 回合的开始 ─────────────
  const opened = startMatch(start);
  expect(opened.events).toEqual([
    { name: "round_began", round: 1 },
    // 水晶回满：cap = min(5 + (1-1)*1, 10) = 5，两边都从 0 涨到 5。
    { name: "crystal_gained", player: P0_BASE, amount: 5 },
    { name: "crystal_gained", player: P1_BASE, amount: 5 },
    // 回合抽牌：drawPerRound = 1，牌库顶那张（p0 的 7 号 = PF_A5）。
    { name: "card_drawn", player: P0_BASE, target: 7, cardId: "PF_A5" },
    { name: "card_drawn", player: P1_BASE, target: 15, cardId: "PF_B5" },
  ]);
  const r1 = opened.state;
  expect(r1.phase).toBe("actions");
  expect(r1.round).toBe(1);
  expect(r1.initiative).toBe(0);
  expect(r1.priority).toBe(0); // 行动交替从先手方开始
  expect(r1.players[0].crystals).toBe(5);
  expect(r1.players[0].crystalCap).toBe(5);
  expect(handOf(r1, 0)).toHaveLength(5);
  // 起手调度**不发事件**（隐藏信息交换，见 rules/phase.ts）：上面 5 条里没有它的份。
  expect(start.phase).toBe("mulligan"); // apply 是纯函数，入参状态一字未动

  // ── ② 打牌上场：扣水晶 + card_played + unit_summoned ──────────────────────
  const played0 = playCard(r1, P0_CARD, 4);
  expect(played0.events).toEqual([
    { name: "action_taken", player: P0_BASE, kind: "play_card" },
    { name: "card_played", player: P0_BASE, target: P0_CARD, cardId: "PF_A1" },
    {
      name: "unit_summoned",
      player: P0_BASE,
      source: null, // 牌自己上场，没有"召唤者"
      target: P0_CARD,
      cardId: "PF_A1",
      slot: 4,
    },
  ]);
  const unit0 = getEntity(played0.state, P0_CARD);
  expect(unit0?.zone).toBe("p0:board");
  expect(unit0?.slot).toBe(4);
  expect(played0.state.slots[0][4]).toBe(P0_CARD);
  expect(handOf(played0.state, 0)).not.toContain(P0_CARD);
  // 上场取号：手牌里是 0，站上战线才从 nextPlayOrder 取（触发排序规则 1 依赖它）。
  expect(unit0?.playOrder).toBeGreaterThan(0);
  // 3/2 的卡面在重算之后仍然是 3/2（规则 4：tags = base + 空 Σ）。
  expect(unit0?.tags).toEqual({ atk: 3, health: 2, cost: 2, direction: 0, armor: 0 });
  // 水晶真的扣了；行动权交给对手；pass 计数清零。
  expect(played0.state.players[0].crystals).toBe(3);
  expect(played0.state.priority).toBe(1);
  expect(played0.state.consecutivePasses).toBe(0);

  const played1 = playCard(played0.state, P1_CARD, 4);
  expect(namesOf(played1.events)).toEqual(["action_taken", "card_played", "unit_summoned"]);
  // 双方同索引对齐（v2 §0 规则 1）：两个 4 号格互不冲突。
  expect(played1.state.slots[1][4]).toBe(P1_CARD);
  expect(played1.state.slots[0][4]).toBe(P0_CARD);
  expect(played1.state.players[1].crystals).toBe(2);
  const defender = getEntity(played1.state, P1_CARD);
  expect(defender === undefined ? -1 : currentHealth(defender)).toBe(4);

  // ── ③ 出手：3 点打在 4 血上，活下来 ──────────────────────────────────────
  // strike 发 `struck` 之后把 `act.hit` 压栈（v2 §3.4：内部走 hit 管线），
  // 于是 `damaged` 落在下一次弹栈 —— 两条事件的先后即因果。
  const hit1 = strikeNow(played1.state, P0_CARD, P1_CARD);
  expect(hit1.events).toEqual([
    { name: "struck", source: P0_CARD, target: P1_CARD, amount: 3 },
    { name: "damaged", source: P0_CARD, target: P1_CARD, amount: 3 },
  ]);
  const wounded = getEntity(hit1.state, P1_CARD);
  expect(wounded?.damage).toBe(3); // 伤害记在 damage
  expect(wounded?.tags.health).toBe(4); // 血量上限一点没动
  expect(wounded === undefined ? -1 : currentHealth(wounded)).toBe(1);
  expect(hit1.state.slots[1][4]).toBe(P1_CARD); // 还站着

  // ── ④ 再一击 → 死亡 ─────────────────────────────────────────────────────
  const hit2 = strikeNow(hit1.state, P0_CARD, P1_CARD);
  expect(hit2.events).toEqual([
    { name: "struck", source: P0_CARD, target: P1_CARD, amount: 3 },
    { name: "damaged", source: P0_CARD, target: P1_CARD, amount: 3 },
    // 死亡是流水线第 ⑤ 步的独立阶段，紧跟在造成它的那一步之后。
    { name: "unit_died", target: P1_CARD, slot: 4 },
  ]);
  expect(hit2.state.slots[1][4]).toBeNull();
  expect(getEntity(hit2.state, P1_CARD)?.zone).toBe("p1:graveyard");
  expect(getEntity(hit2.state, P1_CARD)?.slot).toBeNull();
  expect(getZone(hit2.state, 1, "board")).toEqual([]);
  // 攻击方毫发无伤（单向出手；对打是战斗阶段同时结算的事）。
  expect(getEntity(hit2.state, P0_CARD)?.damage).toBe(0);
});

test("走查（一击致死版）：整条链的事件顺序即因果", () => {
  const start = walkthroughGame();
  // 把对面调成 2 血，让 3 点伤害当场致死。
  setFace(start, P1_CARD, { atk: 2, health: 2, cost: 3 });

  const opened = startMatch(start);
  const a = playCard(opened.state, P0_CARD, 0);
  const b = playCard(a.state, P1_CARD, 0);
  const strike = strikeNow(b.state, P0_CARD, P1_CARD);

  const events: GameEvent[] = [...opened.events, ...a.events, ...b.events, ...strike.events];
  expect(namesOf(events)).toEqual([
    "round_began",
    "crystal_gained",
    "crystal_gained",
    "card_drawn",
    "card_drawn",
    "action_taken",
    "card_played",
    "unit_summoned",
    "action_taken",
    "card_played",
    "unit_summoned",
    "struck",
    "damaged",
    "unit_died",
  ]);
  const state = strike.state;
  expect(events[13]).toEqual({ name: "unit_died", target: P1_CARD, slot: 0 });
  expect(state.slots[1][0]).toBeNull();
  expect(getZone(state, 1, "graveyard")).toEqual([P1_CARD]);
  expect(getEntity(state, P0_CARD)?.damage).toBe(0); // 单向出手，攻击方不挨打
  // 每次 apply 返回时事件日志必为空（events/log.ts 的不变量）。
  expect(state.eventLog).toEqual([]);
  // 纯数据探针（框架 §3.1 / §13 坑 3）：跑完一整条链，状态仍能逐字 JSON 往返。
  expect(JSON.stringify(cloneState(state))).toBe(JSON.stringify(state));
});

test("出手打基地：伤害落在 base 实体上，归零即判负（v2 §4.3 + v2.1 §11.2）", () => {
  const start = walkthroughGame();
  const opened = startMatch(start);
  const played = playCard(opened.state, P0_CARD, 8);

  // 3 点一击，把 base 削到只剩 3 血。
  const state = played.state;
  const base = baseOf(state, 1);
  expect(base).toBeDefined();
  if (base === undefined) {
    return;
  }
  base.damage = RULES.baseHp - 3;

  const final = strikeNow(state, P0_CARD, P1_BASE);

  expect(namesOf(final.events)).toEqual(["struck", "damaged"]);
  expect(final.state.winner).toBe(0);
  expect(final.state.phase).toBe("over");
  expect(isOver(final.state)).toBe(true);
  // base 不进墓地、不发 unit_died（resolve/deaths.ts 的 settleBases）。
  expect(getEntity(final.state, P1_BASE)?.zone).toBe("p1:base");
  // 对局结束后任何意图都被拒。
  expect(apply(final.state, { t: "pass", player: 1 })).toEqual({ ok: false, code: "game_over" });
});

// ═══════════════════════════════════════════════════════════════════════════
// apply 的回执语义（框架 §3.2：非法意图，状态不变）
// ═══════════════════════════════════════════════════════════════════════════

test("非法意图一律 ok:false + 原因码，且入参状态一字未改", () => {
  const start = walkthroughGame();
  const before = JSON.stringify(start);

  // mulligan 相位只收 mulligan；别的意图一律 wrong_phase。
  expect(apply(start, { t: "pass", player: 0 })).toEqual({ ok: false, code: "wrong_phase" });
  expect(apply(start, { t: "play_card", player: 0, card: P0_CARD, slot: 0 })).toEqual({
    ok: false,
    code: "wrong_phase",
  });
  // 换一张不在手里的牌。
  expect(apply(start, { t: "mulligan", player: 0, toss: [[7], []] })).toEqual({
    ok: false,
    code: "wrong_zone",
  });
  // 同一张牌换两次 —— 放过去会让那一方凭空多一张牌。
  expect(apply(start, { t: "mulligan", player: 0, toss: [[3, 3], []] })).toEqual({
    ok: false,
    code: "invalid_choice",
  });
  expect(JSON.stringify(start)).toBe(before);

  const r1 = startMatch(start).state;
  const onBoard = playCard(r1, P0_CARD, 2).state;
  const snapshot = JSON.stringify(onBoard);

  const cases: readonly [Intent, string][] = [
    // 牌不在手里（已经上场了）
    [{ t: "play_card", player: 1, card: P0_CARD, slot: 3 }, "wrong_zone"],
    // 实体不存在
    [{ t: "play_card", player: 1, card: 9999, slot: 3 }, "unknown_entity"],
    // 不是他的行动权（p0 刚打完，priority 已经在 p1 手里）
    [{ t: "play_card", player: 0, card: 4, slot: 3 }, "wrong_player"],
    [{ t: "pass", player: 0 }, "wrong_player"],
    // 相位不对：actions 相位不收起手调度 / 部署
    [{ t: "mulligan", player: 1, toss: [[], []] }, "wrong_phase"],
    [{ t: "deploy", player: 1, picks: [[], []] }, "wrong_phase"],
    // 玩家位非法（不可信输入的兜底）
    [{ t: "pass", player: 7 as PlayerId }, "wrong_player"],
    // 没有挂起点却来回应
    [{ t: "respond", player: 1, chosen: 1 }, "not_suspended"],
    // 格位越界 / 已被占 —— v2 §3.1 的无效槽
    [{ t: "play_card", player: 1, card: P1_CARD, slot: 99 }, "invalid_slot"],
  ];
  for (const [intent, code] of cases) {
    expect([code, apply(onBoard, intent)]).toEqual([code, { ok: false, code }]);
  }

  // 同一格再放一张（p1 的 4 号格是空的，但 p1 自己的 2 号格放了之后就不能再放）
  const p1First = playCard(onBoard, P1_CARD, 2).state;
  const p0Second = handOf(p1First, 0)[0];
  expect(p0Second).toBeDefined();
  if (p0Second !== undefined) {
    expect(apply(p1First, { t: "play_card", player: 0, card: p0Second, slot: 2 })).toEqual({
      ok: false,
      code: "slot_occupied",
    });
  }

  // 水晶不够 —— 一张 99 费的牌打不出来（费用取生效值 tags.cost）。
  const pricey = handOf(p1First, 0)[1];
  expect(pricey).toBeDefined();
  if (pricey !== undefined) {
    const withPricey = cloneState(p1First);
    setFace(withPricey, pricey, { cost: 99 });
    expect(apply(withPricey, { t: "play_card", player: 0, card: pricey, slot: 5 })).toEqual({
      ok: false,
      code: "not_enough_crystals",
    });
  }

  // 全程没有任何一次 apply 改动过传进去的状态。
  expect(JSON.stringify(onBoard)).toBe(snapshot);
});

test("apply 成功即 seq +1（框架 §7.3：每条消息带 seq）", () => {
  const start = walkthroughGame();
  expect(start.seq).toBe(0);

  const opened = startMatch(start);
  expect(opened.state.seq).toBe(1);
  expect(start.seq).toBe(0);

  // 被拒的意图不推进 seq —— 它不会产生一条要广播的消息。
  const rejected = apply(opened.state, { t: "play_card", player: 0, card: 9999, slot: 0 });
  expect(rejected.ok).toBe(false);
  expect(opened.state.seq).toBe(1);

  // 一次 pass 可能带出一整段事件，但仍然只是**一条消息**。
  const p0Pass = passOnce(opened.state);
  const p1Pass = passOnce(p0Pass.state);
  expect(p1Pass.state.seq).toBe(3);
  expect(namesOf(p1Pass.events)).toEqual([
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
});

test("牌库抽空 → 疲劳：不发 card_drawn，按累计值伤害自己的 base（v2 §6 deck.fatigue）", () => {
  // 牌库只有 1 张：起手就被发光，第 1 回合的抽牌立刻空抽。
  const start = createGame(RULES, [["X"], ["Y"]], 1, { shuffle: false, firstPlayer: 0 });
  const opened = startMatch(start);

  // 抽不到牌 ⇒ 没有 card_drawn（v2 §5 明确规定疲劳不发它），只有伤害。
  expect(namesOf(opened.events)).toEqual([
    "round_began",
    "crystal_gained",
    "crystal_gained",
    "damaged",
    "damaged",
  ]);
  expect(opened.events[3]).toEqual({
    name: "damaged",
    source: null, // 规则伤害没有施动实体
    target: P0_BASE,
    amount: 1,
  });
  expect(opened.state.players[0].fatigue).toBe(1);
  expect(getEntity(opened.state, P0_BASE)?.damage).toBe(1);

  // 第 2 回合疲劳累计到 2。
  const r2 = passOnce(passOnce(opened.state).state).state;
  expect(r2.round).toBe(2);
  expect(r2.players[0].fatigue).toBe(2);
  expect(getEntity(r2, P0_BASE)?.damage).toBe(3); // 1 + 2
});

// ═══════════════════════════════════════════════════════════════════════════
// createGame / runMatch
// ═══════════════════════════════════════════════════════════════════════════

test("createGame：seed 入状态、洗牌只动牌序不动实体身份、起手牌已发好", () => {
  const a = createGame(RULES, [P0_DECK, P1_DECK], 0x9f1);
  const b = createGame(RULES, [P0_DECK, P1_DECK], 0x9f1);
  const c = createGame(RULES, [P0_DECK, P1_DECK], 0x9f2);
  const fixed = createGame(RULES, [P0_DECK, P1_DECK], 0x9f1, { shuffle: false, firstPlayer: 0 });

  // 同种子 ⇒ 逐字相同（框架 §4.3）。
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  // 洗牌 + 掷先手确实推进了 RNG；两项都关掉才是"一次 RNG 都不消耗"。
  expect(a.rng).not.toEqual(fixed.rng);
  expect(fixed.rng).toEqual({ ...createGame(RULES, [[], []], 0x9f1, { firstPlayer: 1 }).rng });
  // 换种子 ⇒ 牌序变，但**实体表不变**（id 分配顺序是写死的，要进回放）。
  expect(Object.keys(c.entities)).toEqual(Object.keys(a.entities));
  expect([...getZone(a, 0, "deck"), ...handOf(a, 0)].sort()).toEqual(
    [...getZone(c, 0, "deck"), ...handOf(c, 0)].sort(),
  );
  // 建局不发事件，起手牌已经发好，停在 mulligan。
  expect(a.eventLog).toEqual([]);
  expect(a.phase).toBe("mulligan");
  expect(a.round).toBe(0);
  expect(handOf(a, 0)).toHaveLength(RULES.deck.startingHand);
  expect(getZone(a, 0, "deck")).toHaveLength(DECK_SIZE - RULES.deck.startingHand);
});

test("runMatch：{seed, decks, intents} 三元组跑完一局，非法意图记进 rejected 不中断", () => {
  const decks: [readonly CardId[], readonly CardId[]] = [P0_DECK, P1_DECK];
  const intents: readonly Intent[] = [
    { t: "mulligan", player: 0, toss: [[], []] },
    { t: "play_card", player: 0, card: P0_CARD, slot: 0 },
    { t: "play_card", player: 0, card: 9999, slot: 1 }, // 非法：夹在中间（也不是他的行动权）
    { t: "pass", player: 1 },
    { t: "pass", player: 0 },
  ];
  const options = {
    seed: 0x9f1,
    decks,
    intents,
    rules: RULES,
    game: { shuffle: false, firstPlayer: 0 } as const,
    setup: (state: GameState) => {
      setFace(state, P0_CARD, { atk: 3, health: 2, cost: 2 });
    },
  };

  const run = runMatch(options);

  expect(run.rejected).toEqual([{ index: 2, code: "wrong_player" }]);
  expect(namesOf(run.events)).toEqual([
    "round_began",
    "crystal_gained",
    "crystal_gained",
    "card_drawn",
    "card_drawn",
    "action_taken",
    "card_played",
    "unit_summoned",
    "player_passed",
    "player_passed",
    "combat_began",
    // 战斗快照（v2 §4.2）：p0 的 3/2 站在 0 号格、方向 0 ⇒ 对位的 p1 0 号格是空的
    // ⇒ 打进 p1 的基地。一击两条事件（struck 之后 act.hit 才落地）。
    "struck",
    "damaged",
    "combat_ended",
    "round_ended",
    "round_began",
    "crystal_gained",
    "crystal_gained",
    "card_drawn",
    "card_drawn",
  ]);
  expect(getEntity(run.state, P1_BASE)?.damage).toBe(3);
  expect(run.state.round).toBe(2);
  expect(run.state.seq).toBe(4); // 被拒的那条不计数
  expect(run.state.eventLog).toEqual([]);
  // 同输入两次 ⇒ 终局逐字相同（架构 §6.1 第一条的形状）。
  expect(JSON.stringify(runMatch(options).state)).toBe(JSON.stringify(run.state));
});

test("runMatch 的 rules 缺省用引擎自带的 DEFAULT_RULES", () => {
  const run = runMatch({ seed: 7, decks: [[], []], intents: [] });
  expect(run.state.rules).toEqual(DEFAULT_RULES);
  expect(run.state.slots[0]).toHaveLength(DEFAULT_RULES.board.slots);
});

test("expectOk 的失败路径带上原因码（夹具自检）", () => {
  const start = walkthroughGame();
  expect(() => expectOk(apply(start, { t: "pass", player: 0 }))).toThrow("wrong_phase");
});
