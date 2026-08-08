// 流水线的外部接线点：**handler 表**、**脚本展开器**、**bundle 查询**。
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
// handler 的契约（M4 起 handler 一律基于求值器，逐条必须遵守）
// ═══════════════════════════════════════════════════════════════════════════
// 0. **入参是一个 {@link EvalEnv}**（`state` + `ctx` + 卡表 + 附魔表），不是散开的
//    `(state, ctx)`。位置参数的解析器闭在这一个环境上，handler 求 target 也用它 ——
//    一个动作从「求目标」到「改状态」全程同一个环境，不可能出现两份卡表 / 两份 ctx。
// 1. **直接改状态，返回 void**；事件用 `emitEvent(env.state, ev)` 记进 `state.eventLog`。
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
// 6. **位置参数从第三个形参上"拉"，拉的位置就是它在签名里的位置**：
//    `act-slots.ts` 给的是**惰性且记忆化**的解析器（`slots.at()`），不是算好的值 ——
//    这样字段求值顺序才与规范签名一致（IR v1 §5.4 规则 1）。拉到 `null` = 无效槽
//    ⇒ `isActSkipped(at)` 一行早返回，整个动作静默跳过（v2 §3.1）。
//    求值次数由记忆化保证「恰好一次」，handler 不必自己缓存。
// 7. ★ **集合参数（`target` / `player` / `of`）只求值一次**：IR v1 §5.3 规则 1
//    「动作内快照」。落地在 `handlers/targets.ts`，handler 一律经它取目标，
//    不许在循环体里再求一次 —— 那正是规则 1 想禁掉的写法。

import type { Act, ActNode, ActOp } from "@prismfront/ir";
import type { CardLookup, EnchantLookup, EvalEnv } from "../eval/index.ts";
import { createEvalEnv } from "../eval/index.ts";
import type { CtxBindings, GameState, PendingAction } from "../state/index.ts";
import type { ActSlots, ErasedActSlots } from "./act-slots.ts";
import { resolveActSlots } from "./act-slots.ts";

/**
 * 一个动作的执行器（框架 §4.1 第 3 步）。
 *
 * 泛型参数把动作类型收窄到具体的 op：`ActHandler<"act.hit">` 的第二个参数就是
 * `{ op: "act.hit"; target: Sel; amount: Num; spellDamage?: boolean }`，
 * 不需要在每个 handler 内部再 narrow 一次。
 *
 * 第三个参数是位置参数的**惰性解析器**（{@link ActSlots}，v2 §3.1）：
 * `ActHandler<"act.summon">` 拿到的是 `{ at: () => SlotAddr | null }` —— 字段非可选
 * （一定取得到），但取出来可能是 `null`（无效槽 ⇒ 整个动作跳过，判据 `isActSkipped`）。
 * **在签名里 `at` 排第几，就在 handler 里第几步拉它**（IR v1 §5.4 规则 1）。
 * 不带位置参数的 op 拿到空对象，**照旧只写前两个形参即可**（少写形参是合法赋值）。
 */
export type ActHandler<K extends ActOp = ActOp> = (
  env: EvalEnv,
  act: ActNode<K>,
  slots: ActSlots<K>,
) => void;

/**
 * op → handler 的分发表。★ **全 30 个 `act.*` 一个都不能少** ★
 *
 * ── 为什么是**非可选键**的映射类型（= `Record<ActOp, ActHandler>`）────────────
 * M2 时它是可选键（只手写了跑通走查所需的 5 个 op），代价是「漏一个 op」与
 * 「这个 op 故意不做」在类型上长得一模一样，都退化成运行期静默跳过 ——
 * 而静默跳过的症状是「某张卡偶尔不生效」，在随机对局里未必显形。
 * M4 收紧成非可选之后：**漏一个 op 是编译错误**，而「还没实现」必须在表里
 * 显式挂一个占位（`handlers/index.ts` 的 `notImplemented`），是一条可 grep 的记录。
 *
 * 映射类型同时保证**注册即类型安全**：`{ "act.hit": (env, act) => ... }` 里的 `act`
 * 自动是 `ActNode<"act.hit">`，写错 op 名或错配负载都是编译错误。
 *
 * 需要一张"什么都不做"的底表时用 `handlers/index.ts` 的 `NO_HANDLERS`
 * （它由完整表派生，所以不会有第二份 op 清单）。
 */
export type HandlerTable = {
  readonly [K in ActOp]: ActHandler<K>;
};

/**
 * 脚本引用展开器：`<cardId>#<script 路径>` → 该路径上的动作节点（IR v1 §6.2）。
 *
 * 返回 `null` 表示展不开（bundle 里没有这个 ref）。这在正常对局里不该发生，
 * 但**热更换 bundle 后的旧存档**会撞上它，所以给的是「静默跳过」而不是抛错 ——
 * 一个失效的 ref 不该让整个房间崩掉。（`state.bundleId` 钉住就是为了让它别发生，
 * 见 `state/stack.ts` 的 `ScriptRef`。）
 *
 * 引擎不带 bundle，因此 `ResolveDeps.expandScript` 缺省；接上卡表的一方提供实现。
 */
