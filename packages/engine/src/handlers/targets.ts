// 动作的**集合参数**求值：目标快照、玩家列表、施动者。
// 来源：IR v1 §5.3 规则 1（动作内快照）、IR v1 §5.2（空集合语义）、v2.1 §11.2（玩家实体）。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 规则 1｜动作内快照（IR v1 §5.3，整份规范最容易出错的三条之一）★★★
// ═══════════════════════════════════════════════════════════════════════════
// 规范原文：
// > 一个动作开始执行时，其 `target` 选择器求值**一次**，结果列表在该动作全程冻结。
// > 打第一个随从致死后，列表不会缩短，剩下的照打。
//
// 落地方式：**handler 一律经 {@link snapshot} 取目标，一个动作只调它一次。**
// 于是"求一次值"这件事有唯一的落点，而不是散在 15 个 handler 里各写各的。
//
// ── 为什么冻的是 **id 列表**而不是实体对象 ──────────────────────────────────
// 框架 §3.1「实体用 id 互相引用」。冻 id 之后：
//   - 快照可以原样进事件、进栈条目、跨越挂起点落盘；
//   - 「这个实体中途离场了」变成**取值时**判一次（{@link frozenEntities}），
//     而不是握着一个已经不在 `state.entities` 里的对象继续改它。
// 冻实体对象也能跑通，但它会让「快照」这件事在 clone / 序列化面前失真 ——
// 而 `resolve/suspend.ts` 的挂起点恰恰能横切一个动作的执行过程。
//
// ── ⚠ 与规则 2 的区别（本目录反复点名的那条 review checklist）★ ─────────────
// `act.repeat` 的 `do` 是**每轮重新求值**（规则 2）：它不能走本文件 ——
// 每一轮的 `sel.random` 都要重新抽。落地在 `control.ts`，两边互相指认。
// 判据一句话：**同一个动作节点内的多次使用 ⇒ 冻结；多轮之间 ⇒ 重求。**

import type { EntityId, Sel } from "@prismfront/ir";
import type { EvalEnv } from "../eval/index.ts";
import { evalSel, single } from "../eval/index.ts";
import type { EntityData, PlayerId } from "../state/index.ts";
import { controllerOf, getEntities, getEntity } from "../state/index.ts";

/**
 * ★ 规则 1 的落点：把一个集合参数求值**一次**，冻成 id 列表。
 *
 * 返回的 id 一定在求值那一刻存在（`evalSel` 的不变量），但**之后可能离场**——
 * 取实体请用 {@link frozenEntities}，它按"取值时还在不在"过滤，于是
 * 「列表不会缩短」与「不去改一个已经不存在的实体」两件事同时成立。
 *
 * 空集 → 空数组 ⇒ 调用方 `length === 0` 时**整个动作静默跳过**（IR v1 §5.2），
 * 不报错、不产生事件、**也不再求值后面的字段** —— 「打空气」不该平白推进一次 RNG，
 * 而字段是按声明顺序求值的（IR v1 §5.4 规则 1），target 在最前面。
 */
export function snapshot(env: EvalEnv, sel: Sel): EntityId[] {
  return evalSel(env, sel);
}

/**
 * 把快照里**此刻仍然存在**的实体取出来（顺序与快照一致）。
 *
 * 与「列表不会缩短」不冲突：缩短指的是**不重新求值选择器**，
 * 而一个实体如果连 `state.entities` 里都没有了（M4 里不会发生 —— 死亡只是换区域），
 * 对它做任何事都没有意义。两者的分界见 `state/queries.ts` 的 `getEntities`。
 */
export function frozenEntities(env: EvalEnv, ids: readonly EntityId[]): EntityData[] {
  return getEntities(env.state, ids);
}

/**
 * 取「恰好一个实体」的动作参数（`act.strike.attacker` / `act.swap.a` / `act.swap.b`）。
 *
 * v2 §3.4 对 `act.swap` 的原文是「`a`、`b` 须各为**单个在场单位**，否则跳过」，
 * `act.strike` 的「立即出手一次」同理。判据**直接复用** `eval/sel.ts` 的 `single`
 * （`num.attr` / `num.slot_index` / `slot.of` 用的就是它）：**非单元素一律 `undefined`**，
 * 不取第一个 —— 悄悄取第一个会让"选中了 3 个"与"选中了 1 个"变成同一件事。
 * 复用而不是"写得一样"，是为了让这条判据将来只可能有一处变。
 */
export function singleTarget(env: EvalEnv, sel: Sel): EntityData | undefined {
  return single(frozenEntities(env, snapshot(env, sel)));
}

/**
 * 动作的 `player` 参数（`act.draw` / `act.summon` / `act.gain_crystal` …）→ 玩家列表。
 *
 * IR v1 §3.1 里 `sel.controller` / `sel.opponent` 的取值是**实体**（v2.1 §11.2 之后
 * 就是那一方的 base 实体），所以"哪个玩家"必须从实体反推：取它的**当前控制者**
 * （`act.steal` 之后控制者与 owner 会不同，见 `state/queries.ts` 的 `controllerOf`）。
 *
 * 去重并保持首次出现的顺序：`sel.zone{side:"both"}` 这类写法会一次选中双方的多个实体，
 * 而"给 p0 抽两次牌"与"给 p0 抽一次牌"是两件事 —— 顺序则是事件流顺序（v2 §4.2 顺序敏感点）。
 *
 * 空列表 ⇒ 动作静默跳过（IR v1 §5.2 的 `player` 那一行）。
 */
export function targetPlayers(env: EvalEnv, sel: Sel): PlayerId[] {
  const out: PlayerId[] = [];
  for (const entity of frozenEntities(env, snapshot(env, sel))) {
    const player = controllerOf(entity);
    if (!out.includes(player)) {
      out.push(player);
    }
  }
  return out;
}

/**
 * 事件负载里的 `source`（施动者）。
 *
 * `ctx.self` 取不到实体时给 `null` 而不是硬塞一个 id：`damaged.source` 等字段的类型是
 * `EntityId | null`，`null` 的语义是"无施动实体的伤害"（规则伤害、疲劳）。
 * 引擎自造的动作常常没有 SELF（`state/create.ts`：实体 id 从 1 起，0 是"没有实体"的哨兵）。
 */
export function sourceOf(env: EvalEnv): EntityId | null {
  return getEntity(env.state, env.ctx.self) === undefined ? null : env.ctx.self;
}
