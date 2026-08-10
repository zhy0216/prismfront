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
//   ① 校验        `checkIntent(state, intent, deps.cards)` —— 只读，被拒即返回原因码
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
//
// ═══════════════════════════════════════════════════════════════════════════
// M6：校验开始读**卡表**（色门）
// ═══════════════════════════════════════════════════════════════════════════
// M3~M5 的 `checkIntent` 只读状态。色门（v2.1 §11.4）要问"这张牌是什么颜色"与
// "场上那几个实体是不是英雄"，两件事都只有卡面答得上来，于是 `deps.cards` 一路递到
// `checkPlayCard`。校验的"只读状态、被拒时连 clone 都没发生"这条性质不受影响 ——
// 卡表是**只读查询**（`eval/context.ts` 的 `CardLookup`）。
// 色门的判据与结构化的拒绝原因都在本文件末尾一节，M7 的 legalActions 复用那里的
// {@link lockedColorsOf}，不要再判第二遍。

import type { Color } from "@prismfront/ir";
import type { CardLookup } from "../eval/index.ts";
import { isHero } from "../eval/index.ts";
import type { GameEvent } from "../events/index.ts";
import { DEFAULT_DEPS } from "../handlers/index.ts";
import type { ResolveDeps } from "../resolve/index.ts";
import { InvalidChoiceError, resolve, resume } from "../resolve/index.ts";
import type { EntityData, GameState, PlayerId } from "../state/index.ts";
import {
  boardEntities,
  cloneState,
  getEntity,
  isLethal,
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
 *         ★ 协议层（M9）**不需要从快照恢复**：本函数先 `cloneState` 再跑，半跑的是那份
 *         draft，**入参 `state` 一字未改**（`__tests__/deathrattle-loop.test.ts` 钉住），
 *         丢掉这一次意图即可。权威表述在 {@link ResolutionLoopError} 的文档注释。
 *         ⚠ 残余风险：环发生在**自动相位**里时，那一局会卡在"这条意图提交不下去"上 ——
 *         房间活着，但那局推不动。判负还是作废由 M9 定（`todos/M09-Colyseus服务端.md`）。
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

  // 校验要**卡表**：色门读的是 `card.data.colors`（v2.1 §11.4），而"这个实体是不是英雄"
  // 同样只有卡面答得上来。只递 `deps.cards` 而不是整份 `deps` —— 校验既不执行动作
  // 也不展开脚本，收窄依赖才看得出它确实只读卡面（同 `resolve/deps.ts` 的 `TriggerDeps` 取舍）。
  const rejection = checkIntent(state, intent, deps.cards);
  if (rejection !== null) {
    return { ok: false, code: rejection };
  }

  const draft = cloneState(state);
  runIntentBookkeeping(draft, intent, deps);
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
  cards: CardLookup | undefined,
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
      return gate ?? checkPlayCard(state, intent.player, intent.card, intent.slot, cards);
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
 * `play_card` 的负载校验：牌在自己手里 → **色门**开着 → 水晶够 → 格位可用。
 *
 * 顺序有意为之：**先判归属，再判这张牌本身打不打得出，最后才判资源与落点**。
 *   - 归属在最前：一个乱填 id 的客户端若先收到 `not_enough_crystals`，
 *     那条原因码对排错完全是误导。
 *   - 色门排在水晶之前：色门是**这张牌现在根本打不出**（v2.1 §11.4，攒多少水晶、
 *     换哪个格子都不会变），而水晶是攒得出来的。两条同时不满足时报更根本的那一条，
 *     客户端也才好据此把牌置灰（`color_locked` 的文档注释）。
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
  cards: CardLookup | undefined,
): IllegalReason | null {
  const card = getEntity(state, cardId);
  if (card === undefined) {
    return "unknown_entity";
  }
  if (card.zone !== zoneKey(player, "hand")) {
    return "wrong_zone";
  }
  if (lockedColorsOf(state, player, card, cards).length > 0) {
    return "color_locked";
  }
  if (playerData(state, player).crystals < card.tags.cost) {
    return "not_enough_crystals";
  }
  if (cards?.(card.cardId)?.kind !== "spell") {
    if (!isValidSlot(state, slot)) {
      return "invalid_slot";
    }
    if (!isSlotEmpty(state, player, slot)) {
      return "slot_occupied";
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 色门（v2.1 §11.4）
// ═══════════════════════════════════════════════════════════════════════════
// 规则一句话：**这张牌的每个颜色，都要有一名己方存活在场的英雄提供**。
// 融合卡（`colors` 长度 2）不是特例 —— 它天然落在同一条判断上，两个颜色各自
// 要有一名英雄，且**可以是两名不同的英雄**（一名红英雄 + 一名蓝英雄就能打红蓝融合卡）。
// 所以这里没有、也不该有"融合卡"这个分支。
//
// ★ 色门只看**颜色**，不看**归属** ★
// 构筑规则是英雄专属卡（v2.1 §11.4b，决策 #11）：每张卡在构筑层归属一名英雄。
// 但那是**组牌**的约束，打出限制一个字没改。所以本段代码只读 `data.colors`，
// 绝不读那个归属字段（IR 的 `CardData` 至今也没有它）。危险在于 PF1 每色恰好一名英雄，
// 「所属英雄在场」与「同色英雄在场」结果永远相同，写成同一条判断照样全绿 ——
// 等英雄扩池（同色多名）第一天就炸，且表现为"某些牌莫名打不出"这种很难往回追的症状。
// 反面断言在 `__tests__/heroes.test.ts` 第 6 节（同色两名英雄，死一名照样打得出）。

/**
 * 打出 `card` 还**缺**哪些颜色的英雄（v2.1 §11.4）。空数组 = 门开着，可以打。
 *
 * ── 为什么返回颜色列表而不是一个 boolean ─────────────────────────────────────
 * `IllegalReason` 是稳定机器串、不许塞动态内容（`intent.ts`），所以"缺哪个颜色"
 * 这条信息在 `apply()` 的回执里表达不出来。而 M7 的 `legalActions` 恰恰需要它：
 * 客户端要把手牌逐张置灰并说明理由（"缺一名蓝色英雄"），一张一张地试 `apply`
 * 既拿不到理由也白跑一遍克隆。于是**结构化的那一份从这里出**，
 * `checkPlayCard` 只是把它退化成一个原因码，两边不会各判一次。
 *
 * 返回的顺序 = `card.data.colors` 的声明顺序，于是同一张牌的输出是稳定的
 * （下发给客户端、进快照都不会因为遍历顺序抖动）。
 *
 * ── 退化口径：查不到卡面 ⇒ **不设门** ──────────────────────────────────────
 * `cards` 缺省（`DEFAULT_DEPS` 就没有卡表）或查不到这张卡 ⇒ 颜色列表为空 ⇒ 恒放行。
 * 与 `eval/context.ts` 的 `NO_CARDS` 同一条语义：这不是"出错"而是"引擎不认识任何具体卡"。
 * 这条口径同时是 M2~M5 那一大批不带卡表的测试**一条都不受色门影响**的原因 ——
 * 反过来若定成"查不到就锁住"，那些测试会以"某条 `play_card` 突然非法"的形式集体红，
 * 而真正的错因（没接卡表）离症状很远。
 */
export function lockedColorsOf(
  state: GameState,
  player: PlayerId,
  card: EntityData,
  cards: CardLookup | undefined,
): Color[] {
  const wanted = cards?.(card.cardId)?.colors ?? [];
  if (wanted.length === 0) {
    return [];
  }
  const open = openColorsOf(state, player, cards);
  return wanted.filter((color) => !open.includes(color));
}

/**
 * 某方**当前开着**的颜色 = 己方存活在场的英雄们各自的 `data.colors` 之并。
 *
 * 「存活在场」两个条件缺一不可（v2.1 §11.3/§11.4）：
 *   - **在场** —— 站在自己那一行战线上。`boardEntities` 扫的是 `state.slots`，
 *     于是躺在**复燃泉**里等复活的英雄自动不算数，这正是"阵亡缺席期间该色牌全部锁定"
 *     那句话的全部实现：没有一行代码去读 `respawnAt`，锁不锁只由"它现在站没站着"决定。
 *   - **存活** —— 判据用 `isLethal`，与死亡结算**同一个谓词**（引擎里"死"只有一个定义）。
 *     绝大多数时候流水线已经把致死的实体搬走了，但第 ⑤ 步（死亡）在第 ⑥ 步（光环重算）
 *     之前（`resolve/resolve.ts`），所以"血量刚被光环拿掉、还没来得及结算"这个瞬间是存在的；
 *     M7 的投影若在那种状态上问色门，答案要与流水线一致。
 *
 * 英雄的判据走 `eval/context.ts` 的 {@link isHero} —— 全引擎唯一的一处。
 * 这里**不**顺手写成 `cards(...)?.kind === "hero"`：那就是第二份实现，
 * 而"死亡去向那边认它是英雄、色门这边不认"这种半边分叉最难查。
 * 顺带一条推论：一个红色**随从**站在场上开不了红门，它不是英雄。
 */
function openColorsOf(state: GameState, player: PlayerId, cards: CardLookup | undefined): Color[] {
  const open: Color[] = [];
  for (const entity of boardEntities(state, player)) {
    if (!isHero(cards, entity) || isLethal(entity)) {
      continue;
    }
    for (const color of cards?.(entity.cardId)?.colors ?? []) {
      if (!open.includes(color)) {
        open.push(color);
      }
    }
  }
  return open;
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
