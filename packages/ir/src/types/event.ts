// 事件名与事件负载的实体字段。
// 来源：DSL v2 §5（事件表 v2，取代 IR v1 §4.1 的事件名表）、DSL v2 §11.3（v2.1 新增两个）。

/**
 * 事件名（`trigger.on` 的取值域）。
 *
 * 全量取自 DSL v2 §5 的事件表 v2，加上 v2.1 §11.3 的 `hero_deployed` / `hero_died`。
 *
 * 分组（与 v2 §5 表格逐行对应）：
 * - 回合与资源：`round_began` `round_ended` `crystal_gained`
 * - 行动阶段：`action_taken` `player_passed`
 * - 战斗阶段：`combat_began` `struck` `combat_ended`
 * - 牌：`card_played` `card_drawn` `card_discarded` `card_added_to_hand`
 * - 场面：`unit_summoned` `unit_died` `unit_moved` `direction_changed`
 * - 效果：`damaged` `healed` `buffed` `silenced` `transformed`
 * - 英雄（v2.1 §11.3）：`hero_deployed` `hero_died`
 * - 保留（玩法可能用不上，v2 §5 原文）：`secret_revealed` `hero_power_used`
 *
 * 三条容易写错的语义：
 * 1. `struck` 是"出手这件事"，`damaged` 是"伤害结果"，两者都能挂触发器。
 *    `struck` 负载 `{source, target, amount}`；战斗阶段出手与 `act.strike` 都发它。
 *    溅射/反伤走 `act.hit` 而**不发** `struck`，所以天然不会互相触发成连锁（v2 §8.7）
 * 2. 打基地不单设事件：`damaged` 的 target 是基地实体即是（v2 §5 / §4.3）
 * 3. 英雄阵亡发 `hero_died` 而**不发** `unit_died`，触发器需明确区分（v2.1 §11.3）
 *
 * v1 已删除的事件（v2 §5 / §10 迁移清单，M11 的 L3 会把它们报成错误并提示改名）：
 * `turn_began`→`round_began`、`turn_ended`→`round_ended`、
 * `minion_summoned`→`unit_summoned`、`minion_died`→`unit_died`、
 * `mana_spent`/`weapon_equipped`/`attacked`/`attack_declared` 无对应物。
 */
export const EVENT_NAMES = [
  "round_began",
  "round_ended",
  "crystal_gained",
  "action_taken",
  "player_passed",
  "combat_began",
  "struck",
  "combat_ended",
  "card_played",
  "card_drawn",
  "card_discarded",
  "card_added_to_hand",
  "unit_summoned",
  "unit_died",
  "unit_moved",
  "direction_changed",
  "damaged",
  "healed",
  "buffed",
  "silenced",
  "transformed",
  "hero_deployed",
  "hero_died",
  "secret_revealed",
  "hero_power_used",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/**
 * 事件负载中**实体类**字段的名字。
 *
 * 两处共用同一个取值集，故只定义一次：
 * - `sel.event.field`：从事件负载里取实体（IR v1 §3.1）
 * - `trigger.filter` 的键：按事件负载的实体字段过滤（IR v1 §4.1）
 *
 * 负载里的非实体字段（`struck.amount`、`unit_moved.fromSlot/toSlot`）不在此列，
 * 它们不能作为 `sel.event` 或 `trigger.filter` 的对象。
 */
export const EVENT_ENTITY_FIELDS = ["source", "target", "player"] as const;

export type EventEntityField = (typeof EVENT_ENTITY_FIELDS)[number];
