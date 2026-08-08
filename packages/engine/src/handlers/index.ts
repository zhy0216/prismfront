// handlers/ —— 动作执行表（架构 §2.3 的 `handlers/`，框架 §4.1 第 ③ 步）。
//
// ═══════════════════════════════════════════════════════════════════════════
// M4 的定位：**接上真求值器，表收紧成 `Record<ActOp, Handler>`**
// ═══════════════════════════════════════════════════════════════════════════
// M2 的临时读取器 `read.ts`（只认叶子与字面量）与临时表 `M2_HANDLERS` 已经**整份删除**。
// 现在每个 handler 拿到的是一个 `EvalEnv`（state + ctx + 卡表 + 附魔表），
// 目标一律经 `targets.ts` 求值 —— 区域选择器、组合、过滤、随机、位置推导全部可用。
//
//   targets.ts  ★ 动作的集合参数：**规则 1「动作内快照」的唯一落点**
//   board.ts    位置与区域的写入原语：三处一致性不变量的唯一实现
//   damage.ts   act.hit / act.heal / act.strike / act.destroy
//   draw.ts     act.draw
//   move.ts     act.move（含"放单位到格"）/ act.swap
//   summon.ts   act.summon —— 本目录唯一需要**卡表**的 handler
//   tags.ts     act.set_tag / act.mod_tag / act.buff / act.set_flag（M5/T2 补入）
//   control.ts  ★ act.when / act.repeat / act.for_each / act.nothing
//               —— **规则 2「每轮重新求值」的落点**，与规则 3 的对照写在那里
//   input.ts    act.select_target —— 本目录唯一会**挂起**的 handler（E6 补入）
//
// 死亡**不在这里**：它是流水线第 ⑤ 步的独立阶段（`resolve/deaths.ts`，时序规则 3）。
// handler 只把 `entity.damage` 加上去（`act.destroy` 也一样），判死与移墓地由
// `processDeaths` 统一做。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★★★ code review checklist（M4 起长期，风险登记册有专条）★★★
// ═══════════════════════════════════════════════════════════════════════════
// IR v1 §5.3 的三条求值时机规则是**整份规范最容易出错的地方**，规范原文点名要求
// 「code review checklist 必须有这一条」。改动本目录或 `eval/sel.ts` 时逐条对照：
//
//  □ 规则 1｜**动作内快照**：一个动作的 `target` / `player` / `of` 只求值一次，
//    结果在该动作全程冻结。**判据：handler 里出现第二次 `evalSel(env, act.target)`
//    就是错的。** 一律经 `targets.ts` 的 `snapshot`。
//    可观测形态：打第一个随从致死后列表不缩短，剩下的照打；`act.for_each` 循环中
//    新上场的单位不会被迭代到。
//
//  □ 规则 2｜**`act.repeat` 每轮重新求值**（奥术飞弹）。
//    `repeat(3, hit(random(enemies), 1))` → 三次**独立**随机，**可能三发打同一个**。
//    落地：`control.ts` 的 `repeatHandler` 把 `do` **原样**压 n 份，一个 Sel 都不求值。
//
//  □ 规则 3｜**`sel.random(n)` 一次性求值**（多重射击）。
//    `hit(random(enemies, n=3), 1)` → 一次选 3 个**互不重复**，各挨 1 点。
//    落地：`eval/sel.ts` 的 `evalRandom`，取走不放回，绝不在外层循环里"每次再抽一个"。
//
//  □ ★ 规则 2 与规则 3 **长得像、语义完全不同** ★
//    两者的 RNG 消耗次数可能一样（都是 3），所以**光数随机次数分不出来**——
//    判据是**结果里能不能出现重复**。评审时把这两句话念一遍：
//      「repeat 是重复**做这件事**，每次重新选目标」
//      「random(n) 是一次**选 n 个**，选完就定了」
//    对照测试：`handlers/__tests__/eval-timing.test.ts`（三条规则各一条，缺一不可）。
//
//  □ 顺带：`act.when` 只求值命中的分支、`cond.and/or` 短路（IR v1 §5.4 规则 3/4）。
//    写成"先把两支都算出来再选"会多消耗一整条分支的 RNG —— 单测全绿、回放失真。
//
// ═══════════════════════════════════════════════════════════════════════════
// 30 个 op 里实现了 17 个 —— 其余的行为
// ═══════════════════════════════════════════════════════════════════════════
// M4 的任务书只要求「先支持 8–10 个最常用 op」，但表的类型是 `Record<ActOp, …>`：
// **一个都不能少**，少一个编译不过。于是尚未实现的 op 一律挂 {@link notImplemented}
// 占位 —— 行为与 M2 时的"未注册"完全一样（静默跳过、不抛错、不发事件），
// 但它在源码里是一条**显式的、可 grep 的记录**（`grep notImplemented`），
// 而不再是类型上的一个洞。两者的区别是：
//   「漏了一个 op」  → 编译错误（表不完整）
//   「这个 op 没做」 → 一行 `notImplemented("act.xxx")`，并出现在 {@link NOT_IMPLEMENTED_OPS} 里
//
// 上层 `src/index.ts` 由外层统一组装，本目录不参与。

