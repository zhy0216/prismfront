// M2 的**临时读取器**：从上下文绑定与字面量里取值。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 这不是求值器。求值器（evalSel / evalNum / evalCond）是 M4 ★
// ═══════════════════════════════════════════════════════════════════════════
// M2 的任务是「不碰 DSL，手写几个临时 handler 跑通管线」（里程碑 M2 第 5 项）。
// 但 handler 的入参是 IR 的 `Act` 节点，节点里的 `Sel` / `Num` 总得读出来 ——
// 于是这里给一个**只认叶子与字面量**的最小读取器：
//
//   认：`sel.self` / `sel.target` / `sel.chosen` / `sel.it`（上下文叶子，IR v1 §5.1）
//       `sel.entity`（运行时超集叶子，IR v1 §5.6 —— 引擎自己生成的动作用它冻结目标）
//       `sel.controller` / `sel.opponent`（只在 {@link readPlayer} 里）
//       字面 `number`（IR v1 原则 4：常见字面量不包装）
//   不认：区域选择器、组合、过滤、随机、位置推导…… 一律**当作空集**。
//
// 「不认的一律空集」不是偷懒，而是 IR v1 §5.2 的空集合语义：
// **求值为空 → 动作静默跳过，不报错、不产生事件**。所以一张真卡的脚本喂进 M2 的
// handler 只会什么都不发生，而不会崩 —— 这正是 M2 想要的退化行为。
//
// M4 落地后**整个文件删除**，调用点换成 `evalSel(state, ctx, sel)` 之类。
// 为此这里的函数一律叫 `readXxx` 而不是 `evalXxx`，免得两者在 grep 里混成一片。

import type { EntityId, Num, Sel } from "@prismfront/ir";
import type { CtxBindings, EntityData, GameState, PlayerId } from "../state/index.ts";
import { controllerOf, getEntity, opponentOf, playerData } from "../state/index.ts";

/**
 * 「玩家实体」= 该方的 **base 实体**。
 *
 * 事件负载的 `player` 字段与 `sel.controller` / `sel.opponent` 的取值域都是 **EntityId**
 * （`events/event.ts` 的「三个实体字段」、IR v1 §3.1），可 `PlayerData` 本身不是实体、
 * 状态里也没有单独的"玩家实体"。v2.1 §11.2 之后**base 就是代表玩家的那个实体**：
 * 它承伤、做胜负判定、`damaged` 事件的 target 就是它。所以这里把两者对齐 ——
 * 全引擎凡是要往事件里写 `player`、或要把玩家当实体用的地方，都取 `players[p].baseId`。
 *
 * 收益是 `sel.event("player")`（M5）与 `sel.controller`（M4）不需要另一套「玩家 id 与
 * 实体 id 混住」的判别规则：`eventEntity(ev, "player")` 拿到的 id 直接就是一个真实体。
 * 反过来说：**不要把 `PlayerId`（0/1）塞进事件的 `player` 字段** —— 实体 id 从 1 起，
 * 0/1 会和真实体撞号。
 */
export function playerEntity(state: GameState, player: PlayerId): EntityId {
  return playerData(state, player).baseId;
}

/**
 * 读一个数值（IR v1 原则 4：字面量不包装）。
 *
 * 只认字面 `number`；`num.*` 节点一律回退到 `fallback`（求值是 M4）。
 * `fallback` 的取值请按各字段的规范默认值来（`act.draw.count` 默认 1，等等）。
 */
export function readNum(num: Num | undefined, fallback: number): number {
  return typeof num === "number" ? num : fallback;
}

/** 读一个实体叶子的 id。不认的节点一律 `null`（= 空集合，静默跳过）。 */
function readEntityId(ctx: CtxBindings, sel: Sel): EntityId | null {
  switch (sel.op) {
    case "sel.self":
      return ctx.self;
    case "sel.target":
      return ctx.target;
    case "sel.chosen":
      // `ctx.chosen` 是 `EntityId | CardId | null` 的联合（IR v1 §6.1）：
      // 从 Pool 发现给的是卡 id，那不是实体，读不出实体来。
      return typeof ctx.chosen === "number" ? ctx.chosen : null;
    case "sel.it":
      return ctx.it;
    case "sel.entity":
      // 运行时超集（IR v1 §5.6）：引擎自造的动作用它把目标冻结成一个具体 id。
      return sel.id;
    default:
      return null;
  }
}

/**
 * 读一个**单实体**选择器。
 *
 * 返回 `undefined` 表示「空集」或「读不出来」，调用方应当**静默跳过**整个动作
 * （IR v1 §5.2）。悬空 id（实体已经不在表里）同样落在这里 —— 那是常态而不是错误
 * （见 `state/queries.ts` 的 `getEntity`）。
 */
export function readEntity(state: GameState, ctx: CtxBindings, sel: Sel): EntityData | undefined {
  const id = readEntityId(ctx, sel);
  return id === null ? undefined : getEntity(state, id);
}

/**
 * 读一个**玩家**选择器：`sel.controller` / `sel.opponent`，或任何能读出实体的叶子
 * （取该实体的**当前控制者**）。读不出来 → `null`。
 *
 * 为什么 `sel.controller` 要单独一支：它不是"某个实体"，而是 SELF 的控制者 ——
 * 得先把 SELF 取出来再问它站在谁的区里（`act.steal` 之后控制者与 owner 会不同）。
 */
export function readPlayer(state: GameState, ctx: CtxBindings, sel: Sel): PlayerId | null {
  if (sel.op === "sel.controller" || sel.op === "sel.opponent") {
    const self = getEntity(state, ctx.self);
    if (self === undefined) {
      return null;
    }
    const controller = controllerOf(self);
    return sel.op === "sel.controller" ? controller : opponentOf(controller);
  }
  const entity = readEntity(state, ctx, sel);
  return entity === undefined ? null : controllerOf(entity);
}

/**
 * 事件负载里的 `source`（施动者）。
 *
 * `ctx.self` 取不到实体时给 `null` 而不是硬塞一个 id：`damaged.source` 等字段的类型是
 * `EntityId | null`，`null` 的语义是"无施动实体的伤害"（规则伤害、疲劳）。
 * 引擎自造的动作常常没有 SELF（`state/create.ts`：实体 id 从 1 起，0 是"没有实体"的哨兵）。
 */
export function sourceOf(state: GameState, ctx: CtxBindings): EntityId | null {
  return getEntity(state, ctx.self) === undefined ? null : ctx.self;
}
