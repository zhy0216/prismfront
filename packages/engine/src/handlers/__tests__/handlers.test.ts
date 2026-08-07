// handlers/ 的单元测试。
//
// 走查测试（`src/__tests__/walkthrough.test.ts`）验的是"整条链通不通"，
// 这里验的是**每个 handler 在做不成事时的退化行为** —— 也就是 IR v1 §5.2 的
// 空集合语义与 v2 §3.1 的无效槽语义：**静默跳过，不报错、不产生事件**。
//
// 这些分支在走查里天然走不到（走查全是成功路径），而它们恰恰是 M4 接真求值器时
// 最容易被无意改掉的地方：一旦哪个 handler 改成"读不出目标就抛错"，
// 整个引擎对残局、悬空 id、无效槽的容忍度就没了。
//
// 注：本文件**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1）。

import { expect, test } from "bun:test";
import type { Act, RulesConfig, Sel } from "@prismfront/ir";
import type { HandlerTable } from "../../resolve/index.ts";
import { pushAct, resolve } from "../../resolve/index.ts";
import { createRngState } from "../../rng/index.ts";
import type { CtxBindings, EntityData, GameState, PlayerId } from "../../state/index.ts";
import {
  createCtx,
  createInitialState,
  createTagValues,
  getEntity,
  getZone,
  NO_FLAGS,
  zoneKey,
} from "../../state/index.ts";
import { M2_DEPS, M2_HANDLERS, moveToZone, placeOnSlot, playerEntity, readNum } from "../index.ts";

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

function freshState(deck0: readonly string[] = [], deck1: readonly string[] = []): GameState {
  return createInitialState({
    rules: RULES,
    rng: createRngState(0x9f1),
    decks: [deck0, deck1],
    bundleId: "pf1@test",
  });
}

/** 直接造一个实体丢进某个区（不经 handler，测试要盘面就自己摆）。 */
function addEntity(
  state: GameState,
  player: PlayerId,
  zone: "hand" | "board",
  atk = 1,
): EntityData {
  const id = state.nextEntityId;
  state.nextEntityId += 1;
  const key = zoneKey(player, zone);
  const entity: EntityData = {
    id,
    cardId: `TEST_${id}`,
    owner: player,
    zone: key,
    slot: null,
    playOrder: 0,
    base: createTagValues({ atk, health: 5 }),
    tags: createTagValues({ atk, health: 5 }),
    baseFlags: NO_FLAGS,
    flags: NO_FLAGS,
    enchantments: [],
    damage: 0,
    respawnAt: null,
  };
  state.entities[id] = entity;
  state.zones[key].push(id);
  return entity;
}

/** 跑一条动作并返回事件流。 */
function run(state: GameState, act: Act, ctx: CtxBindings) {
  pushAct(state, act, ctx);
  return resolve(state, M2_DEPS);
}

const SELF: Sel = { op: "sel.self" };

// ═══════════════════════════════════════════════════════════════════════════
// read.ts —— 临时读取器
// ═══════════════════════════════════════════════════════════════════════════

test("readNum 只认字面量；num.* 节点回退到各字段的规范默认值", () => {
  expect(readNum(7, 1)).toBe(7);
  expect(readNum(undefined, 1)).toBe(1);
  expect(readNum({ op: "num.count", of: SELF }, 1)).toBe(1);
});

test("playerEntity = 该方的 base 实体（事件负载里的 player 用它，不是 0/1）", () => {
  const state = freshState();
  expect(playerEntity(state, 0)).toBe(state.players[0].baseId);
  expect(playerEntity(state, 1)).toBe(state.players[1].baseId);
  // 实体 id 从 1 起，所以绝不能拿 PlayerId 冒充实体 id。
  expect(playerEntity(state, 0)).toBeGreaterThan(0);
});

