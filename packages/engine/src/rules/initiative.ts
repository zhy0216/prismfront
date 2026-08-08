// 先手（initiative）的四种策略（DSL v2 §6、v2 §2.1、v2 §36）。
//
// `initiative` 是**本回合先手方**：
//   - `priority` 每回合从它开始（v2 §4.1，行动交替制的起点）；
//   - 战斗快照按 `[initiative 方 0→8, 另一方 0→8]` 遍历（v2 §4.2 第 ② 步）；
//   - 触发器排序里的「当前回合玩家」在非 actions 相位取它（`resolve/triggers.ts`）。
// 也就是说，它同时是**行动权的起点**与**同时结算的排序基准** —— 一个字段，两处用途。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 两件正交的事，不要混成一件 ★
// ═══════════════════════════════════════════════════════════════════════════
// 1. **首回合先手是随机的**（v2 §36），消耗 RNG。这与 `rules.initiative` 选了哪种策略
//    **完全无关** —— 四种策略都是"从第 2 回合起怎么变"的规则，第 1 回合谁先手是掷出来的。
//    所以本文件**不管**首回合：那一掷在 `create-game.ts` 里做（见那里的论证），
//    本文件的 {@link nextInitiative} 只回答"下一回合是谁"。
// 2. **策略只在 round >= 2 生效**。把首回合的随机塞进 `alternate` 之类的分支里，
//    会得到一个"第一次调用时行为特殊"的函数 —— 那种函数迟早会被人在别处复用一次，
//    然后静默多掷一次骰子、整条随机流错位、全部历史回放失真。
//
// ═══════════════════════════════════════════════════════════════════════════
// 四种策略（v2 §6 原文）
// ═══════════════════════════════════════════════════════════════════════════
//   alternate          每回合轮换（v2 §0 的默认假设，**PF1 的默认值**，决策 #2）
//   first_passer       本回合先 pass 的一方获得下回合先手（Artifact 式）
//   random_each_round  每回合随机（消耗 RNG）
//   fixed_first        固定先手（永远是首回合掷出来的那一方）
//
// `first_passer` 为什么要留着：它是 Artifact 公认的深度来源 —— 与双 pass 规则天然咬合，
// 把"何时 pass"从纯节奏决策升级成资源决策（多打一张牌 = 让出下回合先手）。
// v2 §6 建议试玩时与 `alternate` 对比，里程碑把这次对比排在 M12。
// 所以四种**全部实现**，而不是只写默认那一种、别的等要用再补 —— 等到 M12 才补，
// 就得在一个已经稳定的相位机里重新做时序回归。

import type { InitiativeRule } from "@prismfront/ir";
import { emitEvent } from "../events/index.ts";
import { nextInt } from "../rng/index.ts";
import type { GameState, PlayerId } from "../state/index.ts";
import { opponentOf } from "../state/index.ts";

/** 玩家人数 = 随机先手时 `nextInt` 的排他上界。PF1 恒为 2（v2 §0：1v1）。 */
export const PLAYER_COUNT = 2;

/**
 * 掷一次"谁先手"，**消耗 RNG** 并发 `engine.random_picked`（框架 §4.3）。
 *
 * 事件的 `origin` 取 `"initiative"` —— 它已经在 `events/event.ts` 的 `RANDOM_SOURCES`
 * 里占了一格，正是留给这里的。发事件的理由是框架 §4.3 那条：种子永不下发客户端，
 * 客户端无法自行复现随机，**只能被告知结果**；排"随机流从哪一步开始错位"的时候，
 * 回放里这一条是唯一有用的信息。
 *
 * ⚠ 只在**有观众**的时候用（对局中途）。建局期的那一掷不发事件 —— 那时事件流还没有
 *   接收方，且 `createGame` 定死了"不发事件"（见 `create-game.ts`）。
 */
export function rollInitiative(state: GameState): PlayerId {
  const result = nextInt(state, PLAYER_COUNT);
  emitEvent(state, {
    name: "engine.random_picked",
    origin: "initiative",
    max: PLAYER_COUNT,
    result,
  });
  // `nextInt` 的产出落在 `[0, 2)`，恰是 `PlayerId` 的取值域；写成显式三元而不是
  // `as PlayerId`，是为了让"这个数确实只可能是 0 或 1"在运行时也成立。
  return result === 0 ? 0 : 1;
}

/**
 * 按策略算出**下一回合**的先手（round >= 2 时由 `round_start` 调用）。
 *
 * 入参全部取自状态里**上一回合结束时**的值：
 * - `state.initiative` —— 上一回合的先手方；
 * - `state.firstPasser` —— 上一回合先 pass 的那一方（`first_passer` 策略的唯一输入）。
 * 所以调用点必须在 `round_start` 里**重置这两个计数之前**（见 `phase.ts` 的顺序说明）。
 *
 * `switch` 覆盖 `InitiativeRule` 的四个取值，没有 `default` 分支 ——
 * 联合本身提供穷尽性：ir 加了第五种策略而这里没跟上，返回类型立刻变成
 * `PlayerId | undefined`，编译不过。（`validate-config.ts` 的
 * `INITIATIVE_RULE_SET` 是同一件事在运行时侧的那一半。）
 */
export function nextInitiative(state: GameState, rule: InitiativeRule): PlayerId {
  switch (rule) {
    case "alternate":
      // 每回合轮换。默认策略：先手优势最小、最容易预测，也最不需要玩家额外记忆。
      return opponentOf(state.initiative);

    case "first_passer":
      // 先 pass 的一方拿下回合先手（Artifact 式）。
      // `firstPasser === null` 只可能出现在"这一回合一次 pass 都没发生就结束了"的情形
      // （目前只有认输 → `over`，而 `over` 不会再开新回合）。真撞上就维持原先手 ——
      // 静默维持比抛错合适：这条策略的语义本来就是"没人 pass 就没有让渡"。
      return state.firstPasser ?? state.initiative;

    case "random_each_round":
      // 每回合重掷。**这是对局中途的随机**，所以走 rollInitiative 发事件。
      return rollInitiative(state);

    case "fixed_first":
      // 固定先手 = 永远是**首回合掷出来的**那一方（`create-game.ts` 掷的那一次）。
      // 注意它不是"永远 p0"：首回合先手随机这件事与策略正交（见文件头），
      // 固定的是"不再变"，不是"固定为某个座位"。
      return state.initiative;
  }
}
