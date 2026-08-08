// `act.summon` —— 从一个 `CardRef` **新建**单位并落到指定格。
// 来源：IR v1 §3.4 + v2 §3.4（`act.summon{player, card, at: SlotRef, count?}`：
//       `at` 在规范形式中必填；`at` 被占或无效 → 跳过；`count > 1` 时
//       **每个后续单位重新求值 `at`**）、IR v1 §5.2（`card.*` 求值为空 → 整个动作跳过）、
//       v2 §5（`unit_summoned`）。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 这是本目录唯一需要**卡表**的 handler ★
// ═══════════════════════════════════════════════════════════════════════════
// 新建实体要知道卡面属性（atk / health / …），而卡面在 bundle 里，不在动作节点里。
// 卡表按 `resolve/deps.ts` 的 `cards` 注入（形状照抄 `ScriptExpander`），
// 求值期挂在 `EvalEnv.cards` 上，本文件从 `env.cards` 取。
//
// **卡表查不到这张卡 ⇒ 静默跳过，不召唤。** 理由：造出来的会是一个 0/0，
// 而 0 血单位在流水线第 ⑤ 步当场被判死（`state/entity.ts` 的血量记账）——
// "召唤出来立刻暴毙"是个会误导人的地雷，不是"没有卡表"的正确退化形态。
// 引擎没接 bundle 时 `cards` 缺省是 `NO_CARDS`，于是 `act.summon` 整体退化成空操作。
// ⚠ 卡表查不到就在 `card` 的位置上返回，所以后面的 `at` / `count` 一律不再求值 ——
//   「引擎接没接 bundle」因此会改变随机流。这是有意的（它就是 §5.2 的"整个动作跳过"
//   在本 handler 的形态），代价与兜底见 `resolve/act-slots.ts` 文件头第 3 条。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 字段严格按签名顺序求值（IR v1 §5.4 规则 1）★
// ═══════════════════════════════════════════════════════════════════════════
// 签名是 `{player, card, at, count?}`，本 handler 的四步就是这四个字段，**顺序不许换**：
// 四个位置上都可能挂推进 RNG 的节点（`sel.random` / `card.random` /
// `slot.random_empty` / `num.random`），换一下顺序就是换一份回放。
// `at` 是**惰性**拉取的（`resolve/act-slots.ts` 的 `SlotResolver`），正是为了让它
// 排在 `player` / `card` 之后：前两步判出「整个动作跳过」时，`at` 一次随机都不抽。

import { evalCardRef, evalNum, evalSlot, playerEntityId } from "../eval/index.ts";
import { emitEvent } from "../events/index.ts";
import type { ActHandler } from "../resolve/index.ts";
import { isActSkipped } from "../resolve/index.ts";
import { spawnOnSlot } from "./board.ts";
import { sourceOf, targetPlayers } from "./targets.ts";

