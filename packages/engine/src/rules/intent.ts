// Intent / ApplyResult / IllegalReason —— 引擎的**输入**与**回执**形状。
// 来源：框架 §3.2（`apply(state, intent): ApplyResult` 的签名与 `ok:false` 语义）、
//       框架 §7.3（协议里的 Intent 形态）、IR v1 §6.1（挂起点的回应）。
//
// ═══════════════════════════════════════════════════════════════════════════
// M2 的 intent 集是**走查专用**的，M3 会整套换掉
// ═══════════════════════════════════════════════════════════════════════════
// 真正的 intent 集（`play_card` / `pass` / `deploy` / `mulligan` / `concede`）属于
// 回合状态机（v2 §4.1 / v2.1 §11.3），那是 M3。M2 只需要够跑通
// 「抽牌 → 放单位到格 → 手动 strike → 死亡」这条链，外加架构 §6.1 的两条确定性测试。
//
// 所以这里的四条 intent 是**按走查的四步反推**出来的最小集，其中只有 `respond`
// 会原样留到 M3（它对应框架 §7.3 的 `{t:"respond", chosen}`，是挂起协议的一半）。
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
 * 玩家意图（M2 走查子集，见文件头）。
 *
 * 判别键用 `t`，与框架 §7.3 的协议形状一致。
 */
export type Intent =
  /** 抽牌。`count` 缺省 1；牌库抽空即停（疲劳是 M3）。 */
  | { t: "draw"; player: PlayerId; count?: number }
  /**
   * 把手牌里的一张牌放到本方第 `slot` 格。
   *
   * M3 的 `play_card` 的前身：M2**不扣水晶、不查费用、不跑卡牌的 `play` 脚本**
   * （水晶是 M3、脚本是 M4）。名字带 `_unit` 是提醒它只做"上场"这一件事。
   */
  | { t: "play_unit"; player: PlayerId; card: EntityId; slot: number }
  /**
   * 让本方一个在场单位立即出手一次（`act.strike`，v2 §3.4）。
   *
   * ⚠ 这**不是**玩家可以在正式对局里做的动作 —— v2 §3.4 已经删掉 `act.attack`，
   *   出手只由战斗阶段的快照（v2 §4.2，M3）与卡牌效果驱动。它是 M2 的"手动 strike"，
   *   存在的唯一目的是在没有战斗阶段的情况下把伤害与死亡这条链跑通。M3 删。
   */
  | { t: "strike"; player: PlayerId; attacker: EntityId; target: EntityId }
  /**
   * 回应挂起点（框架 §4.2 / §7.3 / IR v1 §6.1）。
   *
   * `chosen: null` = 放弃，仅当 `pendingInput.optional` 为真（或候选集为空）时合法。
   * 这一条 M3 原样保留。
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
  /** 选择不在 `pendingInput.options` 内，或在不可放弃的挂起点上放弃（IR v1 §6.1）。 */
  "invalid_choice",
  /** `player` 不是 0/1，或不是该他做这个选择。 */
  "wrong_player",
  /** intent 里的实体 id 在实体表里查不到。 */
  "unknown_entity",
  /** 实体不在这个动作要求的区域（打牌要在手牌、出手要在场上）。 */
  "wrong_zone",
  /** 实体不由发起方控制。 */
  "not_controlled",
  /** 格位越界或不是整数（v2 §3.1 的无效槽）。 */
  "invalid_slot",
  /** 目标格已被占。 */
  "slot_occupied",
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
