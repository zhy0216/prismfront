// 相位机 —— M3 的本体（DSL v2 §4.1 回合状态机、v2 §4.2 战斗、v2.1 §11.3 deploy）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 相位序列（一次做到 v2.1 形态，不分两步）
// ═══════════════════════════════════════════════════════════════════════════
//
//   mulligan ─┐
//             ↓
//   round_start → deploy(若有) → actions ⇄(行动交替) → combat → round_end ─┐
//        ↑                                                                 │
//        └─────────────────────────────────────────────────────────────────┘
//                                    ↘ over（base 归零 / 认输，任意时刻）
//
// 里程碑 M3 第 1 项明确要求**一次做到 v2.1 形态**，理由是 deploy 相位只是多一个 intent
// 分支（v2.1 §11.3 说服务端聚合双方秘密选择后喂**单个** intent，引擎保持单输入模型），
// 现在写便宜；等 M6 再往一个已经稳定的相位机里插新相位，就得重测全部时序。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 一条贯穿全文件的设计：**相位记账先做完，效果结算后跑** ★
// ═══════════════════════════════════════════════════════════════════════════
// 每条意图分两段处理：
//   ① 记账段（本文件）—— 扣水晶、切 `priority`、加 `consecutivePasses`、发规则事件、
//      把要执行的 `Act` 压栈。**同步、不可挂起、不会失败**。
//   ② 结算段（`resolve/`）—— 弹栈跑六步流水线，可能挂起等玩家输入（框架 §4.2）。
//
// 顺序反过来（先结算再记账）会有一个很难修的洞：卡牌效果在结算中途挂起，此时
// `priority` 还没切、`consecutivePasses` 还没清，而状态已经可以落盘/重连 ——
// 恢复之后到底算不算"这个行动做完了"就没有答案了。
// 先记账则挂起点天然安全：`resume()` 只需接着弹栈，回合状态早已是正确的下一步。
//
// ═══════════════════════════════════════════════════════════════════════════
// 自动相位与等待相位
// ═══════════════════════════════════════════════════════════════════════════
// `combat` / `round_end` / `round_start` 是**自动相位**：没有对应的玩家意图，
// 引擎进去就一路跑到下一个等待相位。`mulligan` / `deploy` / `actions` / `over`
// 是**等待相位**：停在那里等 `apply()` 的下一条意图。
// {@link advancePhases} 就是这条"跑到下一个等待相位"的循环，它是本文件的入口。
//
// 于是一次双 pass 的 `apply()` 会一口气产出：
//   player_passed → combat_began → combat_ended → round_ended → round_began
//   → crystal_gained×2 → card_drawn×2
// 这是对的：框架 §3.1 说 `state.seq` 是**协议消息**的序号，而一次 `apply` 恰好对应
// 服务端要广播的一条消息 —— 玩家按一次 pass，看到的就是这一整段。
//
// ═══════════════════════════════════════════════════════════════════════════
// 战斗在哪：五步分在两个文件
// ═══════════════════════════════════════════════════════════════════════════
// {@link runCombat} 做**相位的进出**（第 ① 步 `combat_began` + 把结算栈跑空、
// 第 ⑤ 步 `end_of_combat` 剥离 + `combat_ended` + 转 round_end）；
// 中间的第 ②③④ 步（快照 / 逐条应用 / 统一死亡）在 `combat.ts` ——
// 那三步有两条只属于战斗的时序偏离（不做中途死亡结算、触发器只入栈不结算），
// 论证很长，独立成文件比塞进相位机里好读。
//
// ═══════════════════════════════════════════════════════════════════════════
// 本文件**没做**的一件事
// ═══════════════════════════════════════════════════════════════════════════
// **卡牌的 `play` 脚本**：`play_card` 目前只把牌放到指定格。跑脚本要求值器（M4），
// 接入点见 {@link playCard} 里标出的那一行。

import type { Act, Duration } from "@prismfront/ir";
import type { GameEvent } from "../events/index.ts";
import { emitEvent } from "../events/index.ts";
import { drawOne, moveToZone, placeOnSlot, playerEntity } from "../handlers/index.ts";
import type { ResolveDeps } from "../resolve/index.ts";
import { pushActs, queueTriggers, refreshAuras, resolve } from "../resolve/index.ts";
import type { CtxBindings, EntityData, GameState, PlayerId } from "../state/index.ts";
import {
  createCtx,
  emptySlotIndices,
  FIRST_ROUND,
  getEntity,
  getZoneEntities,
  opponentOf,
  PLAYER_IDS,
  playerData,
} from "../state/index.ts";
import { resolveStrikes } from "./combat.ts";
import { dealTop, shuffleZone } from "./create-game.ts";
import { nextInitiative } from "./initiative.ts";
import type { DeployPick, Intent } from "./intent.ts";

/**
 * 「没有实体」的哨兵 id（`state/create.ts`：实体 id 从 1 起，0 空出来当哨兵）。
 *
 * 用作规则伤害（疲劳）的 `ctx.self`：`handlers/read.ts` 的 `sourceOf` 查不到实体就返回
 * `null`，于是 `damaged.source` 是 `null` —— 正是"无施动实体的伤害"这个语义
 * （`events/event.ts` 的 `damaged` 注释）。
 */
const NO_ENTITY = 0;