/**
 * `act.summon{player, card, at, count?}` 的 handler。
 *
 * 四步，**逐条对齐签名字段的声明顺序**（IR v1 §5.4 规则 1，见文件头）：
 * 1. `player` → 玩家列表（`targets.ts` 的 `targetPlayers`），空 ⇒ 跳过（IR v1 §5.2）。
 * 2. `card` → 卡 id（`eval/card.ts` 的 `evalCardRef`），`null` ⇒ **整个动作跳过**
 *    （IR v1 §5.2 末行）；再按卡 id 查卡面，查不到同样跳过（见文件头）。
 * 3. `at` → 拉一次解析器（`slots.at()`，惰性 + 记忆化）；无效槽 ⇒ 整个动作跳过
 *    （v2 §3.1，判据 `isActSkipped`）。**这一步必须排在 1、2 之后、4 之前。**
 * 4. `count` 缺省 1，只求值一次（规则 1）。
 *
 * 然后逐个召唤：第 1 个单位用第 3 步拉到的那一份；★ **第 2 个起重新求值 `at`**
 * （v2 §3.4 明文）—— `at: slot.random_empty` 时每个单位各抽一次随机，
 * 而"后续"二字是有意的：第一次不能重求，否则第 1 个单位就多抽了一次。
 *
 * `at` 被占（可能是本动作前面那个单位刚占上的）⇒ 那一个单位不召唤，**但循环继续**：
 * v2 §3.4 说的是"`at` 被占或无效 → 跳过"，跳过的是那一次召唤而不是整个 `count`。
 * 后续单位重新求值 `at` 之后可能落到别的空格上。
 *
 * ── ★ `player` 与 `at` 都带"哪一侧"时以谁为准 ★ ────────────────────────────
 * 规范没有规定这一点（两个字段是同一件事的两种编码：`player` 是 Sel、`at.side` 是
 * 相对 SELF 的 SlotSide）。本引擎的取值：**side 来自 `player`，index 来自 `at`**。
 *   - `player` 在签名里排第一，且它决定的是**归属**——而控制者就是实体所在的 zone
 *     的玩家位（状态不变量 2），归属与落点不可能分家；
 *   - index 单取是良定义的：双方索引轴共享、同索引正对（v2 §0 规则 1）；
 *   - 绝大多数卡两者同侧（`player: sel.controller` + `at: slot.*(friendly)`），
 *     两种读法**完全一致**，这个取值只在写卡人自相矛盾时才可观测。
 * 想召唤到敌方战线请写 `player: sel.opponent`，而不是靠 `at: slot.*(enemy)`。
 *
 * `unit_summoned.source` 是召唤者（SELF），没有则 `null`；与 `act.move` 那条
 * "自己召唤自己归一成 null"的规则无关 —— 新建的实体不可能是 SELF。
 */
export const summonHandler: ActHandler<"act.summon"> = (env, act, slots) => {
  const players = targetPlayers(env, act.player);
  if (players.length === 0) {
    return;
  }
  const cardId = evalCardRef(env, act.card);
  if (cardId === null) {
    return;
  }
  const data = env.cards(cardId);
  if (data === undefined) {
    return;
  }
  // ★ 第 3 步：`at` 在签名里排第三，就在这里拉 —— 前两步跳过时它一次都不会被求值。
  const first = slots.at();
  if (isActSkipped(first)) {
    return;
  }
  const count = act.count === undefined ? 1 : evalNum(env, act.count);
  const source = sourceOf(env);

  // ★ v2 §3.4「每个**后续单位**重新求值 `at`」里的「后续」按**召唤出的单位**连续计数，
  //   不按 `count` 的下标 —— 所以这个开关放在双层循环**外面**。
  //   写成内层的 `i === 0` 会让每个玩家的第 1 个单位都复用同一份：`player` 解析出
  //   两个玩家时（`sel.zone{side:"both"}`），第 2 个玩家的第 1 个单位会落到跟第 1 个
  //   玩家**完全相同的格**上，还少推进一次 RNG。规范没有明文谈多玩家，但「后续单位」
  //   的字面意思就是「第一个之后的每一个」，跟它跨不跨玩家无关。
  let isFirstUnit = true;
  for (const player of players) {
    for (let i = 0; i < count; i += 1) {
      // 第 1 个用刚拉到的那一份（记忆化保证它只求过一次）；第 2 个起**重新求值**（v2 §3.4）。
      const at = isFirstUnit ? first : evalSlot(env, act.at);
      isFirstUnit = false;
      if (at === null) {
        // 无效槽（比如已经没有空格了）⇒ 这一个不召唤。后续几个照样各自再求一次值。
        continue;
      }
      // side 取 `player`，index 取 `at`（见函数说明里的取值论证）。
      const unit = spawnOnSlot(env.state, cardId, player, at.index, data.tags ?? {});
      if (unit === null) {
        continue;
      }
      emitEvent(env.state, {
        name: "unit_summoned",
        player: playerEntityId(env.state, player),
        source,
        target: unit.id,
        cardId,
        slot: at.index,
      });
    }
  }
};
