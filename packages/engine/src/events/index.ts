// events/ —— GameEvent 与事件日志（框架 §3.3 / §4.1 / §4.3）。
//
// 两个文件，两件事：
//   event.ts —— 事件的**形状**：25 个规则事件（名字复用 IR 的 `EventName`，不另抄）
//               + `engine.random_picked`（框架 §4.3 的 `RANDOM_PICK`）。
//   log.ts   —— 事件的**累积与排空**。日志放在 state 里，理由写在 log.ts 顶部。
//
// M2 只做产出侧。投影（`projectEvent`）是 M7，触发器匹配是 M5，两者都不在这里。
//
// 上层 `src/index.ts` 由外层统一组装，本目录不参与。

export type {
  EngineEvent,
  EngineEventPrefix,
  EnginePrefixDisjoint,
  EventNameCoverage,
  EventNameNoStrays,
  EventPayloadOf,
  GameEvent,
  GameEventName,
  GameEventOf,
  RandomSource,
  RuleEvent,
} from "./event.ts";
export {
  ENGINE_EVENT_PREFIX,
  eventEntity,
  isEngineEvent,
  isRuleEvent,
  RANDOM_SOURCES,
} from "./event.ts";
export type { EventSink } from "./log.ts";
export {
  createEventLog,
  drainEventLog,
  emitEvent,
  emitEvents,
  peekEventLog,
} from "./log.ts";
