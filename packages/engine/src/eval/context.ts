// 求值环境 + 三个求值器共用的原语（穷尽检查 / 侧别换算 / RNG 入口）。
// 来源：IR v1 §5.1（上下文绑定 Ctx）、IR v1 §5.4（求值顺序决定 RNG）、
//       IR v1 §5.6（编写子集 vs 运行时超集）、DSL v2 §7（SlotSide / SelSide 是两个集合）、
//       框架 §4.3（随机一律走 nextInt，并作为事件下发）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 为什么叫 Env 而不是 Context
// ═══════════════════════════════════════════════════════════════════════════
// IR v1 §5.1 的 `Ctx` 已经落在 `state/stack.ts` 的 {@link CtxBindings} 上了 ——
// 那是**纯数据**、随栈条目一起进状态、可整份落盘（框架 §4.2）。
// 求值还需要两样**不进状态**的东西：`GameState` 本身（含 `rng`）与卡表查询。
// 把它们塞回 `CtxBindings` 会当场破坏「结算中途可以整个落盘」这条前提，
// 所以另起一个**求值期一次性载体** {@link EvalEnv}，把纯数据那半原样内嵌。
// 于是 `resolve/context.ts` 的 `bindContext` 产出什么，这里就直接收什么，不做转换。
//
// ═══════════════════════════════════════════════════════════════════════════
// 上下文叶子的覆盖情况（IR v1 §5.1）
// ═══════════════════════════════════════════════════════════════════════════
//   sel.self / sel.target / sel.chosen / sel.it / sel.event  → CtxBindings 的同名字段
//   sel.controller / sel.opponent                            → 由 self 的**当前控制者**推出
//                                                              （见 {@link controllerOfSelf}）
//   sel.entity                                               → 运行时超集，节点自带 id（§5.6）
//   num.field                                                → 只在拦截器内合法，M5 扩展本环境
//
// 在错误的上下文里使用叶子是**校验期错误**而不是运行时错误（IR v1 §5.1），
// 所以这里不为「绑定缺失」设计语义 —— 取不到就是空集，按 §5.2 静默退化。

import type {
  CardData,
  CardId,
  EnchantId,
  Enchantment,
  EntityId,
  SelSide,
  SlotSide,
} from "@prismfront/ir";
import type { RandomSource } from "../events/index.ts";
import { emitEvent } from "../events/index.ts";
import { nextInt } from "../rng/index.ts";
import type { CtxBindings, EntityData, GameState, PlayerId } from "../state/index.ts";
import { controllerOf, getEntity, opponentOf, playerData, withCtx } from "../state/index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 卡表查询
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 卡面数据查询：`cardId` → `CardData`（IR v1 §2.2）。查不到给 `undefined`。
 *
 * 为什么是**注入的函数**而不是一张表：框架 §3.1「行为不进状态，一律 `cardId` → 注册表」，
 * 而注册表本身属于 bundle，不属于引擎；框架 §3.2 又要求引擎是纯函数、不许有模块级
 * 可变注册表（理由与 `resolve/deps.ts` 拒绝模块级 handler 表逐字相同）。
 *
 * 只有三个 op 需要它 —— `cond.is_kind` / `cond.has_color` / `cond.has_tribe`，
 * 它们读的都是**卡面数据**（`data.kind` / `data.colors` / `data.tribe`）而不是实体 tag。
 */
export type CardLookup = (cardId: CardId) => CardData | undefined;

/**
 * 一张空卡表：什么都查不到。
 *
 * 这是 {@link createEvalEnv} 的缺省值，语义**不是**「出错」而是「引擎不认识任何具体卡」——
 * 于是 `cond.is_kind` 之类对**非空**集合恒假（无法确认满足 ⇒ 不满足），
 * 对空集仍按 §5.2 恒真。M2/M3 的测试与流水线不带卡表，正是这个退化形态。
 */
export const NO_CARDS: CardLookup = () => undefined;

/**
 * 附魔查询：`ench` → {@link Enchantment}（IR v1 §2.3）。查不到给 `undefined`。
 *
 * 与 {@link CardLookup} 是**并列的两个注入口**，形状照抄 `resolve/deps.ts` 的
 * `ScriptExpander`：一个函数、缺省即退化、由调用方接线，绝不做模块级注册表
 * （框架 §3.2 引擎是纯函数）。
 *
 * 求值器本身一个 op 都不用它 —— 用它的是**动作层**的 `act.buff`：
 * `AttachedEnchantment` 要记 `duration`（IR v1 §2.3 决定何时剥离），
 * 而 `duration` 写在 bundle 的附魔定义里，不在动作节点里。
 */
export type EnchantLookup = (ench: EnchantId) => Enchantment | undefined;

