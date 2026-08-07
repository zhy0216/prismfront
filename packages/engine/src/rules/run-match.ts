// `runMatch({seed, decks, intents})` —— 把一串意图跑成一局。
// 来源：架构 §6.1 的第一条确定性测试原文：
//
// > const a = runMatch({ seed: 0x9F1, decks, intents });
// > const b = runMatch({ seed: 0x9F1, decks, intents });
// > expect(hash(a.state)).toBe(hash(b.state));
//
// 也就是框架 §4.3 说的「`{seed, deckLists, intents[]}` 三元组即可完整复现一局」——
// 本函数就是那个三元组的求值器。回放（M8 的 golden replay）、fuzz（万局对打）、
// 复现玩家申诉的 bug，用的都是它。
//
// ═══════════════════════════════════════════════════════════════════════════
// 为什么非法意图**不抛错**，而是记进 `rejected`
// ═══════════════════════════════════════════════════════════════════════════
// 喂给它的意图流有两种来源：回放（历史意图，理应全合法）与 bot / fuzz（随机生成，
// 大量非法）。抛错会让 fuzz 在第一个非法意图处停住，而 fuzz 的价值恰恰在于
// **在非法意图被拒之后继续跑**，看引擎会不会被拒绝路径带歪。
// 于是这里照 `apply()` 的语义办：被拒 = 状态不变，记一笔，接着喂下一条。

import type { CardId, RulesConfig } from "@prismfront/ir";
import type { GameEvent } from "../events/index.ts";
import type { ResolveDeps } from "../resolve/index.ts";
import type { GameState } from "../state/index.ts";
import { apply } from "./apply.ts";
import { DEFAULT_RULES } from "./config.ts";
import type { CreateGameOptions } from "./create-game.ts";
import { createGame } from "./create-game.ts";
import type { IllegalReason, Intent } from "./intent.ts";

/** {@link runMatch} 的入参。 */
export interface RunMatchOptions {
  /** 随机种子（框架 §4.3）。同 seed + 同 decks + 同 intents ⇒ 同终局。 */
  readonly seed: number;
  /** 双方牌库，下标 0 = 牌堆顶（洗牌前）。 */
  readonly decks: readonly [readonly CardId[], readonly CardId[]];
  /** 按顺序喂给 `apply()` 的意图流。 */
  readonly intents: readonly Intent[];
  /** 本局规则。缺省用引擎自带的 {@link DEFAULT_RULES}（产线应当显式传）。 */
  readonly rules?: RulesConfig;
  /** handler 表与脚本展开器。缺省是 M2 的临时表。 */
  readonly deps?: ResolveDeps;
  /** 透传给 `createGame` 的可选项（英雄 / bundleId / 先手 / 是否洗牌）。 */
  readonly game?: CreateGameOptions;
  /**
   * 建局之后、喂意图之前的一次性摆盘钩子。
   *
   * **只给测试夹具用**：M2 没有卡表，牌库实体的卡面属性全是 0，走查要让单位有
   * atk/health 就得自己写进 `entity.base`。这个函数**不进状态**（它是参数不是字段），
   * 所以纯数据铁律不受影响；M4 接上卡表之后它就没有存在的必要了。
   */
  readonly setup?: (state: GameState) => void;
}

/** 一条被拒的意图：它在 `intents` 里的下标 + 原因码。 */
export interface RunMatchRejection {
  readonly index: number;
  readonly code: IllegalReason;
}

/** {@link runMatch} 的产出。 */
export interface RunMatchResult {
  /** 终局状态。`eventLog` 必为空（`events/log.ts` 的不变量）。 */
  readonly state: GameState;
  /** 全程事件流，按发生顺序拼接（框架 §3.3）。 */
  readonly events: readonly GameEvent[];
  /** 被拒的意图。全合法的回放里它应当是空数组 —— 非空就说明回放与当前规则对不上了。 */
  readonly rejected: readonly RunMatchRejection[];
}

/**
 * 建局并按顺序喂完全部意图，返回终局状态与全程事件流。
 *
 * 每一步都走 `apply()`，所以本函数没有任何"自己推进状态"的代码 ——
 * 它就是一个 fold。这一点很重要：回放与实时对局必须走**同一条**代码路径，
 * 否则回放能复现的东西和线上跑的东西会慢慢分叉。
 */
export function runMatch(options: RunMatchOptions): RunMatchResult {
  const state = createGame(
    options.rules ?? DEFAULT_RULES,
    options.decks,
    options.seed,
    options.game,
  );
  options.setup?.(state);

  const deps = options.deps;
  const events: GameEvent[] = [];
  const rejected: RunMatchRejection[] = [];
  let current = state;

  for (let index = 0; index < options.intents.length; index += 1) {
    const intent = options.intents[index];
    // `noUncheckedIndexedAccess`：下标恒在界内，但不用 `!` 绕过去。
    if (intent === undefined) {
      continue;
    }
    const result = deps === undefined ? apply(current, intent) : apply(current, intent, deps);
    if (result.ok) {
      current = result.state;
      for (const event of result.events) {
        events.push(event);
      }
    } else {
      rejected.push({ index, code: result.code });
    }
  }

  return { state: current, events, rejected };
}
