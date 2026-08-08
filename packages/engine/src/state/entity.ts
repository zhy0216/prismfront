// EntityData：扁平实体表里的一行 —— 状态模型的核心。
// 来源：框架 §3.1（字段基线 + 三条不变量）、DSL v2 §2.2（slot）、DSL v2 §2.3（direction 是 Tag）、
//       DSL v2.1 §11.2/§11.3（base 实体、fountain 与 respawnAt）、IR v1 §2.3（附魔）。
//
// **三条必须守死的不变量**（框架 §3.1、§13 坑 3）：
//   1. 纯数据：不许出现函数 / 闭包 / class 实例 / Map / Set / Symbol。
//   2. 实体之间**用 id 互相引用**（`enchantments[].source` 是 id，不是对象）。
//   3. 行为不进状态：`cardId` 指向注册表，卡牌脚本永远从注册表取。
// 探针是架构 §6.1 的第二条测试（`JSON.parse(JSON.stringify(state))` 往返后结算结果一致）。

import type { CardId, Duration, EnchantId, EntityId, FlagName, TagKey } from "@prismfront/ir";
import type { PlayerId } from "./player.ts";
import type { ZoneKey } from "./zone.ts";

/**
 * 一个实体的全部属性值（IR v1 §3.2 `num.attr` / §3.4 `act.set_tag` 的读写对象）。
 *
 * 写成 `Record<TagKey, number>` 这样的**全量表**而不是 `Partial`：
 * - `TagKey` 是有限字面量联合 → 映射类型 → `noUncheckedIndexedAccess` 不会加 `undefined`，
 *   于是 `tags.atk` 直接是 `number`，全引擎少一整类空值分支；
 * - 缺省即 0，与 v2 §2.3「`base.direction` 默认 0」一致。
 */
export type TagValues = Record<TagKey, number>;

/** 全零属性表。取值集合与 ir 的 `TAG_KEYS` 对齐（engine 不许 import ir 的值，故本地重列）。 */
export const ZERO_TAGS = {
  atk: 0,
  health: 0,
  cost: 0,
  direction: 0,
  armor: 0,
} as const satisfies TagValues;

/** 造一张属性表；未给出的键为 0。 */
export function createTagValues(init?: Partial<TagValues>): TagValues {
  return { ...ZERO_TAGS, ...init };
}

/** 逐键相加，返回新表（光环/附魔叠加用；不改入参）。 */
export function addTagValues(a: TagValues, b: Partial<TagValues>): TagValues {
  return {
    atk: a.atk + (b.atk ?? 0),
    health: a.health + (b.health ?? 0),
    cost: a.cost + (b.cost ?? 0),
    direction: a.direction + (b.direction ?? 0),
    armor: a.armor + (b.armor ?? 0),
  };
}

/**
 * 标志位掩码（框架 §3.1 的 `flags: number // bitmask`）。
 *
 * 用 bitmask 而不是对象，是因为它是**纯数字**：clone / JSON 往返 / 哈希都最便宜，
 * 且不会因为键顺序影响序列化结果。
 */
export type FlagMask = number;

/**
 * 各标志位对应的比特。
 *
 * `satisfies Record<FlagName, number>` 提供**穷尽检查**：ir 的 `FlagName` 新增一项而这里
 * 没跟上，编译即报错 —— 这是在「不许 import ir 的值」（架构 §2.2 禁令 1）的前提下
 * 还能拿到穷尽性的写法。
 */
export const FLAG_BITS = {
  /** 圣盾（主题名「辉膜」）。挡一次出手，实现是拦截器（IR v1 §10.6，M5）。 */
  divine_shield: 1 << 0,
  /** 眩晕（主题名「滞光」）。战斗快照的出手条件是 `atk > 0 && !stunned`（架构 §10 第 5 项）。 */
  stunned: 1 << 1,
  /** 已被沉默。`act.silence` 的落点。 */
  silenced: 1 << 2,
} as const satisfies Record<FlagName, number>;

/** 空掩码。 */
export const NO_FLAGS: FlagMask = 0;

/** 掩码是否含某标志位。 */
export function maskHas(mask: FlagMask, flag: FlagName): boolean {
  return (mask & FLAG_BITS[flag]) !== 0;
}

/** 返回置位/清位后的**新**掩码（纯函数，不改入参）。 */
export function maskWith(mask: FlagMask, flag: FlagName, value: boolean): FlagMask {
  return value ? mask | FLAG_BITS[flag] : mask & ~FLAG_BITS[flag];
}

/**
 * 挂在实体上的一条附魔**实例**。
 *
 * 框架 §3.1 的示例把它写成 `enchantments: EntityId[]`（附魔也是实体）。这里改成
 * **内联的纯数据记录**，理由是 `zones` 才是实体的权威枚举来源
 * （`sel.zone` 直接读它，v2 §3.2 起还规定了 board 的枚举顺序）：
 * 附魔实体既没有合适的区域可放，放进任何一个区域又会被选择器扫到。
 * 内联记录同样满足框架 §3.1 的两条硬约束 —— 纯数据、且 `source` 是 **id 引用**。
 *
 * 附魔的**行为**（mods / flags / script）不进状态，按 `ench` 去 bundle 里查（框架 §3.1）。
 */