/**
 * 一张空附魔表：什么都查不到。
 *
 * 与 {@link NO_CARDS} 同一条语义 —— 不是「出错」而是「引擎不认识任何附魔」，
 * 此时 `act.buff` 静默跳过（挂一条查不到定义的附魔，剥离时机就无从判起）。
 */
export const NO_ENCHANTMENTS: EnchantLookup = () => undefined;

// ═══════════════════════════════════════════════════════════════════════════
// 求值环境
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一次求值的环境。
 *
 * 四个字段的分工：
 * - `state`        —— 盘面 + **RNG**（`state.rng`）。求值器推进 RNG 只经 {@link rollInt}。
 * - `ctx`          —— IR v1 §5.1 的上下文绑定，纯数据，与栈条目里存的是同一个类型。
 * - `cards`        —— 卡面数据查询（见 {@link CardLookup}）。
 * - `enchantments` —— 附魔定义查询（见 {@link EnchantLookup}），动作层的 `act.buff` 用。
 *
 * 后两个是**bundle 侧的只读查询**，与 `state` / `ctx` 一样随求值一次性传入。
 * E4 起本类型同时是 **handler 的入参**（`resolve/deps.ts` 的 `ActHandler`）：
 * 一个动作从「求目标」到「改状态」用的是**同一个环境**，于是不可能出现
 * 「派发层用了卡表 A、handler 自己又造了个卡表 B」这种两份真相。
 *
 * **不可变**：换 `it` 游标用 {@link withIt} 派生新环境，不原地改 ——
 * 与 `state/stack.ts` 的 `withCtx` 同一条理由（避免两处求值共享一个 ctx 对象串味）。
 */
export interface EvalEnv {
  readonly state: GameState;
  readonly ctx: CtxBindings;
  readonly cards: CardLookup;
  readonly enchantments: EnchantLookup;
}

/** 造一个求值环境。两张表的缺省见 {@link NO_CARDS} / {@link NO_ENCHANTMENTS}。 */
export function createEvalEnv(
  state: GameState,
  ctx: CtxBindings,
  cards: CardLookup = NO_CARDS,
  enchantments: EnchantLookup = NO_ENCHANTMENTS,
): EvalEnv {
  return { state, ctx, cards, enchantments };
}

/**
 * 派生一个把 `sel.it` 绑到 `it` 的新环境（`sel.where` 逐个求值时用）。
 *
 * ⚠ `act.for_each` **不走这里**：它要把 `it` 绑进**压栈条目的 ctx**（纯数据，
 * 要跨越挂起点落盘），走的是 `state/stack.ts` 的 `withCtx`。本函数产出的是
 * 求值期的一次性载体，进不了状态。
 */
export function withIt(env: EvalEnv, it: EntityId): EvalEnv {
  return {
    state: env.state,
    ctx: withCtx(env.ctx, { it }),
    cards: env.cards,
    enchantments: env.enchantments,
  };
}

/** 取一个实体的卡面数据（查不到 → `undefined`）。 */
export function cardDataOf(env: EvalEnv, entity: EntityData): CardData | undefined {
  return env.cards(entity.cardId);
}

// ═══════════════════════════════════════════════════════════════════════════
// 穷尽检查
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 可辨识联合没穷尽时的兜底 —— **本条目全部要求的编译期保险就在这一行上**。
 *
 * `evalSel` / `evalNum` / `evalCond` / `evalSlot` 都写成
 * `switch (node.op) { … default: return assertNever(node); }`：
 * IR 加了一个 op 而求值器漏写 case，`node` 在 default 分支就不再是 `never`，
 * **编译当场报错**，而不是运行时静默走进 default 把这个 op 当空集跳过。
 * 静默跳过是最坏的结果 —— 卡牌行为悄悄错掉，随机对局里未必立刻显形。
 *
 * 运行时抛错这一支只有两种到达方式：外部喂进了不合法 IR（编写产物已由 L1/L2 校验挡掉），
 * 或者有人用 `as` 绕过了类型。两种都该响，不该静默。
 */
