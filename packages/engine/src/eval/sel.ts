// `evalSel` —— 选择器求值（IR v1 §3.1 的 `sel.*` 族 + DSL v2 §3.2 的增改）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 返回的是 **id 列表**，不是实体对象
// ═══════════════════════════════════════════════════════════════════════════
// 框架 §3.1 的铁律「实体用 id 互相引用」对求值结果同样适用：id 列表可以直接冻结进
// 动作（IR v1 §5.3 规则 1 的「动作内快照」就是把它冻起来）、进事件、进栈条目。
// 要实体对象的地方（`num.attr` / `cond.has_*`）用 {@link evalEntities}，它只是
// 在 `evalSel` 之上套一层 `getEntities`。
//
// **不变量：返回的 id 一定能在 `state.entities` 里取到实体。** 悬空 id 在这里被
// 直接滤掉（IR v1 §5.2 的空集合语义：取不到就当没有），于是下游不必逐个再判一次。
//
// ═══════════════════════════════════════════════════════════════════════════
// 顺序是语义的一部分
// ═══════════════════════════════════════════════════════════════════════════
// 选择器的枚举顺序会一路变成动作顺序、事件顺序、拦截器消耗顺序（v2 §4.2 的
// 「顺序敏感点」），所以每个 op 的顺序都由规范或本文件明文钉死，不许"碰巧是这样"：
//   sel.zone      side 顺序 [友方, 敌方]（`context.ts` 的 `resolveSelSides`）；
//                 board **按格序 0→8**（v2 §3.2），其余区域按 `zones` 列表顺序
//   sel.and       保持 `of[0]` 的顺序（IR v1 §3.1）
//   sel.or        去重后按 playOrder 升序，同值按实体 id（全序，见 {@link byPlayOrder}）
//   sel.sort      按 tag，同值按 playOrder，再同值按 id（同上）
//   sel.random    **按抽中的先后**，不回填原顺序（见该分支说明）
//   其余          按输入顺序 / 格序，见各分支
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 求值时机三条规则（IR v1 §5.3，整份规范最容易出错的地方）★
// ═══════════════════════════════════════════════════════════════════════════
// 三条规则里，本文件只负责最后一条，前两条在动作层（E4）：
//   规则 1｜动作内快照     —— 动作开始时 `target` 求值**一次**，全程冻结  → handlers/
//   规则 2｜act.repeat     —— **每轮重新求值**（奥术飞弹：三发可能打同一个）→ handlers/
//   规则 3｜sel.random(n)  —— **一次性求值**（多重射击：一次选 n 个不重复）→ ★ 本文件
// 规则 2 与规则 3 长得像、语义完全不同。本文件能做的是把规则 3 做对：
// `sel.random` 的一次求值就抽满 n 个、彼此不重复（`distinct` 默认 true），
// 绝不在内部循环里"每次再抽一个"。

import type { EntityId, Num, Sel, ZoneName } from "@prismfront/ir";
import { eventEntity } from "../events/index.ts";
import type { EntityData, PlayerId } from "../state/index.ts";
import {
  boardEntities,
  controllerOf,
  entityAtSlot,
  getEntities,
  getEntity,
  getZone,
  opponentOf,
  tagOf,
} from "../state/index.ts";
import { evalCond } from "./cond.ts";
import type { EvalEnv } from "./context.ts";
import { assertNever, playerEntityId, resolveSelSides, rollInt, withIt } from "./context.ts";
import { evalNum } from "./num.ts";
import { evalSlot } from "./slot.ts";

/**
 * 求值一个选择器 → **存在的**实体 id 列表（见文件头的不变量与顺序约定）。
 */
