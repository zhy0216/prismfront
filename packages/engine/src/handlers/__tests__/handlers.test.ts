// handlers/ 的单元测试 —— M4 任务书 E4「handler 表穷尽化」。
//
// 三类被钉的性质：
//   1. **表是完整的**：30 个 op 一个不少（类型已经保证），且「还没实现哪些」
//      是一条显式清单（`NOT_IMPLEMENTED_OPS`）而不是类型上的洞。
//   2. **每个 handler 在做不成事时的退化行为** —— IR v1 §5.2 的空集合语义与
//      v2 §3.1 的无效槽语义：**静默跳过，不报错、不产生事件**。
//      这些分支在走查里天然走不到（走查全是成功路径），而它们恰恰是最容易被
//      无意改掉的地方：一旦哪个 handler 改成"读不出目标就抛错"，
//      整个引擎对残局、悬空 id、无效槽的容忍度就没了。
//   3. **接上真求值器之后的新能力**：区域选择器、多目标、卡表驱动的 `act.summon`。
//
// 求值时机三条铁规（IR v1 §5.3）在**另一个文件**里：`eval-timing.test.ts`。
// 那三条是本里程碑的风险登记条目，单独成篇免得混在常规断言里被顺手删掉。
//
// 注：本文件**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1）。
// 盘面一律走 `testkit`（`openGame` / `putUnit` / `runActs`），不写状态字面量。

import { expect, test } from "bun:test";
import type {
  Act,
  ActNode,
  CardData,
  CardId,
  EnchantId,
  Enchantment,
  Sel,
  SlotRef,
} from "@prismfront/ir";
import type { CardLookup, EnchantLookup } from "../../eval/index.ts";
import type { ResolveDeps } from "../../resolve/index.ts";
import type { GameState, PlayerId } from "../../state/index.ts";
import { getEntity, getZone } from "../../state/index.ts";
import type { Step } from "../../testkit/index.ts";
import {
  baseIdOf,
  damageOf,
  deckTop,
  eventNames,
  handOf,
  openGame,
  putUnit,
  runActs,
} from "../../testkit/index.ts";
import { ACT_HANDLERS, DEFAULT_DEPS, NOT_IMPLEMENTED_OPS, spawnOnSlot } from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════════════════

const SELF: Sel = { op: "sel.self" };
const IT: Sel = { op: "sel.it" };
const CONTROLLER: Sel = { op: "sel.controller" };
const OPPONENT: Sel = { op: "sel.opponent" };
const ENEMY_BOARD: Sel = { op: "sel.zone", side: "enemy", zone: "board" };
const FRIENDLY_BOARD: Sel = { op: "sel.zone", side: "friendly", zone: "board" };
const entity = (id: number): Sel => ({ op: "sel.entity", id });
const firstEmpty = (side: "friendly" | "enemy"): SlotRef => ({ op: "slot.first_empty", side });

/** 一张 1/2 的随从卡；卡表只认得它。 */
const TOKEN: CardId = "PF1_TOKEN";
const TEST_CARDS: CardLookup = (cardId: CardId): CardData | undefined =>
  cardId === TOKEN
    ? { name: { zh: "微光侍从" }, kind: "minion", colors: ["green"], tags: { atk: 1, health: 2 } }
    : undefined;

/** 一条永久 +2 攻的附魔；附魔表只认得它。 */
const ENCH: EnchantId = "PF1_TOKEN_e";
const TEST_ENCHANTS: EnchantLookup = (ench: EnchantId): Enchantment | undefined =>
  ench === ENCH
    ? { id: ENCH, attachesTo: "minion", mods: { atk: 2 }, duration: "permanent" }
    : undefined;

/** 接上 bundle 的完整接线（`act.summon` / `act.buff` 需要它）。 */
const BUNDLE_DEPS: ResolveDeps = {
  handlers: ACT_HANDLERS,
  cards: TEST_CARDS,
  enchantments: TEST_ENCHANTS,
};

/** 开局 + 在 p0 的 0 号格摆一个 2/9 当 SELF。 */
function opened(): { state: GameState; self: number } {
  const state = openGame();
  return { state, self: putUnit(state, 0, 0, { atk: 2, health: 9 }) };
}

