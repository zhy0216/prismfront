// 事件日志：累积 + 排空（框架 §4.1 的 drainEventLog）。
//
// 顺带把「日志放在 state 里」这个决定测出来：日志跟着状态一起序列化往返之后，
// 排空得到的批次必须逐字相同（log.ts 顶部理由 3）。

import { expect, test } from "bun:test";
import type { GameEvent } from "../event.ts";
import {
  createEventLog,
  drainEventLog,
  type EventSink,
  emitEvent,
  emitEvents,
  peekEventLog,
} from "../log.ts";
import { ALL_SAMPLES, findImpurities, RULE_EVENT_SAMPLES } from "./samples.ts";

/** 最小的 sink：`GameState` 只要带上同名字段就自动满足 {@link EventSink}。 */
function makeSink(): { eventLog: GameEvent[] } {
  return { eventLog: createEventLog() };
}

test("createEventLog 给出一个空数组，且每次都是新的", () => {
  const a = createEventLog();
  const b = createEventLog();
  expect(a).toEqual([]);
  expect(a === b).toBe(false);
});

test("emitEvent 累积，顺序即数组顺序（框架 §3.3）", () => {
  const sink = makeSink();
  emitEvent(sink, RULE_EVENT_SAMPLES.struck);
  emitEvent(sink, RULE_EVENT_SAMPLES.damaged);
  emitEvent(sink, RULE_EVENT_SAMPLES.unit_died);
  expect(peekEventLog(sink).map((e) => e.name)).toEqual(["struck", "damaged", "unit_died"]);
});

test("emitEvents 批量累积且保序，空批次是空操作", () => {
  const sink = makeSink();
  emitEvents(sink, []);
  expect(peekEventLog(sink)).toHaveLength(0);
  emitEvents(sink, ALL_SAMPLES);
  expect(peekEventLog(sink).map((e) => e.name)).toEqual(ALL_SAMPLES.map((e) => e.name));
});

test("emitEvent 不加工事件：存进去的就是原对象", () => {
  const sink = makeSink();
  emitEvent(sink, RULE_EVENT_SAMPLES.healed);
  expect(peekEventLog(sink)[0] === RULE_EVENT_SAMPLES.healed).toBe(true);
});

test("drainEventLog 排空并返回这一批，再排空得到空批次", () => {
  const sink = makeSink();
  emitEvent(sink, RULE_EVENT_SAMPLES.round_began);
  emitEvent(sink, RULE_EVENT_SAMPLES.card_drawn);

  const first = drainEventLog(sink);
  expect(first.map((e) => e.name)).toEqual(["round_began", "card_drawn"]);
  expect(peekEventLog(sink)).toHaveLength(0);

  // 这是「apply() 返回时 eventLog 必为空」那条不变量的直接后果：
  // 没有新事件就不会重复下发已经发过的那一批。
  expect(drainEventLog(sink)).toEqual([]);
});

test("drainEventLog 原地清空，不换掉 eventLog 的数组身份", () => {
  const sink = makeSink();
  const original = sink.eventLog;
  emitEvent(sink, RULE_EVENT_SAMPLES.combat_began);

  const drained = drainEventLog(sink);

  // 身份不变 → GameState 可以把 eventLog 声明成 readonly，
  // 也不会有别处捏着一个被换掉的旧引用继续 push（那些事件会永远发不出去）。
  expect(sink.eventLog === original).toBe(true);
  expect(original).toHaveLength(0);
  // 排出去的批次是另一个数组，调用方随便改动不会污染状态。
  expect(drained === original).toBe(false);
  expect(drained).toHaveLength(1);
});

test("排空后继续 emit 不会回头改动上一批", () => {
  const sink = makeSink();
  emitEvent(sink, RULE_EVENT_SAMPLES.struck);
  const first = drainEventLog(sink);
  emitEvent(sink, RULE_EVENT_SAMPLES.unit_died);
  expect(first.map((e) => e.name)).toEqual(["struck"]);
  expect(peekEventLog(sink).map((e) => e.name)).toEqual(["unit_died"]);
});

test("peekEventLog 只看不排空", () => {
  const sink = makeSink();
  emitEvent(sink, RULE_EVENT_SAMPLES.player_passed);
  expect(peekEventLog(sink)).toHaveLength(1);
  expect(peekEventLog(sink)).toHaveLength(1);
  expect(sink.eventLog).toHaveLength(1);
});

// ── 「日志放在 state 里」的探针（log.ts 顶部理由 3）───────────────────────────

test("日志跟状态一起 JSON 往返后，排空结果逐字相同", () => {
  const sink = makeSink();
  emitEvents(sink, ALL_SAMPLES);

  const revived: { eventLog: GameEvent[] } = JSON.parse(JSON.stringify(sink));
  expect(drainEventLog(revived)).toEqual(drainEventLog(sink));
});

test("积压的日志本身是纯数据，不会污染状态的可序列化性", () => {
  const sink = makeSink();
  emitEvents(sink, ALL_SAMPLES);
  expect(findImpurities(sink, "state")).toEqual([]);
});

test("EventSink 是结构类型：任何带 eventLog 的对象都能收事件", () => {
  // 模拟 state/ 那边的 GameState：多几个字段、eventLog 声明成 readonly，照样能用。
  const fakeState: { readonly seq: number; readonly eventLog: GameEvent[] } = {
    seq: 7,
    eventLog: createEventLog(),
  };
  const sink: EventSink = fakeState;
  emitEvent(sink, RULE_EVENT_SAMPLES.round_ended);
  expect(drainEventLog(fakeState)).toHaveLength(1);
  expect(fakeState.seq).toBe(7);
});
