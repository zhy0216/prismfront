// 流水线第 4 步：事后触发入栈（框架 §4.1 的 `queueTriggers(state, emitted)`）。
// 来源：框架 §4.1 时序规则 1 与规则 2、IR v1 §4.1（Trigger 的形状）、
//       DSL v2 §5（事件表）、`events/event.ts`（`engine.*` 不进触发器词汇表）。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 本文件同时承担两件事，务必分清 ★
// ═══════════════════════════════════════════════════════════════════════════
//   A. **排序与入栈**（框架 §4.1 时序规则 1 + 规则 2）—— 这是**流水线**的一部分，
//      M2 就要做对，并且已经有测试钉住：{@link compareTriggerOrder} / {@link sortTriggers}。
//   B. **事件 → 触发器的匹配**（`trigger.on` / `filter` / `cond` / `zone` / `once`）
//      —— 这是**卡牌语义**，需要卡表与 M4 的求值器，属于 M5：
//      {@link collectTriggerSubscriptions} 在 M2 恒返回空。
//
// 于是 M5 只需要把 B 填掉，A 与流水线一行都不用改。
// B 的空实现**不抛 TODO 异常**：M2 没有卡表 ⇒ 没有任何实体订阅事件 ⇒ 匹配结果为空，
// 这是**语义正确的退化情形**而不是占位符（抛异常会让 M2 的走查跑不通）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 时序规则 1（框架 §4.1 原文）
// ═══════════════════════════════════════════════════════════════════════════
// > **触发顺序**：当前回合玩家的触发器先于对手；同一方按实体 `playOrder` 升序
// > （先上场的先触发）。
//
// 落到代码里是 {@link compareTriggerOrder} 的三级键：
//   ① 是否属于「当前回合玩家」（是 → 排前）
//   ② `playOrder` 升序
//   ③ 实体 id 升序（兜底，保证是**全序** —— 两个实体不可能有相同 id，
//      于是排序结果与输入顺序、与引擎的排序算法实现都无关。确定性不能靠"稳定排序"
//      这种实现细节，架构 §6.1 的哈希比对会把任何抖动放大成假红。）
//
// ═══════════════════════════════════════════════════════════════════════════
// 时序规则 2（框架 §4.1 原文）
// ═══════════════════════════════════════════════════════════════════════════
// > **触发是入栈而非立即执行**：A 触发 B，B 要等 A 这一步的死亡结算做完才开始。
//
// 落到代码里就是本文件**只 push、不执行**：`queueTriggers` 返回后，流水线继续跑
// 第 5 步死亡结算与第 6 步光环重算，触发器要等下一次 `stack.pop()` 才轮到。
// 由于栈是 LIFO 而排序给的是**执行顺序**，入栈必须逆序 —— 那一次反转关在
// `push.ts` 的 `pushPendingInOrder` 里，本文件不自己写 `stack.push`。

import type { EntityId } from "@prismfront/ir";
import type { GameEvent, RuleEvent } from "../events/index.ts";
import { isRuleEvent } from "../events/index.ts";
import type { GameState, PendingAction, PlayerId } from "../state/index.ts";
import { controllerOf, getEntity } from "../state/index.ts";
import { pushPendingInOrder } from "./push.ts";

/**
 * 一条待入栈的触发器：**宿主实体 + 已经造好的栈条目**。
 *
 * 拆成这两个字段而不是直接给 `PendingAction`，是因为排序（时序规则 1）要看宿主实体的
 * 控制者与 `playOrder`，而栈条目本身只带 `ctx`（其 `self` 恰好就是宿主，但那是
 * M5 的约定，排序不该依赖别人的约定）。
 *
 * 纯数据：`owner` 是 id 引用，`pending` 是纯 JSON（框架 §3.1）。
 */
export interface QueuedTrigger {
  /** 触发器所在的实体（谁的触发器）。 */
  readonly owner: EntityId;
  /** 要压入结算栈的条目。M5 造它时把 `ctx.event` 绑成触发它的那条事件。 */
  readonly pending: PendingAction;
}

/**
 * 时序规则 1 里的「当前回合玩家」。
 *
 * 本游戏是**共享回合 + 行动交替**（DSL v2 §4.1），没有炉石那样的「我的回合」，
 * 所以这个概念要显式定义一次，并且**只定义在这一处**：
 *
 * - `actions` 相位：`priority` —— 正在提交行动的那一方，就是把这一切引发出来的人，
 *   与炉石「当前回合玩家」语义最接近；
 * - 其余相位（`round_start` / `deploy` / `combat` / `round_end` / `mulligan` / `over`）：
 *   `initiative` —— 这些相位没有单个"正在行动"的玩家（deploy 由服务端聚合双方选择后
 *   喂**单个** intent，v2.1 §11.3；combat 是全场同时结算，v2 §4.2），
 *   本回合先手方是唯一稳定且已被规范用作遍历起点的排序基准（v2 §4.2 第 ② 步）。
 *
 * ⚠ 这是 M2 就必须拍板、但真正影响面在 M3（相位机）与 M5（触发器）的一个定义。
 *   若 M3/M5 认为该换成别的口径，**只改这一个函数**，全引擎的触发排序、拦截器排序
 *   会一起跟上。
 */
export function activePlayer(state: GameState): PlayerId {
  return state.phase === "actions" ? state.priority : state.initiative;
}

/** 排序键：① 是否当前回合玩家（0 优先）② playOrder ③ 实体 id。 */
interface TriggerRank {
  side: 0 | 1;
  playOrder: number;
  id: EntityId;
}

