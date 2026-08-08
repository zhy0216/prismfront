// `apply(state, intent)` —— 引擎的**唯一入口**（框架 §3.2、架构 §2.3 engine 对外 API）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 框架 §3.2 原文，逐条落地
// ═══════════════════════════════════════════════════════════════════════════
// > function apply(state: GameState, intent: Intent): ApplyResult;
// > type ApplyResult =
// >   | { ok: true;  state: GameState; events: GameEvent[] }
// >   | { ok: false; code: IllegalReason };            // 非法意图，状态不变
// >
// > 内部允许在一份 draft 上原地改（性能），但对外表现为「进去一个状态，出来一个新状态」。
//
// 落地方式：**先校验，再 clone，再在 draft 上原地跑相位机 + 流水线**。
//   - 校验只读 `state`，所以被拒时连 clone 都不用做，"状态不变"是结构性的；
//   - clone 之后爱怎么原地改怎么改，入参状态一字未动
//     （`cloneState` 是 JSON 往返，见 `state/queries.ts`）。
// 这条性质是 bot 的 MCTS（框架 §10）与架构 §6.1 第二条测试的前提：
// `apply(s, i)` 与 `apply(revive(s), i)` 必须互不干扰地各跑一遍。
//
// ═══════════════════════════════════════════════════════════════════════════
// M3：骨架不变，`planAct` 换成相位机的三段
// ═══════════════════════════════════════════════════════════════════════════
// M2 的骨架是「校验 → clone → pushAct → resolve → 回执」。M3 保持它，只把中间换成：
//
//   ① 校验        `checkIntent(state, intent)` —— 只读，被拒即返回原因码
//   ② 记账 + 压栈  `runIntentBookkeeping(draft, intent)` —— `rules/phase.ts`
//   ③ 结算        `resolve(draft, deps)` —— 六步流水线（框架 §4.1）
//   ④ 推进自动相位 `advancePhases(draft, deps)` —— combat / round_end / round_start
//
// ③ 与 ④ 都可能因为**挂起**（`pendingInput`）提前停下，此时相位不再往前走；
// 玩家 `respond` 之后走 {@link applyRespond}，它同样在 `resume()` 之后接着跑 ④，
// 于是"挂起点横跨相位边界"这件事只有一处实现。
//
// ═══════════════════════════════════════════════════════════════════════════
// intent → Act：引擎自造的内联动作
// ═══════════════════════════════════════════════════════════════════════════
// 意图的效果段被翻译成 `Act` 压进结算栈，目标一律用 `sel.entity`（IR v1 §5.6 的
// **运行时超集**）冻结 —— 这正是"运行时超集只由引擎自己生成，永不来自外部输入"这条
// UGC 安全边界的用法：**玩家发来的是 id 与格号，不是 IR 节点**，节点由引擎按校验通过
// 的 id 现造。翻译本身在 `phase.ts`，本文件只负责校验与外壳。

import type { GameEvent } from "../events/index.ts";
import { DEFAULT_DEPS } from "../handlers/index.ts";
import type { ResolveDeps } from "../resolve/index.ts";
import { InvalidChoiceError, resolve, resume } from "../resolve/index.ts";
import type { EntityData, GameState, PlayerId } from "../state/index.ts";
import {
  cloneState,
  getEntity,
  isSlotEmpty,
  isValidSlot,
  PLAYER_IDS,
  playerData,
  zoneKey,
} from "../state/index.ts";
import type { ApplyResult, DeployPick, IllegalReason, Intent } from "./intent.ts";
import { advancePhases, deployCountFor, runIntentBookkeeping } from "./phase.ts";

/** `player` 字段来自网络，必须运行时收窄 —— TS 的 `PlayerId` 在运行时不存在。 */
function isPlayerId(value: unknown): value is PlayerId {
  return value === 0 || value === 1;
}

/**
 * 提交一个意图，推进对局（框架 §3.2）。
 *
 * 成功时返回**新状态**与这一段的事件流；失败时状态不变，只回原因码。
 * 返回的新状态满足 `eventLog` 为空这条不变量（`events/log.ts`）——
 * 事件全部在 `events` 里，不会在状态里积压，也不会被下次结算重复下发。
 *
 * `state.seq` **每次成功 +1**：它是**协议消息**的去重序号（框架 §3.1 / §7.3
 * 「每条消息带 seq」），而一次 `apply` 恰好对应服务端要广播的一条 `events` 消息。
 * 注意一条消息可能很长 —— 一次 pass 就可能带出
 * `player_passed → combat_began → combat_ended → round_ended → round_began → …`
 * 一整段（见 `phase.ts` 的「自动相位」），这正是相位机把"没人需要做决策的那几步"
 * 一口气跑完的结果。
 *
 * @param deps handler 表与脚本展开器。缺省是求值器提供的完整表 {@link DEFAULT_DEPS}（30 个 op 一个不少）。
 *             测试可以注入自己的表来隔离流水线。
 * @throws ResolutionLoopError 结算栈成环（框架 §4.1）。**不捕获**：那不是"非法意图"，
 *         而是卡牌数据或引擎自身的 bug，吞掉它只会让房间带着一份坏状态继续跑。
 *         协议层（M9）撞上它应当丢弃这份状态并从上一个快照恢复。
 */
