// resolve() —— 整个引擎的心脏（框架 §4.1）。
//
// > 整个引擎的心脏。90% 的卡牌 bug 来自时序，所以时序必须是写死的、可打印的、可测的。
// >                                                        —— 框架 §4.1 开篇
//
// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 必须明文写进文档的四条时序规则（框架 §4.1 原文，逐字抄录）★★★
//     「否则每张卡都会有人来问」—— 规范原话。改动本文件前先读完这四条。
// ═══════════════════════════════════════════════════════════════════════════
//
// 1. **触发顺序**：当前回合玩家的触发器先于对手；同一方按实体 `playOrder` 升序
//    （先上场的先触发）。
//
// 2. **触发是入栈而非立即执行**：A 触发 B，B 要等 A 这一步的死亡结算做完才开始。
//
// 3. **死亡结算是独立阶段**：每个 action 结算完统一检查 `health <= 0`，批量移入墓地，
//    亡语按 `playOrder` 排队。中途新死的要再跑一轮，直到不动点。
//
// 4. **光环是重算而非增量**：`tags = base + 所有附魔 + 所有生效光环`，每步重算。
//    实体数量在 20 量级，重算成本可忽略，但省掉了「光环失效时忘了减回去」这一整类 bug。
//
// ── 四条规则各自落在哪个文件（改语义请改那里，不要改本文件的六步顺序）──────────
//   规则 1 → `triggers.ts` 的 `compareTriggerOrder` / `activePlayer`
//   规则 2 → `triggers.ts` 的 `queueTriggers`（只 push 不执行）+ `push.ts` 的逆序入栈
//   规则 3 → `deaths.ts` 的 `processDeaths`（批量 + 不动点）
//   规则 4 → `auras.ts` 的 `refreshAuras`（整体覆盖，不做增量）
//
// ═══════════════════════════════════════════════════════════════════════════
// 六步流水线（框架 §4.1 的代码，逐步对齐）
// ═══════════════════════════════════════════════════════════════════════════
//   pop → ① bindContext → ② applyInterceptors（CANCELLED 则 continue）
//       → ③ handlers[op] → ④ queueTriggers → ⑤ processDeaths → ⑥ refreshAuras
//       → pendingInput 则 break
//   最后 drainEventLog
//
// ⚠ 步序编号沿用 **IR v1 §5.5**（1 绑定 / 2 拦截 / 3 handler / 4 触发 / 5 死亡 / 6 光环）。
//   框架 §4.1 那段代码里的行内注释 `1)`~`6)` 是**从拦截器开始数**的，比这里少 1 ——
//   两份规范说的是同一条流水线，只是起点不同。本目录一律用 IR §5.5 的编号，
//   免得「第 4 步」在两个文件里指两件事。
//
// ★ **全仓还有第二处按这个顺序跑六步的地方**：`rules/combat.ts` 的 `applyStrikes`
//   （v2 §4.2 第 ③ 步，战斗批次里跳过第 ⑤ 步、并把第 ④ 步排出的触发器留在栈上）。
//   它不复制任何一步的**实现**（六步全调本目录导出的同名函数），但复制了这个**顺序**。
//   **改动下面这六步的顺序或增删步骤，请同步改那里**，并读一遍那个文件头部
//   「为什么选旁路管线而不是给 resolve() 加模式开关」的取舍。
//
// 实现状态：**管线全通，②④⑤⑥ 全是真实现**。
//   ② 拦截器 → **M5/T2 已落地**（`interceptors.ts`：`filter`/`cond`/四种 `effect`/
//              `priority` 降序/8 层上限，按 IR v1 §4.2 匹配；来源同样经 `deps.scripts` 注入，
//              **不接卡表时空链 ⇒ 动作原样返回**，与 M2~M4 逐字相同）
//   ④ 触发   → **M5/T1 已落地**（`triggers.ts`：排序与入栈是 M2 做的，
//              「事件 → 哪些触发器命中」由 `collectTriggerSubscriptions` 按 IR v1 §4.1 匹配；
//              订阅源经 `deps.scripts` / `deps.enchantments` 注入，缺省即退化回排 0 条）
//   ⑥ 光环   → **M5/T3 已落地**（`auras.ts`：两趟重算 `tags = base + Σ附魔 + Σ生效光环`；
//              定义同样经 `deps.scripts` / `deps.enchantments` 注入，
//              **不接卡表时两个 Σ 都是空和 ⇒ `tags = base`**，与 M2~M4 逐字相同）
//   三处的"不接卡表"都是**语义正确的退化情形**，不是抛异常的占位符 —— 抛异常会让走查
//   跑不通，而走查（抽牌 → 放单位到格 → 手动 strike → 死亡）正是 M2 的完成标志。
//
// ═══════════════════════════════════════════════════════════════════════════
// 两处相对框架 §4.1 代码的、有意的偏离
// ═══════════════════════════════════════════════════════════════════════════
// A. **多一个 `deps` 参数**（`resolve(state, deps)`）。框架把 `handlers` 写成模块级全局表；
//    这里改成注入，理由见 `deps.ts` 文件头（框架 §3.2 引擎是纯函数 / MCTS 并行推演）。
// B. **多一个退出条件 `state.winner !== null`**。DSL v2 §4.1：base 归零 → `over`，
//    「任意时刻」判定。对局已经结束还继续弹栈，只会让亡语在终局之后凭空生效。
//    判断在**循环体开头（pop 之前）**：放在体末的话，一个 `winner` 已非空的状态传进来
//    仍会被弹掉并执行栈顶一条才退出 —— 那正是本条要禁掉的事。
//    栈上剩余条目**本函数不清空**，留着它对复现"终局那一刻栈里还有什么"很有用；
//    清空的落点是 `rules/phase.ts` 的 `concludeMatch`（由 `advancePhases` 在观察到
//    `winner` 之后调用，而 `apply()` / `applyRespond()` 无条件走 `advancePhases`）。
//    ⚠ M3 之前这里写的是「清空是相位机进 `over` 相位时的事」——那是一句没有实现的承诺：
//    `over` 由 `deaths.ts` 的 `settleBases` 直接写上去，相位机根本没有"进 over"这一步。

