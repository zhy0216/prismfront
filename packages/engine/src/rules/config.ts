// 引擎自带的一份默认规则参数。
//
// ═══════════════════════════════════════════════════════════════════════════
// 为什么要在 engine 里再抄一份 DEFAULT_RULES_CONFIG
// ═══════════════════════════════════════════════════════════════════════════
// 因为**架构 §2.2 禁令 1 / §6.3**：`packages/engine` 的 `dependencies` 恒为空对象，
// `@prismfront/ir` 只在 devDependencies 里 ⇒ engine 对 ir 只能是**纯类型依赖**，
// 一个运行时值都不许 import（`DEFAULT_RULES_CONFIG` / `IR_VERSION` / 校验器 / builder
// 全部在禁列）。需要常量就在引擎内部自己定义 —— `state/zone.ts` 的 `ZONE_NAMES`、
// `state/entity.ts` 的 `FLAG_BITS` 已经是同一处理。
//
// **ir 的 `DEFAULT_RULES_CONFIG` 是权威，这里是它的副本，两处必须同步。**
// `satisfies RulesConfig` 只能保证形状与字段名不漂（ir 改了字段名这里编译不过），
// 保不了**数值**不漂 —— 数值漂了会静默改变对局手感。所以：
//   - 产线（M9 的 server）应当**显式传 rules**，而不是依赖这个默认值；
//   - 它的用处是让测试与 CLI 少写一大坨字面量，以及让 `runMatch({seed, decks, intents})`
//     能按架构 §6.1 写的样子直接调。

import type { RulesConfig } from "@prismfront/ir";

/**
 * 默认规则参数：DSL v2 §6 + §11.5 的字面值（`heroHp` → `baseHp` 见架构 §10 第 2 项）。
 * 与 `@prismfront/ir` 的 `DEFAULT_RULES_CONFIG` 逐字一致。
 */
export const DEFAULT_RULES = {
  board: { slots: 9 },
  crystals: { initial: 5, growth: 1, capMax: 10 },
  pass: { combatAfterConsecutivePasses: 2 },
  initiative: "alternate",
  baseHp: 30,
  deck: { size: 30, maxCopies: 2, startingHand: 4, drawPerRound: 1, fatigue: true },
  playerActions: ["play_card"],
  actionSeconds: 30,
  reconnectSeconds: 90,
  heroes: { perDeck: 3, deploySchedule: [2, 1], respawnDelay: 1 },
} as const satisfies RulesConfig;
