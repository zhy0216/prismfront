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
//   num.field                                                → 只在拦截器内合法，M5/T2 补上
//                                                              {@link EvalEnv.field}（读取器）
//
// 在错误的上下文里使用叶子是**校验期错误**而不是运行时错误（IR v1 §5.1），
// 所以这里不为「绑定缺失」设计语义 —— 取不到就是空集，按 §5.2 静默退化。

import type {
  ActNumField,
  CardData,
  CardId,
  CardKind,
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
 * `num.field(field)` 的读取器：取**被拦截动作**的某个数值字段（IR v1 §4.2 / §5.1）。
 *
 * ── 为什么是一个函数而不是把 `Act` 本身放进环境 ─────────────────────────────
 * IR v1 §5.1 的 `Ctx.action?: ActNode` 看上去只要塞一个动作节点就够了。但被拦动作的
 * 字段是 `Num`（可以是 `num.random`），**求值一次就推进一次 RNG**，而拦截器链里可能有
 * 好几条 `cond` 都读同一个字段 —— 塞节点等于把"读几次就求值几次"写进类型。
 * 换成读取器之后，"这个字段求值几次、结果冻在哪"由**产出读取器的那一方**（`resolve/
 * interceptors.ts`）说了算：它做惰性 + 记忆化 + 回写冻结，与 `resolve/act-slots.ts`
 * 给位置参数的处理是同一套。求值器这一侧因此只剩一行 `env.field(node.field)`。
 *
 * 语义：动作上**没有**这个数值字段（`act.hit` 没有 `count`，`act.set_flag.value`
 * 是 boolean 不是 Num）时返回 `0` —— 与空集合语义的数值位同调（IR v1 §5.2），
 * 用错上下文是**校验期**错误（§5.1），运行时不为它另设一种失败。
 */
export type ActNumFieldReader = (field: ActNumField) => number;

/**
 * 一次求值的环境。
 *
 * 五个字段的分工：
 * - `state`        —— 盘面 + **RNG**（`state.rng`）。求值器推进 RNG 只经 {@link rollInt}。
 * - `ctx`          —— IR v1 §5.1 的上下文绑定，纯数据，与栈条目里存的是同一个类型。
 * - `cards`        —— 卡面数据查询（见 {@link CardLookup}）。
 * - `enchantments` —— 附魔定义查询（见 {@link EnchantLookup}），动作层的 `act.buff` 用。
 * - `field`        —— `num.field` 的读取器（见 {@link ActNumFieldReader}），
 *                     **只有拦截器求值期非 `null`**；其余场合恒 `null`。
 *
 * 中间两个是**bundle 侧的只读查询**，与 `state` / `ctx` 一样随求值一次性传入。
 * E4 起本类型同时是 **handler 的入参**（`resolve/deps.ts` 的 `ActHandler`）：
 * 一个动作从「求目标」到「改状态」用的是**同一个环境**，于是不可能出现
 * 「派发层用了卡表 A、handler 自己又造了个卡表 B」这种两份真相。
 *
 * `field` 之所以在这里而不在 `CtxBindings` 里：`CtxBindings` 是**纯数据**、随栈条目落盘
 * （框架 §4.2），而被拦动作只在拦截器求值那一瞬存在、且读取器是个闭包 ——
 * 放进状态会当场破坏「结算中途可以整个落盘」这条前提（`state/stack.ts` 已点名说了这件事）。
 *
 * **不可变**：换 `it` 游标用 {@link withIt} 派生新环境，不原地改 ——
 * 与 `state/stack.ts` 的 `withCtx` 同一条理由（避免两处求值共享一个 ctx 对象串味）。
 */
export interface EvalEnv {
  readonly state: GameState;
  readonly ctx: CtxBindings;
  readonly cards: CardLookup;
  readonly enchantments: EnchantLookup;
  readonly field: ActNumFieldReader | null;
}

/**
 * 造一个求值环境。两张表的缺省见 {@link NO_CARDS} / {@link NO_ENCHANTMENTS}。
 *
 * `field` 缺省为 `null` = **不在拦截器里**：`num.field` 于是按 §5.2 退化成 0。
 * 全引擎只有 `resolve/interceptors.ts` 会传非 `null` 的读取器。
 */
export function createEvalEnv(
  state: GameState,
  ctx: CtxBindings,
  cards: CardLookup = NO_CARDS,
  enchantments: EnchantLookup = NO_ENCHANTMENTS,
  field: ActNumFieldReader | null = null,
): EvalEnv {
  return { state, ctx, cards, enchantments, field };
}

/**
 * 派生一个把 `sel.it` 绑到 `it` 的新环境（`sel.where` 逐个求值时用）。
 *
 * ⚠ `act.for_each` **不走这里**：它要把 `it` 绑进**压栈条目的 ctx**（纯数据，
 * 要跨越挂起点落盘），走的是 `state/stack.ts` 的 `withCtx`。本函数产出的是
 * 求值期的一次性载体，进不了状态。
 *
 * `field` 原样带下去：`sel.where` 的 `cond` 出现在拦截器的 `filter` / `cond` 里时，
 * 里面照样可以读 `num.field`（IR v1 §5.1 只限定了"在 intercept 内"，没有限定嵌套深度）。
 */
export function withIt(env: EvalEnv, it: EntityId): EvalEnv {
  return {
    state: env.state,
    ctx: withCtx(env.ctx, { it }),
    cards: env.cards,
    enchantments: env.enchantments,
    field: env.field,
  };
}

/** 取一个实体的卡面数据（查不到 → `undefined`）。 */
export function cardDataOf(env: EvalEnv, entity: EntityData): CardData | undefined {
  return env.cards(entity.cardId);
}

/**
 * 「英雄」这一档 {@link CardKind}（v2.1 §11.2）。engine 只 import ir 的**类型**，
 * 值本地写字面量（架构 §2.2 禁令 1），与 `resolve/deaths.ts` 的 `GRAVEYARD` 同一条规矩。
 */
const HERO_KIND: CardKind = "hero";

/**
 * 一个实体是不是**英雄**（v2.1 §11.2 的 `kind: "hero"`）—— ★ 全引擎唯一的判据。
 *
 * ── 为什么必须只有一处实现 ────────────────────────────────────────────────
 * M6 有三件事各自要问这句话：死亡去向（英雄进复燃泉不进墓地）、色门（`play_card`
 * 要数己方在场英雄的颜色）、选择器词汇分化（`*_MINIONS` 排除英雄）。
 * 三处各判各的，就会出现"死亡那边认它是英雄、色门那边不认"这类只在半边显形的分叉；
 * 而 M6 必守点点名的那个坑（归属 ≠ 色门）正是同源问题 —— PF1 每色恰好一名英雄，
 * 两种判法结果永远相同，等英雄扩池第一天才炸，且炸在数据侧很难往回追。
 *
 * ── 为什么收 {@link CardLookup} 而不是 {@link EvalEnv} ─────────────────────
 * 问这句话的三方里只有求值器手里有环境；死亡结算（`resolve/deaths.ts`）与相位机
 * （`rules/phase.ts`）手里只有 `resolve/deps.ts` 的 `TriggerDeps`。收窄到"一张卡表"
 * 这一份依赖，三处才能共用同一个实现，而不是为了共用去到处传一个用不上的 `EvalEnv`。
 *
 * `cards` 允许是 `undefined`（`TriggerDeps.cards` 本来就是可选的）⇒ 恒 `false`。
 * 这与 `cond.is_kind` 的退化口径**同源**：查不到卡就无法确认它是英雄，于是不是
 * （见 {@link NO_CARDS}）。不接卡表的形态下英雄按普通单位结算 —— M2~M5 的全部测试
 * 跑的正是这个形态，它们因此一条都不受 M6 影响。
 *
 * ⚠ **读 `data.kind`，绝不读 `data.hero`**（v2.1 §11.4b）：后者是纯构筑层的归属字段，
 *   legality / 结算 / 投影 / DSL 求值一律不许碰它。
 */
export function isHero(cards: CardLookup | undefined, entity: EntityData): boolean {
  return cards?.(entity.cardId)?.kind === HERO_KIND;
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