// ═══════════════════════════════════════════════════════════════════════════
// 相位推进的总入口
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一直推进自动相位，直到停在**等待相位**（或挂起 / 对局结束）。
 *
 * 循环体每跑完一个相位步就 `resolve()` 一次：相位步只**压栈**不执行动作
 * （疲劳伤害、战斗出手、将来的 `round_start` 触发器都是压栈的），
 * 必须交给流水线去跑，才能享受拦截器 / 触发器 / 死亡结算 / 光环重算这一整套时序。
 *
 * 两条退出条件与 `resolve()` 一致：
 * - `pendingInput !== null` —— 结算停在一个挂起点，相位**不能**再往前走
 *   （否则玩家还没做完选择，回合就已经翻篇了）。由 `apply` 的 `respond` 支路
 *   再次调用本函数接着推进。
 * - `winner !== null` —— 对局已结束，后续相位没有意义。**并在这里清空结算栈**，
 *   理由见 {@link concludeMatch}。
 *
 * **终止性**：三个自动相位构成一条无环链 `combat → round_end → round_start →
 * {deploy | actions}`，每一步都把 `state.phase` 改成链上的下一个，终点是等待相位。
 * 所以不需要步数上限；刻意不加一个永远走不到的 guard 分支（同 `resolve/deaths.ts`
 * 的取舍：走不到的分支既测不了，又会在覆盖率里变成噪声）。
 *
 * ⚠ `combat` 是唯一**不走** {@link runStep} 的相位步：战斗内部自己要跑好几段结算
 *   （第 ① 步要把栈跑空快照才准，第 ④ 步要开闸跑亡语），因此它自己负责
 *   「事件 → `queueTriggers`」这条规矩，并把沿途排空的事件流返回给这里。
 *   若也交给 `runStep`，它末尾那次 `queueTriggers` 会把战斗内部已经排过队的
 *   `struck` / `damaged` / `unit_died` 再排一遍 —— 一次不可见的重复触发。
 */
export function advancePhases(state: GameState, deps: ResolveDeps): GameEvent[] {
  const events: GameEvent[] = [];
  for (;;) {
    if (state.winner !== null) {
      concludeMatch(state);
      return events;
    }
    if (state.pendingInput !== null) {
      return events;
    }
    switch (state.phase) {
      case "combat":
        for (const event of runCombat(state, deps)) {
          events.push(event);
        }
        break;
      case "round_end":
        runStep(state, () => endRound(state));
        break;
      case "round_start":
        runStep(state, () => beginRound(state));
        break;
      default:
        // mulligan / deploy / actions / over —— 等待相位，停在这里。
        return events;
    }
    for (const event of resolve(state, deps)) {
      events.push(event);
    }
  }
}

/**
 * 终局收口：把结算栈清空（v2 §4.1 的 `over`）。
 *
 * ── 为什么落在这里，而不落在两个写 `winner` 的站点上 ──────────────────────
 * 写 `winner` 的地方有两处：{@link concedeMatch}（认输）与 `resolve/deaths.ts` 的
 * `settleBases`（base 归零）。两处都在 `apply()` 的记账/结算段里，而**本文件的
 * {@link advancePhases} 是它们共同的下游收口** —— `apply()` 与 `applyRespond()`
 * 都无条件调它，于是「交出引擎的那份状态，栈必为空」是结构性的，
 * 不依赖将来谁又在哪里写了一次 `winner`。
 *
 * 反过来在两个站点各清一次则会毁掉一件有用的事：`resolve()` 停下的**那一刻**
 * 栈上还剩什么，是复现终局连锁的唯一线索（`resolve/resolve.ts` 的偏离 B）。
 * 清空发生在这一整段结算跑完之后、状态交出去之前，两边都保住。
 *
 * ── 不清会怎样 ───────────────────────────────────────────────────────────
 * 残留条目会跟着状态进快照 / 投影 / 回放（`winner` 非空的状态照样要落盘），
 * 而它属于一局**已经结束**的对战：任何后续的 `resolve()` / `resume()` 都会把它弹出来
 * 执行一次 —— 亡语在终局之后凭空生效，正是偏离 B 要禁掉的那件事。
 *
 * **只清栈，不动 `pendingInput`**：挂起点与胜负同时存在在 M3 里没有来源
 * （挂起要 M4/M5 的动作），真出现时它是一个需要单独定夺的状态，
 * 不该由本函数顺手抹掉一条它并不理解的信息。
 */
function concludeMatch(state: GameState): void {
  state.stack.length = 0;
}

/**
 * 一个相位步 / 记账段要压进结算栈的动作，按**执行顺序**给（LIFO 反转交给 `push.ts`）。
 *
 * 相位步**自己不压栈**，而是把动作交出来由 {@link runStep} 统一压 —— 理由见那里。
 */
interface StepActs {
  readonly acts: readonly Act[];
  readonly ctx: CtxBindings;
}

