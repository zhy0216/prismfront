// 动作的 **SlotRef 参数**：惰性解析、记忆化、以及「无效槽 → 该动作静默跳过」的落点。
// 来源：DSL v2 §3.1（无效槽语义 = 空集合语义的位置版）、v2 §3.4（`act.summon.at` /
//       `act.move_to.to`）、IR v1 §5.2（空集合语义统一表）、§5.3 规则 1（动作内快照）、
//       §5.4 规则 1（**字段声明顺序即求值顺序**）。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 为什么是**惰性解析器**，而不是派发层预先算好的值 ★
// ═══════════════════════════════════════════════════════════════════════════
// `act.summon` 的规范签名是 `{player, card, at, count?}`，而 IR v1 §5.4 规则 1 说
// **字段按签名声明顺序求值**（`ir/src/types/act.ts` 文件头还钉了一句「不许重排」）。
// 派发层若抢在 handler 之前把 `at` 求掉，真实顺序就成了 `at → player → card → count`，
// 两个**可观测**后果：
//   1. **被跳过的动作照样烧 RNG**：`player` 求值为空 ⇒ 整个动作静默跳过（§5.2），
//      但 `at: slot.random_empty` 已经抽过一次 —— 0 条 `unit_summoned`、
//      1 条 `engine.random_picked`。而同一个引擎里 `act.hit{target: 空集}` 一次都不抽
//      （`handlers/targets.ts`：「打空气」不该平白推进一次 RNG）—— 引擎自相矛盾。
//   2. **随机流与规范不一致**：`card` 也可以推进 RNG（`card.random`）。
//      「召唤一张随机牌到随机空格」这种再普通不过的卡，抽到的牌**和**格子都会错位。
// 所以位置参数改成**惰性**：派发层只把「怎么求」交给 handler（{@link SlotResolver}），
// handler 在自己的签名位置上拉一次 —— 前面的字段先求、后面的字段后求，
// 求值顺序**天然**与签名对齐，不靠任何人记得把哪一行放在哪一行前面。
//
// ═══════════════════════════════════════════════════════════════════════════
// 惰性之后，本文件原来论证过的三条性质靠什么继续成立
// ═══════════════════════════════════════════════════════════════════════════
// (a) 「无效槽 ⇒ 动作静默跳过」（v2 §3.1）**仍然只有一处实现**。
//     判据（什么算无效）在 `eval/slot.ts`，取值（`null`）在 `eval/empty.ts` 的空集合
//     语义统一表，「拉不到就跳过」这句话写在 {@link isActSkipped} 的说明里 ——
//     handler 侧只剩**一行早返回**。
//     ⚠ 类型只兜住**一半**，别指望它兜全（实测过，不要照着直觉重写这段）：
//       {@link SlotResolver} 回的是 `SlotAddr | null`，**完全忘记判**的 handler
//       确实编译不过（`slots.to().index` → TS18047）；但编译器只要求「收窄」，
//       分不清收窄成 `return`（整个动作跳过）还是 `continue`（这一个单位跳过）——
//       而那正是本文件末尾 ⚠ note 指出的两种不同语义。
//       实例：删掉 `handlers/summon.ts` 的 `if (isActSkipped(first)) return;`，
//       `tsc --noEmit` 照样 exit 0，因为 `count > 1` 那个循环自己的
//       `if (at === null) continue;` 已经把类型收窄了。
//       **整动作跳过这层语义由测试钉住**，不是由类型钉住：
//       `__tests__/field-order.test.ts` 的「at 解析为无效槽 ⇒ 动作跳过，
//       排在它后面的 count 不再求值」。删掉那行早返回会让它红。
//     ⚠ `grep isActSkipped` 就是「哪些 handler 有位置参数」的完整清单，
//       review 时对着 {@link ActSlotField} 数一遍即可。
// (b) 「位置参数求值**恰好一次**」靠**记忆化**（{@link lazySlot} 的 `memo`）。
//     这条不能松：`slot.random_empty` 推进 RNG（v2 §3.1），求两次就抽两次 ——
//     单位落在跟第一次不同的格上，事件流里还凭空多一条 `engine.random_picked`。
//     单测照样全绿，回放却已经失真。这也是 IR v1 §5.3 规则 1「动作内快照：
//     求值一次，动作全程冻结」的位置版。
// (c) 「`act.summon` 的 `count > 1` 时**每个后续单位重新求值 `at`**」（v2 §3.4）不受影响：
//     第 1 个单位拉的是这里记忆化的那一份，第 2 个起由 handler 自己调 `evalSlot`
//     （`handlers/summon.ts`）。——「后续」二字是有意的：第一次不能重求，
//     否则第 1 个单位就多抽了一次随机。
//
// ═══════════════════════════════════════════════════════════════════════════
// ⚠ 代价：**实现进度重新开始影响随机流**（有意接受，理由与前提逐条写在下面）
// ═══════════════════════════════════════════════════════════════════════════
// 预先求值的年代有一条附带性质：位置参数**恒被求值**，所以某个 op 挂的是真 handler
// 还是 `notImplemented` 占位（`handlers/index.ts`），RNG 推进的次数都一样 ——
// 「今天的回放到补齐那个 op 的那天依然对得上」。惰性之后这条没了：占位 handler
// 一个字段都不拉，一次随机都不抽；真 handler 会抽。
//
// 1. **这个代价躲不掉。** 真 handler 到底抽几次随机，本来就取决于它前面的字段
//    （`player` 空不空、`card` 求不求得出来）——而那几个字段只有 handler 自己会求。
//    「字段顺序对齐签名」与「RNG 次数与实现进度无关」不可兼得，前者是规范
//    （IR v1 §5.4 规则 1）、后者只是实现的自我承诺，冲突时让后者。
// 2. **未实现的 op 不该出现在真实对局里。** 架构 §5.1：engine 载入 bundle 时用
//    `bundle.opsUsed` 与自己支持的 op 集做一次全集比对，**不支持就拒载**，
//    「不用等到卡打出来才炸」（IR §2.1 对 `opsUsed` 的原话）。成立的话，
//    占位 handler 根本没机会参与任何一局，上面那条差异也就无从观测。
//    ★ **但这个检查目前还没有实现**：engine 里没有任何 bundle 载入路径
//    （`packages/cards` 还是空壳，`ACT_HANDLERS` 也没有把"支持的 op 集"导给谁比对）。
//    `handlers/index.ts` 的 `NOT_IMPLEMENTED_OPS` 已经是那份清单的现成来源，
//    载入期比对补在哪里一目了然；在它补上之前，「未实现的 op 不进对局」靠的是
//    **卡还没写**，不是靠机制 —— 这是一条已知缺口，不是已经兑现的前提。
// 3. 同一类的差异**本来就已经存在一条**：`act.summon` 在「卡表查不到这张卡」时
//    也是在 `card` 的位置上就返回（`handlers/summon.ts`），于是「引擎接没接 bundle」
//    同样会改变随机流。它比第 2 条更早存在，兜底方式也是同一个。
//
// ═══════════════════════════════════════════════════════════════════════════
// 判出无效槽之前**已经消耗掉的 RNG 不回滚**
// ═══════════════════════════════════════════════════════════════════════════
// `slot.shift(slot.random_empty(friendly), +9)` 会先抽一次随机、再算出界 ⇒ 无效槽。
// 动作静默跳过，但那一次 `nextInt` 是真的发生了，`engine.random_picked` 照发 ——
// `events/event.ts` 钉死了「一次 `nextInt` = 一条事件，一一对应」，少发一条会让
// 「随机流从哪一步开始错位」这件事再也查不出来。
// §5.2 说的「不产生事件」指的是**动作自己的**事件（`unit_summoned` 之类），
// 不是引擎的随机审计事件。

