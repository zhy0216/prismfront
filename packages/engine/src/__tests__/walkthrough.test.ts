// M2 的**走查测试**：按里程碑第 5 项的原文顺序真的跑一遍。
//
// > 不碰 DSL：手写几个临时 handler，跑通"抽牌 → 放单位到格 → 手动 strike → 死亡"。
//
// 这条链是 M2「管线真的通了」的证据 —— 它同时经过：
//   建局与洗牌（rng/）→ intent 校验与 clone（rules/apply）→ 结算栈（resolve/push）
//   → 六步流水线（resolve/resolve）→ 临时 handler（handlers/）
//   → 死亡结算与 base 判负（resolve/deaths）→ 事件流排空（events/log）
// 中间任何一环断了，本文件就红。所以逐步断言**状态**与**事件流**两样，缺一不可：
// 只断言状态会漏掉"事件没发或发重了"，只断言事件会漏掉"状态没改对"。
//
// 注：本文件**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1：engine 对 ir
// 只能是纯类型依赖），规则参数用本文件的字面量夹具。

import { expect, test } from "bun:test";
import type { CardId, RulesConfig } from "@prismfront/ir";
import type { GameEvent } from "../events/index.ts";
import type { ApplyResult, Intent } from "../rules/index.ts";
import { apply, createGame, DEFAULT_RULES, runMatch } from "../rules/index.ts";
import type { EntityData, GameState, PlayerId } from "../state/index.ts";
import { baseOf, cloneState, currentHealth, getEntity, getZone, isOver } from "../state/index.ts";

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

const P0_DECK: readonly CardId[] = ["PF_A1", "PF_A2", "PF_A3"];
const P1_DECK: readonly CardId[] = ["PF_B1", "PF_B2", "PF_B3"];

/**
 * 给一张牌写上卡面数值。
 *
 * **M2 没有卡表**（那是 M4），`createGame` 造出来的牌库实体属性全是 0。
 * 而 0 血单位一上场就会在流水线第 ⑤ 步被判死（`state/entity.ts` 的血量记账：
 * 当前血量 = `tags.health - damage`），所以走查必须自己把卡面写进 `entity.base`。
 *
 * 写 `base` 而不是 `tags`：`tags` 是派生值，每一步都会被 `refreshAuras` 从 `base`
 * 重算覆盖（框架 §4.1 时序规则 4）。这里顺手把 `tags` 也对齐，免得在第一次重算
 * 之前读到旧值。
 */
function setFace(state: GameState, id: number, atk: number, health: number): EntityData {
  const card = getEntity(state, id);
  if (card === undefined) {
    throw new Error(`夹具错误：实体 ${id} 不存在`);
  }
  card.base.atk = atk;
  card.base.health = health;
  card.tags.atk = atk;
  card.tags.health = health;
  return card;
}

/** 取某方牌库顶那张牌的实体 id（洗牌后的顺序由状态说了算）。 */
function deckTop(state: GameState, player: PlayerId): number {
  const top = getZone(state, player, "deck")[0];
  if (top === undefined) {
    throw new Error(`夹具错误：p${player} 牌库是空的`);
  }
  return top;
}

/** 断言 `apply` 成功并取出结果；失败时把原因码带进报错信息。 */
function expectOk(result: ApplyResult): { state: GameState; events: GameEvent[] } {
  if (!result.ok) {
    throw new Error(`意图被拒：${result.code}`);
  }
  return { state: result.state, events: result.events };
}

/** 建一局：不洗牌（走查要牌序可预测），双方各摆好一张有数值的单位牌在牌库顶。 */
function walkthroughGame(): GameState {
  const state = createGame(RULES, [P0_DECK, P1_DECK], 0x9f1, { shuffle: false });
  setFace(state, deckTop(state, 0), 3, 2); // p0：3/2
  setFace(state, deckTop(state, 1), 2, 4); // p1：2/4 —— 挨得住一击，第二击才死
  return state;
}