/**
 * 跑一个相位步：改状态 + 发事件 → **先**把事件交给触发器排队 → **后**压它产出的动作。
 *
 * ── 为什么相位机要自己调 `queueTriggers` ──────────────────────────────────
 * `resolve()` 只会把**handler 产出**的事件喂给 `queueTriggers`（流水线第 ③→④ 步）。
 * 相位机产的事件（`round_began` / `crystal_gained` / `player_passed` / `round_ended`
 * / `action_taken` …）不经过 handler，若不在这里补一次，M5 的
 * 「每当回合开始 / 每当对手 pass / 每当你打出一张牌」就永远匹配不到 ——
 * 而那种漏发没有任何编译期防线，只能靠这条约定守住。
 * （`combat_began` / `combat_ended` 是同一条约定，但由 {@link runCombat} 自己排队 ——
 * 战斗不走本函数，理由见 {@link advancePhases} 上的 ⚠。）
 * （`queueTriggers` 在 M5 之前是**语义正确的退化实现** —— 无触发器源 ⇒ 排队 0 条 ——
 * 所以现在调它没有副作用，只是把接缝先接对。）
 *
 * ── ★ 为什么排队在前、压栈在后 ★ ─────────────────────────────────────────
 * 栈是 LIFO：**后**压的**先**执行。所以这个顺序等价于
 * 「这一步自己的动作先跑完，它引发的触发器才开始」—— 正是框架 §4.1 时序规则 2
 * （「A 触发 B，B 要等 A 这一步做完才开始」）。
 * 反过来先压动作再排触发器，会得到「战吼在随从上场之前结算」「疲劳伤害在
 * round_began 的触发器之后才落地」这类颠倒 —— 而颠倒后的结果往往"看起来也挺合理"，
 * 最容易一路混进产线（`resolve/push.ts` 文件头的原话）。
 * 现在两者不可能同时非空（触发器排队是空实现），所以这条顺序**测不出来**，
 * 只能靠这段注释和这一处唯一实现守住。
 */
function runStep(state: GameState, body: () => StepActs | null): void {
  const mark = state.eventLog.length;
  const pending = body();
  queueTriggers(state, state.eventLog.slice(mark));
  if (pending !== null) {
    pushActs(state, pending.acts, pending.ctx);
  }
}

/** 本回合的遍历顺序：**先手方在前**。见 {@link beginRound} 里为什么用它而不是 p0→p1。 */
function roundOrder(state: GameState): readonly [PlayerId, PlayerId] {
  return state.initiative === 0 ? [0, 1] : [1, 0];
}

// ═══════════════════════════════════════════════════════════════════════════
// round_start（v2 §4.1）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 回合开始：编号 +1 → 定先手 → 重置行动计数 → 水晶回满 → 抽牌 → 进 deploy 或 actions。
 *
 * ── 顺序为什么是这个顺序 ──────────────────────────────────────────────────
 * 1. `round += 1` 必须最先：水晶公式与 deploy 排期都按新回合号算。
 * 2. `round_began` 紧随其后：它是这一整段的"标题"，排在前面客户端才好断句；
 *    随后的 `engine.random_picked`（`random_each_round` 策略）、`crystal_gained`、
 *    `card_drawn` 都是这一回合开始的组成部分。
 * 3. **先算先手，再重置 `firstPasser`**：`first_passer` 策略的输入恰恰是
 *    *上一回合*的 `firstPasser`（v2 §6）。顺序反了，那条策略会永远读到 `null`
 *    并退化成 `fixed_first` —— 而且不报错，只是手感悄悄变了。
 * 4. `priority = initiative`：行动交替制的起点（v2 §4.1）。
 * 5. 水晶在抽牌之前：将来若有"抽到时消耗水晶"的卡（M4+），资源必须已经就位。
 *
 * ── 为什么按 `initiative` 顺序而不是 p0 → p1 ──────────────────────────────
 * 水晶与抽牌的事件顺序会进回放，必须写死。这里取**先手方在前**，与 v2 §4.2 战斗
 * 快照的遍历基准（`[initiative 方, 另一方]`）以及 `resolve/triggers.ts` 的
 * 「当前回合玩家优先」是同一个基准 —— 全引擎只用一种"谁排前面"的口径，
 * 比在不同地方各用一种少一整类时序疑问。
 *
 * 返回值是要压栈的疲劳伤害（可能为 `null`），由 {@link runStep} 在触发器排队之后压入。
 */
export function beginRound(state: GameState): StepActs | null {
  state.round += 1;
  emitEvent(state, { name: "round_began", round: state.round });

  if (state.round > FIRST_ROUND) {
    // 首回合的先手是**建局时掷出来的**（`create-game.ts`），与策略正交（v2 §36）。
    // 策略只回答"从第 2 回合起怎么变"，见 `initiative.ts` 的文件头。
    state.initiative = nextInitiative(state, state.rules.initiative);
  }
  state.firstPasser = null;
  state.consecutivePasses = 0;
  state.priority = state.initiative;

  refillCrystals(state);
  const fatigue = drawForRound(state);

  state.phase = needsDeploy(state) ? "deploy" : "actions";
  return fatigue;
}

/**
 * 本回合的水晶上限（v2 §4.1）：`min(initial + (round - 1) * growth, capMax)`。
 *
 * 字面量 5 一律取 `rules.crystals.initial`（默认 5，v2 §6）—— 硬编码会让一份
 * 调过参的 `RulesConfig` 静默失效，而这类失效在对局里表现为"手感不对"，极难归因。
 */
export function crystalCapFor(state: GameState, round: number): number {
  const { initial, growth, capMax } = state.rules.crystals;
  const grown = initial + (round - FIRST_ROUND) * growth;
  return grown < capMax ? grown : capMax;
}

