// `evalNum` —— 数值求值（IR v1 §3.2 的 `num.*` 族 + DSL v2 §3.3 的增改）。
//
// ── 字面量不包装（IR v1 原则 4）─────────────────────────────────────────────
// `number` 是 `Num` 联合的**合法成员**：数字直接写 `6`，不写 `{"op":"num.const","v":6}`。
// 所以求值的第一件事是 `typeof node === "number"`，之后才进 switch。
//
// ── 空集合语义（IR v1 §5.2）────────────────────────────────────────────────
// `num.count` / `num.attr` / `num.sum` 空集一律 `0`，取值来自 `empty.ts` 的统一表。
// ★ **唯一例外是 `num.slot_index`：`-1`** —— 0 是真实格子，不能当空值用（v2 §3.3）。
//
// ── 求值顺序即 RNG 顺序（IR v1 §5.4）────────────────────────────────────────
// 每个 op 的字段按**签名声明顺序**求值（规则 1），`Num[]` 按下标升序（规则 2）。
// ★ `num.if` **只求值命中的那个分支**（规则 4 的数值版）—— 千万不要写成
//   「先把 then 与 else 都算出来再三选一」，那会多消耗一整条分支的 RNG，
//   是**静默的确定性 bug**：单元测试全绿，回放对不上。
//
// ── 结果恒为整数 ───────────────────────────────────────────────────────────
// `num.div` 向下取整、`num.random` 抽整数、tag 与全局量都是整数，
// 于是本模块的产出永远是整数（除非 IR 里写了非整数字面量，那是 L1/L2 该挡的事）。
// 这条被 `num.random` 依赖：`nextInt` 的 `max` 必须是整数。

import type { GlobalTag, Num } from "@prismfront/ir";
import { playerData, tagOf } from "../state/index.ts";
import { evalCond } from "./cond.ts";
import type { EvalEnv } from "./context.ts";
import { assertNever, controllerOfSelf, rollInt } from "./context.ts";
import { EMPTY_SET } from "./empty.ts";
import { evalEntities, evalSel, single } from "./sel.ts";

/** 求值一个数值节点（字面数字直接返回 —— IR v1 原则 4）。 */
export function evalNum(env: EvalEnv, node: Num): number {
  if (typeof node === "number") {
    return node;
  }
  switch (node.op) {
    // ── 读集合 ────────────────────────────────────────────────────────────
    case "num.count":
      // 空集 → `EMPTY_SET.count`（0），由 `length` 自然给出。
      return evalSel(env, node.of).length;
    case "num.attr": {
      // IR v1 §3.2：**集合非单元素时返回 0**（空集与多元素同款处理，见 `single`）。
      const entity = single(evalEntities(env, node.of));
      return entity === undefined ? EMPTY_SET.attr : tagOf(entity, node.tag);
    }
    case "num.sum": {
      // 显式标注 `number`：`EMPTY_SET` 是 `as const`，直接推断会得到字面量类型 `0`。
      let total: number = EMPTY_SET.sum;
      for (const entity of evalEntities(env, node.of)) {
        total += tagOf(entity, node.tag);
      }
      return total;
    }

    // ── 变参算术（`Num[]` 按下标升序求值，IR v1 §5.4 规则 2）────────────────
    case "num.add":
      return foldNums(env, node.of, 0, (acc, value) => acc + value);
    case "num.mul":
      // 空列表 → 1（乘法单位元）。与 `num.add` 的 0 同一条理由：单位元让
      // `mul([])` 与"没有这一项"等价，卡牌脚本里就不用写空守卫。
      return foldNums(env, node.of, 1, (acc, value) => acc * value);
    case "num.max":
      return extremum(env, node.of, (value, best) => value > best);
    case "num.min":
      return extremum(env, node.of, (value, best) => value < best);

    // ── 二元与一元 ────────────────────────────────────────────────────────
    case "num.sub":
      return evalNum(env, node.l) - evalNum(env, node.r);
    case "num.div": {
      // IR v1 §3.2：**向下取整，除零得 0**。两个字段都求值（无短路），
      // 否则 `r` 里的 RNG 会因为除零与否而时有时无。
      const l = evalNum(env, node.l);
      const r = evalNum(env, node.r);
      return r === 0 ? 0 : Math.floor(l / r);
    }
    case "num.neg":
      return -evalNum(env, node.of);
    case "num.clamp": {
      const of = evalNum(env, node.of);
      const lo = evalNum(env, node.lo);
      const hi = evalNum(env, node.hi);
      // `lo > hi` 是写卡错误，此时取 `hi`（`min` 在外层）。不抛错 —— 一张写坏的卡
      // 不该让整个房间崩掉（同 IR v1 §5.2 的基调）。
      return Math.min(Math.max(of, lo), hi);
    }

    // ── 控制流 ★ 只求值命中的分支（IR v1 §5.4 规则 4）──────────────────────
    case "num.if":
      return evalCond(env, node.cond) ? evalNum(env, node.then) : evalNum(env, node.else);

    // ── 随机 ★ 推进 RNG（IR v1 §5.4）───────────────────────────────────────
    case "num.random": {
      // 闭区间 `[lo, hi]`。字段按声明顺序求值：先 lo 后 hi。
      const lo = Math.floor(evalNum(env, node.lo));
      const hi = Math.floor(evalNum(env, node.hi));
      const span = hi - lo + 1;
      // `hi < lo` ⇒ 区间为空 ⇒ 没得可抽 ⇒ **不消耗 RNG**，退化成 `lo`
      // （与空集合语义同调：做不成的事静默退化，不抛）。
      // `lo === hi` 时 span 恰为 1，仍然抽一次 —— `rng/rng.ts` 明文要求
      // 「推进次数与分支无关」，`nextInt(_, 1)` 消耗一个字并恒返回 0。
      // `Math.floor` 是对非整数字面量的兜底：`nextInt` 的 max 非整数会抛 RangeError，
      // 而抛错会掀掉整个房间，比静默取整危险得多（L1/L2 才是该挡住它的地方）。
      return span < 1 ? lo : lo + rollInt(env, "num.random", span);
    }

    // ── 全局量与位置 ──────────────────────────────────────────────────────
    case "num.tag":
      return evalGlobalTag(env, node.tag);
    case "num.field":
      // 只在 intercept 内部合法（IR v1 §5.1 / §4.2）：读**被拦截动作**的数值字段。
      // `CtxBindings` 不承载被拦动作（它不跨越挂起点，见 `state/stack.ts` 的说明），
      // 所以 M5 要在 `EvalEnv` 上扩一个求值期字段。在此之前退化成 0 —— 用错上下文
      // 是**校验期**错误（IR v1 §5.1），运行时不该为它设计语义。
      return EMPTY_SET.attr;
    case "num.slot_index": {
      // ★★ 全 IR 唯一的例外返回值：不在场 / 非单实体 → `-1`（v2 §3.3）★★
      //    因为 0 是真实格子，回 0 会让「站在 0 号格」与「根本不在场」同义。
      const entity = single(evalEntities(env, node.of));
      return entity === undefined || entity.slot === null ? EMPTY_SET.slotIndex : entity.slot;
    }

    default:
      // ★ 穷尽检查：IR 新增一个 num.* 而这里漏写 case → 编译不过（见 `assertNever`）。
      return assertNever(node);
  }
}