test("上下文叶子：sel.chosen（实体）与 sel.it 都能读出目标", () => {
  const state = freshState();
  const victim = addEntity(state, 1, "board");
  const chosenCtx: CtxBindings = {
    self: 0,
    target: null,
    chosen: victim.id,
    it: null,
    event: null,
  };
  run(state, { op: "act.hit", target: { op: "sel.chosen" }, amount: 2 }, chosenCtx);
  expect(getEntity(state, victim.id)?.damage).toBe(2);

  const itCtx: CtxBindings = { self: 0, target: null, chosen: null, it: victim.id, event: null };
  run(state, { op: "act.hit", target: { op: "sel.it" }, amount: 1 }, itCtx);
  expect(getEntity(state, victim.id)?.damage).toBe(3);
});

test("sel.chosen 拿到的是卡 id（从 Pool 发现）时读不出实体 —— 静默跳过", () => {
  const state = freshState();
  const ctx: CtxBindings = { self: 0, target: null, chosen: "GRID_001", it: null, event: null };
  const events = run(state, { op: "act.hit", target: { op: "sel.chosen" }, amount: 9 }, ctx);
  expect(events).toEqual([]);
});

test("M2 读不懂的选择器一律当空集：动作静默跳过，不抛错也不发事件", () => {
  const state = freshState();
  addEntity(state, 1, "board");
  const events = run(
    state,
    // 区域选择器要等 M4 的求值器；M2 读出来是空集。
    { op: "act.hit", target: { op: "sel.zone", side: "enemy", zone: "board" }, amount: 99 },
    createCtx(0),
  );
  expect(events).toEqual([]);
});

test("readPlayer：sel.controller / sel.opponent 认 SELF 的**控制者**（偷来的单位算控制者）", () => {
  const state = freshState(["A"], ["B"]);
  // owner = p0 却站在 p1 的手牌里 —— act.steal 之后的形态。
  const stolen = addEntity(state, 1, "hand");
  stolen.owner = 0;

  run(state, { op: "act.draw", player: { op: "sel.controller" } }, createCtx(stolen.id));
  expect(getZone(state, 1, "hand")).toHaveLength(2); // 抽给了控制者 p1
  expect(getZone(state, 0, "hand")).toHaveLength(0);

  run(state, { op: "act.draw", player: { op: "sel.opponent" } }, createCtx(stolen.id));
  expect(getZone(state, 0, "hand")).toHaveLength(1);
});

test("readPlayer：SELF 不存在时读不出玩家 —— act.draw 静默跳过", () => {
  const state = freshState(["A"]);
  const events = run(state, { op: "act.draw", player: { op: "sel.controller" } }, createCtx(9999));
  expect(events).toEqual([]);
  expect(getZone(state, 0, "deck")).toHaveLength(1);
});

// ═══════════════════════════════════════════════════════════════════════════
// board.ts —— 位置写入原语
// ═══════════════════════════════════════════════════════════════════════════

test("placeOnSlot：无效槽与已占格都返回 false，且**什么都不改**", () => {
  const state = freshState();
  const a = addEntity(state, 0, "hand");
  const b = addEntity(state, 0, "hand");

  expect(placeOnSlot(state, a, 0, 9)).toBe(false); // 越界（board.slots = 9 ⇒ 合法下标 0..8）
  expect(placeOnSlot(state, a, 0, -1)).toBe(false);
  expect(placeOnSlot(state, a, 0, 1.5)).toBe(false); // 非整数
  expect(a.zone).toBe("p0:hand");
  expect(a.slot).toBeNull();

  expect(placeOnSlot(state, a, 0, 3)).toBe(true);
  expect(placeOnSlot(state, b, 0, 3)).toBe(false); // 该格已被占
  expect(b.zone).toBe("p0:hand");
  expect(state.slots[0][3]).toBe(a.id);
});

test("离开战线时腾空原格位（不变量 2：slots[p][i] ⇔ entity.slot）", () => {
  const state = freshState();
  const unit = addEntity(state, 0, "hand");

  expect(placeOnSlot(state, unit, 0, 5)).toBe(true);
  const order = unit.playOrder;
  expect(order).toBeGreaterThan(0); // 上场取号（触发排序规则 1 依赖它）

  moveToZone(state, unit, 0, "graveyard");
  expect(state.slots[0][5]).toBeNull();
  expect(unit.slot).toBeNull();
  expect(unit.zone).toBe("p0:graveyard");
  expect(getZone(state, 0, "board")).toEqual([]);
  expect(getZone(state, 0, "graveyard")).toEqual([unit.id]);
  expect(unit.playOrder).toBe(order); // 离场不清 playOrder（亡语还要按它排队）
});

