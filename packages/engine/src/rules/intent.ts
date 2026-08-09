// Intent / ApplyResult / IllegalReason —— 引擎的**输入**与**回执**形状。
// 来源：框架 §3.2（`apply(state, intent): ApplyResult` 的签名与 `ok:false` 语义）、
//       框架 §7.3（协议里的 Intent 形态）、DSL v2 §4.1（回合状态机）、
//       DSL v2 §6（`playerActions` 白名单）、DSL v2.1 §11.3（deploy 聚合成单条 intent）、
//       IR v1 §6.1（挂起点的回应）。
//
// ═══════════════════════════════════════════════════════════════════════════
// M3：真正的 intent 集（M2 的走查子集已整套换掉）
// ═══════════════════════════════════════════════════════════════════════════
// M2 那四条（`draw` / `play_unit` / `strike` / `respond`）是**按走查四步反推**的临时集，
// 它们各自的去向：
//   `draw`      → 删。抽牌不再是玩家动作，而是 `round_start` 的一步（v2 §4.1），
//                 牌库抽空则按 `deck.fatigue` 走疲劳。
//   `play_unit` → 改造成 `play_card`：多了扣水晶、查费用，以及 M4 的"跑 `play` 脚本"接入点。
//   `strike`    → 删。v2 §3.4 已经删掉 `act.attack`，出手**只**由战斗阶段的快照
//                 （v2 §4.2）与卡牌效果驱动，玩家没有"手动出手"这个动作。
//                 （`act.strike` 这个**动作**当然还在，只是不再有意图能直接触发它。）
//   `respond`   → 原样保留，它是框架 §7.3 挂起协议的一半。
//
// 新集合的六条按「谁在什么相位提交」分组：
//   mulligan  —— `mulligan` 相位，双方聚合
//   deploy    —— `deploy` 相位，双方聚合（v2.1 §11.3）
//   play_card —— `actions` 相位，持 `priority` 的一方
//   pass      —— `actions` 相位，持 `priority` 的一方
//   concede   —— 任意相位，任意一方
//   respond   —— 任意挂起点，由 `pendingInput.player` 提交
//
// ═══════════════════════════════════════════════════════════════════════════
// 为什么 `mulligan` / `deploy` 是「双方聚合的单条 intent」
// ═══════════════════════════════════════════════════════════════════════════
// v2.1 §11.3 对 deploy 写得很明确：服务端聚合双方的**秘密选择**之后喂**单个** intent。
// mulligan 是同一种形态（同时、秘密、互不影响），这里按同一条办法处理。收益有三：
//   1. **引擎保持单输入模型**：一次 `apply` 一条 intent，不需要为"同时选择"发明
//      第二种输入形态，也不需要 `resolve()` 之外的第二种等待机制；
//   2. **不需要额外状态字段**记「谁已经提交了」——那种字段一旦进 `GameState`，
//      投影（M7）、回放、快照全都要跟着处理它；
//   3. **不泄露顺序信息**：没有"先收谁的"这个问题，也就没有由此产生的信息泄露。
// 代价是这两条 intent 的 `player` 字段语义弱（它是**提交者**，不是"这条选择属于谁"），
// 所以各自的 `toss` / `picks` 都写成**按 PlayerId 下标的 2 元组**，
// 归属由下标表达而不是由 `player` 表达。
//
// ⚠ Intent 最终应当住在 `@prismfront/shared`（架构 §2.3）。但 engine 的 dependencies
//   恒为空（§2.2 禁令 1），连 shared 也不能依赖 —— 所以类型先落在 engine，
//   M9 接协议层时由 shared **重新声明**一份结构相同的（或反过来让 shared 抄 engine）。
//
// ⚠ **Intent 来自网络，是不可信输入**。所以 `apply()` 对 `player` 取值、实体 id、
//   格位下标全部做运行时校验，而不是只靠 TS 类型 —— 类型在运行时不存在。

import type { CardId, EntityId } from "@prismfront/ir";
import type { GameEvent } from "../events/index.ts";
import type { GameState, PlayerId } from "../state/index.ts";

/**
 * 一次英雄部署的选择：把复燃泉里的 `hero` 放到本方第 `slot` 格（v2.1 §11.3）。
 *
 * 纯数据的小记录，随 intent 从网络进来，因此每个字段都要在 `apply()` 里运行时校验。
 */
export interface DeployPick {
  /** 复燃泉里的英雄实体 id。 */
  readonly hero: EntityId;
  /** 本方战线的格位下标，`[0, rules.board.slots)`。 */
  readonly slot: number;
}

/**
 * 玩家意图（M3 的完整集，见文件头）。
 *
 * 判别键用 `t`，与框架 §7.3 的协议形状一致。
 */