import type { Act, ActNode, ActOp, SlotRef } from "@prismfront/ir";
import type { EvalEnv, SlotAddr } from "../eval/index.ts";
import { EMPTY_SET, evalSlot } from "../eval/index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 「哪些动作带位置参数」这件事**从 IR 类型算出来**，不手抄
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 某个 act op 上取值为 {@link SlotRef} 的字段名；没有则为 `never`。
 *
 * 从 `ActNode<K>` 算出来而不是维护一张手抄表：IR 给某个动作加一个 SlotRef 字段，
 * 这个类型立刻跟着变，{@link resolveActSlots} 的穷尽检查随之报错。
 * 手抄表则会静默漂移 —— 那正是本文件想根除的那一类 bug。
 */
type SlotFieldOf<K extends ActOp> = {
  [F in keyof ActNode<K>]-?: ActNode<K>[F] extends SlotRef ? F : never;
}[keyof ActNode<K>];

/**
 * 全 IR 里出现过的位置字段名（当前 = `"at" | "to"`）。
 *
 * ⚠ `"to"` 在 `act.steal` 里是 Sel、在 `act.move_to` 里才是 SlotRef
 * （`ir/src/types/act.ts` 的 `ACT_ENTITY_FIELDS` 也点了这件事）。
 * 这里按**字段类型**算，所以不会把 `act.steal.to` 算进来。
 */
