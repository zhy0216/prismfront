// ZoneKey：`zones` 表的键（框架 §3.1 的 `"p0:hand" → [12, 15, 33]`）。
// 来源：框架 §3.1、IR v1 §3.1（ZoneName 词汇表）、DSL v2.1 §11.2/§11.3（base / fountain）。

import type { EntityId, ZoneName } from "@prismfront/ir";
import type { PlayerId } from "./player.ts";

/**
 * 区域键 = `p<玩家>:<区域名>`（框架 §3.1）。
 *
 * 是**字面量联合**而不是 `string`，所以 `Record<ZoneKey, EntityId[]>` 是一张
 * 映射类型而不是索引签名 —— `noUncheckedIndexedAccess` 不会把
 * `state.zones[key]` 变成 `EntityId[] | undefined`，同时漏建一个键会在
 * {@link createEmptyZones} 处编译报错。
 *
 * 键里的玩家位表示**当前控制者**（`act.steal` 会把实体挪到对手的对应区，IR v1 §3.4），
 * 实体的**原始拥有者**另记在 `EntityData.owner` 上，两者可以不同。
 */
export type ZoneKey = `p0:${ZoneName}` | `p1:${ZoneName}`;

/**
 * 全部区域名。
 *
 * engine 对 ir 是**纯类型依赖**（架构 §2.2 禁令 1），不能 import ir 的 `ZONE_NAMES` 值，
 * 所以在这里本地重列一份；`satisfies readonly ZoneName[]` 保证不会写错名字，
 * 「有没有漏」则由 {@link createEmptyZones} 的 `Record<ZoneKey, ...>` 字面量兜住。
 */
export const ZONE_NAMES = [
  "board",
  "hand",
  "deck",
  "graveyard",
  "secret",
  "weapon",
  "base",
  "fountain",
] as const satisfies readonly ZoneName[];

/** 拼区域键。 */
export function zoneKey(player: PlayerId, zone: ZoneName): ZoneKey {
  return `p${player}:${zone}`;
}

/** {@link parseZoneKey} 的返回形状。 */
export interface ZoneKeyParts {
  /** 该区域属于哪一方（= 实体的当前控制者）。 */
  player: PlayerId;
  zone: ZoneName;
}

/** 拆区域键。形状由 {@link ZoneKey} 类型保证，无需运行时校验。 */
export function parseZoneKey(key: ZoneKey): ZoneKeyParts {
  return {
    player: key.startsWith("p0:") ? 0 : 1,
    // ZoneKey 的形状由类型保证：前 3 个字符恒为 `p0:` / `p1:`，其余必是一个合法 ZoneName。
    zone: key.slice(3) as ZoneName,
  };
}

/**
 * 建一张全空的 `zones` 表。
 *
 * 写成**穷举字面量**而不是循环，是为了让「ir 新增一个 ZoneName 而这里忘了跟」
 * 变成编译错误（`Record<ZoneKey, EntityId[]>` 要求每个键都在）。
 */
export function createEmptyZones(): Record<ZoneKey, EntityId[]> {
  return {
    "p0:board": [],
    "p0:hand": [],
    "p0:deck": [],
    "p0:graveyard": [],
    "p0:secret": [],
    "p0:weapon": [],
    "p0:base": [],
    "p0:fountain": [],
    "p1:board": [],
    "p1:hand": [],
    "p1:deck": [],
    "p1:graveyard": [],
    "p1:secret": [],
    "p1:weapon": [],
    "p1:base": [],
    "p1:fountain": [],
  };
}
