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
// 落地方式：**先校验，再 clone，再在 draft 上原地跑流水线**。
//   - 校验只读 `state`，所以被拒时连 clone 都不用做，"状态不变"是结构性的；
//   - clone 之后 `resolve()` 爱怎么原地改怎么改，入参状态一字未动
//     （`cloneState` 是 JSON 往返，见 `state/queries.ts`）。
// 这条性质是 bot 的 MCTS（框架 §10）与架构 §6.1 第二条测试的前提：
// `apply(s, i)` 与 `apply(revive(s), i)` 必须互不干扰地各跑一遍。
//
// ═══════════════════════════════════════════════════════════════════════════
// intent → Act：M2 把意图翻译成**引擎自造的内联动作**
// ═══════════════════════════════════════════════════════════════════════════
// 每条意图被翻译成一条 `Act` 压进结算栈，然后交给 `resolve()` 的六步流水线。
// 翻译产物一律用 `sel.entity`（IR v1 §5.6 的**运行时超集**）冻结目标 ——
// 这正是"运行时超集只由引擎自己生成，永不来自外部输入"这条 UGC 安全边界的用法：
// **玩家发来的是 id 与格号，不是 IR 节点**，节点由引擎按校验通过的 id 现造。
//
// M3 会把这里替换成真正的相位机（round_start / deploy / actions / combat / round_end），
// 那时 `apply` 的骨架（校验 → clone → 推进 → resolve → 回执）不变，只是分支变多。

import type { Act } from "@prismfront/ir";
import { M2_DEPS, playerEntity } from "../handlers/index.ts";
import type { ResolveDeps } from "../resolve/index.ts";
import { InvalidChoiceError, pushAct, resolve, resume } from "../resolve/index.ts";
import type { CtxBindings, GameState, PlayerId } from "../state/index.ts";
import {
  cloneState,
  controllerOf,
  createCtx,
  getEntity,
  isOnBoard,
  isSlotEmpty,
  isValidSlot,
  zoneKey,
} from "../state/index.ts";
import type { ApplyResult, IllegalReason, Intent } from "./intent.ts";

/** 翻译成功的产物：一条待入栈的动作 + 它的上下文。 */
interface ActPlan {
  readonly act: Act;
  readonly ctx: CtxBindings;
}

/** 判别 {@link planAct} 的返回：原因码是字符串，计划是对象。 */
function isRejected(planned: IllegalReason | ActPlan): planned is IllegalReason {
  return typeof planned === "string";
}

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
 * 放在引擎里递增，是为了让它跟着状态一起被 clone / 落盘 / 回放，
 * 而不是变成服务端的另一份可变计数器（那就有两个真相源了）。
 *
 * @param deps handler 表与脚本展开器。缺省是 M2 的临时表 {@link M2_DEPS}；
 *             M4 换成求值器提供的真表。测试可以注入自己的表来隔离流水线。
 * @throws ResolutionLoopError 结算栈成环（框架 §4.1）。**不捕获**：那不是"非法意图"，
 *         而是卡牌数据或引擎自身的 bug，吞掉它只会让房间带着一份坏状态继续跑。
 *         协议层（M9）撞上它应当丢弃这份状态并从上一个快照恢复。
 */
export function apply(state: GameState, intent: Intent, deps: ResolveDeps = M2_DEPS): ApplyResult {
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

  const planned = planAct(state, intent);
  if (isRejected(planned)) {
    return { ok: false, code: planned };
  }

  const draft = cloneState(state);
  pushAct(draft, planned.act, planned.ctx);
  const events = resolve(draft, deps);
  draft.seq += 1;
  return { ok: true, state: draft, events };
}

/**
 * 回应挂起点：把选择交给 `resume()`，结算从栈顶继续（框架 §4.2 / IR v1 §6.1）。
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
  try {
    const events = resume(draft, { chosen: intent.chosen }, deps);
    draft.seq += 1;
    return { ok: true, state: draft, events };
  } catch (error) {
    if (error instanceof InvalidChoiceError) {
      return { ok: false, code: "invalid_choice" };
    }
    throw error;
  }
}

/**
 * 把一条意图翻译成待入栈的动作，或给出拒绝原因。**只读状态，不做任何修改。**
 *
 * 校验的粒度是"这条意图在当前盘面上说得通吗"，不是"这个效果做不做得成" ——
 * 后者是 IR v1 §5.2 的空集合语义，由 handler 静默跳过。分界线：
 *   - 玩家**不该发**的（打一张不在手里的牌、指挥别人的单位）→ 这里拒，回原因码；
 *   - 玩家发得没错、只是**做不成**的（打到空气上）→ 放行，handler 什么都不做。
 */
function planAct(
  state: GameState,
  intent: Exclude<Intent, { t: "respond" }>,
): IllegalReason | ActPlan {
  switch (intent.t) {
    case "draw": {
      // SELF 绑到本方的**玩家实体**（= base 实体，见 `handlers/read.ts`），
      // 于是 `sel.controller` 能解析出发起方 —— 与 M4 的真求值器同一条路径。
      return {
        act: { op: "act.draw", player: { op: "sel.controller" }, count: intent.count ?? 1 },
        ctx: createCtx(playerEntity(state, intent.player)),
      };
    }

    case "play_unit": {
      const card = getEntity(state, intent.card);
      if (card === undefined) {
        return "unknown_entity";
      }
      if (card.zone !== zoneKey(intent.player, "hand")) {
        return "wrong_zone";
      }
      if (!isValidSlot(state, intent.slot)) {
        return "invalid_slot";
      }
      if (!isSlotEmpty(state, intent.player, intent.slot)) {
        return "slot_occupied";
      }
      // `act.move.side` 的基准是 `entity.owner`（IR v1 §3.4）。手牌的**控制者**已经
      // 校验为发起方，但被 `act.steal` 偷来的牌 owner 会是对手 —— 此时要 `"opposite"`
      // 才能落到发起方自己的战线上。
      return {
        act: {
          op: "act.move",
          target: { op: "sel.entity", id: card.id },
          zone: "board",
          side: card.owner === intent.player ? "owner" : "opposite",
          pos: intent.slot,
        },
        // SELF = 牌自己，与 M3 的 `play_card`（卡牌脚本的 SELF 是这张牌）对齐。
        ctx: createCtx(card.id),
      };
    }

    case "strike": {
      const attacker = getEntity(state, intent.attacker);
      if (attacker === undefined) {
        return "unknown_entity";
      }
      if (!isOnBoard(attacker)) {
        return "wrong_zone";
      }
      if (controllerOf(attacker) !== intent.player) {
        return "not_controlled";
      }
      // 目标只要求"是个实体"：打对方基地（v2 §4.3）、打自己人（某些效果就是这样）
      // 都合法，能不能打到是 handler 的事。
      if (getEntity(state, intent.target) === undefined) {
        return "unknown_entity";
      }
      return {
        act: {
          op: "act.strike",
          attacker: { op: "sel.entity", id: attacker.id },
          target: { op: "sel.entity", id: intent.target },
        },
        ctx: createCtx(attacker.id),
      };
    }

    default:
      // `Intent` 是闭合联合，这一支在类型上不可达；但 intent 来自网络，
      // 运行时可能是任何东西，兜底必须留着。
      return "unknown_intent";
  }
}
