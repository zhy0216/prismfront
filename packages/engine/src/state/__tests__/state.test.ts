// state/ 的单元测试。
//
// 重点不在「字段存不存在」，而在**两条会腐化的不变量**：
//   1. 纯数据（框架 §3.1、§13 坑 3）—— `assertPureData` 递归扫描整个状态；
//   2. 序列化往返逐字相等（架构 §6.1 第二条测试的前置条件）。
// 另外把「无效槽 vs 空槽」这条最容易被 `!` 抹掉的三态语义（v2 §3.1）钉死。
//
// 注：这里**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1：engine 对 ir 只能是
// 纯类型依赖），所以规则参数用本文件里的字面量夹具，而不是 ir 的 `DEFAULT_RULES_CONFIG`。

import { expect, test } from "bun:test";
import type { RulesConfig } from "@prismfront/ir";
import { createRngState } from "../../rng/index.ts";
import type { CtxBindings, EntityData, GameState, PlayerId, ZoneKey } from "../index.ts";
import {
  addTagValues,
  baseOf,
  boardEntities,
  cloneState,
  controllerOf,
  createCtx,
  createInitialState,
  createTagValues,
  currentHealth,
  emptySlotIndices,
  entityAtSlot,
  FLAG_BITS,
  flagsOf,
  getEntities,
  getEntity,
  getZone,
  getZoneByKey,
  getZoneEntities,
  hasBaseFlag,
  hasFlag,
  isSlotEmpty,
  isSlotOccupied,
  isSuspended,
  isValidSlot,
  maskHas,
  maskWith,
  opponentOf,
  parseZoneKey,
  playerData,
  slotCount,
  slotOccupant,
  tagOf,
  withCtx,
  zoneKey,
  zoneOf,
} from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════════════════

/** 规则夹具：与 DSL v2 §6 / §11.5 的默认值同值，但本地字面量（不 import ir 的值）。 */
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

function deckOf(prefix: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(`${prefix}_${i}`);
  }
  return out;
}

function freshState(): GameState {
  return createInitialState({
    rules: RULES,
    rng: createRngState(0x9f1),
    decks: [deckOf("P0", 4), deckOf("P1", 4)],
    heroes: [
      ["H0a", "H0b", "H0c"],
      ["H1a", "H1b", "H1c"],
    ],
    bundleId: "pf1@test",
  });
}

/**
 * 把一个牌库实体搬到战线上（测试内的手工摆盘）。
 *
 * 同步维护 `index.ts` 里那四条一致性不变量：zones / slots / entity.zone / entity.slot。
 */
function placeOnBoard(state: GameState, player: PlayerId, index: number): EntityData {
  const deckKey = zoneKey(player, "deck");
  const id = state.zones[deckKey].shift();
  if (id === undefined) {
    throw new Error("牌库空了");
  }
  const entity = state.entities[id];
  if (entity === undefined) {
    throw new Error("实体不存在");
  }
  const boardKey = zoneKey(player, "board");
  entity.zone = boardKey;
  entity.slot = index;
  entity.playOrder = state.nextPlayOrder;
  entity.base = createTagValues({ atk: 3, health: 4 });
  entity.tags = createTagValues({ atk: 3, health: 4 });
  state.nextPlayOrder += 1;
  state.zones[boardKey].push(id);
  state.slots[player][index] = id;
  return entity;
}

