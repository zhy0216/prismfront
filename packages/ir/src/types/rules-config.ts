// RulesConfig：一局对战的规则参数。
// 来源：DSL v2 §6（RulesConfig v2）、§11.5（v2.1 增补）、§0（本版假设）、
//       架构 §10 第 2 项与第 6 项。
//
// 注：架构 §10 第 5 项（stunned 进战斗快照条件）不落在这里 ——
// 它是 flag 而不是配置项，定义与说明见 `tag.ts` 的 `FlagName`。

/**
 * 先手规则（DSL v2 §6）。
 *
 * - `"alternate"`：每回合轮换（v2 §0 的默认假设）
 * - `"first_passer"`：**Artifact 式** —— 本回合先 pass 的一方获得下回合先手。
 *   与双 pass 规则天然咬合："何时 pass"从纯节奏决策升级为资源决策
 *   （多打一张牌 = 让出下回合先手）。v2 §6 建议试玩时与 `"alternate"` 对比
 * - `"random_each_round"`：每回合随机（消耗 RNG）
 * - `"fixed_first"`：固定先手
 */
export const INITIATIVE_RULES = [
  "alternate",
  "first_passer",
  "random_each_round",
  "fixed_first",
] as const;

export type InitiativeRule = (typeof INITIATIVE_RULES)[number];

/**
 * 玩家可提交的 action 类型白名单（DSL v2 §6 的 `playerActions`）。
 *
 * v2 §0 开放问题：玩家能否把"移动单位 / 改方向"当作一个 action？
 * **待定，默认后者**（位置与方向只能由卡牌效果改变，更省经济设计）——
 * 所以默认值只有 `"play_card"`，另两项是留着的开关。
 * 注意这只影响 intent 白名单，不影响 DSL 形状：`act.move_to` / `act.set_tag` 早已覆盖。
 */
export const PLAYER_ACTION_KINDS = ["play_card", "move_unit", "set_direction"] as const;

export type PlayerActionKind = (typeof PLAYER_ACTION_KINDS)[number];

/**
 * 一局对战的规则参数（DSL v2 §6 + §11.5）。
 *
 * v2 §6 原文把默认值写成了字面量类型（`board: { slots: 9 }`），那是在写"默认值"而不是
 * "类型"；这里取宽类型，默认值见 {@link DEFAULT_RULES_CONFIG}。
 */
export interface RulesConfig {
  /** 每方一行的格子数。v2 §12 已定案：维度固定一维，只有数量可配。 */
  board: { slots: number };
  /**
   * 水晶（v2 §0 规则 5，炉石式）：每回合**回满且上限递增**。
   * `crystalCap = min(initial + (round-1) * growth, capMax)`（v2 §4.1）。
   */
  crystals: { initial: number; growth: number; capMax: number };
  /** 连续 pass 到几次进入战斗阶段（v2 §4.1，LoR 式双 pass）。 */
  pass: { combatAfterConsecutivePasses: number };
  initiative: InitiativeRule;
  /**
   * 基地血量，归零判负；双方同回合归零 → 平局（v2 §0）。
   *
   * **架构 §10 第 2 项（规范一致性清理）**：v2 §6 仍写 `heroHp: 30`，
   * 但 v2.1 §11.2 已把承伤实体改名 base（英雄改为占格参战的单位）——
   * 此处**改名为 `baseHp`**。
   */
  baseHp: number;
  deck: {
    size: number;
    maxCopies: number;
    startingHand: number;
    drawPerRound: number;
    fatigue: boolean;
  };
  playerActions: readonly PlayerActionKind[];
  /** 单个 action 的计时（秒）。v2 §4.1：行动交替制 = **每 action 一个计时器**，超时视同 pass。 */
  actionSeconds: number;
  reconnectSeconds: number;
  /** 英雄（v2.1 §11.5）。 */
  heroes: {
    /** 卡组外的英雄张数（v2.1 §11.1：30 张任意混色 + 3 张英雄）。 */
    perDeck: number;
    /**
     * 部署节奏。
     *
     * **架构 §10 第 6 项（规范一致性清理）**：v2 §11.5 只给了 `[2, 1]`，
     * 与 §11.3 的文字描述需对齐字段语义 —— 定为
     * **索引 = 第几个回合（0-based），值 = 该回合部署几名**：
     * `[2, 1]` = **r1 部署 2 名、r2 部署 1 名**。各项之和须等于 `perDeck`。
     * （r1 双方同时秘密各选 2 名英雄及格位 → 同时揭示；r2 部署第 3 名，v2.1 §11.3。）
     */
    deploySchedule: readonly number[];
    /**
     * 复活延迟（回合）。
     * 英雄阵亡 → 进 `"fountain"` 区，`respawnAt = 当前回合 + 1 + respawnDelay`，
     * 即**恰好缺席一整回合**，到期后在 deploy 阶段重新选格上场（v2.1 §11.3、里程碑 M6）。
     */
    respawnDelay: number;
  };
}

/**
 * 默认规则参数：DSL v2 §6 + §11.5 的字面值原样落地
 * （`heroHp` → `baseHp` 见架构 §10 第 2 项）。
 *
 * 节奏参照（《数值基准》§5）：水晶 r1=5 … r6+=10，30 血在 r5-r7 耗尽，目标局长 6±1 回合。
 */
export const DEFAULT_RULES_CONFIG = {
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
} as const satisfies RulesConfig;
