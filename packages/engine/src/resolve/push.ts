// 结算栈的写入口。
// 来源：框架 §4.1（`stack.pop()` ⇒ 后进先出）、IR v1 §5.4 规则 2（`Act[]` 按数组下标升序求值）、
//       IR v1 §6.2（栈条目的**规范形态**：用 `<cardId>#<路径>` 引用）、
//       IR v1 §5.6（运行时超集：引擎**源码里现造**的动作在 bundle 里没有位置 ——
//       ★ 只覆盖下面那份分类的第 ① 类，别把它当成"引擎压的条目都没有 ref"）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 为什么需要一组具名的 push 函数，而不是到处写 `state.stack.push(...)`
// ═══════════════════════════════════════════════════════════════════════════
// 因为**栈是 LIFO，而 `Act[]` 的语义是顺序执行**，两者方向相反：
//
//   `[A, B, C]` 要按 A → B → C 执行  ⇒  必须按 C、B、A 的顺序 push
//
// 这个反转只要有一处写反，卡牌的动作顺序就会静默颠倒 —— 而颠倒后的结果往往
// 「看起来也挺合理」，于是能一路混进产线。把反转关进 {@link pushActs} 一个函数里，
// 全引擎（handler、触发器入栈、resume 续跑）都只调它，反转就只有一处可能写错。
//
// 同一条理由适用于框架 §4.1 时序规则 1 的触发器排序：`triggers.ts` 把排好序的
// 触发器交给 {@link pushPendingInOrder }，同样由本模块做那一次逆序。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 条目形态：什么时候内联、什么时候用 ref（全仓唯一的那份规则）★
// ═══════════════════════════════════════════════════════════════════════════
// IR v1 §6.2 的**规范形态**是引用（`{via:"ref", ref:"CORE_050#play.1"}`），收益是条目极小
// ⇒ `clone(state)` 快 ⇒ MCTS 可行、快照/回放便宜。{@link pushScript} 把那条路留着，
// `deps.ts` 的 `actOfPending` 也两种形态都认。
//
// ── 三个问题必须分开问 ──────────────────────────────────────────────────────
// 「这个节点**来自卡表吗**」「这个压栈点**造得出 ref 吗**」「那**为什么仍然内联**」
// 是三件事。揉成一句就会得到假分类 —— 上一版把 `intercept.then` 与 `act.when.then`
// 一起归进「引擎自己生成的动作，在 bundle 里没有位置」，而 `intercept.then` 明明是
// `deps.scripts(cardId)?.intercepts[i].then[j]` 取出来的卡表节点。逐个压栈点如下。
//
//   ① 引擎源码里现造的动作节点
//      `rules/combat.ts` 的 `act.strike`（战斗快照，v2 §4.2 第 ③ 步）、
//      `handlers/damage.ts` 的 `act.hit`（`act.strike` 展开、数值已冻结）、
//      `rules/phase.ts` 的 `act.move` 与疲劳 `act.hit`。
//      · 来自卡表吗：**不是**，它们是引擎源码里的对象字面量（IR v1 §5.6 运行时超集）
//      · 造得出 ref 吗：**造不出** —— bundle 里根本没有这个节点，ref 无处可指
//      · 于是内联是**唯一**形态，这一类没有取舍可言
//
//   ② `handlers/control.ts` 压的 `act.when.then` / `act.repeat.do` / `act.for_each.do`
//      · 来自卡表吗：**多半是**（卡表节点的子数组），但 handler **判断不了** ——
//        这三个 op 同样会出现在 `intercept.then` / `trigger.do` 里
//        （引擎现造的 Act 目前只有 `act.strike` / `act.hit` / `act.move`，
//        一个带子数组的都没有，所以那一支今天零实例 —— 但 handler 依旧分辨不出来）
//      · 造得出 ref 吗：**这个压栈点造不出**。cardId 只在子数组来自**卡**时拿得到
//        （`ctx.self` → `entity.cardId`）；来自**附魔**的那一支连 cardId 都不对 ——
//        `ctx.self` 是被附魔的宿主，它的 `cardId` 是宿主的卡而非附魔（同 ④ 的第二条）。
//        更根本的是**路径拿不到**：栈条目 `PendingInlineAct` 是
//        `{via, act, ctx}`、`EvalEnv` 是 `{state, ctx, cards, enchantments, field}` ——
//        从弹栈到 handler 全程没有任何一处带着"这个节点在卡里的下标"
//      · 就算补一个路径字段也不够：handler 手里的是**过了拦截器**的节点
//        （`resolve.ts` 把 `applyInterceptors` 的返回值交给 `runHandler`），而
//        `act.repeat.n` 就在 IR 的 `ACT_NUM_FIELDS` 里 —— 一条 `set_field{n}` 就能让
//        「父节点此刻的内容」与「它在 bundle 那条路径上的内容」对不上
//        （实测：卡表写 `n:1`、一条 `intercept:"act.repeat"` 的 `set_field` 改成 3，
//        `repeatHandler` 压的是 3 份）。照路径重新展开 = 静默撤销拦截器
//      · 于是这里同样只有内联走得通
//
//   ③ `resolve/interceptors.ts` 压的 `intercept.then`
//      · 来自卡表吗：**是**。`deps.scripts(entity.cardId)?.intercepts` 取的，
//        与触发器的 `do` 同一张 `ScriptLookup`、同一份卡表
//      · 造得出 ref 吗：**造得出**，`<cardId>#intercepts.<i>.then.<j>` —— cardId 是宿主
//        实体的，两个下标就在 `collectInterceptors` / `applyInterceptors` 那两层循环里
//        （现在写成 `for…of` 没记下标，换 `.entries()` 即得）
//      · 那为什么仍然内联：这是**取舍**，不是被迫。`triggers.ts` 文件头第 2 条那三条
//        理由里，a（引擎手里已经有整段节点）与 c（全仓没有 `ScriptExpander` 实现
//        ⇒ 走 ref 就是静默失效）逐字适用，任一条单独成立就够；b（附魔没有
//        `<cardId>#…` 形式的 ref）**不适用** —— IR v1 §2.3 的 `EnchantmentScript`
//        没有 `intercepts`，拦截器只有卡这一个来源（`interceptors.ts` 文件头第 3 条）
//
//   ④ `resolve/triggers.ts` 压的触发器 / 亡语的 `do`
//      · 来自卡表吗：**卡表或附魔** —— `card.script.triggers` 与
//        `Enchantment.script.triggers`（IR v1 §2.3）两个来源
//      · 造得出 ref 吗：卡的造得出；**附魔的造不出**（`ScriptRef` 的形状就是
//        `<cardId>#…`，见 `state/stack.ts`）
//      · 那为什么仍然内联：★ **完整论证**（三条理由、代价、将来若因快照体积回到 ref
//        形态要动哪几处）写在 `resolve/triggers.ts` 文件头第 2 条。**本节不重复它**，
//        只在 ③ 里点名哪几条适用；那一条也不重复本节的分类
//
//   ⑤ `testkit/index.ts` 的 `castCard` 压的 `card.script.play`
//      · 来自卡表吗：**是** · 造得出 ref 吗：**造得出**（`<cardId>#play.<i>`）
//      · 那为什么仍然内联：同 ③ 的 a / c。★ 这是**跑卡牌 `play` 脚本的现实做法**，
//        M4/E6 起单卡测试一直走它 —— M6 的 `play_card` 照它落地，见下一段
//
// ── 当前事实（**不是**被钉住的不变量）：生产代码压进栈的条目一律内联 ──────────
// 核法是一次 grep —— {@link pushScript} 是唯一**具名的** ref 条目构造处：
//     grep -rn --include='*.ts' 'pushScript(' packages/engine/src | grep -v __tests__
// 只应命中它自己那一行定义；多出任何一行，上面这句话就已经过期。
// ⚠ 这条 grep **必要但不充分**：`pushPending(state, { via: "ref", … })` 同样造得出 ref
//   条目而 grep 抓不到。堵住它的是本节末尾那条「生产代码别处不要手写 `{ via: … }`
//   字面量」—— 两条要合起来读，单看 grep 会以为已经封死了。
// 刻意**不**为它写测试：写得出来的那种（跑一局、断言栈上条目都是 inline）只覆盖被跑到
// 的路径，却会让人以为全仓被钉住了 —— 那种假防线比没有防线更坏。
//
// **谁会打破它**：M6 的 `play_card`。`rules/phase.ts` 的 `playCard` 现在只压一条
// `act.move`，M6 要接上卡的 `play` 段（战吼）。★ 那一步**必须内联**：取
// `deps.scripts(card.cardId)?.play`，接在 `act.move` 后面一起交给 `StepActs.acts`
// （数组顺序即执行顺序，`runStep` 用 `pushActs` 一次压入）—— 与 ⑤ 逐字同一条路。
// 压 ref 条目则会**静默失效**：全仓没有 `ScriptExpander` 的生产实现 ⇒ `deps.expandScript` 缺省
// ⇒ `actOfPending` 返回 null ⇒ 整条战吼一声不响地不执行。这个失败形态由
// `resolve/__tests__/resolve.test.ts` 的「展不开的脚本引用静默跳过」钉着。
// 真要让某个来源改走 ref，得**同时**补上 `ScriptExpander` 的实现，
// 并把上面那句「一律内联」连同它的 grep 一起改写，而不是留着当摆设。
//
// ⚠ 单一来源的是**完整论证**（`triggers.ts` 文件头第 2 条），**不是**「没有生产
//   expander」这条光秃秃的事实 —— 那句话作为上下文在下面几处各出现一次，
//   接上 expander 的那天要一起改，别只改一处：
//     · 本节 ③ 的「理由 c 适用」、本段上面那句「压 ref 会静默失效」
//     · `rules/phase.ts` 的 `playCard`（M6 接战吼那一段）
//     · `resolve/triggers.ts` 文件头第 2 条的理由 c（权威出处）
//     · 本文件 {@link pushScript} 的 ⚠
//
// 于是「栈条目长什么样」全仓只有一处实现：{@link inlinePending} 造内联条目、
// {@link pushScript} 造引用条目。**生产代码别处不要手写 `{ via: … }` 字面量** ——
// 两种形态一旦在别处各自成型，`PendingAction` 的构造就有了第二个真相源，
// 而这类分叉只会在"某张卡偶尔不生效"上显形。
//（测试里仍然手写：那里条目形态本身就是被测对象，用构造函数造反而会跟着一起错。）