/** 变参折叠：按下标升序逐项求值（IR v1 §5.4 规则 2），空列表得到单位元 `init`。 */
function foldNums(
  env: EvalEnv,
  list: readonly Num[],
  init: number,
  step: (acc: number, value: number) => number,
): number {
  let acc = init;
  for (const one of list) {
    acc = step(acc, evalNum(env, one));
  }
  return acc;
}

/**
 * `num.max` / `num.min`：空列表 → `0`。
 *
 * 不用 `Math.max(...values)`：它对空列表给 `-Infinity`，而 `Infinity` 是状态与事件的
 * **禁用值**（框架 §3.1 铁律，`JSON.stringify(-Infinity)` 是 `null`，往返即失真）。
 * 0 与空集合语义的其它数值位同调。
 */
function extremum(
  env: EvalEnv,
  list: readonly Num[],
  better: (value: number, best: number) => boolean,
): number {
  let best: number = EMPTY_SET.count;
  let seen = false;
  for (const one of list) {
    const value = evalNum(env, one);
    if (!seen || better(value, best)) {
      best = value;
      seen = true;
    }
  }
  return best;
}

/**
 * `num.tag(tag)` —— 全局量（DSL v2 §3.3 把 v1 的 `turn` / `mana` 换成了这四个）。
 *
 * `round` 是对局级的；`crystals` / `crystal_cap` / `fatigue` 是**玩家级**的，
 * 取 **SELF 的控制者**那一侧 —— 与 `sel.controller` 同一个口径（IR v1 §5.1 的
 * 「SELF 的控制者」），全引擎只有一种"这是谁的资源"的读法。
 * 取不到控制者（悬空 SELF）时退化成 0，与空集合的数值位同调。
 */
function evalGlobalTag(env: EvalEnv, tag: GlobalTag): number {
  if (tag === "round") {
    return env.state.round;
  }
  const player = controllerOfSelf(env);
  if (player === null) {
    return EMPTY_SET.attr;
  }
  const data = playerData(env.state, player);
  switch (tag) {
    case "crystals":
      return data.crystals;
    case "crystal_cap":
      return data.crystalCap;
    case "fatigue":
      return data.fatigue;
    default:
      // ★ 穷尽检查：ir 的 `GLOBAL_TAGS` 加了一项而这里漏写 → 编译不过。
      return assertNever(tag);
  }
}
