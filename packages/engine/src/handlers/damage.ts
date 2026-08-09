// 伤害与治疗、出手、直接消灭：`act.hit` / `act.heal` / `act.strike` / `act.destroy`。
// 来源：v2 §3.4（`act.strike`：立即出手一次，`amount` 缺省 = attacker **当前** atk，
//       **内部走 `act.hit` 管线**，并发 `struck`；带上 `amount` 时用它 —— 那是 IR §5.6
//       的运行时超集字段，战斗第 ② 步的冻结值，见 {@link strikeHandler}）、
//       IR v1 §3.4（`act.hit` / `act.heal` / `act.destroy`）、
//       v2 §5（`struck` / `damaged` / `healed` 的负载）、
//       `state/entity.ts`（血量记账）、IR v1 §5.3 规则 1（动作内快照）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 三条必须守住的规矩
// ═══════════════════════════════════════════════════════════════════════════
// 1. **伤害写 `entity.damage`，不动 `tags.health`**（`state/entity.ts` 的血量记账定案：
//    `tags.health` 是生效血量上限，当前血量 = `tags.health - damage`）。
//    写 `tags` 会被流水线第 ⑥ 步 `refreshAuras` 从 `base` 重算覆盖（时序规则 4），
//    症状是"打了没掉血"或"buff 掉了单位就复活"。
// 2. **不在 handler 里判死**（`resolve/deps.ts` 的 handler 契约第 2 条）。
//    死亡是流水线第 ⑤ 步的独立阶段（时序规则 3：批量、跑到不动点）。
//    handler 只负责把 `damage` 加上去，`processDeaths` 会在同一步的末尾收走。
//    —— `act.destroy` 也不例外，见 {@link destroyHandler}。
// 3. ★ **目标只求值一次**（IR v1 §5.3 规则 1）：一律经 `targets.ts` 的 `snapshot`。
//    「打第一个随从致死后，列表不会缩短，剩下的照打」就是这条的可观测形态。
//
// ⚠ 溅射 / 反伤走 `act.hit`，**不发 `struck`**（v2 §8.7：这是"反伤不会互相触发成
//   无限连锁"的全部机制）。别顺手在 {@link hitHandler} 里补发 `struck`。

import { evalNum } from "../eval/index.ts";
import { emitEvent } from "../events/index.ts";
import type { ActHandler } from "../resolve/index.ts";
import { pushAct } from "../resolve/index.ts";
import { BASE_CARD_ID, withCtx } from "../state/index.ts";
import { frozenEntities, singleTarget, snapshot, sourceOf } from "./targets.ts";

/**
 * `act.hit{target, amount, spellDamage?}` —— 造成伤害并逐个发 `damaged`。
 *
 * 求值顺序按签名声明顺序（IR v1 §5.4 规则 1）：**先 target 后 amount**，
 * 且 `amount` 对整个动作只求一次 —— 打 5 个目标不是抽 5 次 `num.random`。
 *
 * 两处静默跳过（IR v1 §5.2）：
 * - `target` 求值为空 → 整个动作跳过，**`amount` 连求都不求**
 *   （"打空气"不该平白推进一次 RNG，见 `targets.ts` 的 `snapshot`）；
 * - `amount <= 0` → 什么都不做：「造成 0 点伤害」不是一件发生过的事，
 *   发一条 `amount: 0` 的 `damaged` 只会让"每当受到伤害"的触发器（M5）凭空触发。
 *
 * **不处理**的两件事，都要等它们各自的机制才有意义：
 * - `armor`（护甲减伤）—— 减伤的正确落点是拦截器（IR v1 §4.2），M5；
 * - `spellDamage`（法术伤害加成）—— 加成源要从光环里数（IR v1 §4.3），M5。
 */
export const hitHandler: ActHandler<"act.hit"> = (env, act) => {
  const targets = snapshot(env, act.target);
  if (targets.length === 0) {
    return;
  }
  const amount = evalNum(env, act.amount);
  if (amount <= 0) {
    return;
  }
  const source = sourceOf(env);
  for (const target of frozenEntities(env, targets)) {
    // A combat batch can contain several frozen strikes against the same base.
    // Clamp the recorded damage at the base's health so the public state never
    // exposes a negative health value while preserving the simultaneous batch.
    const applied =
      target.cardId === BASE_CARD_ID
        ? Math.min(amount, Math.max(0, target.tags.health - target.damage))
        : amount;
    if (applied <= 0) {
      continue;
    }
    target.damage += applied;
    emitEvent(env.state, { name: "damaged", source, target: target.id, amount: applied });
  }
};