// ═══════════════════════════════════════════════════════════════════════════
// 走查本体
// ═══════════════════════════════════════════════════════════════════════════

test("走查：抽牌 → 放单位到格 → 手动 strike → 死亡", () => {
  const start = walkthroughGame();
  const p0Card = deckTop(start, 0);
  const p1Card = deckTop(start, 1);
  const p0Base = start.players[0].baseId;
  const p1Base = start.players[1].baseId;

  // ── ① 抽牌 ───────────────────────────────────────────────────────────────
  const drawn = expectOk(apply(start, { t: "draw", player: 0 }));
  // 事件负载的 `player` 是**玩家实体**（= base 实体，见 handlers/read.ts），不是 0/1。
  expect(drawn.events).toEqual([
    { name: "card_drawn", player: p0Base, target: p0Card, cardId: "PF_A1" },
  ]);
  expect(getZone(drawn.state, 0, "hand")).toEqual([p0Card]);
  // 牌库顶被取走，剩下的两张原样保持顺序（zones 是有序列表，牌库顺序由它表达）。
  expect(getZone(drawn.state, 0, "deck")).toHaveLength(P0_DECK.length - 1);
  expect(getZone(drawn.state, 0, "deck")).not.toContain(p0Card);
  expect(getEntity(drawn.state, p0Card)?.zone).toBe("p0:hand");
  // apply 是纯函数：入参状态一字未动（框架 §3.2）。
  expect(getZone(start, 0, "hand")).toEqual([]);

  const drawn1 = expectOk(apply(drawn.state, { t: "draw", player: 1 }));
  expect(drawn1.events.map((e) => e.name)).toEqual(["card_drawn"]);
  expect(getZone(drawn1.state, 1, "hand")).toEqual([p1Card]);

  // ── ② 放单位到格 ─────────────────────────────────────────────────────────
  const played0 = expectOk(
    apply(drawn1.state, { t: "play_unit", player: 0, card: p0Card, slot: 4 }),
  );
  expect(played0.events).toEqual([
    {
      name: "unit_summoned",
      player: p0Base,
      source: null, // 牌自己上场，没有"召唤者"
      target: p0Card,
      cardId: "PF_A1",
      slot: 4,
    },
  ]);
  const unit0 = getEntity(played0.state, p0Card);
  expect(unit0?.zone).toBe("p0:board");
  expect(unit0?.slot).toBe(4);
  expect(played0.state.slots[0][4]).toBe(p0Card);
  expect(getZone(played0.state, 0, "hand")).toEqual([]);
  // 上场取号：手牌里是 0，站上战线才从 nextPlayOrder 取（触发排序规则 1 依赖它）。
  expect(unit0?.playOrder).toBeGreaterThan(0);
  // 3/2 的卡面在重算之后仍然是 3/2（规则 4：tags = base + 空 Σ）。
  expect(unit0?.tags).toEqual({ atk: 3, health: 2, cost: 0, direction: 0, armor: 0 });

  const played1 = expectOk(
    apply(played0.state, { t: "play_unit", player: 1, card: p1Card, slot: 4 }),
  );
  expect(played1.events).toEqual([
    {
      name: "unit_summoned",
      player: p1Base,
      source: null,
      target: p1Card,
      cardId: "PF_B1",
      slot: 4,
    },
  ]);
  // 双方同索引对齐（v2 §0 规则 1）：两个 4 号格互不冲突。
  expect(played1.state.slots[1][4]).toBe(p1Card);
  expect(played1.state.slots[0][4]).toBe(p0Card);
  const defender = getEntity(played1.state, p1Card);
  expect(defender).toBeDefined();
  expect(defender === undefined ? -1 : currentHealth(defender)).toBe(4);

  // ── ③ 手动 strike：3 点打在 4 血上，活下来 ───────────────────────────────
  const hit1 = expectOk(
    apply(played1.state, { t: "strike", player: 0, attacker: p0Card, target: p1Card }),
  );
  // strike 发 `struck` 之后把 `act.hit` 压栈（v2 §3.4：内部走 hit 管线），
  // 于是 `damaged` 落在下一次弹栈 —— 两条事件的先后即因果。
  expect(hit1.events).toEqual([
    { name: "struck", source: p0Card, target: p1Card, amount: 3 },
    { name: "damaged", source: p0Card, target: p1Card, amount: 3 },
  ]);
  const wounded = getEntity(hit1.state, p1Card);
  expect(wounded?.damage).toBe(3); // 伤害记在 damage
  expect(wounded?.tags.health).toBe(4); // 血量上限一点没动
  expect(wounded === undefined ? -1 : currentHealth(wounded)).toBe(1);
  expect(hit1.state.slots[1][4]).toBe(p1Card); // 还站着

  // ── ④ 再一击 → 死亡 ─────────────────────────────────────────────────────
  const hit2 = expectOk(
    apply(hit1.state, { t: "strike", player: 0, attacker: p0Card, target: p1Card }),
  );
  expect(hit2.events).toEqual([
    { name: "struck", source: p0Card, target: p1Card, amount: 3 },
    { name: "damaged", source: p0Card, target: p1Card, amount: 3 },
    // 死亡是流水线第 ⑤ 步的独立阶段，紧跟在造成它的那一步之后。
    { name: "unit_died", target: p1Card, slot: 4 },
  ]);
  expect(hit2.state.slots[1][4]).toBeNull();
  expect(getEntity(hit2.state, p1Card)?.zone).toBe("p1:graveyard");
  expect(getEntity(hit2.state, p1Card)?.slot).toBeNull();
  expect(getZone(hit2.state, 1, "board")).toEqual([]);
  // 攻击方毫发无伤（单向出手，反击是 M3 战斗阶段的事）。
  expect(getEntity(hit2.state, p0Card)?.damage).toBe(0);
});