/**
 * 水晶：上限按公式重算，当前值**回满**（v2 §4.1 / v2 §0 规则 5，炉石式）。
 *
 * `crystal_gained.amount` 取「这一次真的多出来多少」= 回满值 − 回合开始前的余额，
 * 而不是上限本身。理由是 v2 §5 给 `crystal_gained` 的语义是"获得水晶"，
 * 而客户端要播的动画是"+N 颗亮起来"。上限没涨且上回合一颗没花时 `amount` 为 0，
 * 此时**不发事件** —— 一件没有发生的事不该进事件流（同 `handlers/damage.ts` 里
 * 「造成 0 点伤害不发 `damaged`」的取舍），否则 M5 的「每当你获得水晶」会凭空触发。
 *
 * ⚠ v2 §5 没有为"水晶上限提高"单设事件，`act.gain_crystal_cap` 的表达方式规范也没规定。
 *   **M3 的定夺：不新增事件名，上限变化不单独下发**，由 `crystal_gained` 与状态里的
 *   `crystalCap` 共同表达。两条理由：
 *     (a) `RuleEvent["name"]` 与 IR 的 `EventName` 之间有编译期双向断言
 *         （`events/event.ts` 末尾），新增名字要先改 ir 的词汇表，而那是 trigger 的
 *         `on` 取值域 —— 等于允许卡牌监听"上限提高"，那是个没人要的触发时机；
 *     (b) 上限是**状态**而不是**事件**：客户端每次都能从投影后的 `crystalCap` 读到,
 *         用事件表达反而多一个可能与状态不同步的真相源。
 *   将来真要做 `act.gain_crystal_cap`（M4 的动作），它同样只改状态 + 复用
 *   `crystal_gained`（amount 为它顺带回满的那部分），不要在这里开新事件名。
 */
export function refillCrystals(state: GameState): void {
  const cap = crystalCapFor(state, state.round);
  for (const player of roundOrder(state)) {
    const data = playerData(state, player);
    const before = data.crystals;
    data.crystalCap = cap;
    data.crystals = cap;
    const gained = cap - before;
    if (gained > 0) {
      emitEvent(state, {
        name: "crystal_gained",
        player: playerEntity(state, player),
        amount: gained,
      });
    }
  }
}

/**
 * 回合抽牌：每方抽 `rules.deck.drawPerRound` 张；牌库空且开了 `deck.fatigue` 则疲劳。
 *
 * ⚠ **先手补偿（后手多抽一张 / 硬币）在 v2 里没有规定**，这里也就不发明：双方每回合
 *   同抽 `drawPerRound` 张，起手牌也同为 `deck.startingHand` 张。先手优势是否需要补偿
 *   属于数值试玩的结论（里程碑 M12），改起来只是这一个函数，不影响相位机结构。
 *
 * 疲劳（v2 §6 `deck.fatigue`）：**牌库抽空后每次抽牌递增计数，并按该值伤害自己的 base**。
 * 三个要点：
 * - 计数写 `players[p].fatigue`（`num.tag("fatigue")` 读它，v2 §3.3 的 GlobalTag）；
 * - **不发 `card_drawn`**（v2 §5 明确规定），只发伤害那一条 `damaged`；
 * - 伤害走 `act.hit` **压栈**而不是直接改 `damage`：护甲、圣盾、"改为受到 N 点伤害"
 *   这类替换效果都挂在 `act.hit` 这一层（IR v1 §4.2，M5），绕过去它们就全失效了。
 *
 * 疲劳伤害**整批**交出去（而不是在这里逐条 `pushAct`）：栈是 LIFO，逐条压会让
 * **后**记账的那一方**先**挨打，事件顺序与记账顺序相反 —— 那种颠倒"看起来也挺合理"，
 * 最容易一路混进产线（`resolve/push.ts` 文件头的原话）。反转由 `pushActs` 统一做。
 */
function drawForRound(state: GameState): StepActs | null {
  const hits: Act[] = [];
  for (const player of roundOrder(state)) {
    const data = playerData(state, player);
    for (let i = 0; i < state.rules.deck.drawPerRound; i += 1) {
      if (drawOne(state, player)) {
        continue;
      }
      if (!state.rules.deck.fatigue) {
        break;
      }
      data.fatigue += 1;
      hits.push({
        op: "act.hit",
        target: { op: "sel.entity", id: data.baseId },
        amount: data.fatigue,
      });
    }
  }
  // SELF 绑哨兵 ⇒ `damaged.source` 为 `null`：疲劳没有施动实体。
  return hits.length === 0 ? null : { acts: hits, ctx: createCtx(NO_ENTITY) };
}

// ═══════════════════════════════════════════════════════════════════════════
// deploy（v2.1 §11.3）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 本回合按排期要部署几名英雄。
 *
 * `rules.heroes.deploySchedule` 的语义按架构 §10 第 6 项定案：
 * **索引 = 第几个回合（0-based），值 = 该回合部署几名** —— `[2, 1]` = r1 部署 2 名、
 * r2 部署第 3 名（v2.1 §11.3）。排期之外的回合返回 0。
 *
 * ⚠ M6 要在这里补上**复活重部署**那一支：英雄阵亡后进复燃泉、`respawnAt` 到期时
 *   即使排期已经走完也要能重新部署。那一支依赖"阵亡 → fountain + 回写 respawnAt"
 *   的死亡分支（`resolve/deaths.ts` 里同样标着 M6），两件事必须一起做，
 *   所以这里不预先写一个走不到的分支。
 */
export function deployQuotaOf(state: GameState): number {
  return state.rules.heroes.deploySchedule[state.round - FIRST_ROUND] ?? 0;
}

/** 某方复燃泉里**本回合可上场**的英雄（`respawnAt` 到期，v2.1 §11.3）。 */
export function deployableHeroes(state: GameState, player: PlayerId): EntityData[] {
  const out: EntityData[] = [];
  for (const hero of getZoneEntities(state, player, "fountain")) {
    if (hero.respawnAt !== null && hero.respawnAt <= state.round) {
      out.push(hero);
    }
  }
  return out;
}

