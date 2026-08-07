// PlayerId 与 PlayerData。
// 来源：框架 §3.1（`players` 是定长 2 元组）、DSL v2 §2.1（crystals / crystalCap）、
//       DSL v2 §3.3（GlobalTag 里的 fatigue）、DSL v2.1 §11.2（原 `hp` 的去向，见下方说明）。

import type { EntityId } from "@prismfront/ir";

/**
 * 玩家下标。
 *
 * `players` 与 `slots` 都是**定长 2 元组**（框架 §3.1 / v2 §2.1），用它做下标。
 * 写成 `0 | 1` 而不是 `number`，于是 `state.players[player]` 不会因
 * `noUncheckedIndexedAccess` 变成 `PlayerData | undefined`。
 */
export type PlayerId = 0 | 1;

/** 两个玩家下标。需要「对双方各做一遍」时遍历它，顺序即 p0 → p1（确定性）。 */
export const PLAYER_IDS = [0, 1] as const satisfies readonly PlayerId[];

/** 对手。 */
export function opponentOf(player: PlayerId): PlayerId {
  return player === 0 ? 1 : 0;
}

/**
 * 玩家数据（DSL v2 §2.1）。
 *
 * **`hp` 不在这里**：v2 §2.1 的 `hp` 是 v2.1 之前的形态。v2.1 §11.2 把承伤实体独立成
 * **base**（30 血、胜负判定、`damaged` 事件的 target 就是它、护甲与拦截器同样作用于它，
 * v2 §4.3）。血量因此记在 base **实体**的 `tags.health` / `damage` 上，
 * PlayerData 只留一个 `baseId` 引用 —— 一处记账，不会出现两处不同步。
 * 这正是框架 §3.1「实体用 id 互相引用」的直接应用。
 *
 * hand / deck / graveyard 仍然是 `zones` 里的**有序列表**（v2 §2.1），不进 PlayerData。
 */
export interface PlayerData {
  /** 当前可用水晶（v2 §2.1，v1 的 mana 改名而来）。 */
  crystals: number;
  /**
   * 水晶上限。回合开始时 `crystalCap = min(initial + (round-1) * growth, capMax)`
   * 且 `crystals` **回满**（v2 §4.1）。M3 实现，M2 只留字段。
   */
  crystalCap: number;
  /** 本方 base 实体 id（v2.1 §11.2）。**id 引用，不存对象**（框架 §3.1）。 */
  baseId: EntityId;
  /**
   * 疲劳计数：牌库抽空后每次抽牌递增，并按该值造成伤害。
   * `num.tag("fatigue")` 读它（v2 §3.3 的 GlobalTag），`rules.deck.fatigue` 决定是否生效。
   * M3/M4 实现，M2 只留字段。
   */
  fatigue: number;
}