/**
 * `act.heal{target, amount}` —— 治疗，逐个发 `healed`。
 *
 * 治疗是**减 `damage` 且不越过 0**（`state/entity.ts` 的血量记账），不是加 `tags.health`：
 * 加上限等于"+X/+X 的永久 buff"，那是 `act.buff` 的事。
 *
 * `healed.amount` 是**实际**回复量（`events/event.ts`：溢出部分不计），
 * 于是治疗一个满血单位 `amount` 为 0 ⇒ **不发事件**（同 {@link hitHandler} 的 0 伤害）。
 * 「过量治疗」在别的游戏里是可监听事件，这里没有对应的事件名（v2 §5 的 25 个里没有），
 * 强行发一条 `amount: 0` 只会污染触发器。
 */
export const healHandler: ActHandler<"act.heal"> = (env, act) => {
  const targets = snapshot(env, act.target);
  if (targets.length === 0) {
    return;
  }
  const amount = evalNum(env, act.amount);
  if (amount <= 0) {
    return;
  }
  const source = sourceOf(env);
  for (const target of frozenEntities(env, targets)) {
    const healed = Math.min(amount, target.damage);
    if (healed <= 0) {
      continue;
    }
    target.damage -= healed;
    emitEvent(env.state, { name: "healed", source, target: target.id, amount: healed });
  }
};

/**
 * `act.strike{attacker, target}` —— 发 `struck`，然后**把一条 `act.hit` 压栈**。
 *
 * 为什么是压栈而不是就地调用 {@link hitHandler}：
 * - v2 §3.4 规定 strike **内部走 `act.hit` 管线**，目的是让拦截器（圣盾、减伤、
 *   "改为受到 1 点伤害"）在 `act.hit` 这一层就能拦到；就地调用会绕过流水线第 ② 步，
 *   M5 接上拦截器时圣盾会挡不住出手。
 * - 框架 §4.1 时序规则 2：连锁一律入栈。
 *
 * ── ⚠ 压栈带来的**真实**事件顺序（别按直觉猜）────────────────────────────
 * `damaged` **不在本 handler 里发**：它要等压进去的那条 `act.hit` 被弹出来、跑完
 * 自己那一遍流水线才发。于是 `struck` 与 `damaged` 分属**两次**弹栈、进的是**两批**
 * 触发器排队，而两批之间谁先跑**由调用方的入栈时机决定**，本 handler 决定不了：
 * - `resolve()` 逐条弹栈、每批当场入栈（`resolve/triggers.ts` 的 `queueTriggers`）⇒
 *   第 ④ 步压的触发器盖在第 ③ 步压的那条 `act.hit` **之上**，于是它先跑。
 *   事件流是 `struck` →（`struck` 的触发器产的事件）→ `damaged` →（`damaged` 的触发器）：
 *   出手的触发器跑在**这一击自己的伤害之前**。
 * - 战斗第 ③ 步（`rules/combat.ts` 的 `applyStrikes`）把 `act.hit` 收进本地链条、
 *   整批只入栈一次 ⇒ 两批按事件发出序排，`struck` 的触发器在 `damaged` 的之前，
 *   而伤害在两批触发器之前就落地了。
 * 所以这里**不**声称"排队顺序天然正确" —— 那是一条测不到的断言（reviewer 实测：
 * 修复之前战斗里同一击的 `damaged` 触发器反而先于 `struck` 触发器跑）。
 *
 * `attacker` 与 `target` 都要求**恰好一个实体**（"立即出手一次"，v2 §3.4）：
 * 非单实体一律静默跳过，判据与 `act.swap` 的"须各为单个在场单位"是同一条
 * （见 `targets.ts` 的 `singleTarget`）。
 *
 * ── ★ `amount` 从哪来：**动作上带了就用它**，否则读 attacker 当前 atk ★ ─────
 * `act.strike.amount` 是 IR §5.6 的**运行时超集**字段（`ir/src/types/act.ts`，
 * irVersion 2.3.0 加的），编写层写不出来 —— 唯一的填写方是战斗第 ② 步的快照
 * （`rules/combat.ts` 的 `strikeActOf`），填的就是 v2 §4.2「记录后全部冻结」的那个数。
 * 缺省分支（卡牌效果驱动的 `Strike(a, t)`）保持 v2 §3.4 原文的「attacker **当前** atk」。
 *
 * 这一行是「冻结值真的走完管线」的**唯一**落点：改回无条件 `attacker.tags.atk`，
 * 批次中途被拦截器 `then` 或光环重算改掉的 atk 就会重新泄漏进伤害数字
 * （M5/T5 之前正是如此，那时靠一道运行时哨兵当场抛错止损）。
 *
 * 求值顺序仍是签名序（IR v1 §5.4 规则 1）：attacker → target → amount。
 * 前两者取不到单实体就直接返回，**`amount` 连求都不求** —— 与 {@link hitHandler}
 * 「打空气不平白推进一次 RNG」是同一条（战斗填的是字面量，但卡面将来若填节点就有分别）。
 *
 * 之后 `amount` 与 `target` 在压栈时**冻结**成字面量与 `sel.entity`（同样是运行时超集）：
 * 压栈之后 attacker 掉 buff 或死亡都不该改变这一击。
 *
 * `atk <= 0` 这里**不特判**：v2 §4.2 的「`atk <= 0` → 不出手」是**战斗快照**的条件
 * （`rules/combat.ts`），而 `act.strike` 是卡牌效果驱动的"立即出手一次"，
 * 它照常走一遍管线，只是 {@link hitHandler} 那一步不会产生伤害事件。
 */