function rankOf(state: GameState, owner: EntityId): TriggerRank {
  const entity = getEntity(state, owner);
  if (entity === undefined) {
    // 宿主已经不在实体表里（例如触发器排队期间被 `act.transform` 换掉了 id）。
    // 排到最后而不是抛错 —— 悬空 id 是常态而不是错误（`state/queries.ts` 的 `getEntity`）。
    return { side: 1, playOrder: Number.MAX_SAFE_INTEGER, id: owner };
  }
  return {
    side: controllerOf(entity) === activePlayer(state) ? 0 : 1,
    playOrder: entity.playOrder,
    id: owner,
  };
}

/**
 * 时序规则 1 的比较函数：**当前回合玩家优先，同方按 playOrder 升序**。
 *
 * 负数 ⇒ `a` 先触发。三级键见文件头；第三级用实体 id 兜底，保证全序。
 */
export function compareTriggerOrder(state: GameState, a: QueuedTrigger, b: QueuedTrigger): number {
  const ra = rankOf(state, a.owner);
  const rb = rankOf(state, b.owner);
  if (ra.side !== rb.side) {
    return ra.side - rb.side;
  }
  if (ra.playOrder !== rb.playOrder) {
    return ra.playOrder - rb.playOrder;
  }
  return ra.id - rb.id;
}

/**
 * 按时序规则 1 排序，返回**执行顺序**的新数组（不改入参）。
 *
 * 排序的是「执行顺序」不是「入栈顺序」—— 反转交给 `push.ts`。
 */
export function sortTriggers(
  state: GameState,
  queued: readonly QueuedTrigger[],
): readonly QueuedTrigger[] {
  return [...queued].sort((a, b) => compareTriggerOrder(state, a, b));
}

/**
 * 找出订阅了某条规则事件的全部触发器。
 *
 * ★ **M5 的填空点**（M2 恒返回空数组）。要做的事：
 *   1. 枚举候选宿主：默认 `zone: "board"`（IR v1 §4.1），亡语写 `"graveyard"`、
 *      手牌触发写 `"hand"` —— 按 `trigger.zone` 决定去哪个区域找；
 *   2. `on` 匹配事件名（`EventName`，25 个，见 `events/event.ts`）；
 *   3. `filter` 判定：键是事件负载的实体字段，用 `eventEntity(event, field)` 取 id，
 *      值是 `Sel`，需要 M4 的求值器；
 *   4. `cond` 判定（可访问 `sel.event.*`）；
 *   5. `once` 的一次性移除；
 *   6. 为每个命中的触发器造条目：`pushScript` 形态的 ref（IR v1 §6.2）+
 *      `ctx = { self: 宿主, event: 本事件, ... }`。
 *
 * 关于**亡语**：`deathrattle` 只是 `{on:"unit_died", filter:{target:SELF}, zone:"graveyard"}`
 * 的糖（IR v1 §4.1），引擎内部一律当 trigger 处理 —— 所以框架 §4.1 时序规则 3 说的
 * 「亡语按 playOrder 排队」，落到实现上就是死亡结算把 `unit_died` 事件交给本模块，
 * 由这里按规则 1 排序入栈。`deaths.ts` 不需要另写一套亡语排队逻辑。
 *
 * 参数在 M2 未被使用，签名保持不变，M5 直接在函数体里填。
 */
export function collectTriggerSubscriptions(
  _state: GameState,
  _event: RuleEvent,
): readonly QueuedTrigger[] {
  return [];
}

/**
 * 把**已经排好序**的一批触发器压入结算栈（规则 2），返回入栈条目数。
 *
 * 与 {@link queueTriggers} 分开导出，是为了让「排序 + 入栈」这段**流水线逻辑**
 * 能被独立测到 —— M2 的 {@link collectTriggerSubscriptions} 恒返回空，
 * 若不拆开，规则 1/2 的落地代码在整个 M2 期间都是跑不到的死代码，
 * 等 M5 接上真匹配时才第一次执行，那时出问题就分不清是匹配错了还是排序错了。
 *
 * **只 push、不执行**（规则 2）：压完就返回，触发器要等下一次 `stack.pop()` 才轮到。
 * LIFO 的那一次反转由 `push.ts` 负责，本文件不碰 `state.stack.push`。
 */
export function enqueueTriggers(state: GameState, ordered: readonly QueuedTrigger[]): number {
  if (ordered.length === 0) {
    return 0;
  }
  const items: PendingAction[] = [];
  for (const trigger of ordered) {
    items.push(trigger.pending);
  }
  pushPendingInOrder(state, items);
  return items.length;
}

/**
 * 把一批事件匹配出的触发器**按时序规则 1 排序后入栈**（框架 §4.1 第 4 步）。
 *
 * 返回入栈条目数，方便调用方与测试断言「这一步排了几个触发」。
 *
 * 两条顺序约定：
 * - **事件之间保持发出顺序**（`events/event.ts`：顺序即数组顺序）。一次 `act.strike`
 *   先发 `struck` 再发 `damaged`，那么监听 `struck` 的触发器整体排在监听 `damaged` 的前面。
 * - **同一条事件内部按规则 1 排序**。
 * 两者合起来是「事件序为外层键、规则 1 为内层键」的字典序，跨批次也稳定。
 *
 * `engine.*` 事件（目前只有 `engine.random_picked`）**不进触发器词汇表**，
 * 在这里被 `isRuleEvent` 挡掉 —— 否则等于允许卡牌"监听随机数"（见 `events/event.ts`）。
 */
export function queueTriggers(state: GameState, events: readonly GameEvent[]): number {
  const ordered: QueuedTrigger[] = [];
  for (const event of events) {
    if (!isRuleEvent(event)) {
      continue;
    }
    const matched = collectTriggerSubscriptions(state, event);
    for (const trigger of sortTriggers(state, matched)) {
      ordered.push(trigger);
    }
  }
  return enqueueTriggers(state, ordered);
}