/** 在 `player` 的这几格各摆一个 1/1，返回 id 列表。 */
function line(state: GameState, player: PlayerId, slots: readonly number[]): number[] {
  return slots.map((slot) => putUnit(state, player, slot, { atk: 1, health: 1 }));
}

/** `player` 的第 `slot` 格上站着的实体（空格 / 无效槽都给 `undefined`）。 */
function unitAt(state: GameState, player: PlayerId, slot: number) {
  const id = state.slots[player][slot];
  return typeof id === "number" ? getEntity(state, id) : undefined;
}

/** 某个实体现在在哪个区。 */
function zoneOfId(state: GameState, id: number): string {
  return getEntity(state, id)?.zone ?? "(不存在)";
}

/** 跑一条动作（SELF = `self`），返回 `{state, events}`。 */
function run(state: GameState, act: Act, self: number, deps: ResolveDeps = DEFAULT_DEPS): Step {
  return runActs(state, [act], self, deps);
}

// ═══════════════════════════════════════════════════════════════════════════
// ★ 1. 表的完整性与「还没实现」的显式清单
// ═══════════════════════════════════════════════════════════════════════════

test("★ handler 表是 Record<ActOp, …>：30 个 op 一个不少", () => {
  // 「漏一个」在类型层面已经是编译错误（`HandlerTable` 是非可选键的映射类型）。
  // 这里钉的是运行期形态：每个键都真的取得到一个函数，没有 undefined 混进来。
  const ops = Object.keys(ACT_HANDLERS);
  expect(ops).toHaveLength(30);
  for (const op of ops) {
    expect(typeof (ACT_HANDLERS as Record<string, unknown>)[op]).toBe("function");
  }
});

test("★ 尚未实现的 op 是一条显式清单（实现掉一个却忘了摘占位 ⇒ 这里红）", () => {
  // M4 只要求「先支持 8–10 个最常用 op」。剩下的挂 `notImplemented` 占位，
  // 于是「这个里程碑做了哪些」是机器可查的，而不是靠读 diff 猜。
  expect([...NOT_IMPLEMENTED_OPS].sort()).toEqual([
    "act.discard",
    "act.discover",
    "act.gain_armor",
    "act.gain_crystal",
    "act.gain_crystal_cap",
    "act.give",
    "act.move_to",
    "act.set_health",
    "act.shift",
    "act.shuffle",
    "act.silence",
    "act.steal",
    "act.transform",
  ]);
  expect(NOT_IMPLEMENTED_OPS).toHaveLength(13);
});