test("走查（一击致死版）：strike 之后 struck → damaged → unit_died 一次跑完", () => {
  const start = walkthroughGame();
  const p0Card = deckTop(start, 0);
  const p1Card = deckTop(start, 1);
  // 把对面调成 2 血，让 3 点伤害当场致死。
  setFace(start, p1Card, 2, 2);

  const intents: readonly Intent[] = [
    { t: "draw", player: 0 },
    { t: "draw", player: 1 },
    { t: "play_unit", player: 0, card: p0Card, slot: 0 },
    { t: "play_unit", player: 1, card: p1Card, slot: 0 },
    { t: "strike", player: 0, attacker: p0Card, target: p1Card },
  ];

  let state = start;
  const events: GameEvent[] = [];
  for (const intent of intents) {
    const step = expectOk(apply(state, intent));
    state = step.state;
    for (const event of step.events) {
      events.push(event);
    }
  }

  // 完整的一条链，顺序即因果（框架 §3.3）。
  expect(events.map((e) => e.name)).toEqual([
    "card_drawn",
    "card_drawn",
    "unit_summoned",
    "unit_summoned",
    "struck",
    "damaged",
    "unit_died",
  ]);
  expect(events[6]).toEqual({ name: "unit_died", target: p1Card, slot: 0 });
  expect(state.slots[1][0]).toBeNull();
  expect(getZone(state, 1, "graveyard")).toEqual([p1Card]);
  expect(getEntity(state, p0Card)?.damage).toBe(0); // 单向出手，攻击方不挨打
  // 每次 apply 返回时事件日志必为空（events/log.ts 的不变量）。
  expect(state.eventLog).toEqual([]);
  // 纯数据探针（框架 §3.1 / §13 坑 3）：跑完一整条链，状态仍能逐字 JSON 往返。
  expect(JSON.stringify(cloneState(state))).toBe(JSON.stringify(state));
});