/**
 * 某方本回合实际要部署的名数 = min(排期, 泉里可用的, **战线空格数**)。
 *
 * ── ★ 空格数必须进这个 min，否则 deploy 相位会死锁 ★ ──────────────────────
 * `apply.ts` 的 `checkDeploy` 拿本函数当「名数必须**刚好**」的判据，而每个 pick 还要
 * 再过一道「该格当前为空」。两条合起来意味着：战线站满时若本函数仍返回排期的名数，
 * 那一方**提交什么都会被拒** —— 空 picks 判 `invalid_choice`、任何格判 `slot_occupied`，
 * 而 `pass` / `play_card` 在 deploy 相位是 `wrong_phase`，只剩认输能脱身。
 * 这与 {@link applyDeploy} 注释里那句「相位机必须能从 deploy 走出去」正面冲突。
 * 补上空格数之后 {@link needsDeploy} 也随之正确：站满 ⇒ 0 ⇒ 根本不进 deploy。
 *
 * 空格数走 `emptySlotIndices`（`state/queries.ts`）而不是在这里再数一遍：
 * 「哪些格是空的」全引擎只有那一处实现，三态（`undefined` 无效槽 / `null` 空 / id 有人）
 * 的判读也就只有一个口径。
 *
 * ⚠ M6 的复活重部署（见 {@link deployQuotaOf} 的 ⚠）同样受这条约束：泉里排着队的英雄
 *   在战线站满时**这一回合上不了场**，只能等下一回合 —— 那是规则结果，不是要绕过的限制。
 */
export function deployCountFor(state: GameState, player: PlayerId): number {
  const quota = deployQuotaOf(state);
  const available = deployableHeroes(state, player).length;
  const vacancies = emptySlotIndices(state, player).length;
  return Math.min(quota, available, vacancies);
}

/**
 * 本回合是否需要经过 deploy 相位。
 *
 * 「若有」的判据是**双方合计要部署的名数 > 0**：没有英雄的对局（M3 的全部测试夹具、
 * 以及将来任何不带英雄的变体）会直接从 round_start 跳到 actions，
 * 不会平白多出一个所有人都只能提交空 picks 的相位。
 *
 * 名数由 {@link deployCountFor} 给，它已经把**战线空格数**算进去了 ——
 * 于是"双方战线都站满"与"没有英雄"在这里是同一种情形：都不进 deploy。
 */
export function needsDeploy(state: GameState): boolean {
  for (const player of PLAYER_IDS) {
    if (deployCountFor(state, player) > 0) {
      return true;
    }
  }
  return false;
}

/**
 * 执行一次部署（v2.1 §11.3）。
 *
 * intent 是**双方聚合后的单条**：服务端收齐两边的秘密选择，再喂给引擎一次
 * （v2.1 §11.3 原文），于是引擎保持"一次 `apply` 一条 intent"的单输入模型，
 * 不需要为"同时秘密选择"发明第二种输入形态。
 *
 * 顺序写死 p0 → p1（不按 initiative）：部署是**同时揭示**的，两边互不影响
 * （校验阶段已经保证格位不冲突 —— 各自的战线本来也是分开的两行），
 * 这里只需要一个稳定顺序让事件流可回放，取最简单的那个。
 *
 * ⚠ M6 的部分：英雄的卡面属性（要卡表，M4）、阵亡 → 复燃泉 → `respawnAt` 回写、
 *   复活重部署、以及服务端那一侧的秘密收集与超时兜底。本函数只做 v2.1 §11.3 的
 *   **部署动作本身** —— 因为相位机必须能从 deploy 走出去，否则一局带英雄的对战
 *   会卡死在这个相位。
 */