export type Intent =
  /**
   * 起手调度（`mulligan` 相位）。`toss[p]` = 玩家 p 要换掉的手牌，空数组 = 不换。
   *
   * **双方聚合的单条 intent**（见文件头）：`player` 是提交者（服务端），
   * 选择的归属由 `toss` 的下标表达。
   */
  | { t: "mulligan"; player: PlayerId; toss: readonly [readonly EntityId[], readonly EntityId[]] }
  /**
   * 英雄部署（`deploy` 相位，v2.1 §11.3）。`picks[p]` = 玩家 p 这一回合部署的英雄与格位。
   *
   * 同样是**双方聚合的单条 intent**。每方的条数必须恰好等于
   * `min(本回合排期, 泉里可部署的名数)` —— 少部署不是一种战术选择，
   * 而是 v2.1 §11.3 规定的"该部署几名就部署几名"。
   */
  | {
      t: "deploy";
      player: PlayerId;
      picks: readonly [readonly DeployPick[], readonly DeployPick[]];
    }
  /**
   * 打出手牌里的一张牌到本方第 `slot` 格（`actions` 相位，持 `priority` 的一方）。
   *
   * 这是 `rules.playerActions` 里**唯一开放**的行动类型：另两项（`move_unit` /
   * `set_direction`）恒关，且在配置校验期就会抛错（`validate-config.ts` 的决策 #3），
   * 所以这里不需要一条"玩家移动单位"的 intent，将来也不该加。
   *
   * M4 之前 `slot` 是必填的：没有卡表就分不出随从牌与法术牌（法术不占格）。
   */
  | { t: "play_card"; player: PlayerId; card: EntityId; slot: number }
  /** 过牌（`actions` 相位）。连续 `rules.pass.combatAfterConsecutivePasses` 次进入战斗。 */
  | { t: "pass"; player: PlayerId }
  /**
   * 认输。任意相位、任意一方都可以提交，对手直接获胜。
   *
   * 引擎需要它而不是让服务端直接改状态：胜负判定必须只有一个实现
   * （`winner` 与 `phase` 要一起写，见 `state/game-state.ts` 的不变量），
   * 而且断线超时判负（M9）最终也会落到这条意图上。
   */
  | { t: "concede"; player: PlayerId }
  /**
   * 回应挂起点（框架 §4.2 / §7.3 / IR v1 §6.1）。
   *
   * `chosen: null` = 放弃，仅当 `pendingInput.optional` 为真（或候选集为空）时合法。
   */
  | { t: "respond"; player: PlayerId; chosen: EntityId | CardId | null };

/** {@link Intent} 的判别键取值全集。 */
export type IntentKind = Intent["t"];

/**
 * 意图被拒的原因（框架 §3.2 的 `IllegalReason`）。
 *
 * 全是**稳定的机器可读串**：协议层（M9）会原样下发给客户端做文案映射，
 * 所以不要为了好读改词，也不要往里塞动态内容（实体 id 之类）。
 */
export const ILLEGAL_REASONS = [
  /** 对局已结束（`state.winner !== null`）。 */
  "game_over",
  /** 正挂起等某人做选择，此时只接受 `respond`（框架 §4.2）。 */
  "awaiting_input",
  /** 发了 `respond`，但当前没有挂起点。多半是消息重放或 seq 错位。 */
  "not_suspended",
  /**
   * 这条意图不属于当前相位（v2 §4.1 的回合状态机）。
   *
   * M3 新增。典型来源是客户端的**消息竞速**：玩家在 `actions` 相位按下"打出"的同时，
   * 对手的第二次 pass 已经把对局推进到 combat/下一回合了。协议层应当把它当作
   * "重新拉一次状态再来"，而不是当作作弊。
   */
  "wrong_phase",
  /** 选择不在 `pendingInput.options` 内，或在不可放弃的挂起点上放弃（IR v1 §6.1）。 */
  "invalid_choice",
  /** `player` 不是 0/1，或不是该他做这个选择（不持 `priority`、不是挂起点指定的人）。 */
  "wrong_player",
  /** intent 里的实体 id 在实体表里查不到。 */
  "unknown_entity",
  /** 实体不在这个动作要求的区域（打牌要在手牌、部署的英雄要在复燃泉）。 */
  "wrong_zone",
  /** 实体不由发起方控制。 */
  "not_controlled",
  /** 格位越界或不是整数（v2 §3.1 的无效槽）。 */
  "invalid_slot",
  /** 目标格已被占（含同一条 intent 内两个选择撞同一格）。 */
  "slot_occupied",
  /** 水晶不够付这张牌的生效费用（v2 §2.1）。M3 新增。 */
  "not_enough_crystals",
  /**
   * **色门未开**：这张牌的某个颜色没有己方存活在场的英雄（v2.1 §11.4）。M6 新增。
   *
   * 这是唯一一条**会随盘面反复开合**的拒绝原因：英雄阵亡的那一刻起，该色的牌
   * （含以它为其中一色的融合卡）全部打不出，直到那个颜色重新有英雄站在战线上。
   * 客户端应当据此把手牌置灰，而不是等玩家点下去才收到拒绝。
   *
   * ⚠ 它**不带**"缺哪个颜色"这个信息 —— 本表的取值是稳定机器串，不塞动态内容
   *   （见上面的说明）。结构化的那一份由 `apply.ts` 的 `lockedColorsOf` 给，
   *   M7 的 legalActions 直接调它，而不是去解析这个串。
   */
  "color_locked",
  /** `t` 不是已知的意图类型（不可信输入的兜底）。 */
  "unknown_intent",
] as const;

export type IllegalReason = (typeof ILLEGAL_REASONS)[number];

/**
 * `apply()` 的回执（框架 §3.2 原文签名）。
 *
 * - `ok: true` —— `state` 是**新**状态（入参状态一字未改），`events` 是这一段的事件流
 *   （框架 §3.3：输出是事件流，不是状态 diff）。
 * - `ok: false` —— **状态不变**，只回一个原因码。
 */
export type ApplyResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; code: IllegalReason };
