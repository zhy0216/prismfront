// GameState —— 整个引擎的唯一真相源。
//
// 来源：框架 §3.1（字段基线 + 三条核心不变量）、框架 §4.1/§4.2（stack / pendingInput）、
//       框架 §4.3（rng 入状态）、DSL v2 §2.1（round/phase/priority/initiative/
//       firstPasser/consecutivePasses/slots）、DSL v2 §4.1（回合状态机）、
//       DSL v2.1 §11.3（deploy 相位）、IR v1 §2.1/§6.2（bundleId 钉住）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 一条铁律（框架 §3.1、§13 坑 3）★
// ═══════════════════════════════════════════════════════════════════════════
// **状态是纯数据，实体用 id 互相引用。**
//
//   允许：string / number / boolean / null / 纯对象 / 数组
//   禁止：函数、闭包、class 实例、Map、Set、Symbol、BigInt、NaN、Infinity、
//         以及**指向另一个实体对象的引用**（一律换成 EntityId）
//
// 收益（框架 §3.1 原文）：`clone(state)` 几微秒 → MCTS 每秒几万次模拟；
// 回放/存档直接 `JSON.stringify`；挂起点（§4.2）可以整个落盘。
// 探针是架构 §6.1 的第二条测试 —— 它一红就说明架构已经腐化，别去改测试。
//
// 推论 1：卡牌**行为**不进状态，一律 `cardId` → 注册表（框架 §3.1）。
// 推论 2：**辅助函数放模块里，不要挂到状态对象上**（挂上去就是方法 = class 化）。
//         本目录的所有查询都是 `f(state, ...)` 形式，见 `queries.ts`。
// 推论 3：`Record<EntityId, EntityData>` 的键在 JSON 往返后会变成字符串，
//         但 JS 的属性访问对 `entities[12]` 与 `entities["12"]` 是同一个键，
//         整数键的枚举顺序也仍是升序 —— 往返前后行为一致，这是有意选的表示。

import type { BundleId, EntityId, RulesConfig } from "@prismfront/ir";
import type { GameEvent } from "../events/index.ts";
import type { RngState } from "../rng/index.ts";
import type { EntityData } from "./entity.ts";
import type { InputRequest } from "./input.ts";
import type { PlayerData, PlayerId } from "./player.ts";
import type { PendingAction } from "./stack.ts";
import type { ZoneKey } from "./zone.ts";

/**
 * 相位。
 *
 * DSL v2 §2.1 给的是 `"mulligan" | "actions" | "combat" | "over"`，
 * v2 §4.1 的状态机又用了 `round_start` / `round_end` 两个名字，
 * v2.1 §11.3 再插入 `deploy`，最终序列是：
 *
 * ```
 * mulligan → round_start → deploy(若有) → actions → combat → round_end → round_start → …
 *                                                                       ↘ over
 * ```
 *
 * 这里取**并集**，因为 M2 的任务是「状态模型要能容纳」；相位机本身是 M3
 * （里程碑 M3 明确要求一次做到 v2.1 形态，不分两步）。
 */
export const PHASES = [
  "mulligan",
  "round_start",
  "deploy",
  "actions",
  "combat",
  "round_end",
  "over",
] as const;

export type Phase = (typeof PHASES)[number];

/** 对局结果：某一方获胜，或双方 base 同回合归零 → 平局（v2 §0 / §4.1）。 */
export type MatchResult = PlayerId | "draw";

/**
 * 一局对战的完整状态。
 *
 * 字段分组即读法：**外部契约 → 回合与相位 → 实体与位置 → 结算 → 计数器**。
 */
export interface GameState {
  // ── 外部契约（一局之内不变）─────────────────────────────────────────────
  /**
   * 本局钉住的 bundle 标识（IR v1 §2.1）。
   *
   * 结算栈条目用 `<cardId>#<路径>` 引用脚本节点（IR v1 §6.2），一旦卡表热更而 bundleId
   * 没钉住，ref 就会指向错的节点、历史回放随之失真。所以它属于**状态**而不是环境。
   */
  bundleId: BundleId;
  /**
   * 本局规则参数（DSL v2 §6 + §11.5）。
   *
   * 放进状态而不是做成模块级配置：引擎是纯函数（框架 §3.2），同一份状态在任何进程里
   * 结算都必须得到同样的结果；规则跟着状态走，回放才不会被线上配置漂移带偏。
   */
  rules: RulesConfig;

  // ── 协议与随机 ──────────────────────────────────────────────────────────
  /** 单调递增，用于协议去重（框架 §3.1 / §7.3）。逐条**消息**递增，不是逐个事件。 */
  seq: number;
  /**
   * 随机状态（框架 §4.3）。**种子入状态 ⇒ 可回放。**
   * 所有随机一律走 `../rng` 的 `nextInt`；`Math.random` 已被 biome 封死（架构 §6.1）。
   * 投影层（M7）要把它整个抹掉 —— 可预测随机 = 泄露隐藏信息。
   */
  rng: RngState;