export function assertNever(node: never): never {
  throw new TypeError(`求值器遇到未知的 IR 节点：${JSON.stringify(node)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 侧别换算：相对（friendly / enemy）→ 绝对（PlayerId）
// ═══════════════════════════════════════════════════════════════════════════
// `state/queries.ts` 的格位查询收的是**绝对** PlayerId，注释里点名说了
// 「相对侧别 → 绝对玩家的换算依赖上下文里的 SELF，是求值器的事」—— 就是这一节。

/**
 * SELF 的**当前控制者**（不是 owner —— `act.steal` 之后两者会不同）。
 *
 * 取不到 SELF 的实体时返回 `null`。悬空 `self` 是常态而不是错误
 * （`resolve/context.ts` 已经论证过：亡语里引用自己、实体入栈后离场都会走到），
 * 调用方按 IR v1 §5.2 退化成空集 / 无效槽即可。
 */
export function controllerOfSelf(env: EvalEnv): PlayerId | null {
  const self = getEntity(env.state, env.ctx.self);
  return self === undefined ? null : controllerOf(self);
}

/**
 * `slot.*` 的侧别（{@link SlotSide}，只有 friendly / enemy）→ 绝对玩家。
 * 取不到 SELF 的控制者 → `null`，调用方按无效槽处理。
 */
export function resolveSlotSide(env: EvalEnv, side: SlotSide): PlayerId | null {
  const controller = controllerOfSelf(env);
  if (controller === null) {
    return null;
  }
  return side === "friendly" ? controller : opponentOf(controller);
}

/**
 * `sel.zone` 的侧别（{@link SelSide}，**比 SlotSide 多一个 `"both"`**，架构 §10 第 4 项）
 * → 绝对玩家列表。
 *
 * `"both"` 的顺序钉成 **[友方, 敌方]**：`sel.zone` 的枚举顺序会直接变成事件流顺序，
 * 必须由规范而不是由 `PLAYER_IDS` 的下标顺序决定 —— 否则同一张卡在 p0 与 p1 手里
 * 打出的效果顺序会不一样。
 *
 * 取不到 SELF 的控制者 → 空列表 ⇒ `sel.zone` 得到空集（IR v1 §5.2）。
 */
export function resolveSelSides(env: EvalEnv, side: SelSide): PlayerId[] {
  const controller = controllerOfSelf(env);
  if (controller === null) {
    return [];
  }
  const enemy = opponentOf(controller);
  if (side === "friendly") {
    return [controller];
  }
  if (side === "enemy") {
    return [enemy];
  }
  return [controller, enemy];
}

/**
 * 「玩家实体」= 该方的 **base 实体**（v2.1 §11.2）。
 *
 * `sel.controller` / `sel.opponent` 的返回类型是 `Entity[]`（IR v1 §3.1），
 * 可 `PlayerData` 本身不是实体。v2.1 §11.2 之后 base 就是代表玩家的那个实体：
 * 它承伤、做胜负判定、`damaged` 事件的 target 就是它 —— 于是
 * `sel.event("player")`（事件负载里的 id）与 `sel.controller` 落在同一个取值域上，
 * 不需要第二套「玩家 id 与实体 id 混住」的判别规则。
 *
 * ⚠ E4 起这是**全引擎唯一的实现**：M2 的临时读取器 `handlers/read.ts` 里那个同名的
 *   `playerEntity` 已随该文件整份删除（它的文件头承诺了这件事），`rules/phase.ts`
 *   的调用点改指本函数。
 */
export function playerEntityId(state: GameState, player: PlayerId): EntityId {
  return playerData(state, player).baseId;
}

// ═══════════════════════════════════════════════════════════════════════════
// RNG 入口
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 抽一个 `[0, max)` 的整数，**推进 `state.rng`** 并下发 `engine.random_picked`。
 *
 * 求值器里推进 RNG 的节点只有三个（IR v1 §5.4 + DSL v2 §3.1）：
 * `sel.random`、`num.random`、`slot.random_empty`（`card.random` 在 E4 的 CardRef 求值里，
 * 同样走本函数）。**它们必须全部经过这里**，理由有二：
 *
 * 1. 框架 §4.3：种子永不下发客户端，客户端无法自行复现随机，**只能被告知结果**；
 *    排「随机流从哪一步开始错位」时，回放里这一条是唯一有用的信息。
 *    `origin` 取 {@link RandomSource}，一眼能看出这一步随机是谁要的。
 * 2. 一次 `nextInt` = 一条事件，**一一对应**。`sel.random(n=3)` 抽三次就发三条，
 *    于是「事件条数」可以直接当成「RNG 推进了几次」的探针
 *    （`events/event.ts` 对 `EngineEvent.result` 的说明要求的正是这种配对）。
 *
 * ⚠ 空集合不是本函数的职责（同 `rng/rng.ts` 的 `nextInt`）：调用方必须**先判空**
 *   再决定要不要抽 —— `max` 传 0 会抛 RangeError。
 * ⚠ 光环重算与死亡结算**不得**经过这里（IR v1 §5.4 规则 5）。
 */
export function rollInt(env: EvalEnv, origin: RandomSource, max: number): number {
  const result = nextInt(env.state, max);
  emitEvent(env.state, { name: "engine.random_picked", origin, max, result });
  return result;
}