/** 一个「中局」状态：有单位在场、有附魔、有栈、有挂起点、有积压事件。 */
function midGameState(): GameState {
  const state = freshState();
  state.phase = "actions";
  state.round = 3;
  state.priority = 1;
  state.consecutivePasses = 1;
  state.firstPasser = 0;
  playerData(state, 0).crystals = 4;
  playerData(state, 0).crystalCap = 7;

  const attacker = placeOnBoard(state, 0, 4);
  const defender = placeOnBoard(state, 1, 4);
  defender.damage = 1;
  attacker.enchantments.push({ ench: "GRID_001e", source: defender.id, duration: "end_of_combat" });
  attacker.flags = maskWith(attacker.flags, "divine_shield", true);

  state.stack.push({
    via: "inline",
    // `sel.entity` + 裸数字字面量 = IR v1 §5.6 的运行时超集（由引擎自己生成）
    act: { op: "act.hit", target: { op: "sel.entity", id: defender.id }, amount: 3 },
    ctx: withCtx(createCtx(attacker.id), {
      target: defender.id,
      event: { name: "damaged", source: attacker.id, target: defender.id, amount: 3 },
    }),
  });
  state.stack.push({ via: "ref", ref: "GRID_001#play.0", ctx: createCtx(attacker.id) });
  state.pendingInput = {
    player: 0,
    kind: "select_target",
    options: [defender.id],
    optional: false,
    deadline: null,
  };
  state.eventLog.push({ name: "struck", source: attacker.id, target: defender.id, amount: 3 });
  return state;
}

// ═══════════════════════════════════════════════════════════════════════════
// 纯数据探针（框架 §3.1 / §13 坑 3）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 递归断言「只由 JSON 能表达的东西构成」。
 *
 * 拒绝：`undefined`（JSON 往返会丢键）、`NaN` / `Infinity`（会变成 `null`）、
 * 函数 / Symbol / BigInt、以及任何 `Object.prototype` 之外原型的对象
 * （class 实例、Map、Set、Date 都在此列）。
 */
function assertPureData(value: unknown, path: string): void {
  if (value === null) {
    return;
  }
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") {
    return;
  }
  if (kind === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path}: 非有限数，JSON 往返会变成 null`);
    }
    return;
  }
  if (kind === "undefined") {
    throw new Error(`${path}: 出现 undefined —— 状态里一律用「必填 + | null」`);
  }
  if (kind !== "object") {
    throw new Error(`${path}: 不可序列化的 ${kind}`);
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    for (let i = 0; i < items.length; i += 1) {
      assertPureData(items[i], `${path}[${i}]`);
    }
    return;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${path}: 不是纯对象（class 实例 / Map / Set 之类）`);
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assertPureData(child, `${path}.${key}`);
  }
}

test("初始状态是纯数据（无函数 / class / Map / undefined）", () => {
  assertPureData(freshState(), "state");
});

test("中局状态是纯数据 —— 栈、上下文绑定、附魔、挂起点、事件日志一并覆盖", () => {
  assertPureData(midGameState(), "state");
});

