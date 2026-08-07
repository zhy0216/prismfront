// handlers/ —— 动作执行表（架构 §2.3 的 `handlers/`，框架 §4.1 第 ③ 步）。
//
// ═══════════════════════════════════════════════════════════════════════════
// M2 的定位：**手写的临时件，跑通一条链就够**
// ═══════════════════════════════════════════════════════════════════════════
// 里程碑 M2 第 5 项原文：
// > 不碰 DSL：手写几个临时 handler，跑通"抽牌 → 放单位到格 → 手动 strike → 死亡"。
//
// 所以本目录**不读 IR 卡表、不做 DSL 求值**（evalSel / evalNum / evalCond 是 M4）。
// 节点里的 `Sel` / `Num` 由 `read.ts` 的最小读取器按"只认叶子与字面量"读出来，
// 读不出来就当空集 → 动作静默跳过（IR v1 §5.2）。
// `SlotRef`（`slot.*` 一族）M2 一个都不读：需要它的动作全在 M4（`act.summon` /
// `act.move_to` / `act.shift`），本目录用的是 `act.move.pos` 那个字面格索引。
//
//   read.ts    临时读取器（M4 落地后整个文件删除）+ 「玩家实体 = base 实体」的约定
//   board.ts   位置与区域的写入原语：三处一致性不变量的唯一实现
//   draw.ts    act.draw      抽牌
//   move.ts    act.move      把实体挪到区域；zone:"board" 即**放单位到指定格**
//   damage.ts  act.hit / act.strike   造成伤害 / 出手（strike 压一条 hit 入栈）
//
// 死亡**不在这里**：它是流水线第 ⑤ 步的独立阶段（`resolve/deaths.ts`，时序规则 3）。
// handler 只把 `entity.damage` 加上去，判死与移墓地由 `processDeaths` 统一做。
//
// ═══════════════════════════════════════════════════════════════════════════
// 93 个 op 里只实现了 5 个 —— 其余的行为
// ═══════════════════════════════════════════════════════════════════════════
// **未注册的 op 静默跳过，不抛错**（`resolve/deps.ts` 的 `runHandler`）。
// 于是一张真卡的脚本喂进 M2 只会什么都不发生，而不会把流水线崩掉。
//
// 没实现 `act.summon` 的理由见 `move.ts` 文件头：新建实体要卡面属性 ⇒ 要卡表 ⇒ M4。
//
// M4 的接法（本目录的调用点不需要改）：
//   1. `read.ts` 换成真求值器，`readEntity` → `evalSel` 返回集合而非单实体；
//   2. 表的类型从 `HandlerTable`（可选键）收紧成 `Record<ActOp, ActHandler>`，
//      靠**穷尽检查**保证 93 个 op 一个不漏 —— 那时漏一个是编译错误，而不是静默跳过。
//
// 上层 `src/index.ts` 由外层统一组装，本目录不参与。

import type { ActHandler, HandlerTable, ResolveDeps } from "../resolve/index.ts";
import { hitHandler, strikeHandler } from "./damage.ts";
import { drawHandler } from "./draw.ts";
import { moveHandler } from "./move.ts";

/** `act.nothing`：什么都不做（IR v1 §3.4）。注册它只是为了"已实现"与"未实现"能分开。 */
export const nothingHandler: ActHandler<"act.nothing"> = () => {};

/**
 * M2 的临时动作执行表。
 *
 * 名字带 `M2_` 前缀是**故意**的：它是一次性的脚手架，M4 会整张换掉。
 * 前缀让"哪些东西该在 M4 删干净"在 grep 里一目了然。
 */
export const M2_HANDLERS: HandlerTable = {
  "act.draw": drawHandler,
  "act.move": moveHandler,
  "act.hit": hitHandler,
  "act.strike": strikeHandler,
  "act.nothing": nothingHandler,
};

/**
 * 配好 {@link M2_HANDLERS} 的默认接线，`apply()` / `runMatch()` 的缺省 `deps`。
 *
 * 没有 `expandScript`：M2 没有卡表，栈里的 `via: "ref"` 条目一律静默跳过
 * （`resolve/deps.ts` 的 `ScriptExpander`）。M2 只会往栈里放 `via: "inline"` 条目。
 *
 * 这是一个**不可变常量**，不是"模块级可变注册表"—— `resolve/deps.ts` 反对的是后者
 * （会让 MCTS 的并行推演互相串味）。它作为默认参数出现，调用方随时可以换成自己的表。
 */
export const M2_DEPS: ResolveDeps = { handlers: M2_HANDLERS };

export { moveToZone, placeOnSlot } from "./board.ts";
export { hitHandler, strikeHandler } from "./damage.ts";
export { drawHandler, drawOne } from "./draw.ts";
export { moveHandler } from "./move.ts";
export { playerEntity, readEntity, readNum, readPlayer, sourceOf } from "./read.ts";