export function apply(
  state: GameState,
  intent: Intent,
  deps: ResolveDeps = DEFAULT_DEPS,
): ApplyResult {
  if (state.winner !== null) {
    return { ok: false, code: "game_over" };
  }
  if (!isPlayerId(intent.player)) {
    return { ok: false, code: "wrong_player" };
  }
  // 挂起期间只接受 `respond`：栈上还压着续跑动作，此时插进别的意图会让玩家的选择
  // 写到错的栈顶条目上（`resolve/suspend.ts` 的挂起契约）。
  if (intent.t === "respond") {
    return applyRespond(state, intent, deps);
  }
  if (state.pendingInput !== null) {
    return { ok: false, code: "awaiting_input" };
  }

  const rejection = checkIntent(state, intent);
  if (rejection !== null) {
    return { ok: false, code: rejection };
  }

  const draft = cloneState(state);
  runIntentBookkeeping(draft, intent);
  const events = resolve(draft, deps);
  for (const event of advancePhases(draft, deps)) {
    events.push(event);
  }
  draft.seq += 1;
  return { ok: true, state: draft, events };
}

/**
 * 回应挂起点：把选择交给 `resume()`，结算从栈顶继续（框架 §4.2 / IR v1 §6.1）。
 *
 * 结算跑完之后**必须再推一次自动相位**：挂起点可能正好卡在"双 pass 之后的战斗中途"
 * 或"回合结束的某个触发器里"，`resume()` 只负责把结算栈跑空，
 * 剩下的相位推进仍然是相位机的事。少了这一行，对局会停在一个没人能提交意图的相位上。
 *
 * `InvalidChoiceError` 被翻成 `ok:false` 而不是往外抛：**玩家发来一个不在候选集里的
 * 选择，是一次非法意图**（协议层要回 `rejected` 让客户端重发），不是引擎故障。
 * 其余异常原样抛出。
 */
function applyRespond(
  state: GameState,
  intent: Extract<Intent, { t: "respond" }>,
  deps: ResolveDeps,
): ApplyResult {
  const request = state.pendingInput;
  if (request === null) {
    return { ok: false, code: "not_suspended" };
  }
  if (request.player !== intent.player) {
    return { ok: false, code: "wrong_player" };
  }

  const draft = cloneState(state);
  let events: GameEvent[];
  try {
    events = resume(draft, { chosen: intent.chosen }, deps);
  } catch (error) {
    if (error instanceof InvalidChoiceError) {
      return { ok: false, code: "invalid_choice" };
    }
    throw error;
  }
  for (const event of advancePhases(draft, deps)) {
    events.push(event);
  }
  draft.seq += 1;
  return { ok: true, state: draft, events };
}

// ═══════════════════════════════════════════════════════════════════════════
// 校验：只读状态，被拒时连 clone 都没发生
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 校验一条意图，通过返回 `null`，否则给出拒绝原因。**只读状态，不做任何修改。**
 *
 * 校验的粒度是"这条意图在当前盘面上说得通吗"，不是"这个效果做不做得成" ——
 * 后者是 IR v1 §5.2 的空集合语义，由 handler 静默跳过。分界线：
 *   - 玩家**不该发**的（不是他的回合、打一张不在手里的牌、水晶不够）→ 这里拒，回原因码；
 *   - 玩家发得没错、只是**做不成**的（打到空气上）→ 放行，handler 什么都不做。
 *
 * 两级结构：先判**相位与行动权**（所有意图共有的门），再判各自的负载。
 */
function checkIntent(
  state: GameState,
  intent: Exclude<Intent, { t: "respond" }>,
): IllegalReason | null {
  switch (intent.t) {
    case "concede":
      // 认输在任何相位都合法（`over` 已经被 `apply` 的 `game_over` 挡在门外），
      // 也不要求持有 `priority` —— 认输本来就是"我不想等到轮到我了"。
      return null;

    case "mulligan":
      return state.phase === "mulligan" ? checkMulligan(state, intent.toss) : "wrong_phase";

    case "deploy":
      return state.phase === "deploy" ? checkDeploy(state, intent.picks) : "wrong_phase";

    case "play_card": {
      const gate = checkActionGate(state, intent.player);
      return gate ?? checkPlayCard(state, intent.player, intent.card, intent.slot);
    }

    case "pass":
      return checkActionGate(state, intent.player);

    default:
      // `Intent` 是闭合联合，这一支在类型上不可达；但 intent 来自网络，
      // 运行时可能是任何东西，兜底必须留着。
      return "unknown_intent";
  }
}