test("换格：placeOnSlot 会先腾空旧格再占新格", () => {
  const state = freshState();
  const unit = addEntity(state, 0, "hand");
  placeOnSlot(state, unit, 0, 2);

  expect(placeOnSlot(state, unit, 0, 6)).toBe(true);
  expect(state.slots[0][2]).toBeNull();
  expect(state.slots[0][6]).toBe(unit.id);
  expect(getZone(state, 0, "board")).toEqual([unit.id]); // 区域列表里不会留下两份
});

// ═══════════════════════════════════════════════════════════════════════════
// draw.ts / move.ts / damage.ts
// ═══════════════════════════════════════════════════════════════════════════

test("act.draw：牌库顶是悬空 id 时停下，不抛错", () => {
  const state = freshState(["A", "B"]);
  const top = getZone(state, 0, "deck")[0];
  expect(top).toBeDefined();
  if (top === undefined) {
    return;
  }
  delete state.entities[top]; // 人为制造悬空 id

  const events = run(
    state,
    { op: "act.draw", player: { op: "sel.entity", id: top } },
    createCtx(0),
  );
  expect(events).toEqual([]);
  expect(getZone(state, 0, "hand")).toEqual([]);
});

test("act.move 到非 board 区：只挪位置，不发事件（事件映射留给 M4）", () => {
  const state = freshState();
  const card = addEntity(state, 0, "hand");
  const events = run(
    state,
    { op: "act.move", target: SELF, zone: "graveyard" },
    createCtx(card.id),
  );

  expect(events).toEqual([]);
  expect(card.zone).toBe("p0:graveyard");
});

test("act.move 的 side:'opposite' 按 **owner** 翻面（被偷走的牌回不到偷牌人手上）", () => {
  const state = freshState();
  const card = addEntity(state, 0, "hand");
  run(
    state,
    { op: "act.move", target: SELF, zone: "board", side: "opposite", pos: 1 },
    createCtx(card.id),
  );
  expect(state.slots[1][1]).toBe(card.id);
  expect(card.zone).toBe("p1:board");
  expect(card.owner).toBe(0); // 归属没变
});

test("act.move 到被占的格 / 无效槽：静默跳过，不发 unit_summoned", () => {
  const state = freshState();
  const sitting = addEntity(state, 0, "hand");
  placeOnSlot(state, sitting, 0, 0);
  const card = addEntity(state, 0, "hand");

  const occupied = run(
    state,
    { op: "act.move", target: SELF, zone: "board", pos: 0 },
    createCtx(card.id),
  );
  expect(occupied).toEqual([]);
  expect(card.zone).toBe("p0:hand");

  const invalid = run(
    state,
    { op: "act.move", target: SELF, zone: "board", pos: 99 },
    createCtx(card.id),
  );
  expect(invalid).toEqual([]);
  // `pos` 缺省（非字面量同理）同样解析成无效槽 —— 不会悄悄落到 0 号格。
  const noPos = run(state, { op: "act.move", target: SELF, zone: "board" }, createCtx(card.id));
  expect(noPos).toEqual([]);
  expect(card.zone).toBe("p0:hand");
});

test("unit_summoned.source：别人召唤的记召唤者，自己上场记 null", () => {
  const state = freshState();
  const summoner = addEntity(state, 0, "board");
  placeOnSlot(state, summoner, 0, 8);
  const token = addEntity(state, 0, "hand");

  const byOther = run(
    state,
    { op: "act.move", target: { op: "sel.entity", id: token.id }, zone: "board", pos: 0 },
    createCtx(summoner.id),
  );
  expect(byOther[0]).toEqual({
    name: "unit_summoned",
    player: playerEntity(state, 0),
    source: summoner.id,
    target: token.id,
    cardId: token.cardId,
    slot: 0,
  });
});

