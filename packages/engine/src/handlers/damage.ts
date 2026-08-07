// `act.strike` / `act.hit` —— 手动出手与伤害（走查第 3 步，死亡由第 ⑤ 步接手）。
// 来源：v2 §3.4（`act.strike`：立即出手一次，`amount` = attacker **当前** atk，
//       **内部走 `act.hit` 管线**，并发 `struck`）、IR v1 §3.4（`act.hit`）、
//       v2 §5（`struck` / `damaged` 的负载）、`state/entity.ts`（血量记账）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 两条必须守住的规矩
// ═══════════════════════════════════════════════════════════════════════════
// 1. **伤害写 `entity.damage`，不动 `tags.health`**（`state/entity.ts` 的血量记账定案：
//    `tags.health` 是生效血量上限，当前血量 = `tags.health - damage`）。
//    写 `tags` 会被流水线第 ⑥ 步 `refreshAuras` 从 `base` 重算覆盖（时序规则 4），
//    症状是"打了没掉血"或"buff 掉了单位就复活"。
// 2. **不在 handler 里判死**（`resolve/deps.ts` 的 handler 契约第 2 条）。
//    死亡是流水线第 ⑤ 步的独立阶段（时序规则 3：批量、跑到不动点）。
//    handler 只负责把 `damage` 加上去，`processDeaths` 会在同一步的末尾收走。
//    ——「你只要让伤害能把 health 打到 <= 0」，剩下的是 `resolve/deaths.ts` 的事。
//
// ⚠ 溅射 / 反伤走 `act.hit`，**不发 `struck`**（v2 §8.7：这是"反伤不会互相触发成
//   无限连锁"的全部机制）。别顺手在 {@link hitHandler} 里补发 `struck`。

import { emitEvent } from "../events/index.ts";
import type { ActHandler } from "../resolve/index.ts";
import { pushAct } from "../resolve/index.ts";
import { withCtx } from "../state/index.ts";
import { readEntity, readNum, sourceOf } from "./read.ts";

/**
 * `act.hit` 的 M2 临时 handler：造成伤害并发 `damaged`。
 *
 * `target` 求值为空 → 静默跳过（IR v1 §5.2）。`amount <= 0` 同样什么都不做：
 * 「造成 0 点伤害」不是一件发生过的事，发一条 `amount: 0` 的 `damaged` 只会让
 * 「每当受到伤害」的触发器（M5）凭空触发。
 *
 * M2 **不处理**的两件事，都要等有了它们各自的机制才有意义：
 * - `armor`（护甲减伤）—— 减伤的正确落点是拦截器（IR v1 §4.2），M5；
 * - `spellDamage`（法术伤害加成）—— 加成源要从卡表/光环里数，M4/M5。
 */
export const hitHandler: ActHandler<"act.hit"> = (state, ctx, act) => {
  const target = readEntity(state, ctx, act.target);
  if (target === undefined) {
    return;
  }
  const amount = readNum(act.amount, 0);
  if (amount <= 0) {
    return;
  }
  target.damage += amount;
  emitEvent(state, {
    name: "damaged",
    source: sourceOf(state, ctx),
    target: target.id,
    amount,
  });
};

/**
 * `act.strike` 的 M2 临时 handler：发 `struck`，然后**把一条 `act.hit` 压栈**。
 *
 * 为什么是压栈而不是就地调用 {@link hitHandler}：
 * - v2 §3.4 规定 strike **内部走 `act.hit` 管线**，目的是让拦截器（圣盾、减伤、
 *   "改为受到 1 点伤害"）在 `act.hit` 这一层就能拦到；就地调用会绕过流水线第 ② 步，
 *   M5 接上拦截器时圣盾会挡不住出手。
 * - 框架 §4.1 时序规则 2：连锁一律入栈。压栈之后 `damaged` 落在**下一次弹栈**，
 *   于是 `struck` 的触发器与 `damaged` 的触发器排队顺序天然正确。
 *
 * `amount` 与 `target` 在这里就**冻结**成字面量与 `sel.entity`（IR v1 §5.6 运行时超集）：
 * 出手数值取的是**此刻**的 atk（v2 §3.4 / §4.2「快照后数值冻结」），
 * 压栈之后 attacker 掉 buff 或死亡都不该改变这一击。
 *
 * `atk <= 0` 这里**不特判**：v2 §4.2 的「`atk <= 0` → 不出手」是**战斗快照**的条件
 * （M3 的事），而 `act.strike` 是卡牌效果驱动的"立即出手一次"，它照常走一遍管线，
 * 只是 {@link hitHandler} 那一步不会产生伤害事件。
 */
export const strikeHandler: ActHandler<"act.strike"> = (state, ctx, act) => {
  const attacker = readEntity(state, ctx, act.attacker);
  const target = readEntity(state, ctx, act.target);
  if (attacker === undefined || target === undefined) {
    return;
  }
  const amount = attacker.tags.atk;
  emitEvent(state, { name: "struck", source: attacker.id, target: target.id, amount });
  pushAct(
    state,
    { op: "act.hit", target: { op: "sel.entity", id: target.id }, amount },
    withCtx(ctx, { self: attacker.id, target: target.id }),
  );
};