export type ActSlotField = { [K in ActOp]: SlotFieldOf<K> }[ActOp];

/** 带位置参数的 act op（当前 = `"act.summon" | "act.move_to"`）。 */
type ActOpWithSlot = { [K in ActOp]: [SlotFieldOf<K>] extends [never] ? never : K }[ActOp];

// ═══════════════════════════════════════════════════════════════════════════
// 交给 handler 的东西：解析器，而不是值
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一个位置参数的**惰性且记忆化**的取值口。
 *
 * - **惰性**：不调就不求值 —— handler 在自己的签名位置上调它，于是位置参数与
 *   前后字段的求值顺序自动对齐规范签名（IR v1 §5.4 规则 1，见文件头）。
 *   前面的字段判出「整个动作跳过」时（`player` 为空集之类），它一次都不会被调用，
 *   `slot.random_empty` 那一次随机也就不会白白烧掉。
 * - **记忆化**：调两次也只求一次值，第二次拿到同一份坐标（文件头 (b)）。
 *
 * 返回 `null` = **无效槽**（v2 §3.1）⇒ 整个动作静默跳过，判据见 {@link isActSkipped}。
 */
export type SlotResolver = () => SlotAddr | null;

/**
 * 一个动作的位置参数**解析器**：字段名 → {@link SlotResolver}。
 *
 * 对具体 op 是**精确**的，而且字段**非可选**：
 * - `ActSlots<"act.summon">` = `{ readonly at: SlotResolver }`
 * - `ActSlots<"act.move_to">` = `{ readonly to: SlotResolver }`
 * - 不带位置参数的 op（30 个 act op 里的 28 个）得到空对象，handler 忽略第三个参数即可。
 *
 * 「非可选」保证的是**取得到**（handler 不必写 `slots.at?.()`）；
 * 「取出来可能是 `null`」保证的是**判得到**（无效槽跳不掉就编译不过）。
 */
export type ActSlots<K extends ActOp = ActOp> = {
  readonly [F in SlotFieldOf<K>]: SlotResolver;
};

/**
 * {@link ActSlots} 的**擦除**形态：只在派发点（`deps.ts` 的 `runHandler`）出现。
 *
 * 分发时 `act` 是整个 `Act` 联合，无法把「表里取出的 handler」与「这个 act」的
 * op 关联起来（TS 至今没有 correlated union 的类型运算），所以派发点必然有一次断言；
 * 本类型是那次断言的目标形状，字段一律可选。类型安全由**注册侧**保证 ——
 * 往 `HandlerTable` 里放 handler 时，键与 {@link ActSlots} 的对应是编译期检查过的。
 */
export type ErasedActSlots = { readonly [F in ActSlotField]?: SlotResolver };

/** 没有位置参数的动作得到的解析器集合（30 个 act op 里的 28 个走这一支）。 */
export const NO_ACT_SLOTS: ErasedActSlots = {};

/**
 * {@link resolveActSlots} 的产物：交给 handler 的解析器 + 事后回读「跳过了吗」。
 *
 * 两半分开是因为它们的读者不同：`slots` 给 handler，`skipped` 给派发层
 * （`runHandler` 的返回值，见那里的说明）。**`skipped` 必须在 handler 跑完之后问** ——
 * 位置参数是惰性的，跑之前问一律是 `false`（还没人拉过）。
 */
export interface ActSlotAccess {
  /** 按字段名取解析器，原样交给 handler 的第三个形参。 */
  readonly slots: ErasedActSlots;
  /** 有没有位置参数被拉取过、且解析成了无效槽（⇒ 该动作静默跳过，v2 §3.1）。 */
  readonly skipped: () => boolean;
}

/** 没有位置参数的动作的定值结果：空解析器集合 + 恒不跳过。 */
const NO_SLOT_ACCESS: ActSlotAccess = { slots: NO_ACT_SLOTS, skipped: () => false };