test("strike 打基地：伤害落在 base 实体上，归零即判负（v2 §4.3 + v2.1 §11.2）", () => {
  const start = walkthroughGame();
  const p0Card = deckTop(start, 0);
  const p1Base = start.players[1].baseId;

  let state = expectOk(apply(start, { t: "draw", player: 0 })).state;
  state = expectOk(apply(state, { t: "play_unit", player: 0, card: p0Card, slot: 8 })).state;
  // 3 点一击，把 base 削到只剩 3 血。
  const base = baseOf(state, 1);
  expect(base).toBeDefined();
  if (base === undefined) {
    return;
  }
  base.damage = RULES.baseHp - 3;

  const final = expectOk(
    apply(state, { t: "strike", player: 0, attacker: p0Card, target: p1Base }),
  );

  expect(final.events.map((e) => e.name)).toEqual(["struck", "damaged"]);
  expect(final.state.winner).toBe(0);
  expect(final.state.phase).toBe("over");
  expect(isOver(final.state)).toBe(true);
  // base 不进墓地、不发 unit_died（resolve/deaths.ts 的 settleBases）。
  expect(getEntity(final.state, p1Base)?.zone).toBe("p1:base");
  // 对局结束后任何意图都被拒。
  expect(apply(final.state, { t: "draw", player: 0 })).toEqual({ ok: false, code: "game_over" });
});

// ═══════════════════════════════════════════════════════════════════════════
// apply 的回执语义（框架 §3.2：非法意图，状态不变）
// ═══════════════════════════════════════════════════════════════════════════

test("非法意图一律 ok:false + 原因码，且入参状态一字未改", () => {
  const start = walkthroughGame();
  const p0Card = deckTop(start, 0);
  const before = JSON.stringify(start);

  const state = expectOk(apply(start, { t: "draw", player: 0 })).state;
  const onBoard = expectOk(
    apply(state, { t: "play_unit", player: 0, card: p0Card, slot: 2 }),
  ).state;

  const cases: readonly [Intent, string][] = [
    // 牌不在手里（已经上场了）
    [{ t: "play_unit", player: 0, card: p0Card, slot: 3 }, "wrong_zone"],
    // 实体不存在
    [{ t: "play_unit", player: 0, card: 9999, slot: 3 }, "unknown_entity"],
    // 格位越界 —— v2 §3.1 的无效槽
    [{ t: "strike", player: 0, attacker: p0Card, target: 9999 }, "unknown_entity"],
    // 指挥别人的单位
    [{ t: "strike", player: 1, attacker: p0Card, target: p0Card }, "not_controlled"],
    // 玩家位非法（不可信输入的兜底）
    [{ t: "draw", player: 7 as PlayerId }, "wrong_player"],
    // 没有挂起点却来回应
    [{ t: "respond", player: 0, chosen: 1 }, "not_suspended"],
  ];
  for (const [intent, code] of cases) {
    expect(apply(onBoard, intent)).toEqual({ ok: false, code });
  }

  // 同一格再放一张（先抽第二张牌）
  const second = expectOk(apply(onBoard, { t: "draw", player: 0 })).state;
  const secondCard = getZone(second, 0, "hand")[0];
  expect(secondCard).toBeDefined();
  if (secondCard !== undefined) {
    expect(apply(second, { t: "play_unit", player: 0, card: secondCard, slot: 2 })).toEqual({
      ok: false,
      code: "slot_occupied",
    });
    expect(apply(second, { t: "play_unit", player: 0, card: secondCard, slot: 99 })).toEqual({
      ok: false,
      code: "invalid_slot",
    });
  }

  // 全程没有任何一次 apply 改动过传进去的状态。
  expect(JSON.stringify(start)).toBe(before);
});

test("apply 成功即 seq +1（框架 §7.3：每条消息带 seq）", () => {
  const start = walkthroughGame();
  expect(start.seq).toBe(0);

  const ok = expectOk(apply(start, { t: "draw", player: 0 }));
  expect(ok.state.seq).toBe(1);
  expect(start.seq).toBe(0);

  // 被拒的意图不推进 seq —— 它不会产生一条要广播的消息。
  const rejected = apply(ok.state, { t: "play_unit", player: 0, card: 9999, slot: 0 });
  expect(rejected.ok).toBe(false);
  expect(ok.state.seq).toBe(1);
});