test("act.hit：0 / 负数伤害什么都不做（不发 damaged，免得触发器凭空触发）", () => {
  const state = freshState();
  const victim = addEntity(state, 1, "board");
  const ctx: CtxBindings = { self: 0, target: victim.id, chosen: null, it: null, event: null };

  expect(run(state, { op: "act.hit", target: { op: "sel.target" }, amount: 0 }, ctx)).toEqual([]);
  expect(run(state, { op: "act.hit", target: { op: "sel.target" }, amount: -3 }, ctx)).toEqual([]);
  // amount 是 num.* 节点（M4 才求值）⇒ 回退到 0 ⇒ 同样什么都不做。
  expect(
    run(
      state,
      { op: "act.hit", target: { op: "sel.target" }, amount: { op: "num.count", of: SELF } },
      ctx,
    ),
  ).toEqual([]);
  expect(victim.damage).toBe(0);
});

test("act.hit：SELF 不是实体时 source 记 null（无施动实体的伤害）", () => {
  const state = freshState();
  const victim = addEntity(state, 1, "board");
  const ctx: CtxBindings = { self: 0, target: victim.id, chosen: null, it: null, event: null };

  const events = run(state, { op: "act.hit", target: { op: "sel.target" }, amount: 2 }, ctx);
  expect(events).toEqual([{ name: "damaged", source: null, target: victim.id, amount: 2 }]);
});

test("act.strike：attacker 或 target 读不出来 → 静默跳过，一条 hit 都不压栈", () => {
  const state = freshState();
  const attacker = addEntity(state, 0, "board", 4);
  placeOnSlot(state, attacker, 0, 0);

  const noTarget = run(
    state,
    { op: "act.strike", attacker: SELF, target: { op: "sel.target" } },
    createCtx(attacker.id),
  );
  expect(noTarget).toEqual([]);
  expect(state.stack).toEqual([]);
});

test("act.strike：atk 为 0 照常发 struck，但不产生伤害（不出手是战斗快照的条件，M3）", () => {
  const state = freshState();
  const attacker = addEntity(state, 0, "board", 0);
  const victim = addEntity(state, 1, "board");
  const ctx: CtxBindings = {
    self: attacker.id,
    target: victim.id,
    chosen: null,
    it: null,
    event: null,
  };

  const events = run(
    state,
    { op: "act.strike", attacker: SELF, target: { op: "sel.target" } },
    ctx,
  );
  expect(events).toEqual([{ name: "struck", source: attacker.id, target: victim.id, amount: 0 }]);
  expect(victim.damage).toBe(0);
});

test("act.strike 冻结出手数值：压栈之后 attacker 掉 atk 也不改变这一击", () => {
  const state = freshState();
  const attacker = addEntity(state, 0, "board", 5);
  const victim = addEntity(state, 1, "board");
  const ctx: CtxBindings = {
    self: attacker.id,
    target: victim.id,
    chosen: null,
    it: null,
    event: null,
  };
  // 在 strike 与它压入的 hit 之间插一条动作，把 attacker 的 atk 抹成 0。
  const handlers: HandlerTable = {
    ...M2_HANDLERS,
    "act.nothing": () => {
      attacker.base.atk = 0;
      attacker.tags.atk = 0;
    },
  };
  pushAct(state, { op: "act.nothing" }, ctx);
  pushAct(state, { op: "act.strike", attacker: SELF, target: { op: "sel.target" } }, ctx);

  const events = resolve(state, { handlers });

  expect(events.map((e) => e.name)).toEqual(["struck", "damaged"]);
  expect(victim.damage).toBe(5); // 用的是快照时刻的 5，不是被抹成的 0
});

test("act.nothing 已注册但没有副作用；未注册的 op 同样静默跳过", () => {
  const state = freshState();
  expect(run(state, { op: "act.nothing" }, createCtx(0))).toEqual([]);
  // act.silence 在 M2 没有 handler。
  expect(run(state, { op: "act.silence", target: SELF }, createCtx(0))).toEqual([]);
});