export interface AttachedEnchantment {
  /** 指向 bundle 的 `enchantments[ench]`（IR v1 §2.3）。 */
  ench: EnchantId;
  /** 施加者实体 id。`duration: "while_source_alive"` 靠它判定存续（IR v1 §2.3）。 */
  source: EntityId;
  /**
   * 存续时长（IR v1 §2.3、v2 §3.5）。
   * 剥离时机：`end_of_round` → round_end；`end_of_combat` → 战斗第 ⑤ 步；
   * `while_source_alive` → source 死亡时；`permanent` → 只有 `act.silence` 能剥。
   */
  duration: Duration;
}

/**
 * 一个运行时实体（框架 §3.1 + v2 §2.2 + v2.1 §11.3）。
 *
 * 血量记账（ir 的 `TagKey` 注释把这条留给 M2 定案）：
 * **`tags.health` 是生效血量上限，`damage` 是累计已受伤害，当前血量 = `tags.health - damage`。**
 * 于是「+2/+1 的附魔」只加上限、不治疗，`act.heal` 减 `damage` 且不越过 0，
 * 死亡判定是 `damage >= tags.health`（M2 的死亡结算走这条，见 `../resolve/`）。
 */
export interface EntityData {
  id: EntityId;
  /**
   * 卡牌 id → 去注册表查行为（框架 §3.1）。**行为不进状态。**
   * base 实体没有对应卡，用保留值 {@link BASE_CARD_ID}。
   */
  cardId: CardId;
  /** 原始拥有者。当前控制者看 `zone` 的玩家位（`act.steal` 会让两者不同）。 */
  owner: PlayerId;
  /** 所在区域键。它同时是 `state.zones` 的键 —— 与该键下的列表**必须始终一致**。 */
  zone: ZoneKey;
  /**
   * 在场格位（v2 §2.2）：`zone` 为 board 时是 `[0, rules.board.slots)`，否则 `null`。
   * 它与 `state.slots[控制者][slot] === id` **必须始终一致**。
   * v2.1 §11.2 起英雄也占格，`slot` 不再恒为 null；base 恒为 `null`。
   */
  slot: number | null;
  /**
   * 上场序号，触发排序用（框架 §4.1 时序规则 1：同一方按 playOrder **升序**，先上场的先触发）。
   * 进入 board / base 时从 `state.nextPlayOrder` 取号；未上场的实体为 0。
   */
  playOrder: number;
  /** 卡面原始值（框架 §3.1）。`act.silence` 把 `tags` 复位到它 —— 包括 direction（v2 §2.3）。 */
  base: TagValues;
  /**
   * 计算后的当前值（框架 §3.1）。
   * `tags = base + Σ附魔.mods + Σ生效光环.mods`，**每步重算而非增量**（框架 §4.1 时序规则 4）。
   */
  tags: TagValues;
  /** 卡面原始标志位。 */
  baseFlags: FlagMask;
  /** 计算后的当前标志位 = `baseFlags + Σ附魔.flags + Σ生效光环.flags`，与 `tags` 同一套重算管线。 */
  flags: FlagMask;
  /** 挂在身上的附魔实例，按施加顺序。`act.silence` 清空它。 */
  enchantments: AttachedEnchantment[];
  /** 累计已受伤害。见接口头部的血量记账说明。 */
  damage: number;
  /**
   * 已经烧掉的 `once` 触发器的键（IR v1 §4.1「触发一次后自动移除」）。
   *
   * ★ 为什么这件事必须落在**实体**上、而不是某个闭包或模块级 Set：
   * 框架 §4.2 要求「结算中途整个 state 可序列化落盘、revive 之后接着跑」。
   * 一次性触发器的"已经用掉了"是**对局进度**的一部分 —— 存在状态之外，
   * 断线重连之后那张卡就能再触发一次，而这种 bug 只在重连路径上显形。
   * 于是它与 `damage` / `enchantments` 同级：纯数据、跟着实体走、JSON 往返逐字相等。
   *
   * 键的形状由 `../resolve/triggers.ts` 的 `triggerKeyOf` 定义（本文件不重复一遍），
   * 那里也说明了为什么不能用「数组下标」当键。**「移除」是记账而不是真删**：
   * 触发器写在 bundle 的 `card.script` 里，而**行为不进状态**（本文件头不变量 3），
   * 引擎删不掉也不该删 —— 能记的只有"这一条已经烧过了"。
   *
   * 绝大多数实体上恒为空数组（`once` 是少数派），代价与 `enchantments: []` 同级。
   */
  firedOnce: string[];
  /**
   * 英雄在复燃泉里的可再部署回合（v2.1 §11.3）：`round >= respawnAt` 时可在 deploy 阶段上场。
   * 不在等待的实体为 `null`。阵亡时置为 `当前回合 + 1 + rules.heroes.respawnDelay`。
   * M6 实现语义，M2 只留字段。
   */
  respawnAt: number | null;
}

/**
 * base 实体的保留 cardId（v2.1 §11.2）。
 *
 * base 是承接「方向指空格」伤害、并做胜负判定的实体，它**不是一张卡**：没有脚本、
 * 不进卡组、注册表里查不到。用一个不可能与真实卡 id（如 `"BASE_R09"` / `"GRID_001"`）
 * 相撞的保留值占位。
 */
export const BASE_CARD_ID = "__base";