function applyDeploy(
  state: GameState,
  picks: readonly [readonly DeployPick[], readonly DeployPick[]],
): null {
  for (const player of PLAYER_IDS) {
    for (const pick of picks[player]) {
      const hero = getEntity(state, pick.hero);
      if (hero === undefined) {
        continue;
      }
      if (!placeOnSlot(state, hero, player, pick.slot)) {
        continue;
      }
      // 上了场就不再是"等待复活"的状态（v2.1 §11.3：respawnAt 只在泉里有意义）。
      hero.respawnAt = null;
      emitEvent(state, {
        name: "hero_deployed",
        player: playerEntity(state, player),
        target: hero.id,
        cardId: hero.cardId,
        slot: pick.slot,
      });
    }
  }
  state.phase = "actions";
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// actions（v2 §4.1：行动交替 + 双 pass）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 打出一张牌 —— PF1 唯一开放的玩家行动（`rules.playerActions` 恒为 `["play_card"]`，
 * 见 `validate-config.ts` 的决策 #3）。
 *
 * 记账顺序（三件事都在效果结算之前完成，见文件头）：
 * 1. **扣水晶**。费用取 `card.tags.cost` 即**生效费用** —— 派生值，于是"本回合你的
 *    下一张随从便宜 2 点"这类光环/附魔（M5）自动生效，不需要在这里写一行特判。
 * 2. 发 `action_taken` 与 `card_played`。`action_taken` 在前：v2 §5 说它"发出即意味着
 *    `consecutivePasses` 归零"，也就是它描述的是**行动经济**这件事本身，
 *    而 `card_played` 描述的是这次行动的**内容**；先经济后内容，与 pass 那一支对称。
 * 3. `consecutivePasses = 0`（★ **pass 不锁定**，v2 §4.1：对手行动后计数清零）
 *    + `priority` 交给对手。
 *
 * ── 效果段（M4 的接入点）★ ────────────────────────────────────────────────
 * 现在只压一条 `act.move` 把牌放到指定格，等价于 M2 的 `play_unit`。真正的
 * `play_card` 还要做两件事，两件都要求值器（M4）：
 *   (a) **区分随从牌与法术牌** —— 需要卡表才知道这张卡是不是要占格；
 *   (b) **跑卡牌的 `play` 脚本** —— 用 `pushScript` 压一条 `<cardId>#play` 的引用条目，
 *       排在 `act.move` **后面**（返回的 `acts` 是执行顺序），于是"上场"先于"战吼"发生，
 *       `unit_summoned` 也就排在战吼的事件之前。
 * 接入点就是本函数末尾返回的那个 `acts` 数组：把 `act.move` 与展开出的脚本一起放进去，
 * 顺序即执行顺序（`resolve/push.ts` 负责那次 LIFO 反转）。
 */
function playCard(state: GameState, player: PlayerId, card: EntityData, slot: number): StepActs {
  const data = playerData(state, player);
  data.crystals -= card.tags.cost;

  emitEvent(state, {
    name: "action_taken",
    player: playerEntity(state, player),
    kind: "play_card",
  });
  emitEvent(state, {
    name: "card_played",
    player: playerEntity(state, player),
    target: card.id,
    cardId: card.cardId,
  });

  state.consecutivePasses = 0;
  state.priority = opponentOf(player);

  return {
    acts: [
      {
        op: "act.move",
        target: { op: "sel.entity", id: card.id },
        zone: "board",
        // `act.move.side` 的基准是 `entity.owner`（IR v1 §3.4）。被 `act.steal` 偷来的牌
        // owner 是对手，要 `"opposite"` 才能落到**发起方自己**的战线上。
        side: card.owner === player ? "owner" : "opposite",
        pos: slot,
      },
    ],
    // SELF = 这张牌自己，与卡牌脚本里 `sel.self` 的绑定一致（M4 接脚本时不用改）。
    ctx: createCtx(card.id),
  };
}

/**
 * 过牌（v2 §4.1 的 LoR 式双 pass）。
 *
 * 三件事：
 * 1. 记 `firstPasser` —— 本回合**先** pass 的一方。它是 `first_passer` 先手策略的
 *    唯一输入（v2 §6），只记第一次，后续 pass 不覆盖。
 * 2. `consecutivePasses += 1`，达到 `rules.pass.combatAfterConsecutivePasses`
 *    （默认 2，**读配置不写死**）→ 进战斗。
 * 3. 没到阈值就把 `priority` 交给对手，让对手有机会行动 ——
 *    ★ **pass 不锁定**：对手一旦行动，{@link playCard} 会把计数清零，
 *    于是"我 pass 了但你还想打牌"不会把我锁在场外。
 *
 * 进战斗时**不切 `priority`**：`actions` 相位到此结束，`priority` 会在下一个
 * `round_start` 被重置为新的 `initiative`，中间这段它没有意义。
 */
function passAction(state: GameState, player: PlayerId): null {
  emitEvent(state, { name: "player_passed", player: playerEntity(state, player) });
  if (state.firstPasser === null) {
    state.firstPasser = player;
  }
  state.consecutivePasses += 1;
  if (state.consecutivePasses >= state.rules.pass.combatAfterConsecutivePasses) {
    state.phase = "combat";
    return null;
  }
  state.priority = opponentOf(player);
  return null;
}

/**
 * 认输：对手直接获胜（v2 §4.1 的 `over` 相位）。
 *
 * **不发事件**：v2 §5 的事件表里没有"对局结束"，而借用别的名字会让触发器误触发
 * （同 `resolve/deaths.ts` 的 `settleBases` 论证）。胜负由 `state.winner` 承载，
 * 下发客户端是协议层（M9）的事。
 *
 * 与 base 归零一样，必须**两个字段一起写**才能维持
 * `winner !== null ⇔ phase === "over"` 这条状态不变量（`state/game-state.ts`）。
 *
 * 结算栈不在这里清：认输与 base 归零共用 {@link concludeMatch} 那一处收口（见那里）。
 */
function concedeMatch(state: GameState, player: PlayerId): null {
  state.winner = opponentOf(player);
  state.phase = "over";
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// combat（v2 §4.2）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 战斗阶段（v2 §4.2 的五步）。返回这一段排空的事件流。
 *
 *   ① `combat_began` → 结算栈完全清空（此时的 buff/召唤还能影响快照）
 *   ② 快照 strikes：按 `[initiative 方 0→8, 另一方 0→8]` 遍历，
 *      条件 `atk > 0 && !stunned`，目标格 = 敌方行（自己格 + **生效** direction），
 *      越界或空 → 敌方基地；记下 `{attacker, target, amount}` 后**全部冻结**
 *   ③ 逐条应用（`act.strike` → `act.hit`）：★ 不做中途死亡结算、★ 触发器只入栈不结算
 *   ④ 全部应用完 → 结算栈开闸 → 统一死亡 → 亡语 → 光环重算 → 循环至不动点
 *   ⑤ `combat_ended` → `end_of_combat` 附魔剥离 → `round_end`
 *
 * ②③④ 在 `combat.ts` 的 {@link resolveStrikes}（那三步的两条时序偏离论证很长，
 * 见那个文件的头部）。本函数只管相位的进出，也就是 ① 与 ⑤。
 *
 * ── 第 ① 步的「结算栈完全清空」到底要做什么 ───────────────────────────────
 * 两件事，缺一不可：
 * 1. **进来时栈已经是空的**。这不是巧合，而是 {@link advancePhases} 的循环不变量
 *    （它每跑完一个相位步就 `resolve()` 到栈空）。所以这里**不**写
 *    `state.stack.length = 0` —— 那句会悄悄吞掉一个本该被发现的"栈没跑干净"的 bug。
 * 2. **`combat_began` 自己引发的触发器要在快照之前跑完**。规范那句括号
 *    「此时的 buff/召唤会影响快照」说的正是这件事：一张「每当战斗开始，全体 +1/+1」
 *    必须在第 ② 步取数之前生效。所以这里发完事件立刻 `queueTriggers` + `resolve()`，
 *    而不是把它交给 {@link runStep} 末尾那次排队（那会排到快照**之后**才跑）。
 *    M5 之前 `queueTriggers` 恒排 0 条，这一段是空转，但接缝必须现在就接对。
 *
 * ── 终局：base 被战斗打穿时**不发** `combat_ended` ────────────────────────
 * 第 ④ 步的死亡结算会做 base 归零判负（v2 §4.1「任意时刻」）。此时对局已经结束，
 * 再发 `combat_ended`、再剥附魔、再把相位改成 `round_end`，等于让终局之后还有后续时序
 * （`resolve/resolve.ts` 的偏离 B 是同一条理由），而且会打破
 * `winner !== null ⇔ phase === "over"` 这条状态不变量。所以直接返回。
 * **同一条理由在第 ① 步之后同样成立**（战斗开始的触发器就能打穿 base），
 * 那里有一道同形的判断，连同 `pendingInput` 一起 —— 见函数体里的 ★。
 *
 * ⚠ **假设（规范没说清，M5 需要复核）**：第 ⑤ 步里「剥附魔」与「发 `combat_ended`」
 *   的先后。v2 §4.2 把这一步写成 `combat_ended → end_of_combat 剥离 → round_end`，
 *   本函数实现的是**先剥再发**（与 {@link endRound} 对 `end_of_round` 的处理一致）。
 *   目前两种顺序**完全不可观测**：剥离不发事件，触发器又只入栈不结算，
 *   两者产出的事件流与状态逐字相同。M5 起会有一处差别 ——
 *   `queueTriggers` 里的 `cond` 求值会看到剥离前 / 剥离后两种不同的盘面
 *   （「每当战斗结束，若你有一个 atk ≥ 5 的单位…」算不算那条本轮 buff）。
 *   到那时要**同时**为 `end_of_combat` 与 `end_of_round` 定一个口径，
 *   而不是只改这一处；在此之前不擅自翻转，免得两个存续期的行为分叉。
 */
export function runCombat(state: GameState, deps: ResolveDeps): GameEvent[] {
  const events: GameEvent[] = [];

  // ① combat_began → 触发器排队 → 把结算栈跑到空（快照必须看见它们的效果）
  const opening = state.eventLog.length;
  emitEvent(state, { name: "combat_began", round: state.round });
  queueTriggers(state, state.eventLog.slice(opening));
  for (const event of resolve(state, deps)) {
    events.push(event);
  }
  // ★ 第 ① 步之后与第 ⑤ 步之前是**同一道**判断，两处都要有：
  // - `winner` —— 一张「每当战斗开始，对敌方基地造成 N 点伤害」（M5）足以在这里就打穿
  //   base。终局之后不该再有后续时序（`resolve/resolve.ts` 的偏离 B），
  //   少了这道判断，②③④ 会在一局已经结束的对战上照跑，base 还能吃到超过 baseHp 的伤害。
  // - `pendingInput` —— 挂起时**同样不能开始快照**：批次是原子的（`rules/combat.ts`
  //   文件头），快照是那个文件的局部变量，从第一步就被劈开的话后半批无处可存。
  //   （挂起之后 `phase` 仍是 `combat`，`resume()` 会让 `advancePhases` 重新进本函数、
  //   于是 `combat_began` 再发一次。M3 没有挂起源，所以这只是把"不做半批"这条守住；
  //   M5 真给拦截器开挂起时，要先回答 `rules/combat.ts` 文件头那个
  //   「战斗批次跨挂起点如何续跑」的问题，那时这一段一并重做。）
  if (state.winner !== null || state.pendingInput !== null) {
    return events;
  }

  // ②③④ 快照 → 逐条应用（不做中途死亡结算、触发器只入栈）→ 统一死亡到不动点
  for (const event of resolveStrikes(state, deps)) {
    events.push(event);
  }
  if (state.winner !== null) {
    return events;
  }

  // ⑤ `end_of_combat` 附魔在战斗结束时剥离（v2 §3.5 / IR v1 §2.3 的 Duration）。
  //    事件排队之后就交出去：`combat_ended` 与它的触发器由 `advancePhases` 末尾那次
  //    `resolve()` 排空 / 弹栈，于是它排在本段全部事件之后 —— 顺序即因果。
  const closing = state.eventLog.length;
  stripEnchantments(state, "end_of_combat");
  emitEvent(state, { name: "combat_ended", round: state.round });
  queueTriggers(state, state.eventLog.slice(closing));
  state.phase = "round_end";
  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
// round_end（v2 §4.1）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 回合结束：剥离 `end_of_round` 附魔 → 发 `round_ended` → 直接进下一个 `round_start`。
 *
 * 为什么**不**在这里停下等一条"开始下一回合"的意图：那种意图不存在 ——
 * v2 §4.1 的回合状态机里 `round_end` 到 `round_start` 是一条无条件边，
 * 没有任何一方需要在这里做决策。给它造一条意图只会多一次网络往返和一个
 * "谁来发"的扯皮点（引擎不认识网络，架构 §6.1）。
 */
export function endRound(state: GameState): null {
  stripEnchantments(state, "end_of_round");
  emitEvent(state, { name: "round_ended", round: state.round });
  state.phase = "round_start";
  return null;
}

/**
 * 剥离所有指定存续期的附魔实例（IR v1 §2.3 的 `Duration`，v2 §3.5）。
 *
 * 只动 `entity.enchantments` 这份**实例列表**（纯数据、`ench` 是 bundle 里的 id），
 * 剥完立刻 `refreshAuras` 让 `tags` / `flags` 重新算一遍 ——
 * 属性是**重算而非增量**（框架 §4.1 时序规则 4），所以"剥离"这件事不需要
 * 也不允许去减回任何数值，只要把来源拿掉再重算即可。这正是规则 4 想省掉的
 * 那一整类"失效时忘了减回去"的 bug。
 *
 * **不发事件**：v2 §5 没有"附魔到期"这个事件名，而 `silenced` 是 `act.silence`
 * 的专属语义（剥离全部附魔 + 复位 tag），借用它会让"沉默"的触发器误触发。
 *
 * ⚠ 现在剥离是**不可观测**的：`resolve/auras.ts` 的 `refreshAuras` 在 M5 之前还是
 *   `tags = base + 两个空 Σ`，附魔根本没被加进去。即便如此这段也不是空壳 ——
 *   存续期语义完整且正确，M5 把 Σ 填上之后它立刻生效，不需要回头改这里。
 *   （另一条存续期 `while_source_alive` 的剥离时机是"source 死亡时"，
 *   落点在死亡结算而不是相位机，同属 M5。）
 */
export function stripEnchantments(state: GameState, duration: Duration): void {
  let changed = false;
  for (const key of Object.keys(state.entities)) {
    const entity = state.entities[Number(key)];
    if (entity === undefined || entity.enchantments.length === 0) {
      continue;
    }
    const kept = entity.enchantments.filter((ench) => ench.duration !== duration);
    if (kept.length !== entity.enchantments.length) {
      entity.enchantments = kept;
      changed = true;
    }
  }
  if (changed) {
    refreshAuras(state);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// mulligan（起手调度）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 起手调度：把选中的牌塞回牌库 → 洗牌 → 补抽同样张数（v2 §4.1 的 `mulligan` 相位）。
 *
 * 与 deploy 一样是**双方聚合后的单条 intent**（`toss[0]` / `toss[1]` 各是一方要换掉的牌）：
 * 两边都是**同时的秘密选择**，服务端收齐再喂进来，引擎保持单输入模型。
 * 这样也免掉了"先收谁的"这个只会泄露信息、又要额外状态字段记录的问题。
 *
 * 顺序写死 p0 → p1：洗牌**消耗 RNG**，随机流的推进顺序要进回放
 * （与 `create-game.ts` 的建局洗牌同一条理由）。
 *
 * ── ★ 全程不发任何事件 ★ ─────────────────────────────────────────────────
 * 起手牌与调度都属于**建局期的隐藏信息交换**，不是对局中的"抽牌"：
 * - 补抽若发 `card_drawn`，M5 的「每当你抽到一张牌」会在开局白白触发一轮 ——
 *   那是规则错误，不是表现层取舍；
 * - 客户端要看自己的新手牌，从投影后的**状态**里读就够了（M7），
 *   不需要事件流复述一遍。
 * 这与 `createGame` 发起手牌同样不发事件是同一条口径（见 `create-game.ts`）。
 */
function applyMulligan(
  state: GameState,
  toss: readonly [readonly number[], readonly number[]],
): null {
  for (const player of PLAYER_IDS) {
    const cards = toss[player];
    if (cards.length === 0) {
      continue;
    }
    for (const id of cards) {
      const card = getEntity(state, id);
      if (card === undefined) {
        continue;
      }
      moveToZone(state, card, player, "deck");
    }
    shuffleZone(state, player, "deck");
    for (let i = 0; i < cards.length; i += 1) {
      dealTop(state, player);
    }
  }
  state.phase = "round_start";
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 意图分发（`apply()` 的记账段）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 执行一条**已经校验通过**的意图的记账段，并把它要执行的动作压栈。
 *
 * 只改状态、发事件、压栈，**不跑结算**（那是 `apply()` 里紧接着的 `resolve()`）。
 * 校验在 `apply()` 里对**入参状态**做完，所以这里可以假定：相位对、玩家对、
 * 实体存在且在正确的区、格位可用、水晶够。这条分工让"被拒时状态一字不变"
 * 是结构性的 —— 被拒时连 `cloneState` 都还没发生。
 *
 * 走 {@link runStep}，与三个自动相位共用同一条「事件先排队、动作后入栈」的规矩。
 */
export function runIntentBookkeeping(
  state: GameState,
  intent: Exclude<Intent, { t: "respond" }>,
): void {
  runStep(state, () => bookkeepIntent(state, intent));
}

/** {@link runIntentBookkeeping} 的分发体：按意图类型改状态并交出要压栈的动作。 */
function bookkeepIntent(
  state: GameState,
  intent: Exclude<Intent, { t: "respond" }>,
): StepActs | null {
  switch (intent.t) {
    case "mulligan":
      return applyMulligan(state, intent.toss);
    case "deploy":
      return applyDeploy(state, intent.picks);
    case "play_card": {
      const card = getEntity(state, intent.card);
      // 校验已保证它存在；`getEntity` 的 `undefined` 分支不用 `!` 抹掉（本仓硬约束）。
      return card === undefined ? null : playCard(state, intent.player, card, intent.slot);
    }
    case "pass":
      return passAction(state, intent.player);
    case "concede":
      return concedeMatch(state, intent.player);
  }
}