export function evalSel(env: EvalEnv, node: Sel): EntityId[] {
  switch (node.op) {
    // ── 上下文叶子（IR v1 §3.1 / §5.1）────────────────────────────────────
    case "sel.self":
      return refOf(env, env.ctx.self);
    case "sel.target":
      return refOf(env, env.ctx.target);
    case "sel.controller":
    case "sel.opponent": {
      // SELF 的控制者 / 对手，取值是该方的 **base 实体**（v2.1 §11.2，见 `playerEntityId`）。
      // 走 `resolveSelSides` 而不是自己算一遍：`"friendly"` / `"enemy"` 的换算全引擎一处。
      const [player] = resolveSelSides(env, node.op === "sel.controller" ? "friendly" : "enemy");
      return player === undefined ? [] : refOf(env, playerEntityId(env.state, player));
    }
    case "sel.chosen":
      // `ctx.chosen` 是 `EntityId | CardId` 的联合（IR v1 §6.1）：从 Pool 发现给的是
      // **卡 id**，那不是实体，读不出实体来 → 空集。
      return typeof env.ctx.chosen === "number" ? refOf(env, env.ctx.chosen) : [];
    case "sel.it":
      // 仅在 `sel.where` / `act.for_each` 内部有绑定；用错位置是**校验期**错误
      // （IR v1 §5.1），运行时按空集退化。
      return refOf(env, env.ctx.it);
    case "sel.event":
      // 仅在 trigger 内部有绑定。字段名的取值域与 `trigger.filter` 同一个类型，
      // 取值走 `events/event.ts` 的 `eventEntity`，不在这里另抄一份负载表。
      return env.ctx.event === null ? [] : refOf(env, eventEntity(env.ctx.event, node.field));
    case "sel.entity":
      // IR v1 §5.6 的**运行时超集**：引擎自造的动作用它把目标冻结成一个具体 id
      // （战斗快照就是这么做的，见 `rules/combat.ts`）。编写产物里出现即校验错误。
      return refOf(env, node.id);

    // ── 区域选择器（IR v1 §3.1 / DSL v2 §3.2）──────────────────────────────
    case "sel.zone": {
      const zones = toList(node.zone);
      const out: EntityId[] = [];
      for (const player of resolveSelSides(env, node.side)) {
        for (const zone of zones) {
          pushZone(env, out, player, zone);
        }
      }
      // `zone: ["board","board"]` 这类写法不该产出重复项（下游会打两次）。
      return dedupe(out);
    }

    // ── 组合与过滤（IR v1 §3.1）───────────────────────────────────────────
    case "sel.and": {
      // 交集，保持 `of[0]` 的顺序。**每一支都求值**（没有短路规则）——
      // 短路只属于 `cond.and/or` 与 `num.if`（IR v1 §5.4 规则 3/4），
      // 在这里擅自短路会少消耗右侧的 RNG，是确定性 bug。
      const lists = node.of.map((one) => evalSel(env, one));
      const [first, ...rest] = lists;
      if (first === undefined) {
        return [];
      }
      return first.filter((id) => rest.every((other) => other.includes(id)));
    }
    case "sel.or": {
      const out: EntityId[] = [];
      for (const one of node.of) {
        for (const id of evalSel(env, one)) {
          out.push(id);
        }
      }
      return sortEntities(env, dedupe(out), byPlayOrder);
    }
    case "sel.minus": {
      const of = evalSel(env, node.of);
      const exclude = evalSel(env, node.exclude);
      return of.filter((id) => !exclude.includes(id));
    }
    case "sel.where":
      // 逐个求值 `cond`，其中 `sel.it` 绑定到候选（IR v1 §3.1）。
      // 每个候选一份派生环境，不原地改 ctx（`withIt` 的说明）。
      return evalSel(env, node.of).filter((id) => evalCond(withIt(env, id), node.cond));

    case "sel.random":
      return evalRandom(env, node.of, node.n, node.distinct);

    case "sel.limit": {
      const of = evalSel(env, node.of);
      const n = evalNum(env, node.n);
      if (n <= 0) {
        return [];
      }
      // 取后 n 个时**保持原相对顺序**（"取"不是"倒序"）。
      return (node.from ?? "start") === "start"
        ? of.slice(0, n)
        : of.slice(Math.max(0, of.length - n));
    }
    case "sel.sort": {
      const by = node.by;
      const desc = (node.dir ?? "asc") === "desc";
      return sortEntities(env, evalSel(env, node.of), (a, b) => {
        const diff = desc ? tagOf(b, by) - tagOf(a, by) : tagOf(a, by) - tagOf(b, by);
        return diff !== 0 ? diff : byPlayOrder(a, b);
      });
    }

    // ── 位置相关（DSL v2 §3.2 新增/变更）──────────────────────────────────
    case "sel.at": {
      // 格上的实体。**空格贡献空集**，无效槽同理（v2 §3.1/§3.2）。
      const out: EntityId[] = [];
      for (const ref of toList(node.slot)) {
        const addr = evalSlot(env, ref);
        const occupant =
          addr === null ? undefined : entityAtSlot(env.state, addr.player, addr.index);
        if (occupant !== undefined) {
          out.push(occupant.id);
        }
      }
      return dedupe(out);
    }
    case "sel.opposite": {
      // 每个实体的**正对面**实体（不看 direction，v2 §3.2）。双方同索引对齐（v2 §0 规则 1）。
      const out: EntityId[] = [];
      for (const entity of evalEntities(env, node.of)) {
        if (entity.slot === null) {
          continue;
        }
        const facing = entityAtSlot(env.state, opponentOf(controllerOf(entity)), entity.slot);
        if (facing !== undefined) {
          out.push(facing.id);
        }
      }
      return dedupe(out);
    }
    case "sel.combat_target": {
      // 按**当前 direction** 解析的战斗目标；指空格/出界 → 敌方基地（v2 §4.3 + v2.1 §11.2）。
      const out: EntityId[] = [];
      for (const entity of evalEntities(env, node.of)) {
        const target = combatTargetOf(env, entity);
        if (target !== null) {
          out.push(target);
        }
      }
      return dedupe(out);
    }
    case "sel.attackers_of": {
      // "谁在瞄我"：所有当前方向指向 `of` 中实体的敌方单位（v2 §3.2）。
      // 判据直接复用 {@link combatTargetOf} —— 于是它与 `sel.combat_target` 恒为互逆，
      // 不可能出现"A 打 B，但 B 的 attackers 里没有 A"这种两处实现漂移的经典 bug。
      const out: EntityId[] = [];
      for (const entity of evalEntities(env, node.of)) {
        const enemy = opponentOf(controllerOf(entity));
        for (const unit of boardEntities(env.state, enemy)) {
          if (combatTargetOf(env, unit) === entity.id) {
            out.push(unit.id);
          }
        }
      }
      return dedupe(out);
    }
    case "sel.adjacent": {
      // ★ v2 §3.2 **语义变更**：v1 是"召唤顺序相邻"，v2 是**位置相邻** ——
      //   同侧 ±dist 格内的单位，`dist` 默认 1（v2 §10 迁移清单第 6 条要求逐卡复查）。
      const of = evalEntities(env, node.of);
      const dist = node.dist === undefined ? 1 : evalNum(env, node.dist);
      const out: EntityId[] = [];
      for (const entity of of) {
        if (entity.slot === null) {
          continue;
        }
        const player = controllerOf(entity);
        // `dist <= 0` 时循环自然不执行 —— 不写特判，退化行为就是"没有邻居"。
        for (let index = entity.slot - dist; index <= entity.slot + dist; index += 1) {
          const neighbour =
            index === entity.slot ? undefined : entityAtSlot(env.state, player, index);
          if (neighbour !== undefined) {
            out.push(neighbour.id);
          }
        }
      }
      return dedupe(out);
    }

    default:
      // ★ 穷尽检查：IR 新增一个 sel.* 而这里漏写 case → 编译不过（见 `assertNever`）。
      return assertNever(node);
  }
}

