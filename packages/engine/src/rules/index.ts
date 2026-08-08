// rules/ —— 对局层入口（架构 §2.3 的 `rules/`）。
//
// `state/` 建模、`resolve/` 结算、`handlers/` 执行动作，本目录负责把它们接成
// **一局对战**：建局、收玩家意图、推进相位、回执。架构 §2.3 列在 engine 对外 API 里的
// `createGame(rules, decks, seed)` 与 `apply(state, intent)` 就在这里。
//
// ═══════════════════════════════════════════════════════════════════════════
// 文件分工
// ═══════════════════════════════════════════════════════════════════════════
//   config.ts           DEFAULT_RULES —— ir 的 DEFAULT_RULES_CONFIG 的副本（禁令 1 逼出来的）
//   validate-config.ts  validateRulesConfig —— 建局期的规则校验（★ playerActions 恒关）
//   intent.ts           Intent / IllegalReason / ApplyResult —— 输入与回执的形状
//   initiative.ts       先手的四种策略 + 首回合随机掷（v2 §6 / §36）
//   phase.ts            ★ 相位机本体：round_start / deploy / actions / combat / round_end
//   combat.ts           ★ 战斗第 ②③④ 步：快照 / 逐条应用（旁路管线）/ 统一死亡（v2 §4.2）
//   create-game.ts      createGame + shuffleZone + 发起手牌（"建局期消耗 RNG"的唯一收口）
//   apply.ts            apply —— 校验 → clone → 记账入栈 → resolve → 推进相位 → 回执
//   run-match.ts        runMatch —— {seed, decks, intents} 三元组的求值器（架构 §6.1 用它）
//
// ═══════════════════════════════════════════════════════════════════════════
// M3 的边界
// ═══════════════════════════════════════════════════════════════════════════
// **相位机是完整的 v2.1 形态**（里程碑 M3 第 1 项要求一次做到，不分两步）：
// `mulligan → round_start → deploy(若有) → actions ⇄ → combat → round_end → …`，
// 水晶回满与上限递增、行动交替与双 pass、先手四策略、`playerActions` 恒关校验，全部落地。
//
// **战斗五步也完整**（v2 §4.2）：`combat.ts` 的快照 → 逐条应用 → 统一死亡，
// 其中「不做中途死亡结算」与「触发器只入栈不结算」这两条走的是一条**旁路管线**，
// 取舍写在那个文件的头部。direction 作为普通 Tag 也在那里落地 —— 战斗读的是
// 派生值 `tags.direction`，全引擎**没有一行 direction 的特判**。
// 第 ② 步的「记录后全部冻结」另有一道**运行时哨兵**（抛 `StrikeAmountDriftError`）：
// M3 里恒真，M5 引入"能在批次中途改 atk 的拦截器/触发器"时当场抛。
// 它是临时防线，M5 按 `PlannedStrike.amount` 的 TODO 二选一落地之后退役。
//
// 其余仍在别的里程碑：DSL 求值器与卡表（M4，`play_card` 的脚本接入点已标出）、
// 触发器匹配与光环源（M5）、英雄的阵亡/复活语义（M6，部署动作本身已在 `phase.ts`）。
//
// 上层 `src/index.ts` 由外层统一组装，本目录不参与。

export { apply } from "./apply.ts";
export type { PlannedStrike, TriggerQueue } from "./combat.ts";
export { planStrikes, resolveStrikes, StrikeAmountDriftError } from "./combat.ts";
export { DEFAULT_RULES } from "./config.ts";
export type { CreateGameOptions } from "./create-game.ts";
export { createGame, dealStartingHands, dealTop, shuffleZone } from "./create-game.ts";
export { nextInitiative, PLAYER_COUNT, rollInitiative } from "./initiative.ts";
export type { ApplyResult, DeployPick, IllegalReason, Intent, IntentKind } from "./intent.ts";
export { ILLEGAL_REASONS } from "./intent.ts";
export {
  advancePhases,
  beginRound,
  crystalCapFor,
  deployableHeroes,
  deployCountFor,
  deployQuotaOf,
  endRound,
  needsDeploy,
  refillCrystals,
  runCombat,
  runIntentBookkeeping,
  stripEnchantments,
} from "./phase.ts";
export type { RunMatchOptions, RunMatchRejection, RunMatchResult } from "./run-match.ts";
export { runMatch } from "./run-match.ts";
export { RulesConfigError, validateRulesConfig } from "./validate-config.ts";
