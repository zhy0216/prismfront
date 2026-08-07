// 流水线的两个外部接线点：**handler 表**与**脚本展开器**。
// 来源：框架 §4.1（`handlers[action.kind](state, ctx, action)`）、框架 §3.2（引擎是纯函数）、
//       IR v1 §6.2（栈条目是引用，需要展开）、IR v1 §5.6（编写子集 vs 运行时超集）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 为什么是**注入**而不是模块级注册表
// ═══════════════════════════════════════════════════════════════════════════
// 框架 §4.1 的 `handlers` 看上去像一张模块级的全局表。这里改成参数注入，理由与
// `events/log.ts` 拒绝「模块级事件缓冲」是同一条：**框架 §3.2 引擎是纯函数**。
// 模块级可变注册表会让 bot 的 MCTS（框架 §10，一个进程里并行推演成千上万个克隆状态）
// 互相串味，也让「同一份状态在任何进程里结算得到同样结果」失去保证。
//
// 代价是 `resolve()` 比框架 §4.1 的写法多一个参数（`resolve(state, deps)`）。
// 这是本模块相对规范代码的**唯一一处签名偏离**，其余六步逐条对齐。
//
// ═══════════════════════════════════════════════════════════════════════════
// handler 的契约（M2 手写临时 handler、M4 起由求值器提供，都必须遵守）
// ═══════════════════════════════════════════════════════════════════════════
// 1. **直接改状态，返回 void**；事件用 `emitEvent(state, ev)` 记进 `state.eventLog`。
//    不要「返回事件数组」—— 那会出现两个事件真相源，且与 `events/log.ts` 的论证冲突
//    （除了 state 之外没有第二样东西能被所有产事件的子系统看到）。
//    流水线用**日志区间**（handler 前后的 `eventLog.length`）取出本步产出的事件，
//    喂给 `queueTriggers`，所以既不会漏也不可能重复计入。
// 2. **不要自己调 `processDeaths` / `refreshAuras` / `resolve`**：那是流水线的第 4~6 步，
//    handler 抢着做会破坏框架 §4.1 的时序规则 2（触发是入栈而非立即执行）。
// 3. 要连锁执行更多动作 ⇒ 用 `push.ts` 的 `pushAct` / `pushActs` **入栈**。
// 4. 要挂起等玩家输入 ⇒ 先把「续跑的动作」入栈，再调 `suspend.ts` 的 `suspend()`。
// 5. **持久的属性变更请写 `entity.base`**，不要写 `entity.tags` ——
//    `tags` 是派生值，每一步都会被 `refreshAuras` 从 `base` 重算覆盖（时序规则 4）。

import type { Act, ActNode, ActOp } from "@prismfront/ir";
import type { CtxBindings, GameState, PendingAction } from "../state/index.ts";

/**
 * 一个动作的执行器（框架 §4.1 第 3 步）。
 *
 * 泛型参数把动作类型收窄到具体的 op：`ActHandler<"act.hit">` 的第三个参数就是
 * `{ op: "act.hit"; target: Sel; amount: Num; spellDamage?: boolean }`，
 * 不需要在每个 handler 内部再 narrow 一次。
 */
export type ActHandler<K extends ActOp = ActOp> = (
  state: GameState,
  ctx: CtxBindings,
  act: ActNode<K>,
) => void;

/**
 * op → handler 的分发表。
 *
 * 写成**可选键的映射类型**而不是 `Record<ActOp, ActHandler>`：M2 只手写了跑通
 * 「抽牌 → 放单位到格 → 手动 strike → 死亡」所需的那几个 op，93 个 op 要到 M4
 * 才补齐。未注册的 op 的处理方式见 {@link runHandler}。
 *
 * 映射类型同时保证**注册即类型安全**：`{ "act.hit": (s, c, act) => ... }` 里的 `act`
 * 自动是 `ActNode<"act.hit">`，写错 op 名或错配负载都是编译错误。
 */
export type HandlerTable = {
  readonly [K in ActOp]?: ActHandler<K>;
};