/**
 * ★ 位置参数没解析出来 ⇒ **整个动作静默跳过**（DSL v2 §3.1）★
 *
 * 「动作的 SlotRef 参数解析为无效槽 → 该动作静默跳过」这句规范，在 handler 侧
 * 就是**这一个谓词 + 一行 `return`**；判据与取值都不在 handler 里，
 * 分别来自 `eval/slot.ts` 与 `eval/empty.ts` 的空集合语义统一表（文件头 (a)）。
 *
 * 刻意不让调用方直接写 `at === null`：那样取值就来自一个字面量而不是来自
 * {@link EMPTY_SET}，`empty.ts` 那张「不许各 op 各自发明」的表就白立了
 * （与该文件里 `forAll` 拒绝直接写 `list.every` 是同一条理由）。
 *
 * ⚠ 它表达的是**整个动作**跳过。`act.summon` 的 `count > 1` 时「这一个单位召不出来、
 *   但循环继续」是另一回事（v2 §3.4），那里直接判 `evalSlot` 的 `null` 并 `continue`。
 */
export function isActSkipped(addr: SlotAddr | null): addr is null {
  return addr === EMPTY_SET.actSkipped;
}

// ═══════════════════════════════════════════════════════════════════════════
// 解析
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 为一个动作的全部 SlotRef 参数**建**解析器（此刻**一次都不求值**）。
 *
 * 返回值两态：
 * - {@link NO_SLOT_ACCESS} —— 这个动作没有位置参数；
 * - `{ slots: { at } }` / `{ slots: { to } }` —— handler 拉的时候才求值，
 *   拉到的坐标要么**保证有效**（`evalSlot` 的承诺：索引已落在 `[0, rules.board.slots)`，
 *   格子数量来自规则而不是写死的 9），要么是 `null` = 无效槽 ⇒ 动作跳过。
 *
 * 「有效」不等于「空着」：`act.summon` 的 `at` 被**占用**同样要跳过（v2 §3.4），
 * 但那是 handler 的事 —— 占用与否随本动作前面的连锁而变，属于执行语义，不属于取值。
 */
export function resolveActSlots(env: EvalEnv, act: Act): ActSlotAccess {
  switch (act.op) {
    case "act.summon": {
      const at = lazySlot(env, act.at);
      return { slots: { at: at.pull }, skipped: at.skipped };
    }
    case "act.move_to": {
      const to = lazySlot(env, act.to);
      return { slots: { to: to.pull }, skipped: to.skipped };
    }
    default:
      return assertNoSlotArg(act);
  }
}

/**
 * 一个位置参数的惰性求值单元：对外是 {@link SlotResolver}，对内多一个回读口。
 *
 * `memo` 有**三**个取值，缺一不可：
 *   `undefined` —— 还没求过（handler 没拉，或者前面的字段先判出了跳过）；
 *   `SlotAddr`  —— 求过了，有效；
 *   `null`      —— 求过了，是无效槽。
 * 把「没求过」与「求出来是 null」混成一个值，记忆化就会退化成"每次重求"，
 * 无效槽那一支于是每拉一次抽一次随机 —— 正是 (b) 要禁掉的事。
 */
interface LazySlot {
  readonly pull: SlotResolver;
  readonly skipped: () => boolean;
}

function lazySlot(env: EvalEnv, ref: SlotRef): LazySlot {
  let memo: SlotAddr | null | undefined;
  return {
    pull: () => {
      if (memo === undefined) {
        const addr = evalSlot(env, ref);
        // 无效槽的取值来自空集合语义统一表，本文件不自己发明（`eval/empty.ts`）。
        memo = addr === null ? EMPTY_SET.actSkipped : addr;
      }
      return memo;
    },
    // 没拉过 ⇒ 谈不上"被无效槽掐掉"，所以 `undefined` 必须与 `null` 分开判。
    skipped: () => memo !== undefined && isActSkipped(memo),
  };
}

/**
 * ★ 穷尽检查：与 `eval/context.ts` 的 `assertNever` 同一条思路，只是判据换成
 * 「这个 op 上没有 SlotRef 字段」。IR 新增一个带位置参数的动作而上面漏写 case，
 * `act` 在 `default` 分支就不再可赋给本函数的参数类型 —— **编译当场报错**。
 *
 * 与 `assertNever` 的一处**有意不同**：本函数**不抛错**，正常返回。
 * `assertNever` 的 default 分支是「不可能到达」，所以到了就该响；而这里的 default
 * 是 28 个 op 每次结算都要走的**正常路径**，抛错等于把整条流水线炸掉。
 * 保险完全落在编译期那一行上，运行期只是老实地回一句「这个动作没有位置参数」。
 */
function assertNoSlotArg(_act: ActNode<Exclude<ActOp, ActOpWithSlot>>): ActSlotAccess {
  return NO_SLOT_ACCESS;
}
