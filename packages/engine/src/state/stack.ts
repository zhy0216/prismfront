// 结算栈条目与上下文绑定。
// 来源：框架 §4.1（resolve 六步）、框架 §4.2（结算栈进状态 → 免费拿到「中途等玩家选择」）、
//       IR v1 §5.1（Ctx）、IR v1 §5.6（编写子集 vs 运行时超集）、IR v1 §6.2（栈条目表示）。
//
// 为什么栈要进状态（框架 §4.2）：action 是**纯数据** + 栈**在状态里** ⇒ 结算中途暂停
// 变成天然能力。`state.pendingInput` 一置上就 break，整个 state 可序列化落盘，
// 断线重连不丢，玩家回应后 `resume()` 接着弹栈。
// 反过来说：**栈条目里放进任何闭包 / class 实例，这个能力立刻失效**（框架 §13 坑 3）。

import type { Act, CardId, EntityId } from "@prismfront/ir";
import type { RuleEvent } from "../events/index.ts";

/**
 * 脚本引用：`<cardId>#<script 路径>`，路径是从 `script` 起的点分下标（IR v1 §6.2）。
 * 例：`"CORE_050#play.1"`。
 *
 * 「栈条目**不内联卡牌节点**而用引用」是 §6.2 的**规范形态**，收益是条目极小 →
 * `clone(state)` 快 → MCTS 可行、快照/存档/回放便宜。前提是 `state.bundleId` 在对局
 * 开始时钉住（IR v1 §2.1 / §6.2），否则热更会让 ref 指向错的节点。
 *
 * ⚠ **生产代码当前压进栈的条目一律是 {@link PendingInlineAct}**，这条路没有生产使用者。
 *   这是**当前事实**而不是被钉住的不变量：怎么核它、以及"谁会打破它"（M6 的
 *   `play_card`），连同各压栈点为什么内联的逐条取舍，写在 `resolve/push.ts` 文件头
 *   「条目形态」一节 —— 全仓只有那一份，这里不复述。
 */
export type ScriptRef = string;

/**
 * 上下文绑定（IR v1 §5.1 的 `Ctx`，取其**可序列化**的那部分）。
 *
 * 每个字段对应一个上下文叶子选择器；在错误的上下文里使用叶子是**校验期错误**
 * 而不是运行时错误（IR v1 §5.1），所以这里不需要为「绑定缺失」设计运行时语义。
 *
 * IR v1 §5.1 的 `Ctx.action`（`num.field` 在拦截器内部读被拦动作的字段）**不在这里**：
 * 它只在拦截器求值期间存在、不跨越挂起点，属于求值期上下文而非状态。
 * M5 的拦截器求值应当在本类型之上扩展一个 eval 期的 Ctx。
 *
 * **字段一律「必填 + `| null`」，不用可选属性** —— 与 `../events/event.ts` 同一条规矩：
 * `JSON.stringify({ target: undefined })` 会**丢键**，而 `null` 能原样往返。
 * 状态里只要不存在「可选属性」这个形态，架构 §6.1 第二条测试（序列化往返）就永远是
 * 逐字相等的探针，不会因为某处写了个 `undefined` 而变成假绿。
 */
export interface CtxBindings {
  /** `sel.self`：持有本脚本的实体。 */
  self: EntityId;
  /** `sel.target`：本次打出/动作指定的目标。 */
  target: EntityId | null;
  /** `sel.chosen`：最近一次 `act.discover` / `act.select_target` 的结果（实体 id 或卡 id）。 */
  chosen: EntityId | CardId | null;
  /** `sel.it`：迭代游标，仅在 `sel.where` / `act.for_each` 内部有绑定。 */
  it: EntityId | null;
  /**
   * `sel.event`：仅在 trigger 内部有绑定。
   *
   * 直接存整条 {@link RuleEvent}（它本身就是纯数据的可辨识联合），
   * `sel.event.field` 用 `../events` 的 `eventEntity(event, field)` 取值 ——
   * 不另造一份「事件负载的实体字段快照」类型，免得两处对表。
   * 类型取 `RuleEvent` 而非 `GameEvent`：触发器只能挂在 IR 的 `EventName` 上，
   * `engine.*` 事件（如 `engine.random_picked`）不进触发器上下文。
   */
  event: RuleEvent | null;
}

/** 造一份只绑定了 `self` 的上下文（最常见的形态）。 */
export function createCtx(self: EntityId): CtxBindings {
  return { self, target: null, chosen: null, it: null, event: null };
}

/**
 * 在已有绑定之上覆盖若干项，返回**新**对象（纯函数，不改入参）。
 *
 * 上下文在结算过程中会被反复派生（`act.for_each` 换 `it`、trigger 绑 `event`、
 * `resume` 写 `chosen`），派生而不是原地改，可以避免「栈里两条条目共享同一个 ctx
 * 对象，改一条串到另一条」这类共享可变状态的 bug。
 */
export function withCtx(ctx: CtxBindings, patch: Partial<CtxBindings>): CtxBindings {
  return { ...ctx, ...patch };
}

/**
 * 栈条目：来自卡牌/附魔脚本的一段动作，用 {@link ScriptRef} 引用（IR v1 §6.2 的规范形态）。
 */
export interface PendingScript {
  via: "ref";
  ref: ScriptRef;
  ctx: CtxBindings;
}

/**
 * 栈条目：内联的 IR 动作节点。**生产代码压进栈的条目当前全部是这一种。**
 *
 * 内联的理由**按压栈点各不相同**，而且三件事要分开问：这个节点来自卡表吗、
 * 那个压栈点造得出 ref 吗、那为什么仍然内联。战斗快照的 `act.strike`、
 * `act.when.then` 这类子数组、`intercept.then`、触发器 / 亡语的 `do`、
 * `castCard` 的 `script.play` —— 五类的答案并不一样，逐条写在
 * `resolve/push.ts` 文件头「条目形态」一节。那里是全仓唯一的一份，
 * 这里**不复述**，免得又长出一条对不上的分类。
 *
 * ★ 条目由该模块的 `inlinePending` 构造，**别处不要手写 `{ via: … }` 字面量**。
 *
 * `Act` 本身是可辨识联合的**纯 JSON**，内联它不破坏任何不变量，只是条目更大一点。
 */
export interface PendingInlineAct {
  via: "inline";
  act: Act;
  ctx: CtxBindings;
}

/**
 * 结算栈条目（框架 §4.1 的 `PendingAction`）。
 *
 * `state.stack` 是**后进先出**：框架 §4.1 的 `resolve` 用 `stack.pop()` 取条目，
 * 所以 `queueTriggers` 必须按「排好序之后的逆序」push，才能让排在前面的触发器先出栈
 * （框架 §4.1 时序规则 1：当前回合玩家优先，同一方按 playOrder 升序）。
 */
export type PendingAction = PendingScript | PendingInlineAct;
