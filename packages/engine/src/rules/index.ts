// rules/ —— 对局层入口（架构 §2.3 的 `rules/`）。
//
// `state/` 建模、`resolve/` 结算、`handlers/` 执行动作，本目录负责把它们接成
// **一局对战**：建局、收玩家意图、推进、回执。架构 §2.3 列在 engine 对外 API 里的
// `createGame(rules, decks, seed)` 与 `apply(state, intent)` 就在这里。
//
// ═══════════════════════════════════════════════════════════════════════════
// 文件分工
// ═══════════════════════════════════════════════════════════════════════════
//   config.ts       DEFAULT_RULES —— ir 的 DEFAULT_RULES_CONFIG 的副本（禁令 1 逼出来的）
//   intent.ts       Intent / IllegalReason / ApplyResult —— 输入与回执的形状
//   create-game.ts  createGame + shuffleZone（唯一一处"建局期消耗 RNG"）
//   apply.ts        apply —— 校验 → clone → 入栈 → resolve → 回执
//   run-match.ts    runMatch —— {seed, decks, intents} 三元组的求值器（架构 §6.1 用它）
//
// ═══════════════════════════════════════════════════════════════════════════
// M2 的边界
// ═══════════════════════════════════════════════════════════════════════════
// **没有回合状态机**。`phase` 停在建局时的 `"mulligan"`，`round` 停在 0，
// 水晶不涨、不自动抽牌、不进战斗 —— 那整套是 M3（v2 §4.1 / §4.2 / v2.1 §11.3），
// 而且里程碑明确要求 M3 一次做到 v2.1 形态、不分两步。
//
// 于是 M2 的 intent 集是**按走查四步反推的最小集**（`intent.ts` 文件头有完整说明）：
// `draw` / `play_unit` / `strike` / `respond`，其中只有 `respond` 会留到 M3。
// M3 接手时 `apply` 的骨架不变，只是 `planAct` 换成相位机的意图分发。
//
// 上层 `src/index.ts` 由外层统一组装，本目录不参与。

export { apply } from "./apply.ts";
export { DEFAULT_RULES } from "./config.ts";
export type { CreateGameOptions } from "./create-game.ts";
export { createGame, shuffleZone } from "./create-game.ts";
export type { ApplyResult, IllegalReason, Intent, IntentKind } from "./intent.ts";
export { ILLEGAL_REASONS } from "./intent.ts";
export type { RunMatchOptions, RunMatchRejection, RunMatchResult } from "./run-match.ts";
export { runMatch } from "./run-match.ts";