/** `evalSel` 的实体版。下游要读 tag / flag / zone 时用它，顺序与 `evalSel` 完全一致。 */
export function evalEntities(env: EvalEnv, node: Sel): EntityData[] {
  return getEntities(env.state, evalSel(env, node));
}

/**
 * 取「恰好一个实体」，否则 `undefined`。
 *
 * `num.attr`（IR v1 §3.2「集合非单元素时返回 0」）、`num.slot_index` 与 `slot.of`
 * （v2 §3.3/§3.1「非单实体 → -1 / 无效槽」）共用同一条判据，所以收在一处。
 * 顺带把 `noUncheckedIndexedAccess` 的 `list[0]` 收口在这里，调用点不再出现空判断。
 */
export function single(list: readonly EntityData[]): EntityData | undefined {
  return list.length === 1 ? list[0] : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// 内部原语
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一个叶子 id 变成 0 或 1 元的列表：`null` 与**悬空 id** 都得到空集。
 *
 * 悬空 id 是常态而不是错误（`state/queries.ts` 的 `getEntity` 已经论证过），
 * 这里滤掉它就兑现了文件头那条不变量。
 */
function refOf(env: EvalEnv, id: EntityId | null): EntityId[] {
  return id !== null && getEntity(env.state, id) !== undefined ? [id] : [];
}

/** `X | readonly X[]` 的字段（zone / slot / kind / color…）统一摊成列表。 */
function toList<T>(value: T | readonly T[]): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

/** 去重，保留**首次出现**的位置（顺序是语义的一部分，见文件头）。 */
function dedupe(ids: readonly EntityId[]): EntityId[] {
  const out: EntityId[] = [];
  for (const id of ids) {
    if (!out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

/**
 * 把某方某区域的实体追加进 `out`。
 *
 * `board` 走 `boardEntities`（**按格序 0→8**，v2 §3.2 起 board 的枚举顺序有定义了）；
 * 其余区域走 `zones` 的有序列表 —— 牌库顺序、手牌顺序都由它表达（框架 §3.1）。
 */
function pushZone(env: EvalEnv, out: EntityId[], player: PlayerId, zone: ZoneName): void {
  if (zone === "board") {
    for (const entity of boardEntities(env.state, player)) {
      out.push(entity.id);
    }
    return;
  }
  for (const id of getZone(env.state, player, zone)) {
    if (getEntity(env.state, id) !== undefined) {
      out.push(id);
    }
  }
}

/**
 * 全序比较子：playOrder 升序，同值按实体 id 升序。
 *
 * 为什么要兜到**全序**：架构 §6.1 的确定性测试比的是 `hash(state)`，任何"看排序算法
 * 心情"的抖动都会被放大成假红。`resolve/deaths.ts` 的死亡排序用的是同一条兜底。
 * IR v1 §3.1 对 `sel.or` / `sel.sort` 只说了"按 playOrder 稳定"，本文件把它落成全序。
 */
function byPlayOrder(a: EntityData, b: EntityData): number {
  return a.playOrder !== b.playOrder ? a.playOrder - b.playOrder : a.id - b.id;
}

/** 按实体属性排序一串 id（取不到实体的 id 已在 `evalSel` 处滤掉，故不会丢项）。 */
function sortEntities(
  env: EvalEnv,
  ids: readonly EntityId[],
  compare: (a: EntityData, b: EntityData) => number,
): EntityId[] {
  return getEntities(env.state, ids)
    .sort(compare)
    .map((entity) => entity.id);
}

/**
 * 一次出手的目标：敌方行的「自己格 + 生效 direction」；越界或空 → **敌方基地**。
 * 不在场的实体没有战斗目标 → `null`。
 *
 * `direction` 是普通 Tag（v2 §2.3），读**生效值** `tags.direction`，于是附魔改方向、
 * 光环批量改方向、沉默重置方向全部免费获得，这里一行特判都没有。
 * **不 clamp、不取模**：越界的结果不是"绕回来"，而是打进敌方基地（v2 §4.3）。
 *
 * ⚠ 与 `rules/combat.ts` 的 `combatTargetOf` 是同一条规则的两处实现。不共用的原因是
 *   模块环：`rules/` 依赖 `resolve/`、`resolve/` 与 `handlers/` 将依赖 `eval/`，
 *   反向 import 会成环（同 `rules/combat.ts` 的 `combatOrder` 不 import `phase.ts`
 *   的取舍）。两处注释互相指认，改一处请一起改；行为一致由
 *   `eval/__tests__` 里"与战斗快照同源"那条测试钉着。
 */
function combatTargetOf(env: EvalEnv, entity: EntityData): EntityId | null {
  if (entity.slot === null) {
    return null;
  }
  const enemy = opponentOf(controllerOf(entity));
  const facing = entityAtSlot(env.state, enemy, entity.slot + entity.tags.direction);
  return facing === undefined ? playerEntityId(env.state, enemy) : facing.id;
}

/**
 * `sel.random(of, n?, distinct?)` —— **推进 RNG**（IR v1 §5.4）。
 *
 * ★ IR v1 §5.3 规则 3：**一次性求值**。一次调用就抽满 `n` 个（`distinct` 默认 true ⇒
 *   彼此不重复），这就是"多重射击"。它与规则 2 的 `act.repeat`（每轮重新求值 ⇒
 *   奥术飞弹，三发可能打同一个）长得像、语义完全不同 —— 后者在动作层，不在这里。
 *
 * 求值顺序按签名声明顺序（IR v1 §5.4 规则 1）：先 `of`、后 `n`。
 * **空集与 `n <= 0` 一次 RNG 都不抽**（`rollInt` 的 max 不许为 0）。
 *
 * 抽法是「取走不放回」的 `splice`：第 i 次在剩下的 `len - i` 个里抽，于是
 * `distinct` 时恰好消耗 `min(n, len)` 次 RNG，与盘面细节无关；
 * `n >= len` 时最后一次是 `nextInt(_, 1)`，仍然消耗一个字 ——
 * 让**推进次数与分支无关**是 `rng/rng.ts` 明文定下的规矩。
 *
 * 结果按**抽中的先后**排列，不回填成原顺序：随机结果的顺序本身就是随机的一部分，
 * 回填会让"先打谁"变成一个与随机无关的量，而事件顺序是可观测的（v2 §4.2 顺序敏感点）。
 */
function evalRandom(
  env: EvalEnv,
  of: Sel,
  n: Num | undefined,
  distinct: boolean | undefined,
): EntityId[] {
  const pool = evalSel(env, of);
  const count = n === undefined ? 1 : evalNum(env, n);
  if (pool.length === 0 || count <= 0) {
    return [];
  }
  const picks: EntityId[] = [];
  if (distinct ?? true) {
    const bag = [...pool];
    const times = Math.min(count, bag.length);
    for (let i = 0; i < times; i += 1) {
      // `splice` 返回的是数组，天然没有 `noUncheckedIndexedAccess` 的空值分支。
      for (const id of bag.splice(rollInt(env, "sel.random", bag.length), 1)) {
        picks.push(id);
      }
    }
    return picks;
  }
  for (let i = 0; i < count; i += 1) {
    const index = rollInt(env, "sel.random", pool.length);
    for (const id of pool.slice(index, index + 1)) {
      picks.push(id);
    }
  }
  return picks;
}