/** `actions` 相位的公共门：相位对不对 + 是不是持 `priority` 的那一方（v2 §4.1 行动交替）。 */
function checkActionGate(state: GameState, player: PlayerId): IllegalReason | null {
  if (state.phase !== "actions") {
    return "wrong_phase";
  }
  if (state.priority !== player) {
    return "wrong_player";
  }
  return null;
}

/**
 * `play_card` 的负载校验：牌在自己手里 → 水晶够 → 格位可用。
 *
 * 顺序有意为之：**先判归属再判资源**。反过来的话，一个乱填 id 的客户端会先收到
 * `not_enough_crystals`，那条原因码对排错完全是误导。
 *
 * 费用取 `card.tags.cost` 即**生效费用**（派生值），于是 M5 的减费光环/附魔自动生效。
 * M2/M3 没有卡表，`tags.cost` 恒为 0 ⇒ 所有牌免费 —— 这不是 bug 而是"没有卡面数据"
 * 的正确退化，卡面由 M4 的卡表填上（测试用 `testkit` 的摆盘夹具写 `base.cost`）。
 */
function checkPlayCard(
  state: GameState,
  player: PlayerId,
  cardId: number,
  slot: number,
): IllegalReason | null {
  const card = getEntity(state, cardId);
  if (card === undefined) {
    return "unknown_entity";
  }
  if (card.zone !== zoneKey(player, "hand")) {
    return "wrong_zone";
  }
  if (playerData(state, player).crystals < card.tags.cost) {
    return "not_enough_crystals";
  }
  if (!isValidSlot(state, slot)) {
    return "invalid_slot";
  }
  if (!isSlotEmpty(state, player, slot)) {
    return "slot_occupied";
  }
  return null;
}

/**
 * `mulligan` 的负载校验：每一张要换掉的牌都得**在那一方自己的手里**，且不重复。
 *
 * 重复（同一张牌换两次）判 `invalid_choice`：它不是"实体不存在"也不是"区域不对"，
 * 而是这次**选择本身**不合法 —— 放过去会让那一方多补一张牌，凭空多牌。
 */
function checkMulligan(
  state: GameState,
  toss: readonly [readonly number[], readonly number[]],
): IllegalReason | null {
  for (const player of PLAYER_IDS) {
    const cards = toss[player];
    const hand = zoneKey(player, "hand");
    for (let i = 0; i < cards.length; i += 1) {
      const id = cards[i];
      if (id === undefined) {
        continue;
      }
      const card = getEntity(state, id);
      if (card === undefined) {
        return "unknown_entity";
      }
      if (card.zone !== hand) {
        return "wrong_zone";
      }
      if (cards.indexOf(id) !== i) {
        return "invalid_choice";
      }
    }
  }
  return null;
}

/**
 * `deploy` 的负载校验（v2.1 §11.3）。
 *
 * 四道关：
 * 1. **名数必须刚好** = `min(本回合排期, 泉里可部署的名数)`。少部署不是战术选择
 *    （v2.1 §11.3：该部署几名就部署几名），多部署则是凭空多英雄。
 * 2. 每个英雄都在**那一方自己的**复燃泉里，且 `respawnAt` 已到期。
 * 3. 格位有效且当前为空。
 * 4. 同一条 intent 内不许两个选择撞同一格 / 同一个英雄 —— 这两种冲突在逐条落地时
 *    才会暴露（第二个会静默失败），必须在校验期就拒掉，否则"部署了 2 名却只上场 1 名"
 *    会带着一份少了一个英雄的状态继续跑。
 */
function checkDeploy(
  state: GameState,
  picks: readonly [readonly DeployPick[], readonly DeployPick[]],
): IllegalReason | null {
  for (const player of PLAYER_IDS) {
    const chosen = picks[player];
    if (chosen.length !== deployCountFor(state, player)) {
      return "invalid_choice";
    }
    const fountain = zoneKey(player, "fountain");
    for (let i = 0; i < chosen.length; i += 1) {
      const pick = chosen[i];
      if (pick === undefined) {
        continue;
      }
      const hero = getEntity(state, pick.hero);
      if (hero === undefined) {
        return "unknown_entity";
      }
      if (hero.zone !== fountain || !isDeployable(state, hero)) {
        return "wrong_zone";
      }
      if (!isValidSlot(state, pick.slot)) {
        return "invalid_slot";
      }
      if (!isSlotEmpty(state, player, pick.slot)) {
        return "slot_occupied";
      }
      const conflict = chosen.findIndex(
        (other, j) => j < i && (other.hero === pick.hero || other.slot === pick.slot),
      );
      if (conflict >= 0) {
        return "slot_occupied";
      }
    }
  }
  return null;
}

/** 英雄是否已经等到了可以重新上场的回合（v2.1 §11.3 的 `respawnAt`）。 */
function isDeployable(state: GameState, hero: EntityData): boolean {
  return hero.respawnAt !== null && hero.respawnAt <= state.round;
}
