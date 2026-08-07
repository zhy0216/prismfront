// Trigger：事后触发。
// 来源：IR v1 §4.1 + §9、DSL v2 §5（事件表）、§11.3（英雄事件）。

import type { Act } from "./act.ts";
import type { Cond } from "./cond.ts";
import type { EventEntityField, EventName } from "./event.ts";
import type { Sel } from "./sel.ts";
import type { ZoneName } from "./zone.ts";

/**
 * 触发器的事件过滤器（IR v1 §4.1）。
 *
 * 键是事件负载的**实体字段名**，值是 `Sel`；该字段上的实体须落在该 `Sel` 的结果内。
 * 例：荆棘卫士 `{ target: sel.self }`（"我被出手命中时"）、
 * Cleave `{ source: sel.self }`（"我命中单位时"）。
 *
 * v2 §5：filter 现在可用位置选择器，
 * 例如 `{ target: sel.adjacent(sel.self) }` = "相邻友军被打时"，不需要任何新机制。
 */
export type TriggerFilter = Partial<Record<EventEntityField, Sel>>;

/**
 * 事后触发器（IR v1 §4.1）。
 *
 * `deathrattle` 是 `{on:"unit_died", filter:{target:SELF}, zone:"graveyard"}` 的糖，
 * 构建器会展开。IR 里保留 `script.deathrattle` 字段只是为了可读性和 lint，
 * engine 内部一律当 trigger 处理。
 * （v1 原文用的事件名是 `minion_died`，v2 §5 已改名 `unit_died`。）
 */
export interface Trigger {
  /** 事件名（v2 §5 事件表 + v2.1 §11.3）。用已删除的 v1 事件名 → L3 报错并提示改名映射。 */
  on: EventName;
  /** 按事件负载的实体字段过滤。 */
  filter?: TriggerFilter;
  /** 额外条件，可访问 `sel.event.*`。 */
  cond?: Cond;
  /** 触发一次后自动移除。 */
  once?: boolean;
  /**
   * 本触发器在哪个区域生效，默认 `"board"`。
   * 手牌触发写 `"hand"`，亡语相关写 `"graveyard"`。
   */
  zone?: ZoneName;
  do: readonly Act[];
}