import type { Act } from "@prismfront/ir";
import type {
  CtxBindings,
  GameState,
  PendingAction,
  PendingInlineAct,
  ScriptRef,
} from "../state/index.ts";

/**
 * 把一个已经造好的栈条目压栈。
 *
 * 这是最底层的写入口；正常代码请优先用 {@link pushAct} / {@link pushActs} /
 * {@link pushScript}，它们负责造条目并处理顺序。
 */
export function pushPending(state: GameState, pending: PendingAction): void {
  state.stack.push(pending);
}

/**
 * 按「`items[0]` 最先出栈」的语义压入一批条目，即**逆序 push**。
 *
 * 调用方给的永远是**执行顺序**，反转由本函数负责 —— 见文件头。
 */
export function pushPendingInOrder(state: GameState, items: readonly PendingAction[]): void {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    // `noUncheckedIndexedAccess` 下 `items[i]` 是 `T | undefined`。这里 i 恒在界内，
    // 但不用 `!` 绕过去（架构对 M2 的硬约束之一），显式判一下更便宜也更诚实。
    if (item !== undefined) {
      state.stack.push(item);
    }
  }
}

/**
 * 造一条**内联动作**栈条目 —— ★ 内联形态的唯一构造处，**不入栈**。
 *
 * 给「先逐条造好、稍后一次性入栈」的调用方用：`triggers.ts` 的
 * `collectTriggerSubscriptions` 要先把条目挂到 `QueuedTrigger` 上排序（时序规则 1），
 * 排完才交给 {@link pushPendingInOrder }；`interceptors.ts` 的 `then` 同理。
 * 直接入栈的场合用 {@link pushAct} / {@link pushActs} —— 它们也从这里造条目，
 * 于是两条路造出来的条目必然逐字相同。
 *
 * 谁该内联、谁该走 {@link pushScript}：见文件头「条目形态」一节。
 */