import type { ActOp } from "@prismfront/ir";
import type { ActHandler, HandlerTable, ResolveDeps } from "../resolve/index.ts";
import { forEachHandler, nothingHandler, repeatHandler, whenHandler } from "./control.ts";
import { destroyHandler, healHandler, hitHandler, strikeHandler } from "./damage.ts";
import { drawHandler } from "./draw.ts";
import { selectTargetHandler } from "./input.ts";
import { moveHandler, swapHandler } from "./move.ts";
import { summonHandler } from "./summon.ts";
import { buffHandler, modTagHandler, setFlagHandler, setTagHandler } from "./tags.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 未实现的 op：显式占位
// ═══════════════════════════════════════════════════════════════════════════

/** {@link notImplemented} 挂在占位 handler 上的标记，供 {@link NOT_IMPLEMENTED_OPS} 反查。 */
interface NotImplementedMark {
  /** 这个占位对应的 op 名。 */
  readonly notImplementedOp: ActOp;
}

/**
 * 一个**尚未实现**的 op 的占位 handler：行为 = 静默跳过（IR v1 §5.2 的基调）。
 *
 * 为什么不是"把类型放松回可选键"：见文件头。占位让「漏一个」与「没做一个」
 * 在编译期就分得开，而**不用**在运行期靠"表里查不到"去猜。
 *
 * op 名同时进两处：源码里（`grep notImplemented` 一眼列全）与函数对象上
 * （{@link NOT_IMPLEMENTED_OPS} 由此派生，于是测试能把这份清单钉住 ——
 * 实现掉一个却忘了从表里摘掉占位，测试会红）。
 */
function notImplemented<K extends ActOp>(op: K): ActHandler<K> {
  const handler = (): void => {};
  return Object.assign(handler, { notImplementedOp: op } satisfies NotImplementedMark);
}

/** 一个什么都不做的 handler。{@link NO_HANDLERS} 用它填满整张表。 */
const silent: ActHandler = () => {};

// ═══════════════════════════════════════════════════════════════════════════
// 动作执行表
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 引擎的动作执行表 —— **30 个 `act.*` 逐个列出，一个都不能少**。
 *
 * 类型是 `HandlerTable`（= `Record<ActOp, ActHandler<K>>`，见 `resolve/deps.ts`）：
 * - IR 新增一个 `act.*` 而这里没跟上 → **编译错误**（缺键）；
 * - 键与负载的对应是编译期检查过的 → handler 里的 `act` 自动收窄到具体节点类型。
 *
 * 这是一个**不可变常量**，不是"模块级可变注册表"—— `resolve/deps.ts` 反对的是后者
 * （会让 MCTS 的并行推演互相串味）。它作为默认参数出现，调用方随时可以换成自己的表
 * （测试就是这么隔离流水线的：`{ ...ACT_HANDLERS, "act.hit": 桩 }`）。
 *
 * 分组顺序与 `ir/src/types/act.ts` 的联合成员顺序逐行对齐，便于对表。
 */
export const ACT_HANDLERS: HandlerTable = {
  // ── 伤害与治疗（IR v1 §3.4）─────────────────────────────────────────────
  "act.hit": hitHandler,
  "act.heal": healHandler,
  "act.set_health": notImplemented("act.set_health"),
  "act.gain_armor": notImplemented("act.gain_armor"),

  // ── 牌与区域（IR v1 §3.4）───────────────────────────────────────────────
  "act.draw": drawHandler,
  "act.give": notImplemented("act.give"),
  "act.shuffle": notImplemented("act.shuffle"),
  "act.discard": notImplemented("act.discard"),
  "act.move": moveHandler,
  "act.steal": notImplemented("act.steal"),

  // ── 场面（IR v1 §3.4 / v2 §3.4）─────────────────────────────────────────
  "act.summon": summonHandler,
  "act.destroy": destroyHandler,
  "act.transform": notImplemented("act.transform"),

  // ── 属性修改（IR v1 §3.4）───────────────────────────────────────────────
  "act.buff": buffHandler,
  "act.silence": notImplemented("act.silence"),
  "act.set_tag": setTagHandler,
  "act.mod_tag": modTagHandler,
  // ★ M5/T2 补入：IR v1 §10.6 的圣盾把它写在 `intercept.then` 里（"把盾用掉"）。
  "act.set_flag": setFlagHandler,

  // ── 位置四件套 + 出手（v2 §3.4）─────────────────────────────────────────
  "act.move_to": notImplemented("act.move_to"),
  "act.shift": notImplemented("act.shift"),
  "act.swap": swapHandler,
  "act.strike": strikeHandler,

  // ── 资源（v2 §3.4）──────────────────────────────────────────────────────
  "act.gain_crystal": notImplemented("act.gain_crystal"),
  "act.gain_crystal_cap": notImplemented("act.gain_crystal_cap"),

  // ── 控制流（IR v1 §3.4）★ 三条铁规里的规则 1/2 都在这一组 ★──────────────
  "act.when": whenHandler,
  "act.repeat": repeatHandler,
  "act.for_each": forEachHandler,

  // ── 需要玩家输入：挂起点（IR v1 §3.4 / §6）──────────────────────────────
  "act.discover": notImplemented("act.discover"),
  "act.select_target": selectTargetHandler,

  "act.nothing": nothingHandler,
};