test("占位 handler = 静默跳过：不抛错、不发事件、盘面一字未动", () => {
  const { state, self } = opened();
  const step = run(state, { op: "act.silence", target: SELF }, self);

  expect(step.events).toEqual([]);
  expect(damageOf(step.state, self)).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. damage.ts —— hit / heal / strike / destroy
// ═══════════════════════════════════════════════════════════════════════════

test("act.hit 打整个敌方战线：一次动作、逐个发 damaged（顺序 = 格序 0→8）", () => {
  const { state, self } = opened();
  const foes = line(state, 1, [0, 2, 5]);

  const step = run(state, { op: "act.hit", target: ENEMY_BOARD, amount: 1 }, self);

  expect(eventNames(step.events)).toEqual([
    "damaged",
    "damaged",
    "damaged",
    ...foes.map(() => "unit_died"),
  ]);
  for (const foe of foes) {
    expect(zoneOfId(step.state, foe)).toBe("p1:graveyard");
  }
});

test("act.hit：目标为空 / 伤害 <= 0 都静默跳过（不发 damaged，免得触发器凭空触发）", () => {
  const { state, self } = opened();

  // 敌方战线是空的 ⇒ 目标空集 ⇒ 整个动作跳过。
  expect(run(state, { op: "act.hit", target: ENEMY_BOARD, amount: 9 }, self).events).toEqual([]);
  // 目标非空但伤害为 0 / 负数。
  expect(run(state, { op: "act.hit", target: SELF, amount: 0 }, self).events).toEqual([]);
  expect(run(state, { op: "act.hit", target: SELF, amount: -3 }, self).events).toEqual([]);
});

test("act.hit：SELF 不是实体时 source 记 null（无施动实体的伤害）", () => {
  const { state, self } = opened();
  const step = run(state, { op: "act.hit", target: entity(self), amount: 2 }, 9999);

  expect(step.events).toEqual([{ name: "damaged", source: null, target: self, amount: 2 }]);
});

test("act.heal：减 damage 不越过 0，amount 是**实际**回复量；满血目标不发事件", () => {
  const { state, self } = opened();
  const wounded = run(state, { op: "act.hit", target: entity(self), amount: 5 }, 0).state;

  const partial = run(wounded, { op: "act.heal", target: entity(self), amount: 2 }, self);
  expect(partial.events).toEqual([{ name: "healed", source: self, target: self, amount: 2 }]);
  expect(damageOf(partial.state, self)).toBe(3);

  // 回 99 点只回得动剩下的 3 点（溢出不计）。
  const full = run(partial.state, { op: "act.heal", target: entity(self), amount: 99 }, self);
  expect(full.events).toEqual([{ name: "healed", source: self, target: self, amount: 3 }]);
  expect(damageOf(full.state, self)).toBe(0);

  // 已经满血 ⇒ 实际回复量 0 ⇒ 一条事件都不发。
  expect(run(full.state, { op: "act.heal", target: entity(self), amount: 4 }, self).events).toEqual(
    [],
  );
  // 目标为空 / amount <= 0 同样跳过。
  expect(run(full.state, { op: "act.heal", target: ENEMY_BOARD, amount: 4 }, self).events).toEqual(
    [],
  );
  expect(run(full.state, { op: "act.heal", target: SELF, amount: 0 }, self).events).toEqual([]);
});

test("act.strike：先发 struck，伤害压栈走 act.hit 管线（拦得住 hit 就拦得住 strike）", () => {
  const { state, self } = opened();
  const [foe] = line(state, 1, [0]);
  expect(foe).toBeDefined();

  const step = run(state, { op: "act.strike", attacker: SELF, target: ENEMY_BOARD }, self);

  expect(eventNames(step.events)).toEqual(["struck", "damaged", "unit_died"]);
});

test("act.strike：attacker / target 非单实体 ⇒ 静默跳过，一条 hit 都不压栈", () => {
  const { state, self } = opened();
  line(state, 1, [0, 1]); // 敌方两个 ⇒ target 是二元集合

  expect(
    run(state, { op: "act.strike", attacker: SELF, target: ENEMY_BOARD }, self).events,
  ).toEqual([]);
  // attacker 读不出来（SELF 悬空）同理。
  expect(
    run(state, { op: "act.strike", attacker: SELF, target: entity(self) }, 9999).events,
  ).toEqual([]);
});

test("act.destroy：把伤害顶到致死线，判死与 unit_died 由流水线第 ⑤ 步统一做", () => {
  const { state, self } = opened();
  const foes = line(state, 1, [0, 1]);

  const step = run(state, { op: "act.destroy", target: ENEMY_BOARD }, self);

  // **不发 damaged**（消灭不是伤害），只有死亡结算发出来的 unit_died。
  expect(eventNames(step.events)).toEqual(["unit_died", "unit_died"]);
  for (const foe of foes) {
    expect(zoneOfId(step.state, foe)).toBe("p1:graveyard");
  }
});

test("act.destroy：目标为空什么都不做；重伤目标不会被「治疗」回致死线以下", () => {
  const { state, self } = opened();
  expect(run(state, { op: "act.destroy", target: ENEMY_BOARD }, self).events).toEqual([]);

  // SELF 是 2/9，先挨 20 点（damage 20 > health 9），destroy 不该把 damage 降回 9。
  const overkilled = runActs(
    state,
    [
      { op: "act.hit", target: entity(self), amount: 20 },
      { op: "act.destroy", target: entity(self) },
    ],
    self,
  );
  expect(getEntity(overkilled.state, self)?.damage).toBe(20);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. draw.ts
// ═══════════════════════════════════════════════════════════════════════════

test("act.draw：player 是 Sel，取它的**控制者**；count 缺省 1", () => {
  const { state, self } = opened();
  const before = handOf(state, 0).length;

  const one = run(state, { op: "act.draw", player: CONTROLLER }, self);
  expect(handOf(one.state, 0)).toHaveLength(before + 1);

  const three = run(state, { op: "act.draw", player: CONTROLLER, count: 3 }, self);
  expect(handOf(three.state, 0)).toHaveLength(before + 3);
  expect(eventNames(three.events)).toEqual(["card_drawn", "card_drawn", "card_drawn"]);

  // sel.opponent ⇒ 抽给对手。
  const enemy = run(state, { op: "act.draw", player: OPPONENT }, self);
  expect(handOf(enemy.state, 1)).toHaveLength(handOf(state, 1).length + 1);
});

test("act.draw：一个 Sel 选中双方 ⇒ 各抽各的；同一方被选两次只算一次", () => {
  const { state, self } = opened();
  const both: Sel = { op: "sel.zone", side: "both", zone: "base" };
  const twice: Sel = { op: "sel.or", of: [CONTROLLER, CONTROLLER] };

  const step = run(state, { op: "act.draw", player: both }, self);
  expect(handOf(step.state, 0)).toHaveLength(handOf(state, 0).length + 1);
  expect(handOf(step.state, 1)).toHaveLength(handOf(state, 1).length + 1);

  const once = run(state, { op: "act.draw", player: twice }, self);
  expect(handOf(once.state, 0)).toHaveLength(handOf(state, 0).length + 1);
});

test("act.draw：player 求值为空 ⇒ 整个动作跳过；牌库抽空就停（不发空事件）", () => {
  const { state, self } = opened();
  expect(run(state, { op: "act.draw", player: ENEMY_BOARD }, self).events).toEqual([]);

  // 牌库里剩多少就抽多少，抽完停下。
  const deck = getZone(state, 0, "deck").length;
  const step = run(state, { op: "act.draw", player: CONTROLLER, count: deck + 5 }, self);
  expect(eventNames(step.events)).toHaveLength(deck);
  expect(getZone(step.state, 0, "deck")).toHaveLength(0);
});

test("act.draw：牌库顶是悬空 id 时停下，不抛错", () => {
  const { state, self } = opened();
  const top = deckTop(state, 0);
  delete state.entities[top]; // 人为制造悬空 id

  const step = run(state, { op: "act.draw", player: CONTROLLER }, self);
  expect(step.events).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. move.ts —— act.move / act.swap
// ═══════════════════════════════════════════════════════════════════════════

test("act.move 到 board：放成功发 unit_summoned；被占 / 无效槽 / 缺 pos 都静默跳过", () => {
  const { state, self } = opened();
  const card = handOf(state, 0)[0];
  expect(card).toBeDefined();
  if (card === undefined) {
    return;
  }

  const ok = run(state, { op: "act.move", target: entity(card), zone: "board", pos: 3 }, self);
  expect(eventNames(ok.events)).toEqual(["unit_summoned"]);
  expect(ok.state.slots[0][3]).toBe(card);

  const occupied = run(
    state,
    { op: "act.move", target: entity(card), zone: "board", pos: 0 },
    self,
  );
  expect(occupied.events).toEqual([]);
  const invalid = run(
    state,
    { op: "act.move", target: entity(card), zone: "board", pos: 99 },
    self,
  );
  expect(invalid.events).toEqual([]);
  // 缺 pos ⇒ 无效槽，**不会**悄悄落到 0 号格。
  const noPos = run(state, { op: "act.move", target: entity(card), zone: "board" }, self);
  expect(noPos.events).toEqual([]);
  expect(zoneOfId(noPos.state, card)).toBe("p0:hand");
});

test("act.move 到非 board 区：只挪位置、不发事件；side:'opposite' 按 **owner** 翻面", () => {
  const { state, self } = opened();
  const card = handOf(state, 0)[0];
  expect(card).toBeDefined();
  if (card === undefined) {
    return;
  }

  const buried = run(state, { op: "act.move", target: entity(card), zone: "graveyard" }, self);
  expect(buried.events).toEqual([]);
  expect(zoneOfId(buried.state, card)).toBe("p0:graveyard");

  const flipped = run(
    state,
    { op: "act.move", target: entity(card), zone: "board", side: "opposite", pos: 1 },
    self,
  );
  expect(flipped.state.slots[1][1]).toBe(card);
  expect(getEntity(flipped.state, card)?.owner).toBe(0); // 归属没变
});

test("act.move：目标为空静默跳过；多目标时只有第一个落得下（其余撞'格子被占'）", () => {
  const { state, self } = opened();
  expect(
    run(state, { op: "act.move", target: ENEMY_BOARD, zone: "graveyard" }, self).events,
  ).toEqual([]);

  const hand: Sel = { op: "sel.zone", side: "friendly", zone: "hand" };
  const step = run(state, { op: "act.move", target: hand, zone: "board", pos: 4 }, self);
  expect(eventNames(step.events)).toEqual(["unit_summoned"]);
});

test("act.swap：交换两格、发两条 unit_moved，**不重取 playOrder**", () => {
  const { state, self } = opened();
  const [other] = line(state, 0, [4]);
  expect(other).toBeDefined();
  if (other === undefined) {
    return;
  }
  const orders = [getEntity(state, self)?.playOrder, getEntity(state, other)?.playOrder];

  const step = run(state, { op: "act.swap", a: entity(self), b: entity(other) }, self);

  expect(step.state.slots[0][0]).toBe(other);
  expect(step.state.slots[0][4]).toBe(self);
  expect(step.events).toEqual([
    { name: "unit_moved", target: self, fromSlot: 0, toSlot: 4 },
    { name: "unit_moved", target: other, fromSlot: 4, toSlot: 0 },
  ]);
  expect([getEntity(step.state, self)?.playOrder, getEntity(step.state, other)?.playOrder]).toEqual(
    orders,
  );
});

test("act.swap 跨阵营：连**区域**一起换（控制者就是 zone 的玩家位）", () => {
  const { state, self } = opened();
  const [foe] = line(state, 1, [3]);
  expect(foe).toBeDefined();
  if (foe === undefined) {
    return;
  }

  const step = run(state, { op: "act.swap", a: entity(self), b: entity(foe) }, self);

  expect(zoneOfId(step.state, self)).toBe("p1:board");
  expect(zoneOfId(step.state, foe)).toBe("p0:board");
  expect(step.state.slots[1][3]).toBe(self);
  expect(step.state.slots[0][0]).toBe(foe);
});

test("act.swap：非单实体 / 不在场 / 同一个实体 ⇒ 静默跳过", () => {
  const { state, self } = opened();
  line(state, 1, [0, 1]);
  const card = handOf(state, 0)[0];
  expect(card).toBeDefined();
  if (card === undefined) {
    return;
  }

  expect(run(state, { op: "act.swap", a: entity(self), b: ENEMY_BOARD }, self).events).toEqual([]);
  // 手牌里的实体不在场 ⇒ 换不成。
  expect(run(state, { op: "act.swap", a: entity(self), b: entity(card) }, self).events).toEqual([]);
  // 自己跟自己换。
  expect(run(state, { op: "act.swap", a: SELF, b: entity(self) }, self).events).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. summon.ts —— 唯一需要卡表的 handler
// ═══════════════════════════════════════════════════════════════════════════

const summon = (count?: number): ActNode<"act.summon"> => ({
  op: "act.summon",
  player: CONTROLLER,
  card: TOKEN,
  at: firstEmpty("friendly"),
  ...(count === undefined ? {} : { count }),
});

test("act.summon：按卡面新建实体、落到 at、发 unit_summoned", () => {
  const { state, self } = opened();

  const step = run(state, summon(), self, BUNDLE_DEPS);

  expect(eventNames(step.events)).toEqual(["unit_summoned"]);
  const unit = unitAt(step.state, 0, 1);
  expect(unit?.cardId).toBe(TOKEN);
  expect(unit?.base.atk).toBe(1);
  expect(unit?.base.health).toBe(2);
  expect(unit?.tags.health).toBe(2); // 不会因为 0 血当场暴毙
  expect(unit?.playOrder).toBeGreaterThan(0); // 上场取号（触发排序规则 1 依赖它）
});

test("★ act.summon 的 count > 1：**每个后续单位重新求值 at**（v2 §3.4）", () => {
  const { state, self } = opened();

  const step = run(state, summon(3), self, BUNDLE_DEPS);

  // 第 1 个用 handler 从解析器拉到的那一份（1 号格），第 2、3 个各自重求 ⇒ 2、3 号格。
  // 若 `at` 只求一次，后两个会撞上"格子被占"而一个都召不出来。
  expect(eventNames(step.events)).toEqual(["unit_summoned", "unit_summoned", "unit_summoned"]);
  expect(step.state.slots[0].slice(0, 4).every((cell) => cell !== null)).toBe(true);
});

test("act.summon：卡表查不到 / CardRef 求值为空 / player 为空 ⇒ 一个单位都不建", () => {
  const { state, self } = opened();
  const before = state.nextEntityId;

  // 缺省接线没有卡表（NO_CARDS）⇒ 造不出实体（0/0 会当场暴毙，那是地雷不是退化）。
  const noTable = run(state, summon(), self);
  expect(noTable.events).toEqual([]);
  expect(noTable.state.nextEntityId).toBe(before);

  // 卡表在，但这张卡不在表里。
  const unknown = run(state, { ...summon(), card: "NOT_IN_BUNDLE" }, self, BUNDLE_DEPS);
  expect(unknown.events).toEqual([]);

  // `card.of(空集)` ⇒ CardRef 求值为空 ⇒ 整个动作跳过（IR v1 §5.2 末行）。
  const empty = run(
    state,
    { ...summon(), card: { op: "card.of", of: ENEMY_BOARD } },
    self,
    BUNDLE_DEPS,
  );
  expect(empty.events).toEqual([]);

  // player 求值为空。
  const noPlayer = run(state, { ...summon(), player: ENEMY_BOARD }, self, BUNDLE_DEPS);
  expect(noPlayer.events).toEqual([]);
});

test("act.summon：card.of 复制一个在场单位的身份", () => {
  const { state, self } = opened();
  const copied = run(
    state,
    { ...summon(), card: { op: "card.of", of: FRIENDLY_BOARD } },
    self,
    // SELF 的 cardId 是 testkit 造的 "A…"，卡表里没有 ⇒ 用一张认得的卡来复制。
    { ...BUNDLE_DEPS, cards: () => TEST_CARDS(TOKEN) },
  );
  expect(unitAt(copied.state, 0, 1)?.cardId).toBe(getEntity(state, self)?.cardId);
});

test("spawnOnSlot：格子无效 / 被占时**一个实体都不建**（不吃 nextEntityId）", () => {
  const { state } = opened();
  const before = state.nextEntityId;

  expect(spawnOnSlot(state, TOKEN, 0, 99, {})).toBeNull();
  expect(spawnOnSlot(state, TOKEN, 0, 0, {})).toBeNull(); // 0 号格是 SELF
  expect(state.nextEntityId).toBe(before);

  expect(spawnOnSlot(state, TOKEN, 0, 1, { atk: 3 })?.base.atk).toBe(3);
  expect(state.nextEntityId).toBe(before + 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. tags.ts —— set_tag / mod_tag / buff
// ═══════════════════════════════════════════════════════════════════════════

test("act.set_tag / act.mod_tag 写 base（扛得住第 ⑥ 步重算），并发 buffed", () => {
  const { state, self } = opened();

  const set = run(state, { op: "act.set_tag", target: SELF, tag: "atk", value: 7 }, self);
  expect(set.events).toEqual([{ name: "buffed", source: self, target: self, ench: null }]);
  // 写的是 base，所以 `refreshAuras` 之后 tags 仍是 7（写 tags 会被抹掉）。
  expect(getEntity(set.state, self)?.base.atk).toBe(7);
  expect(getEntity(set.state, self)?.tags.atk).toBe(7);

  const mod = run(set.state, { op: "act.mod_tag", target: SELF, tag: "atk", delta: -2 }, self);
  expect(getEntity(mod.state, self)?.tags.atk).toBe(5);
});

test("act.set_tag：值没变不发事件；目标为空整个动作跳过", () => {
  const { state, self } = opened();
  // SELF 的 atk 本来就是 2。
  expect(
    run(state, { op: "act.set_tag", target: SELF, tag: "atk", value: 2 }, self).events,
  ).toEqual([]);
  expect(
    run(state, { op: "act.mod_tag", target: SELF, tag: "atk", delta: 0 }, self).events,
  ).toEqual([]);
  expect(
    run(state, { op: "act.set_tag", target: ENEMY_BOARD, tag: "atk", value: 9 }, self).events,
  ).toEqual([]);
  expect(
    run(state, { op: "act.mod_tag", target: ENEMY_BOARD, tag: "atk", delta: 9 }, self).events,
  ).toEqual([]);
});

test("★ 改 direction 发 direction_changed 而不是 buffed（v2 §2.3：它是普通 Tag）", () => {
  const { state, self } = opened();

  const step = run(state, { op: "act.mod_tag", target: SELF, tag: "direction", delta: -1 }, self);

  expect(step.events).toEqual([{ name: "direction_changed", target: self, from: 0, to: -1 }]);
  expect(getEntity(step.state, self)?.tags.direction).toBe(-1);
});

test("act.buff：挂附魔实例（ench / source / duration），加成本身留给第 ⑥ 步", () => {
  const { state, self } = opened();

  const step = run(state, { op: "act.buff", target: SELF, ench: ENCH }, self, BUNDLE_DEPS);

  expect(step.events).toEqual([{ name: "buffed", source: self, target: self, ench: ENCH }]);
  expect(getEntity(step.state, self)?.enchantments).toEqual([
    { ench: ENCH, source: self, duration: "permanent" },
  ]);
  // ★ 本 handler 一个数值都没写：`base.atk` 仍是卡面值 2，而**生效值** `tags.atk`
  //   是第 ⑥ 步 `refreshAuras` 从 `base + Σ附魔` 算出来的（M5/T3 起 Σ 是真的）。
  //   两条一起断言才说明加成走的是重算而不是 handler 里的增量。
  expect(getEntity(step.state, self)?.base.atk).toBe(2);
  expect(getEntity(step.state, self)?.tags.atk).toBe(4);
});

test("act.buff：附魔表查不到 / 目标为空 ⇒ 静默跳过（不挂一条不知何时剥的附魔）", () => {
  const { state, self } = opened();

  expect(run(state, { op: "act.buff", target: SELF, ench: ENCH }, self).events).toEqual([]);
  expect(getEntity(state, self)?.enchantments).toEqual([]);
  expect(
    run(state, { op: "act.buff", target: ENEMY_BOARD, ench: ENCH }, self, BUNDLE_DEPS).events,
  ).toEqual([]);
});

test("act.set_flag：写 baseFlags（扛得住第 ⑥ 步重算），且一个事件都不发（M5/T2）", () => {
  const { state, self } = opened();

  const set = run(
    state,
    { op: "act.set_flag", target: SELF, flag: "divine_shield", value: true },
    self,
  );

  // ★ 写 `baseFlags` 而不是只写派生的 `flags`：只写 `flags` 的实现，
  //   本步末尾的 `refreshAuras` 就会把它从 `baseFlags` 重算掉 ⇒ 这两行同时读到 0/false。
  expect(getEntity(set.state, self)?.baseFlags).not.toBe(0);
  expect(getEntity(set.state, self)?.flags).not.toBe(0);
  // v2 §5 没有"标志位变化"这个事件名，借 `buffed` 会让触发器为一次不存在的加成而触发。
  expect(set.events).toEqual([]);

  // 清回去（圣盾的 `then` 走的就是这条路径）。
  const clear = run(
    set.state,
    { op: "act.set_flag", target: SELF, flag: "divine_shield", value: false },
    self,
  );
  expect(getEntity(clear.state, self)?.baseFlags).toBe(0);
  expect(getEntity(clear.state, self)?.flags).toBe(0);
});

test("act.set_flag：目标为空 ⇒ 整个动作跳过；值没变 ⇒ 不写", () => {
  const { state, self } = opened();

  // 空集合语义（IR v1 §5.2）：战线上没有敌人 ⇒ 什么都不做。
  expect(
    run(state, { op: "act.set_flag", target: ENEMY_BOARD, flag: "stunned", value: true }, self)
      .events,
  ).toEqual([]);
  // 本来就是 false，再置一次 false ⇒ 盘面一字未动（`baseFlags` 仍是 0）。
  const noop = run(
    state,
    { op: "act.set_flag", target: SELF, flag: "stunned", value: false },
    self,
  );
  expect(getEntity(noop.state, self)?.baseFlags).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. control.ts —— when / repeat / for_each / nothing
// ═══════════════════════════════════════════════════════════════════════════

test("act.when：只把命中的那一支压栈；else 省略且条件为假 ⇒ 什么都不做", () => {
  const { state, self } = opened();
  const foes = line(state, 1, [0]);
  const hasFoe: Act = {
    op: "act.when",
    cond: { op: "cond.exists", of: ENEMY_BOARD },
    then: [{ op: "act.hit", target: ENEMY_BOARD, amount: 1 }],
    else: [{ op: "act.hit", target: SELF, amount: 1 }],
  };

  const hit = run(state, hasFoe, self);
  expect(eventNames(hit.events)).toEqual(["damaged", "unit_died"]);
  expect(damageOf(hit.state, self)).toBe(0);
  expect(foes[0]).toBeDefined();

  // 敌方战线清空之后走 else。
  const elseBranch = run(hit.state, hasFoe, self);
  expect(damageOf(elseBranch.state, self)).toBe(1);

  // 没有 else 的假分支。
  const noElse = run(
    hit.state,
    { op: "act.when", cond: { op: "cond.exists", of: ENEMY_BOARD }, then: [{ op: "act.nothing" }] },
    self,
  );
  expect(noElse.events).toEqual([]);
});

test("act.for_each：把 sel.it 绑到每个成员，**按格序**逐个执行", () => {
  const { state, self } = opened();
  const foes = line(state, 1, [1, 0, 5]); // 摆的顺序与格序不同

  const step = run(
    state,
    { op: "act.for_each", of: ENEMY_BOARD, do: [{ op: "act.hit", target: IT, amount: 1 }] },
    self,
  );

  // `sel.zone` 的 board 按格序 0→8 枚举（v2 §3.2），于是事件顺序是 0 号格那个先挨打。
  const damaged = step.events.filter((event) => event.name === "damaged");
  expect(damaged).toHaveLength(3);
  expect(damaged.map((event) => (event as { target: number }).target)).toEqual([
    foes[1],
    foes[0],
    foes[2],
  ]);
});

test("act.repeat：n 只求值一次；n <= 0 一份都不压", () => {
  const { state, self } = opened();

  const three = run(
    state,
    { op: "act.repeat", n: 3, do: [{ op: "act.hit", target: SELF, amount: 1 }] },
    self,
  );
  expect(damageOf(three.state, self)).toBe(3);

  const none = run(
    state,
    { op: "act.repeat", n: 0, do: [{ op: "act.hit", target: SELF, amount: 1 }] },
    self,
  );
  expect(none.events).toEqual([]);
});

test("act.repeat：算出来的巨大 n 被截到结算深度上限 ⇒ 抛 ResolutionLoopError 而不是挂死", () => {
  // 编写期的 `n <= 64` 只管字面量；`num.mul` 算出来的 n 没有上限。
  // 截一刀之后行为与"真压 90000 份"完全一致（第 257 次弹栈必抛），只是不会先挂死。
  const { state, self } = opened();
  const huge: Act = {
    op: "act.repeat",
    n: { op: "num.mul", of: [300, 300] },
    do: [{ op: "act.nothing" }],
  };

  expect(() => run(state, huge, self)).toThrow(/结算步数超过上限/);
});

test("act.nothing 是真实现，不是占位（它不在 NOT_IMPLEMENTED_OPS 里）", () => {
  const { state, self } = opened();
  expect(run(state, { op: "act.nothing" }, self).events).toEqual([]);
  expect(NOT_IMPLEMENTED_OPS).not.toContain("act.nothing");
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. targets.ts —— sourceOf / base 实体
// ═══════════════════════════════════════════════════════════════════════════

test("事件负载里的 player 是该方的 **base 实体**，不是 0/1", () => {
  const { state, self } = opened();
  const step = run(state, { op: "act.draw", player: CONTROLLER }, self);
  const drawn = step.events[0];

  expect(drawn?.name).toBe("card_drawn");
  expect((drawn as { player: number }).player).toBe(baseIdOf(step.state, 0));
  // 实体 id 从 1 起，所以绝不能拿 PlayerId 冒充实体 id。
  expect(baseIdOf(step.state, 0)).toBeGreaterThan(0);
});