export function inlinePending(act: Act, ctx: CtxBindings): PendingInlineAct {
  return { via: "inline", act, ctx };
}

/**
 * 压入一条**内联动作**（IR v1 §5.6 的运行时超集）。
 *
 * 条目由 {@link inlinePending} 造；内联与引用怎么选见文件头「条目形态」一节，
 * 这里不复述规则。
 */
export function pushAct(state: GameState, act: Act, ctx: CtxBindings): void {
  state.stack.push(inlinePending(act, ctx));
}

/**
 * 压入一串内联动作，保证按**数组下标升序**执行（IR v1 §5.4 规则 2）。
 *
 * 这是 `act.when.then` / `act.repeat.do` / `act.for_each.do` / 触发器的 `do`
 * 这些 `Act[]` 字段唯一正确的入栈方式。
 */
export function pushActs(state: GameState, acts: readonly Act[], ctx: CtxBindings): void {
  for (let i = acts.length - 1; i >= 0; i -= 1) {
    const act = acts[i];
    if (act !== undefined) {
      state.stack.push(inlinePending(act, ctx));
    }
  }
}

/**
 * 压入一条**脚本引用**条目（IR v1 §6.2 的规范形态）—— ★ 引用形态的唯一构造处。
 *
 * `ref` 形如 `"CORE_050#play.1"`。条目里不内联节点，收益见 `state/stack.ts`：
 * 条目极小 → `clone(state)` 快 → MCTS 可行、快照/回放便宜。
 * 展开由 `deps.ts` 的 `ScriptExpander` 负责。
 *
 * ⚠ **目前没有任何生产代码走这条路**（核法与"谁会打破它"见文件头「当前事实」那一段）。
 * 它留在这里是为了让 M7/M8 真需要缩小快照时有一条现成的路，**不是**"卡表的脚本
 * 应该走这里" —— `ScriptExpander` 补上之前，压一条 ref 条目 = 那段脚本静默失效。
 */
export function pushScript(state: GameState, ref: ScriptRef, ctx: CtxBindings): void {
  state.stack.push({ via: "ref", ref, ctx });
}