test("抽空牌库不报错也不发事件（疲劳是 M3，v2 §5：疲劳不发 card_drawn）", () => {
  const start = createGame(RULES, [["X"], []], 1, { shuffle: false });

  const first = expectOk(apply(start, { t: "draw", player: 0, count: 3 }));
  // 只有一张可抽 —— 事件数与真实发生的张数一致，不会补三条。
  expect(first.events).toHaveLength(1);
  expect(getZone(first.state, 0, "hand")).toHaveLength(1);

  const empty = expectOk(apply(first.state, { t: "draw", player: 0 }));
  expect(empty.events).toEqual([]);
  expect(empty.state.players[0].fatigue).toBe(0); // M2 不动疲劳计数
});

// ═══════════════════════════════════════════════════════════════════════════
// createGame / runMatch
// ═══════════════════════════════════════════════════════════════════════════

test("createGame：seed 入状态、洗牌只动牌序不动实体身份", () => {
  const a = createGame(RULES, [P0_DECK, P1_DECK], 0x9f1);
  const b = createGame(RULES, [P0_DECK, P1_DECK], 0x9f1);
  const c = createGame(RULES, [P0_DECK, P1_DECK], 0x9f2);
  const fixed = createGame(RULES, [P0_DECK, P1_DECK], 0x9f1, { shuffle: false });

  // 同种子 ⇒ 逐字相同（框架 §4.3）。
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  // 洗牌确实推进了 RNG，牌序与不洗牌不同（这副牌只有 3 张，够看出区别）。
  expect(a.rng).not.toEqual(fixed.rng);
  expect(fixed.rng).toEqual(createGame(RULES, [[], []], 0x9f1).rng);
  // 换种子 ⇒ 牌序变，但**实体表不变**（id 分配顺序是写死的，要进回放）。
  expect(Object.keys(c.entities)).toEqual(Object.keys(a.entities));
  expect([...getZone(a, 0, "deck")].sort()).toEqual([...getZone(c, 0, "deck")].sort());
  // 建局不发事件。
  expect(a.eventLog).toEqual([]);
  expect(a.phase).toBe("mulligan");
  expect(a.round).toBe(0);
});

test("runMatch：{seed, decks, intents} 三元组跑完一局，非法意图记进 rejected 不中断", () => {
  const decks: [readonly CardId[], readonly CardId[]] = [P0_DECK, P1_DECK];
  const intents: readonly Intent[] = [
    { t: "draw", player: 0 },
    { t: "play_unit", player: 0, card: 9999, slot: 0 }, // 非法：夹在中间
    { t: "draw", player: 1 },
  ];
  const options = {
    seed: 0x9f1,
    decks,
    intents,
    rules: RULES,
    game: { shuffle: false } as const,
    setup: (state: GameState) => {
      setFace(state, deckTop(state, 0), 3, 2);
    },
  };

  const run = runMatch(options);

  expect(run.rejected).toEqual([{ index: 1, code: "unknown_entity" }]);
  expect(run.events.map((e) => e.name)).toEqual(["card_drawn", "card_drawn"]);
  expect(run.state.seq).toBe(2); // 被拒的那条不计数
  expect(run.state.eventLog).toEqual([]);
  // 同输入两次 ⇒ 终局逐字相同（架构 §6.1 第一条的形状）。
  expect(JSON.stringify(runMatch(options).state)).toBe(JSON.stringify(run.state));
});

test("runMatch 的 rules 缺省用引擎自带的 DEFAULT_RULES", () => {
  const run = runMatch({ seed: 7, decks: [[], []], intents: [] });
  expect(run.state.rules).toEqual(DEFAULT_RULES);
  expect(run.state.slots[0]).toHaveLength(DEFAULT_RULES.board.slots);
});