test("状态对象上没有挂任何函数（辅助函数放模块里，不放进状态）", () => {
  const state = midGameState();
  for (const value of Object.values(state)) {
    expect(typeof value).not.toBe("function");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 序列化往返（架构 §6.1 第二条测试的前置条件）
// ═══════════════════════════════════════════════════════════════════════════

test("JSON 往返逐字相等", () => {
  const state = midGameState();
  const text = JSON.stringify(state);
  const revived = JSON.parse(text) as GameState;
  expect(JSON.stringify(revived)).toBe(text);
  expect(revived).toEqual(state);
});

test("cloneState 是深拷贝：改副本不影响原状态", () => {
  const state = midGameState();
  const before = JSON.stringify(state);
  const copy = cloneState(state);
  copy.round = 99;
  copy.slots[0][4] = null;
  const copiedAttacker = copy.entities[2];
  if (copiedAttacker !== undefined) {
    copiedAttacker.damage = 42;
    copiedAttacker.enchantments.length = 0;
  }
  expect(JSON.stringify(state)).toBe(before);
});

test("往返后按数字 id 仍能取到实体（Record<EntityId,…> 的键变字符串不影响访问）", () => {
  const state = midGameState();
  const revived = JSON.parse(JSON.stringify(state)) as GameState;
  const baseId = playerData(revived, 0).baseId;
  const base = getEntity(revived, baseId);
  expect(base?.id).toBe(baseId);
  expect(boardEntities(revived, 0)).toHaveLength(1);
});

// ═══════════════════════════════════════════════════════════════════════════
// createInitialState
// ═══════════════════════════════════════════════════════════════════════════

test("建局：两个 base、双方牌库入 deck 区、英雄入 fountain 区", () => {
  const state = freshState();

  const base0 = baseOf(state, 0);
  const base1 = baseOf(state, 1);
  expect(base0?.cardId).toBe("__base");
  expect(zoneOf(base0 as EntityData)).toBe("base");
  expect(base0?.tags.health).toBe(30);
  expect(currentHealth(base0 as EntityData)).toBe(30);
  expect(base0?.slot).toBeNull();
  expect(base1?.id).not.toBe(base0?.id);

  expect(getZone(state, 0, "deck")).toHaveLength(4);
  expect(getZone(state, 1, "deck")).toHaveLength(4);
  expect(getZone(state, 0, "hand")).toHaveLength(0);

  const heroes = getZone(state, 0, "fountain");
  expect(heroes).toHaveLength(3);
  const firstHero = getEntity(state, heroes[0] as number);
  expect(firstHero?.cardId).toBe("H0a");
  // v2.1 §11.3：respawnAt 到期即可在 deploy 阶段上场；初始英雄从 r1 起可部署。
  expect(firstHero?.respawnAt).toBe(1);
  expect(firstHero?.slot).toBeNull();
});

test("建局：两行空战线，长度 = rules.board.slots", () => {
  const state = freshState();
  expect(slotCount(state)).toBe(9);
  expect(state.slots[0]).toHaveLength(9);
  expect(state.slots[1]).toHaveLength(9);
  expect(emptySlotIndices(state, 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  expect(boardEntities(state, 0)).toHaveLength(0);
});

test("建局：起点是 mulligan / round 0 / 空栈 / 无挂起点 / 空事件日志", () => {
  const state = freshState();
  expect(state.phase).toBe("mulligan");
  expect(state.round).toBe(0);
  expect(state.stack).toHaveLength(0);
  expect(state.pendingInput).toBeNull();
  expect(state.eventLog).toHaveLength(0);
  expect(state.winner).toBeNull();
  expect(state.bundleId).toBe("pf1@test");
  expect(playerData(state, 0).crystals).toBe(0);
  expect(playerData(state, 0).crystalCap).toBe(0);
});

test("建局：id 分配顺序写死（p0 base → p1 base → p0 牌库 → p1 牌库 → p0 英雄 → p1 英雄）", () => {
  const state = freshState();
  expect(playerData(state, 0).baseId).toBe(1);
  expect(playerData(state, 1).baseId).toBe(2);
  expect(getZone(state, 0, "deck")).toEqual([3, 4, 5, 6]);
  expect(getZone(state, 1, "deck")).toEqual([7, 8, 9, 10]);
  expect(getZone(state, 0, "fountain")).toEqual([11, 12, 13]);
  expect(state.nextEntityId).toBe(17);
});

test("建局：不消耗 RNG（洗牌等随机是 M3 的事）", () => {
  const rng = createRngState(0x9f1);
  const before = { ...rng };
  createInitialState({ rules: RULES, rng, decks: [deckOf("P0", 4), deckOf("P1", 4)] });
  expect(rng).toEqual(before);
});

test("四条一致性不变量成立（zones ⇔ entity.zone、slots ⇔ entity.slot、id 自洽、base 归位）", () => {
  const state = midGameState();

  // 不变量 1 与 3：zones[k] 含 id ⇔ entities[id].zone === k；entities[id].id === id
  for (const [key, ids] of Object.entries(state.zones)) {
    for (const id of ids) {
      const entity = getEntity(state, id);
      expect(entity).toBeDefined();
      expect((entity as EntityData).id).toBe(id);
      expect((entity as EntityData).zone).toBe(key as ZoneKey);
    }
  }

  for (const player of [0, 1] as const) {
    // 不变量 2：slots[p][i] === id ⇔ entity.slot === i 且 entity 在 p 的 board 区
    const row = state.slots[player];
    for (let i = 0; i < row.length; i += 1) {
      const id = row[i];
      if (id === null || id === undefined) {
        continue;
      }
      const entity = getEntity(state, id);
      expect(entity).toBeDefined();
      expect((entity as EntityData).slot).toBe(i);
      expect(controllerOf(entity as EntityData)).toBe(player);
      expect(zoneOf(entity as EntityData)).toBe("board");
    }
    // 不变量 4：players[p].baseId 指向的实体在 p{p}:base 区
    const base = baseOf(state, player);
    expect(base).toBeDefined();
    expect(zoneOf(base as EntityData)).toBe("base");
    expect(controllerOf(base as EntityData)).toBe(player);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 格位三态：无效槽 / 空槽 / 占用（v2 §3.1）
// ═══════════════════════════════════════════════════════════════════════════

test("slotOccupant 三态：undefined = 无效槽，null = 空槽，number = 占用", () => {
  const state = midGameState();
  expect(slotOccupant(state, 0, 4)).toBe(3);
  expect(slotOccupant(state, 0, 0)).toBeNull();
  // 越界 / 负数 / 非整数一律是**无效槽**，不是空槽 —— 两者语义相反，不许合并。
  expect(slotOccupant(state, 0, 9)).toBeUndefined();
  expect(slotOccupant(state, 0, -1)).toBeUndefined();
  expect(slotOccupant(state, 0, 1.5)).toBeUndefined();
});

test("无效槽既不是空槽也不是被占（cond.occupied(无效槽) = false）", () => {
  const state = midGameState();
  expect(isSlotEmpty(state, 0, 0)).toBe(true);
  expect(isSlotOccupied(state, 0, 0)).toBe(false);
  expect(isSlotEmpty(state, 0, 4)).toBe(false);
  expect(isSlotOccupied(state, 0, 4)).toBe(true);
  expect(isSlotEmpty(state, 0, 99)).toBe(false);
  expect(isSlotOccupied(state, 0, 99)).toBe(false);
  expect(isValidSlot(state, 8)).toBe(true);
  expect(isValidSlot(state, 9)).toBe(false);
});

test("entityAtSlot / boardEntities 按格序枚举，空格与无效槽都取不到实体", () => {
  const state = midGameState();
  placeOnBoard(state, 0, 1);
  expect(entityAtSlot(state, 0, 4)?.slot).toBe(4);
  expect(entityAtSlot(state, 0, 0)).toBeUndefined();
  expect(entityAtSlot(state, 0, 42)).toBeUndefined();
  // v2 §3.2：board 自 v2 起按格序 0→8 枚举，1 号格排在 4 号格之前。
  expect(boardEntities(state, 0).map((e) => e.slot)).toEqual([1, 4]);
  expect(emptySlotIndices(state, 0)).toEqual([0, 2, 3, 5, 6, 7, 8]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 区域键、属性、标志位、上下文
// ═══════════════════════════════════════════════════════════════════════════

test("zoneKey / parseZoneKey 往返", () => {
  expect(zoneKey(0, "hand")).toBe("p0:hand");
  expect(zoneKey(1, "fountain")).toBe("p1:fountain");
  expect(parseZoneKey("p1:graveyard")).toEqual({ player: 1, zone: "graveyard" });
  expect(parseZoneKey(zoneKey(0, "board"))).toEqual({ player: 0, zone: "board" });
});

test("controllerOf 读的是当前控制者（区域键的玩家位），不是 owner", () => {
  const state = midGameState();
  const stolen = getEntity(state, 3) as EntityData;
  expect(stolen.owner).toBe(0);
  expect(controllerOf(stolen)).toBe(0);
  // 模拟 act.steal：实体挪进对手的区域，owner 不变、controller 变。
  stolen.zone = zoneKey(1, "graveyard");
  expect(stolen.owner).toBe(0);
  expect(controllerOf(stolen)).toBe(1);
});

test("opponentOf", () => {
  expect(opponentOf(0)).toBe(1);
  expect(opponentOf(1)).toBe(0);
});

test("属性表是全量表：未给的键为 0，direction 默认 0（v2 §2.3）", () => {
  const tags = createTagValues({ atk: 2 });
  expect(tags.atk).toBe(2);
  expect(tags.health).toBe(0);
  expect(tags.direction).toBe(0);
  expect(tags.armor).toBe(0);
  expect(tags.cost).toBe(0);
});

test("标志位掩码：置位 / 清位 / 互不干扰", () => {
  let mask = 0;
  expect(maskHas(mask, "divine_shield")).toBe(false);
  mask = maskWith(mask, "divine_shield", true);
  mask = maskWith(mask, "stunned", true);
  expect(maskHas(mask, "divine_shield")).toBe(true);
  expect(maskHas(mask, "stunned")).toBe(true);
  expect(maskHas(mask, "silenced")).toBe(false);
  mask = maskWith(mask, "divine_shield", false);
  expect(maskHas(mask, "divine_shield")).toBe(false);
  expect(maskHas(mask, "stunned")).toBe(true);
  // 三个标志位占三个互不相同的比特
  expect(FLAG_BITS.divine_shield & FLAG_BITS.stunned).toBe(0);
  expect(FLAG_BITS.stunned & FLAG_BITS.silenced).toBe(0);
});

test("hasFlag 读的是生效标志位", () => {
  const state = midGameState();
  const attacker = getEntity(state, 3) as EntityData;
  expect(hasFlag(attacker, "divine_shield")).toBe(true);
  expect(hasFlag(attacker, "stunned")).toBe(false);
});

test("血量记账：当前血量 = tags.health - damage", () => {
  const state = midGameState();
  const defender = getEntity(state, 7) as EntityData;
  expect(defender.tags.health).toBe(4);
  expect(defender.damage).toBe(1);
  expect(currentHealth(defender)).toBe(3);
});

test("createCtx / withCtx：派生新对象，不改入参", () => {
  const base: CtxBindings = createCtx(7);
  expect(base).toEqual({ self: 7, target: null, chosen: null, it: null, event: null });
  const derived = withCtx(base, { target: 9, chosen: "CORE_050" });
  expect(derived.target).toBe(9);
  expect(derived.chosen).toBe("CORE_050");
  expect(derived.self).toBe(7);
  expect(base.target).toBeNull();
  expect(base.chosen).toBeNull();
});

test("查询函数不改状态", () => {
  const state = midGameState();
  const before = JSON.stringify(state);
  boardEntities(state, 0);
  emptySlotIndices(state, 1);
  getZone(state, 0, "deck");
  entityAtSlot(state, 1, 4);
  baseOf(state, 1);
  expect(JSON.stringify(state)).toBe(before);
});

// ═══════════════════════════════════════════════════════════════════════════
// 读取器与叠加原语
//
// 这一节盯的是**语义**，不是「函数被调用过」：每条测试都指向一个具体的、
// 后续里程碑会依赖的约定（悬空 id、base 与生效值之分、叠加的纯函数性）。
// ═══════════════════════════════════════════════════════════════════════════

test("addTagValues 逐键相加，缺省键当 0，且不改两个入参（光环重算的叠加原语）", () => {
  // 框架 §4.1 时序规则 4：`tags = base + Σ附魔 + Σ光环`，**每步重算而非增量**。
  // 重算的正确性建立在这个加法是纯函数上 —— 它一旦改了入参，
  // `base` 就会被逐步污染，而 `base` 是 `act.silence` 的复位目标。
  const base = createTagValues({ atk: 2, health: 5 });
  const buff = { atk: 1, armor: 3 };
  const sum = addTagValues(base, buff);

  expect(sum).toEqual({ atk: 3, health: 5, cost: 0, direction: 0, armor: 3 });
  // 入参一字未改
  expect(base).toEqual({ atk: 2, health: 5, cost: 0, direction: 0, armor: 0 });
  expect(buff).toEqual({ atk: 1, armor: 3 });
  // 返回的是新对象，不是被改过的入参
  expect(sum).not.toBe(base);
  // 负数是合法的（减益光环），direction 也参与叠加（v2 §2.3：direction 是 Tag）
  expect(addTagValues(sum, { atk: -5, direction: 1 })).toEqual({
    atk: -2,
    health: 5,
    cost: 0,
    direction: 1,
    armor: 3,
  });
});

test("getEntities 静默跳过悬空 id（死亡结算与延迟触发里最常见的一类情况）", () => {
  const state = midGameState();
  const attacker = getEntity(state, 3) as EntityData;
  const defender = getEntity(state, 7) as EntityData;

  // 顺序按入参列表，不按 id 大小
  expect(getEntities(state, [defender.id, attacker.id]).map((e) => e.id)).toEqual([
    defender.id,
    attacker.id,
  ]);
  // 悬空 id 被跳过而不是抛错、也不是留一个 undefined 空位
  // （IR v1 §5.2 的空集合语义：取不到就是取不到，不是错误）
  const mixed = getEntities(state, [attacker.id, 9999, defender.id]);
  expect(mixed.map((e) => e.id)).toEqual([attacker.id, defender.id]);
  expect(mixed).toHaveLength(2);
  // 全是悬空 id → 空数组
  expect(getEntities(state, [9998, 9999])).toEqual([]);
  expect(getEntities(state, [])).toEqual([]);
});

test("hasBaseFlag 读卡面、hasFlag 读生效值 —— 两者必须分得开（沉默的复位目标）", () => {
  const state = midGameState();
  const attacker = getEntity(state, 3) as EntityData;

  // 夹具里的圣盾是**运行时**加上去的（附魔/光环），卡面上并没有。
  // `act.silence` 把 flags 复位到 baseFlags，所以这两个读取器要是串了，
  // 沉默会把运行时加的圣盾"复位"成永久圣盾。
  expect(hasFlag(attacker, "divine_shield")).toBe(true);
  expect(hasBaseFlag(attacker, "divine_shield")).toBe(false);
  expect(flagsOf(attacker)).toBe(FLAG_BITS.divine_shield);
  expect(attacker.baseFlags).toBe(0);

  // 卡面自带的标志位则两者都为 true
  attacker.baseFlags = maskWith(attacker.baseFlags, "stunned", true);
  attacker.flags = maskWith(attacker.flags, "stunned", true);
  expect(hasBaseFlag(attacker, "stunned")).toBe(true);
  expect(hasFlag(attacker, "stunned")).toBe(true);
});

test("tagOf 读生效属性，未设的键为 0（tags 是全量表，恒有值）", () => {
  const state = midGameState();
  const attacker = getEntity(state, 3) as EntityData;
  expect(tagOf(attacker, "atk")).toBe(3);
  expect(tagOf(attacker, "health")).toBe(4);
  // 夹具没给 armor / cost / direction —— 全量表保证它们是 0 而不是 undefined
  expect(tagOf(attacker, "armor")).toBe(0);
  expect(tagOf(attacker, "cost")).toBe(0);
  expect(tagOf(attacker, "direction")).toBe(0);
});

test("getZoneByKey / getZoneEntities 与 getZone 同源，且保持区域列表的顺序", () => {
  const state = midGameState();

  // 两条取法必须落到同一个列表（区域键是 zones 的唯一主键）
  expect(getZoneByKey(state, zoneKey(0, "board"))).toEqual([...getZone(state, 0, "board")]);
  expect(getZoneByKey(state, zoneKey(0, "deck"))).toEqual([...getZone(state, 0, "deck")]);

  // 实体版按区域列表顺序返回 —— 牌库顺序就是抽牌顺序，顺序不能被打乱
  const deckIds = getZone(state, 0, "deck");
  expect(getZoneEntities(state, 0, "deck").map((e) => e.id)).toEqual([...deckIds]);
  expect(getZoneEntities(state, 0, "board").map((e) => e.id)).toEqual([
    ...getZone(state, 0, "board"),
  ]);
  // 空区域 → 空数组
  expect(getZoneEntities(state, 0, "graveyard")).toEqual([]);
});

test("isSuspended 判挂起点（框架 §4.2）", () => {
  expect(isSuspended(freshState())).toBe(false);
  const state = midGameState();
  expect(isSuspended(state)).toBe(true);
  state.pendingInput = null;
  expect(isSuspended(state)).toBe(false);
});