/**
 * 脚本引用展开器：`<cardId>#<script 路径>` → 该路径上的动作节点（IR v1 §6.2）。
 *
 * 返回 `null` 表示展不开（bundle 里没有这个 ref）。这在正常对局里不该发生，
 * 但**热更换 bundle 后的旧存档**会撞上它，所以给的是「静默跳过」而不是抛错 ——
 * 一个失效的 ref 不该让整个房间崩掉。（`state.bundleId` 钉住就是为了让它别发生，
 * 见 `state/stack.ts` 的 `ScriptRef`。）
 *
 * M2 没有卡表，因此 `ResolveDeps.expandScript` 通常缺省；M4 的求值器提供真实实现。
 */
export type ScriptExpander = (state: GameState, ref: string, ctx: CtxBindings) => Act | null;

/** `resolve()` / `resume()` 的外部接线。 */
export interface ResolveDeps {
  /** 动作执行表。见文件头的 handler 契约。 */
  readonly handlers: HandlerTable;
  /**
   * 脚本引用展开器。缺省 ⇒ 栈里的 `via: "ref"` 条目一律静默跳过。
   * M2 只会往栈里放 `via: "inline"` 条目，所以缺省是安全的。
   */
  readonly expandScript?: ScriptExpander;
}

/** 一张空的 handler 表。适合「只想跑流水线本身」的测试与桩。 */
export const NO_HANDLERS: HandlerTable = {};

/** 什么都不做的接线。流水线会照常弹栈、跑死亡结算与光环重算，只是没有动作被执行。 */
export const NO_DEPS: ResolveDeps = { handlers: NO_HANDLERS };

/**
 * `HandlerTable` 取值时的**擦除后**形态。
 *
 * TS 无法表达「`table[act.op]` 的参数类型与 `act` 的类型相关联」这件事
 * （correlated union 分发，TS 至今没有对应的类型运算），所以分发点必须有一次断言。
 * 把它关在 {@link runHandler} 一个函数里，全引擎就只有这一处断言。
 * 类型安全由**注册侧**保证：往 {@link HandlerTable} 里放 handler 时，
 * 键与负载的对应关系是编译期检查过的。
 */
type ErasedActHandler = (state: GameState, ctx: CtxBindings, act: Act) => void;

/**
 * 分发执行一个动作（框架 §4.1 第 3 步）。
 *
 * 返回是否真的有 handler 跑过。**未注册的 op 静默跳过**，不抛错，理由有两层：
 * - M2 只实现了几个 op，抛错会让任何触到未实现 op 的路径直接崩，
 *   而 M2 的目标是先把管线立起来；
 * - IR v1 §5.2 的空集合语义已经确立了「做不成的事静默跳过，不报错、不产生事件」
 *   这个基调，未注册的 op 落在同一条基调里。
 *
 * 返回值给调用方留了「想严格就自己断言」的余地（M4 补齐 93 个 op 之后，
 * 一条 `false` 就意味着分发表漏了一项，那时可以在测试里把它钉成断言）。
 */
export function runHandler(
  state: GameState,
  ctx: CtxBindings,
  act: Act,
  handlers: HandlerTable,
): boolean {
  const handler = handlers[act.op] as ErasedActHandler | undefined;
  if (handler === undefined) {
    return false;
  }
  handler(state, ctx, act);
  return true;
}

/**
 * 取出栈条目要执行的动作节点。
 *
 * 两种条目（`state/stack.ts`）：
 * - `via: "inline"` —— 动作就在条目里，直接返回；
 * - `via: "ref"` —— 交给 {@link ScriptExpander} 展开；没有展开器或展不开则返回 `null`。
 *
 * 返回 `null` = 这一步没有动作可执行，流水线跳过它（不跑拦截器、不跑 handler，
 * 也不跑第 4~6 步 —— 什么都没发生，就不该有事后时序）。
 */
export function actOfPending(
  state: GameState,
  pending: PendingAction,
  deps: ResolveDeps,
): Act | null {
  if (pending.via === "inline") {
    return pending.act;
  }
  const expand = deps.expandScript;
  if (expand === undefined) {
    return null;
  }
  return expand(state, pending.ref, pending.ctx);
}