import type { GameEvent } from "../events/index.ts";
import { drainEventLog } from "../events/index.ts";
import type { GameState } from "../state/index.ts";
import { refreshAuras } from "./auras.ts";
import { bindContext } from "./context.ts";
import { processDeaths } from "./deaths.ts";
import type { ResolveDeps } from "./deps.ts";
import { actOfPending, runHandler } from "./deps.ts";
import { applyInterceptors, isCancelled } from "./interceptors.ts";
import { queueTriggers } from "./triggers.ts";

/**
 * 单次结算的步数上限（IR v1 §7 资源上限表：**单次结算栈深度 256**）。
 *
 * 计的是**弹栈次数**而不是栈的瞬时高度 —— 框架 §4.1 的 `guard` 就是这么写的
 * （`while` 体里 `++guard`）。弹栈次数是瞬时高度的上界的上界：任何一次结算，
 * 只要弹栈超过 256 次，要么是真环（A 触发 B、B 触发 A），要么是失控的连锁，
 * 两种都该在这里被截断，而不是把房间挂死。
 *
 * 计数器是 `resolve()` 的局部变量，所以**每次调用重新计数**：一次挂起
 * （`pendingInput`）之后 `resume()` 会拿到全新的 256 步预算。这是有意的 ——
 * 玩家做了一次选择就是一次新的因果起点，不该被上一段结算的步数拖累。
 *
 * ★ **这也是框架 §13 坑 5「亡语递归」的全部防线**（M5/T4 复核后拍板：**不另设**
 *   亡语专用的深度上限）。亡语是普通触发器（`triggers.ts` 的 `deathrattleTriggerOf`），
 *   只入栈不立即执行（时序规则 2），所以"亡语召唤的随从又有亡语"这条链**必然**
 *   一步一次地经过上面那个 `while` —— 上限管的是「同一次结算弹了几次栈」，
 *   而不是「亡语套了几层」，于是**合法的深链**（一条亡语召唤一个带亡语的随从，
 *   乃至几十层的接力）不会被误伤。实测与专门测试见
 *   `__tests__/deathrattle-loop.test.ts`，那里也写着"撞上限该抛错还是截断"的取舍。
 */
export const MAX_RESOLUTION_DEPTH = 256;

/**
 * 结算步数超过 {@link MAX_RESOLUTION_DEPTH}（框架 §4.1 的 `ResolutionLoopError`）。
 *
 * 抛错前已经把事件日志排空并挂在 `events` 上：`events/log.ts` 定死了
 * 「`apply()` / `resume()` 返回时 `state.eventLog` 必为空」这条不变量，
 * **抛错路径也不例外** —— 否则这一批事件会滞留在状态里，下次结算重复下发。
 * 顺手把它们带出来，排"到底连锁到第几步炸的"时这是唯一有用的信息。
 *
 * 注意 `state` **不会**被回滚：引擎不做事务，抛错时这份状态是半跑的（栈没空、
 * 死亡已经落地），直接调 `resolve()` 的一方必须丢弃它，不能接着用。
 *
 * ⚠ 走 `apply()` 的一方（M9 的 server 层）**不需要回滚快照**：`apply()` 先 clone
 *   再跑，半跑的是那份 draft，**入参状态一字未改** —— 丢掉这一次意图即可。
 *   这条由 `__tests__/deathrattle-loop.test.ts` 的最后一条测试钉住。
 */
export class ResolutionLoopError extends Error {
  /** 被突破的上限值。 */
  readonly limit: number;
  /** 抛错前排空的事件（见类说明）。 */
  readonly events: readonly GameEvent[];