  // ── 回合与相位（v2 §2.1 / §4.1，语义由 M3 实现）──────────────────────────
  /** 回合数，从 1 起（v2 §4.1）。建局时为 0，第一个 round_start 置 1。 */
  round: number;
  phase: Phase;
  /** 当前该谁提交 action（v2 §2.1）。行动交替制，每 action 切换一次。 */
  priority: PlayerId;
  /** 本回合先手；战斗快照的遍历顺序从它开始（v2 §2.1 / §4.2 第 ② 步）。 */
  initiative: PlayerId;
  /** 本回合先 pass 的一方，`initiative: "first_passer"` 用（v2 §2.1 / §6）。 */
  firstPasser: PlayerId | null;
  /**
   * 连续 pass 次数（v2 §2.1）。达到 `rules.pass.combatAfterConsecutivePasses` 进入战斗。
   * v2 §2.1 把它写成 `0 | 1 | 2`，但阈值是可配的，故取 `number`。
   * **pass 不锁定**：对手做了 action 就清零（v2 §4.1）。
   */
  consecutivePasses: number;

  // ── 玩家、实体与位置 ────────────────────────────────────────────────────
  /** 定长 2 元组，用 {@link PlayerId} 下标（框架 §3.1）。 */
  players: [PlayerData, PlayerData];
  /**
   * 扁平实体表（框架 §3.1）。**这是实体数据的唯一真相源**，
   * `zones` / `slots` / `players.baseId` 里存的全部是指向这张表的 id。
   */
  entities: Record<EntityId, EntityData>;
  /**
   * 区域表（框架 §3.1 的 `"p0:hand" → [12, 15, 33]`）。
   *
   * **有序列表**：牌库顺序、手牌顺序都由它表达。`sel.zone` 直接枚举它。
   * 不变量：`zones[k]` 含 `id` ⇔ `entities[id].zone === k`。
   */
  zones: Record<ZoneKey, EntityId[]>;
  /**
   * 战线格位：**两侧各一行**，用 {@link PlayerId} 下标（v2 §2.1）。
   *
   * - 每行长度 = `rules.board.slots`（默认 9，v2 §6）；坐标是**一维** `(side, index)`，
   *   双方同索引对齐（v2 §0 规则 1）。v2 §12 已定案：永不加 lane/row 维度。
   * - 元素 `EntityId` = 有人占，`null` = 空格。
   * - `noUncheckedIndexedAccess` 下越界访问得到 `undefined` —— 这**正是**「无效槽」
   *   语义（v2 §3.1）：动作的 SlotRef 解析为无效槽则**静默跳过**，
   *   `cond.occupied(无效槽)` 为 `false`。所以三态 `EntityId | null | undefined`
   *   是要保留并区分的，**不要用 `!` 把 undefined 抹掉**。查询见 `queries.ts` 的
   *   {@link import("./queries.ts").slotOccupant}。
   * - 不变量：`slots[p][i] === id` ⇔ `entities[id].slot === i` 且其 zone 是 `p{p}:board`。
   */
  slots: [(EntityId | null)[], (EntityId | null)[]];

  // ── 结算（框架 §4.1 / §4.2）─────────────────────────────────────────────
  /**
   * 结算栈，**后进先出**（框架 §4.1 用 `stack.pop()`）。
   * 它进状态，是「中途等玩家选择」能免费拿到的前提（框架 §4.2）。
   */
  stack: PendingAction[];
  /** 挂起点：非 null ⇒ 结算循环 break，等 `resume()`（框架 §4.2、IR v1 §6.1）。 */
  pendingInput: InputRequest | null;
  /**
   * 事件日志（框架 §3.3 / §4.1 的 `drainEventLog(state)`）。
   *
   * 表示与工具函数在 `../events/log.ts`，那里写了「为什么放进 state」的完整论证。
   * 不变量：`apply()` / `resume()` 返回时必为空。
   */
  eventLog: GameEvent[];
  /** 胜负。非 null ⇔ `phase === "over"`（v2 §4.1：base 归零判定，双亡为 draw）。 */
  winner: MatchResult | null;

  // ── 计数器（单调递增，保证确定性）───────────────────────────────────────
  /** 下一个实体 id。分配后自增，**永不复用**（回放里 id 必须稳定）。 */
  nextEntityId: EntityId;
  /**
   * 下一个上场序号。实体进入 board / base 时取号并自增。
   * 触发排序（框架 §4.1 时序规则 1）与 `sel.sort` 的稳定性都依赖它。
   */
  nextPlayOrder: number;
}