export const strikeHandler: ActHandler<"act.strike"> = (env, act) => {
  const attacker = singleTarget(env, act.attacker);
  const target = singleTarget(env, act.target);
  if (attacker === undefined || target === undefined) {
    return;
  }
  const amount = act.amount === undefined ? attacker.tags.atk : evalNum(env, act.amount);
  emitEvent(env.state, { name: "struck", source: attacker.id, target: target.id, amount });
  pushAct(
    env.state,
    { op: "act.hit", target: { op: "sel.entity", id: target.id }, amount },
    withCtx(env.ctx, { self: attacker.id, target: target.id }),
  );
};

/**
 * `act.destroy{target}` —— 直接消灭（IR v1 §3.4）。
 *
 * 实现是**把累计伤害顶到致死线**，而不是就地把实体搬进墓地：
 * - 判死与移墓地是流水线第 ⑤ 步的独立阶段（时序规则 3），handler 抢着做会绕过
 *   「批量 + 跑到不动点」，于是"同归于尽"与亡语连锁全部失真（`resolve/deaths.ts`）；
 * - 顶到致死线之后，本步末尾的 `processDeaths` 会把它连同这一波其它致死单位一起收走，
 *   `unit_died` 也由那里统一发 —— 于是"被消灭"与"被打死"在事件流里完全一致，
 *   亡语不需要区分自己是怎么死的。
 *
 * **不发 `damaged`**：消灭不是伤害（v2 §5 没有"被消灭"这个事件名，
 * 而借用 `damaged` 会让"每当受到伤害"的触发器与减伤拦截器误命中一次不存在的伤害）。
 * 也因此圣盾挡不住 `act.destroy` —— 这与炉石的"直接消灭"一致，是有意的。
 *
 * 用 `Math.max` 而不是直接赋值：已经受过伤的单位不该被"治疗"回致死线以下，
 * 而 `tags.health <= 0` 的实体本来就已致死，再减也没有意义。
 * 只对**在场**的实体有可观测效果（`processDeaths` 只扫 `state.slots`），
 * 手牌/牌库里的实体被 destroy 只会留下一身伤 —— 弃牌请用 `act.discard`（M5）。
 */
export const destroyHandler: ActHandler<"act.destroy"> = (env, act) => {
  for (const target of frozenEntities(env, snapshot(env, act.target))) {
    target.damage = Math.max(target.damage, target.tags.health);
  }
};