  constructor(limit: number, events: readonly GameEvent[]) {
    super(`结算步数超过上限 ${limit}：结算栈可能存在环（框架 §4.1 ResolutionLoopError）`);
    this.name = "ResolutionLoopError";
    this.limit = limit;
    this.events = events;
  }
}

/**
 * 把结算栈跑到空（或跑到挂起 / 对局结束），返回这一段产生的事件流（框架 §4.1）。
 *
 * **原地改 `state`**，返回值只有事件。这与框架 §3.3「输出是事件流，不是状态 diff」
 * 一致：调用方要新状态就自己 `cloneState` 再调。
 *
 * 三条退出路径，每条都排空事件日志（`events/log.ts` 的不变量）：
 *   - 栈空 —— 正常结束；
 *   - `state.pendingInput !== null` —— 挂起等玩家输入，整个 state 可序列化落盘
 *     （框架 §4.2）；由 `suspend.ts` 的 `resume()` 接着弹栈；
 *   - `state.winner !== null` —— 对局结束（见文件头偏离 B）。**进来时就非空则一条都不弹**，
 *     直接返回空事件流：调用方（相位机、战斗的第 ④ 步）因此可以无脑再调一次。
 * 第四条是抛 {@link ResolutionLoopError}，它同样在抛之前排空（事件挂在错误对象上）。
 *
 * @param deps handler 表与脚本展开器，见 `deps.ts`。
 */
export function resolve(state: GameState, deps: ResolveDeps): GameEvent[] {
  let guard = 0;

  while (state.stack.length > 0) {
    // 对局结束 → 停止结算（见文件头偏离 B）。★ 必须在 `pop()` **之前**判：
    // 传进来时 `winner` 已经非空（战斗第 ④ 步打穿 base、认输、上一段结算判出胜负）
    // 的话，判断放在循环体末尾就等于"先执行一条再退出" —— 终局之后凭空多跑一条动作，
    // 而它多半是一条亡语或触发器。也因此这里**不**计 `guard`：一次都没弹栈。
    if (state.winner !== null) {
      break;
    }
    guard += 1;
    if (guard > MAX_RESOLUTION_DEPTH) {
      throw new ResolutionLoopError(MAX_RESOLUTION_DEPTH, drainEventLog(state));
    }

    const pending = state.stack.pop();
    // `pop()` 的 `undefined` 在 `stack.length > 0` 下不可能出现，但不用 `!` 抹掉它。
    if (pending === undefined) {
      break;
    }

    // ① 绑定上下文（SELF / TARGET / EVENT）
    const ctx = bindContext(state, pending);
    const act = actOfPending(state, pending, deps);
    if (act === null) {
      // 展不开的脚本引用：这一步什么都没发生，因此也不该有事后时序（不跑 ②~⑥）。
      continue;
    }

    // ② 替换效果：圣盾、免疫、"改为…"
    //    `deps` 带着拦截器的来源（`deps.scripts`，M5/T2）一起进去，与第 ④ 步同一张表。
    const action = applyInterceptors(state, ctx, act, deps);
    if (isCancelled(action)) {
      // 被取消 ≠ 什么都没发生：拦截器的 `then` 已经**入栈**（IR v1 §4.2 + 时序规则 2），
      // 下一次弹栈就轮到它 —— 所以这里只是跳过本步的第 ③~⑥ 步，不是丢掉这条链。
      continue;
    }

    // ③ 执行，产出事件
    //    handler 只改状态 + `emitEvent`（`deps.ts` 的契约），本步产出的事件用
    //    **日志区间**取出来 —— 不让 handler 返回数组，就不会出现两个事件真相源，
    //    也不可能重复计入（`events/log.ts` 的论证）。
    const mark = state.eventLog.length;
    runHandler(state, ctx, action, deps);
    const emitted = state.eventLog.slice(mark);

    // ④ 事后触发：按「当前回合玩家优先，再按 playOrder 升序」入栈（规则 1 + 规则 2）
    //    `deps` 带着订阅源（`deps.scripts` / `deps.enchantments`，M5）一起进去。
    queueTriggers(state, emitted, deps);

    // ⑤ 状态基础动作：死亡结算（规则 3；本步自己会把 `unit_died` 交给 ④ 排队）
    processDeaths(state, deps);

    // ⑥ 光环重算（规则 4）
    //    `deps` 带着光环与附魔的定义（`deps.scripts` / `deps.enchantments`，M5/T3）一起进去。
    refreshAuras(state, deps);

    // 需要玩家输入 → 挂起，等 resume()（框架 §4.2）
    if (state.pendingInput !== null) {
      break;
    }
    // 对局结束的那道判断在循环体开头，本步刚刚判出胜负时由下一轮的它接住。
  }

  return drainEventLog(state);
}