/**
 * 还挂着占位、**尚未实现**的 op 清单（按 {@link ACT_HANDLERS} 的声明顺序）。
 *
 * 从表里反查而不是另抄一份：另抄的清单会与表静默漂移，而漂移正是本目录
 * 收紧类型想根除的那一类问题。测试拿它钉住"这个里程碑做了哪些"——
 * 实现掉一个 op 却忘了把占位摘掉（于是那个 handler 根本不会被调用），测试会红。
 *
 * ★ 它同时是架构 §5.1 那个**载入期比对**的现成来源：engine 载入 bundle 时应当拿
 *   `bundle.opsUsed` 与自己支持的 op 集（= `ACT_OPS` 减去本清单）比一遍，
 *   不支持就**拒载**。那个检查**目前还没有实现**（engine 里没有任何 bundle 载入路径），
 *   而 `resolve/act-slots.ts` 文件头「代价」一节的第 2 条正是以它为前提 ——
 *   位置参数改成惰性求值之后，占位 handler 与真 handler 消耗的随机数不再一样多，
 *   靠"未实现的 op 进不了对局"兜底。补载入期比对时请回头读那一节。
 */
export const NOT_IMPLEMENTED_OPS: readonly ActOp[] = Object.values(ACT_HANDLERS)
  .map((handler) => (handler as Partial<NotImplementedMark>).notImplementedOp)
  .filter((op): op is ActOp => op !== undefined);

/**
 * 一张**全部静默跳过**的表。适合「只想跑流水线本身」的测试与桩。
 *
 * 从 {@link ACT_HANDLERS} 的键派生，所以全仓只有一份 op 清单
 * （表收紧成非可选键之后，`{}` 不再是一张合法的表）。
 * 一次断言：键集来自一张**编译期已经完整**的表，逐个换成 `silent` 不改变完整性。
 */
export const NO_HANDLERS: HandlerTable = Object.fromEntries(
  Object.keys(ACT_HANDLERS).map((op) => [op, silent]),
) as HandlerTable;

/**
 * 配好 {@link ACT_HANDLERS} 的默认接线，`apply()` / `runMatch()` 的缺省 `deps`。
 *
 * 三个可选接线口全部缺省，即**引擎不认识任何具体卡**这一退化形态：
 * - 没有 `expandScript` ⇒ 栈里的 `via: "ref"` 条目静默跳过（引擎自造的动作全是 inline）；
 * - 没有 `cards` ⇒ `cond.is_kind` 一族对非空集合恒假，`act.summon` 造不出单位；
 * - 没有 `enchantments` ⇒ `act.buff` 静默跳过。
 * 接上 bundle 的一方（`packages/cards` 的产物、M9 的服务端）自己传一份完整的 deps。
 *
 * 这是一个**不可变常量**，不是"模块级可变注册表"（理由见 {@link ACT_HANDLERS}）。
 */
export const DEFAULT_DEPS: ResolveDeps = { handlers: ACT_HANDLERS };

/** 什么都不做的接线。流水线会照常弹栈、跑死亡结算与光环重算，只是没有动作被执行。 */
export const NO_DEPS: ResolveDeps = { handlers: NO_HANDLERS };

export { moveToZone, placeOnSlot, spawnOnSlot, swapSlots } from "./board.ts";
export { forEachHandler, nothingHandler, repeatHandler, whenHandler } from "./control.ts";
export { destroyHandler, healHandler, hitHandler, strikeHandler } from "./damage.ts";
export { drawHandler, drawOne } from "./draw.ts";
export { selectTargetHandler } from "./input.ts";
export { moveHandler, swapHandler } from "./move.ts";
export { summonHandler } from "./summon.ts";
export { buffHandler, modTagHandler, setFlagHandler, setTagHandler } from "./tags.ts";
export { frozenEntities, singleTarget, snapshot, sourceOf, targetPlayers } from "./targets.ts";