export type ScriptExpander = (state: GameState, ref: string, ctx: CtxBindings) => Act | null;

/** `resolve()` / `resume()` 的外部接线。 */
export interface ResolveDeps {
  /** 动作执行表。见文件头的 handler 契约。 */
  readonly handlers: HandlerTable;
  /**
   * 脚本引用展开器。缺省 ⇒ 栈里的 `via: "ref"` 条目一律静默跳过。
   * 引擎自造的动作全是 `via: "inline"` 条目，所以缺省是安全的。
   */
  readonly expandScript?: ScriptExpander;
  /**
   * 卡面数据查询（`eval/context.ts` 的 `CardLookup`）。缺省 ⇒ `NO_CARDS`。
   *
   * 两处要用它：`cond.is_kind` / `cond.has_color` / `cond.has_tribe` 读**卡面**
   * 而不是实体 tag；`act.summon` 要按卡面属性新建实体（没有卡面就造不出单位）。
   * 它跟 `handlers` / `expandScript` 一样是**注入**而不是模块级注册表 ——
   * 理由见本文件头（框架 §3.2 引擎是纯函数）。
   *
   * 缺省不是「出错」而是「引擎不认识任何具体卡」这一退化形态（见 `NO_CARDS` 的说明）。
   */
  readonly cards?: CardLookup;
  /**
   * 附魔定义查询（`eval/context.ts` 的 `EnchantLookup`）。缺省 ⇒ `NO_ENCHANTMENTS`。
   *
   * 只有 `act.buff` 用：`AttachedEnchantment` 要记 `duration`（IR v1 §2.3），
   * 而那写在 bundle 的附魔定义里。缺省 ⇒ `act.buff` 静默跳过。
   */
  readonly enchantments?: EnchantLookup;
}

/**
 * `HandlerTable` 取值时的**擦除后**形态。
 *
 * TS 无法表达「`table[act.op]` 的参数类型与 `act` 的类型相关联」这件事
 * （correlated union 分发，TS 至今没有对应的类型运算），所以分发点必须有一次断言。
 * 把它关在 {@link runHandler} 一个函数里，全引擎就只有这一处断言。
 * 类型安全由**注册侧**保证：往 {@link HandlerTable} 里放 handler 时，
 * 键与负载的对应关系是编译期检查过的。
 */
type ErasedActHandler = (env: EvalEnv, act: Act, slots: ErasedActSlots) => void;

/**
 * 分发执行一个动作（框架 §4.1 第 3 步）。
 *
 * 返回值 = **这个动作有没有被无效槽掐掉**（DSL v2 §3.1：「动作的 SlotRef 参数解析为
 * 无效槽 → 该动作静默跳过」）。注意判断是**事后**回读的：位置参数是惰性的，
 * 由 handler 在自己的签名位置上拉（`act-slots.ts`，完整论证见那个文件头），
 * 所以「跳过了没有」这件事只有等 handler 跑完才问得出来。
 *
 * ⚠ 一条 `true` **不**等于「这个动作真的做成了事」：`player` / `target` 求值为空集
 * （IR v1 §5.2）、`at` 被占、卡表查不到卡……都在 handler 内部静默跳过，
 * 派发层看不见也不该看见。想知道"发生了什么"请看这一步产出的事件流。
 *
 * ── M2 的第二条路径「op 未注册」已经消失 ─────────────────────────────────────
 * {@link HandlerTable} 收紧成非可选键之后，30 个 op 全部有条目，取出来一定是函数。
 * 于是一条 `false` **只**意味着无效槽，不再可能是「表里漏了一项」。
 * （反过来，惰性求值让「某个 op 是真实现还是 `notImplemented` 占位」重新会影响
 * RNG 推进次数 —— 这个代价、它躲不掉的原因、以及架构 §5.1 的载入期兜底
 * **目前尚未实现**这件事，都写在 `act-slots.ts` 文件头。）
 */
export function runHandler(
  state: GameState,
  ctx: CtxBindings,
  act: Act,
  deps: ResolveDeps,
): boolean {
  // 一个动作一个环境：位置参数的解析器与 handler 求 target 用的是同一份
  // （契约第 0 条）。`createEvalEnv` 与 `resolveActSlots` 都是纯构造，不消耗 RNG。
  const env = createEvalEnv(state, ctx, deps.cards, deps.enchantments);
  const access = resolveActSlots(env, act);
  const handler = deps.handlers[act.op] as ErasedActHandler;
  handler(env, act, access.slots);
  return !access.skipped();
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
