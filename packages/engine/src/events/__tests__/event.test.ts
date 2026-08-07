// GameEvent 的形状测试：词汇表对齐 IR、纯数据、可 JSON 往返、两个命名空间不相交。

import { expect, test } from "bun:test";
import type { EventName } from "@prismfront/ir";
import {
  ENGINE_EVENT_PREFIX,
  eventEntity,
  type GameEvent,
  isEngineEvent,
  isRuleEvent,
  RANDOM_SOURCES,
} from "../event.ts";
import {
  ALL_SAMPLES,
  ENGINE_EVENT_SAMPLES,
  findImpurities,
  RULE_EVENT_SAMPLES,
} from "./samples.ts";

// ── 词汇表：复用 IR 的 EventName，不另抄一份 ─────────────────────────────────

test("每个 EventName 都配了一份负载，且键与 name 一致", () => {
  const entries = Object.entries(RULE_EVENT_SAMPLES);
  // 键集穷尽由 samples.ts 的映射类型注解在编译期保证；这里断言键与 name 没错位。
  for (const [key, event] of entries) {
    expect(event.name).toBe(key as EventName);
  }
  expect(entries.length).toBeGreaterThan(0);
});

test("规则事件与引擎事件是两个不相交的命名空间", () => {
  for (const event of Object.values(RULE_EVENT_SAMPLES)) {
    expect(event.name.startsWith(ENGINE_EVENT_PREFIX)).toBe(false);
    expect(isRuleEvent(event)).toBe(true);
    expect(isEngineEvent(event)).toBe(false);
  }
  for (const event of ENGINE_EVENT_SAMPLES) {
    expect(event.name.startsWith(ENGINE_EVENT_PREFIX)).toBe(true);
    expect(isRuleEvent(event)).toBe(false);
    expect(isEngineEvent(event)).toBe(true);
  }
});

test("isRuleEvent 在类型层面收窄到 RuleEvent", () => {
  const event: GameEvent = RULE_EVENT_SAMPLES.struck;
  if (!isRuleEvent(event)) throw new Error("struck 应当是规则事件");
  // 收窄成功才有 .name 的字面量联合可用；下面这行编译得过就说明收窄生效。
  const name: EventName = event.name;
  expect(name).toBe("struck");
});

// ── 纯数据 + JSON 往返（框架 §3.1 / §13 坑 3）─────────────────────────────────

test("每个事件都是纯数据：无函数 / class 实例 / undefined / 非有限数", () => {
  for (const event of ALL_SAMPLES) {
    expect(findImpurities(event, event.name)).toEqual([]);
  }
});

test("每个事件 JSON 往返后逐字相等（没有可选字段被 stringify 吃掉）", () => {
  for (const event of ALL_SAMPLES) {
    const revived: GameEvent = JSON.parse(JSON.stringify(event));
    expect(revived).toEqual(event);
    // 反向也比一次：键集不能多也不能少。
    expect(Object.keys(revived).sort()).toEqual(Object.keys(event).sort());
  }
});

test("findImpurities 确实抓得住脏值（探针自检）", () => {
  expect(findImpurities({ fn: () => 1 })).toHaveLength(1);
  expect(findImpurities({ nested: { bad: undefined } })).toHaveLength(1);
  expect(findImpurities({ n: Number.NaN })).toHaveLength(1);
  expect(findImpurities({ m: new Map() })).toHaveLength(1);
  expect(findImpurities({ list: [1, Symbol.iterator] })).toHaveLength(1);
  expect(findImpurities({ ok: [1, "a", true, null, { deep: 0 }] })).toEqual([]);
});

// ── 实体字段（IR 的 EVENT_ENTITY_FIELDS = source | target | player）───────────

test("eventEntity 读得到实体字段，读不到的返回 null", () => {
  expect(eventEntity(RULE_EVENT_SAMPLES.struck, "source")).toBe(11);
  expect(eventEntity(RULE_EVENT_SAMPLES.struck, "target")).toBe(21);
  // struck 没有 player 字段 → null，不是抛错（IR v1 §5.2 空集合静默）。
  expect(eventEntity(RULE_EVENT_SAMPLES.struck, "player")).toBeNull();
  // 显式写成 null 的字段也返回 null。
  expect(eventEntity(RULE_EVENT_SAMPLES.healed, "source")).toBeNull();
  expect(eventEntity(RULE_EVENT_SAMPLES.card_played, "player")).toBe(1);
});

test("eventEntity 不会把同名的非实体字段当成 id", () => {
  const picked = ENGINE_EVENT_SAMPLES[0];
  if (picked === undefined) throw new Error("样本缺失");
  // engine.random_picked 有个 string 的 origin，没有实体字段，三个都该是 null。
  expect(eventEntity(picked, "source")).toBeNull();
  expect(eventEntity(picked, "target")).toBeNull();
  expect(eventEntity(picked, "player")).toBeNull();
});

test("每个规则事件的实体字段都只用 source / target / player 三个名字", () => {
  const allowedEntityKeys = new Set(["source", "target", "player"]);
  // 允许的非实体字段（数值 / 卡 id / 枚举），逐个来自 DSL v2 §5 与 v2.1 §11.3。
  const allowedDataKeys = new Set([
    "name",
    "round",
    "amount",
    "kind",
    "cardId",
    "slot",
    "fromSlot",
    "toSlot",
    "from",
    "to",
    "ench",
    "fromCardId",
    "toCardId",
    "respawnAt",
  ]);
  for (const event of Object.values(RULE_EVENT_SAMPLES)) {
    for (const key of Object.keys(event)) {
      const known = allowedEntityKeys.has(key) || allowedDataKeys.has(key);
      if (!known) throw new Error(`${event.name} 出现了未登记的负载字段 ${key}`);
      expect(known).toBe(true);
    }
  }
});

// ── engine.random_picked（框架 §4.3）─────────────────────────────────────────

test("engine.random_picked 带得住 nextInt 的原始产出", () => {
  for (const event of ENGINE_EVENT_SAMPLES) {
    expect(event.name).toBe("engine.random_picked");
    expect(RANDOM_SOURCES.includes(event.origin)).toBe(true);
    expect(event.max).toBeGreaterThan(0);
    expect(event.result).toBeGreaterThanOrEqual(0);
    expect(event.result).toBeLessThan(event.max);
  }
});

test("RANDOM_SOURCES 覆盖 IR §5.4 点名的四个推进 RNG 的节点", () => {
  for (const op of ["sel.random", "num.random", "card.random", "slot.random_empty"]) {
    expect(RANDOM_SOURCES).toContain(op);
  }
});
