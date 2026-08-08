// 战斗的第 ②③④ 步 —— v2 §4.2「同时结算」的核心（M3 任务书第 5 项，以及第 6 项的落点）。
// 来源：DSL v2 §4.2（战斗五步）、《数值基准》§7（出手条件 `atk > 0 && !stunned`）、
//       DSL v2 §2.3（direction 是普通 Tag）、DSL v2 §3.2（board 按格序 0→8 枚举）、
//       DSL v2 §3.4（`act.strike` 内部走 `act.hit` 管线）、
//       框架 §4.1（六步流水线与四条时序规则）。
//
// 相位的**进出**在 `phase.ts` 的 `runCombat`：第 ① 步（`combat_began` + 把结算栈跑空）
// 与第 ⑤ 步（`end_of_combat` 剥离 + `combat_ended` + 转 round_end）都在那里。
// 本文件只负责中间三步：
//   ② {@link planStrikes}   快照：谁打谁、打多少，此后全部冻结
//   ③ {@link applyStrikes}  逐条应用，★ 不做中途死亡结算、★ 触发器只入栈不结算
//   ④ {@link settleCombat}  结算栈开闸 → 统一死亡 → 亡语 → 光环重算 → 循环至不动点
// 三步由 {@link resolveStrikes} 串起来，是本文件对外的唯一入口。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 最容易写错的地方：第 ③ 步那两个「不」★★★
// ═══════════════════════════════════════════════════════════════════════════
// 里程碑 M3 的原话：
// > 一旦在逐条应用中途做了死亡结算，同归于尽就不成立，整个战斗手感全变 ——
// > 而这个 bug 在随机对局里未必立刻显形。
//
// 「同归于尽」的全部机制就是：**快照在前、伤害全部落完、死亡才统一结算**。
// 先被打死的单位在第 ③ 步里仍然站在场上（只是 `damage >= tags.health`），
// 于是它照样打出自己那一击。中途判一次死，这条性质当场失效。
//
// 「触发器只入栈不结算」是同一条性质的另一半：本轮的触发器若在批次中途跑起来，
// 它可以加 buff、可以召唤、可以移动单位，于是**后面那些已经冻结的出手**会落在一个
// 变了的盘面上 —— 快照就白冻了。
//
// ── 这两个「不」各自被哪条测试钉着（任务书原话：不能靠 fuzz 兜）───────────────
//   第一个「不」（不做中途死亡结算）→ 「同归于尽」+「双亡平局」两条：它在 M3 的
//     两处可观测面分别是**事件顺序**与**base 归零判负的时刻**。
//   第二个「不」（触发器只入栈不结算）→ 「★ 触发器只入栈不结算」那一条。它必须经
//     {@link TriggerQueue} 塞一个**会真排队**的源进来才测得到：M5 之前排队恒 0 条，
//     把 {@link harvest} 挪到排队之后（= 批次中途就跑触发器）不改变任何可观测结果。
//   第 ④ 步的「开闸」→ 「★ 第 ④ 步给结算栈开闸」那一条（往主栈上摆一条站位触发器，
//     看它是不是**到第 ④ 步才**跑）。
// 另有一道**运行时哨兵** {@link assertFrozenAmount} 守第 ② 步的「记录后全部冻结」——
// 那一条在 M3 只有结构性论证，没有代码守着，理由与退役条件写在那个函数上。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 设计选择：**旁路管线**，而不是给 `resolve()` 加「抑制死亡结算」的模式 ★
// ═══════════════════════════════════════════════════════════════════════════
// 两条路都能实现第 ③ 步，取舍如下。
//
// 【选中】旁路管线（本文件的 {@link applyStrikes}）：自己弹一条**本地链条**，
//   逐条跑六步流水线，但跳过第 ⑤ 步，并且把 `queueTriggers` 压出来的东西**留在主栈上**。
//   代价：六步的**顺序**在本仓出现了第二处实现（另一处是 `resolve/resolve.ts`）。
//   缓解：本文件不自己实现任何一步，六步全部调 `resolve/` 导出的同名函数
//   （`bindContext` / `applyInterceptors` / `runHandler` / `queueTriggers` /
//   `processDeaths` / `refreshAuras`）。于是 M5 往那些函数里填真语义时，战斗自动跟上；
//   真正可能分叉的只剩「步骤顺序」这一件事，而它在 `resolve.ts` 的文件头里被
//   显式点名要求「改本文件前先读完四条时序规则」，那里也留了一行指回这里。
//
// 【放弃】给 `resolve()` 加模式开关：看起来"主管线不分叉"，但要做成需要**三个**旋钮，
//   而不是任务书设想的一个：
//     (a) 抑制第 ⑤ 步死亡结算；
//     (b) 跑到「本条链条跑完」就停，而不是跑到栈空 —— 否则会把同一批次里后面那些
//         还没应用的出手、以及刚排队的触发器一起弹掉；
//     (c) 弹栈时区分「本条链条的连锁」与「触发器」，前者要跑、后者要留。
//   三个旋钮加在整个引擎唯一的时序权威上，而且其中两个只有战斗一个调用方 ——
//   任何一个泄漏到别的调用点（M4 的求值器、M5 的拦截器、M9 的 server）都会静默地
//   改变时序，而时序 bug 恰恰是最难归因的一类（框架 §4.1 开篇）。
//   把这三条特殊性关在**只有战斗看得见**的一个文件里，比把它们做成公共 API 更安全。
//
// ═══════════════════════════════════════════════════════════════════════════
// 「本地链条」是怎么把连锁与触发器分开的
// ═══════════════════════════════════════════════════════════════════════════
// 一条 `act.strike` 在流水线里会往栈上放两类完全不同的东西：
//   1. **连锁**：handler 压的 `act.hit`（v2 §3.4：strike 内部走 hit 管线）、
//      以及 M5 拦截器命中后压的 `then` —— 它们是「这一击还没做完」的部分，属于第 ③ 步；
//   2. **触发器**：`queueTriggers` 压的条目 —— 它们是「这一击做完之后的反应」，属于第 ④ 步。
// 两类东西都落在同一个 `state.stack` 上，靠位置分不开。但它们的**产生时刻**是分开的：
// 连锁在 handler（第 ③ 步）里压，触发器在第 ④ 步压。于是只要在 handler 跑完、
// `queueTriggers` 之前把「新长出来的那一截」整段摘走（{@link harvest}），
// 分类就是精确的，不需要给栈条目加任何标记（那会污染 `PendingAction` 这个纯数据类型）。
//
// ═══════════════════════════════════════════════════════════════════════════
// ⚠ 战斗批次是**原子**的：第 ③ 步不检查 `pendingInput`
// ═══════════════════════════════════════════════════════════════════════════
// 一次挂起会把批次劈成两半，而「剩下的出手」没有地方存 —— 快照是本函数的局部变量，
// 不在 `GameState` 里，落盘之后就没了。
// M3 里这件事**结构性地不可能发生**：批次里只有 `act.strike` / `act.hit` 两个 handler，
// 两个都不挂起；拦截器与触发器都还没有源（M5），压不出会挂起的东西。
// 所以这里既不写 guard（写了也测不到，只会变成覆盖率噪声，同 `resolve/deaths.ts` 的取舍），
// 也不假装支持。**M5 若要让拦截器能挂起，必须先回答「战斗批次跨挂起点如何续跑」**——
// 那需要把剩余快照放进 `GameState`（于是它要被投影/回放/快照一路照顾到），
// 是一次有成本的设计变更，不是在这里补一个 `if` 能糊过去的。

import type { Act, EntityId } from "@prismfront/ir";
import type { GameEvent } from "../events/index.ts";
import { drainEventLog } from "../events/index.ts";
import type { ResolveDeps } from "../resolve/index.ts";
import {
  actOfPending,
  applyInterceptors,
  bindContext,
  isCancelled,
  MAX_RESOLUTION_DEPTH,
  processDeaths,
  pushAct,
  queueTriggers,
  ResolutionLoopError,
  refreshAuras,
  resolve,
  runHandler,
} from "../resolve/index.ts";
import type {
  CtxBindings,
  EntityData,
  GameState,
  PendingAction,
  PlayerId,
} from "../state/index.ts";
import {
  createCtx,
  entityAtSlot,
  getEntity,
  getSlots,
  hasFlag,
  opponentOf,
  playerData,
  withCtx,
} from "../state/index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// ② 快照（v2 §4.2 第 ② 步）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一条**已经冻结**的出手（v2 §4.2 第 ② 步的 `{attacker, target, amount}`）。
 *
 * 纯数据、全是 id 与数字：它是一个局部值（不进 `GameState`，见文件头的原子性说明），
 * 但保持纯数据形态让它可以直接进测试断言，也免得将来真要落盘时再改一遍形状。
 */
export interface PlannedStrike {
  /** 出手的单位。 */
  readonly attacker: EntityId;
  /** 挨打的实体：敌方对位格上的单位，或（越界/空格时）敌方 base。 */
  readonly target: EntityId;
  /**
   * 快照那一刻的**生效 atk**（v2 §4.2「记录后全部冻结」）。
   *
   * ⚠ IR v1 的 `act.strike` 是 `{op, attacker, target}`，**没有 `amount` 字段**
   *   （`ir/src/types/act.ts`），所以这个冻结值没法随动作一起压进栈 ——
   *   真正打出去的数值由 `handlers/damage.ts` 的 `strikeHandler` 在应用那一刻
   *   重新读 `attacker.tags.atk` 得到。两者在 M3 里**必然相等**，理由是结构性的：
   *   第 ③ 步不结算死亡、不跑触发器，`refreshAuras` 又只是从没变过的 `base` 重算，
   *   于是批次期间没有任何东西能改动 `tags.atk`。
   *   M5 若引入「能在批次中途改 atk 的拦截器」，这条论证就断了，那时必须二选一：
   *   给 IR 的 `act.strike` 加一个可选 `amount`（编写子集不开放，只进运行时超集），
   *   或者让战斗自己发 `struck` + 压冻结的 `act.hit`（代价是与 `strikeHandler` 分叉）。
   *   本字段先把「规范要求冻结」这件事记在类型里，并由 U2 的战斗测试直接断言。
   *
   *   ★ TODO(M5)：在那个二选一落地**之前**，这条不变量由 {@link assertFrozenAmount}
   *   那道**运行时哨兵**守着（`applyStrikes` 里，应用每条快照之前跑一次）——
   *   M3 里它恒真，M5 第一次引入「能在批次中途改 atk 的东西」时当场抛
   *   {@link StrikeAmountDriftError}。
   *   哨兵是**临时防线不是终局方案**：它只能让"冻结被破坏"这件事停下来，
   *   不能让那一击真的按冻结值打出去。M5 必须回到上面那个二选一挑一条
   *   （给 IR 的 `act.strike` 加可选 `amount` / 战斗自己发 `struck` + 压冻结的 `act.hit`），
   *   把冻结值真的送进管线，**然后把哨兵连同它的错误类一起删掉**。
   *   两处互相指认（那边也写着同一句），改一处请一起改。
   */
  readonly amount: number;
}

/**
 * 本回合的遍历顺序：**先手方在前**（v2 §4.2 第 ② 步的 `[initiative 方, 另一方]`）。
 *
 * 与 `phase.ts` 的 `roundOrder`（水晶与抽牌的顺序）、`resolve/triggers.ts` 的
 * `activePlayer`（非 actions 相位取 `initiative`）是**同一个基准** ——
 * 全引擎只用一种"谁排前面"的口径，比在不同地方各用一种少一整类时序疑问。
 *
 * 这里不 import `phase.ts` 的那一个：`phase.ts` 要 import 本文件（相位机调战斗），
 * 反过来再 import 就成了循环。两行的重复换掉一个模块环，值得；两处注释互相指认。
 */
function combatOrder(state: GameState): readonly [PlayerId, PlayerId] {
  return [state.initiative, opponentOf(state.initiative)];
}

/**
 * 战斗快照（v2 §4.2 第 ② 步）：按 `[initiative 方 0→8, 另一方 0→8]` 遍历，记下每一击。
 *
 * ── 出手条件：`atk > 0 && !stunned` ───────────────────────────────────────
 * `atk > 0` 来自 v2 §4.2；`!stunned` 是《数值基准》§7 的增补（滞光 = 本轮不出手）。
 * 两个都读**生效值**：`tags.atk` 与 `flags`（不是 `base` / `baseFlags`）——
 * 于是「本回合 -2 atk」的附魔、「使敌方全体滞光」的光环（M5）自动生效，
 * 这里一行特判都不用写。
 *
 * ── ★ 第 6 项：direction 是普通 Tag，读 `tags.direction` ★ ────────────────
 * 目标格 = **自己格 + 生效 direction**，落在敌方那一行。生效值同样是
 * `base.direction + Σ附魔 + Σ光环`（M5 把两个 Σ 填上，`resolve/auras.ts`），
 * 与 atk/health 走**完全同一套**管线。
 * 于是这三件事全部是免费获得的，本文件**没有一行 direction 的特判**：
 *   - 沉默自动重置方向（`act.silence` 把 `tags` 复位到 `base`）；
 *   - 光环批量改方向（Σ光环 里加一个 `direction: +1`）；
 *   - `num.attr(of, "direction")` 可读（`state/queries.ts` 的 `tagOf`）。
 * **direction 允许为负、不限幅**：不 clamp、不取模 —— 越界的结果不是"绕回来"，
 * 而是打进敌方基地（下一段），这正是 v2 §4.2 想要的语义。
 *
 * ── 越界或空 → 敌方基地 ──────────────────────────────────────────────────
 * `entityAtSlot` 对**无效槽**（越界/非整数）与**空格**都返回 `undefined`
 * （`state/queries.ts`：在"取不到实体"这一点上两者同义），而 v2 §4.2 对这两种情况的
 * 规定也恰好相同，于是一次判断就够，不需要把三态拆开。
 *
 * 只扫 `state.slots`：base 不占格，因此**base 不出手**（它只挨打，v2.1 §11.2）；
 * 手牌与墓地里的实体自然也扫不到。
 */
export function planStrikes(state: GameState): PlannedStrike[] {
  const plan: PlannedStrike[] = [];
  for (const player of combatOrder(state)) {
    const enemy = opponentOf(player);
    const row = getSlots(state, player);
    for (let index = 0; index < row.length; index += 1) {
      const id = row[index];
      // 三态：`undefined` = 无效槽、`null` = 空格、其余 = 有人占（v2 §3.1）。
      if (id === null || id === undefined) {
        continue;
      }
      const attacker = getEntity(state, id);
      if (attacker === undefined) {
        continue;
      }
      const amount = attacker.tags.atk;
      if (amount <= 0 || hasFlag(attacker, "stunned")) {
        continue;
      }
      plan.push({ attacker: id, target: combatTargetOf(state, attacker, index, enemy), amount });
    }
  }
  return plan;
}

/** 一次出手的目标：敌方行的「自己格 + 生效 direction」；越界或空 → 敌方 base。 */
function combatTargetOf(
  state: GameState,
  attacker: EntityData,
  index: number,
  enemy: PlayerId,
): EntityId {
  const facing = entityAtSlot(state, enemy, index + attacker.tags.direction);
  return facing === undefined ? playerData(state, enemy).baseId : facing.id;
}

// ═══════════════════════════════════════════════════════════════════════════
// ③ 逐条应用（v2 §4.2 第 ③ 步）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 应用一条快照时，攻击者的**生效 atk 已经不等于快照冻结的那个数**（v2 §4.2 第 ② 步）。
 *
 * 形态与理念照抄 `resolve/resolve.ts` 的 `ResolutionLoopError`：
 * 它**不是「非法意图」**（那一类由 `apply()` 回 `ok:false` 的原因码），
 * 而是**引擎 / 卡牌数据的 bug**。吞掉它只会让房间带着一个坏状态继续跑 ——
 * 快照说这一击是 3、真打出去 9，两个数字都"看起来挺合理"，
 * 于是它会以「很久以后某局对战的伤害对不上」的形式才被发现。
 *
 * 抛错前把事件日志排空并挂在 {@link events} 上：`events/log.ts` 定死了
 * 「`apply()` / `resume()` 返回时 `state.eventLog` 必为空」这条不变量，
 * **抛错路径也不例外**（同 `ResolutionLoopError`）。
 *
 * 注意 `state` **不会**被回滚：引擎不做事务。M9 的 server 撞上它应当丢弃这份状态
 * 并从上一个快照恢复，而不是接着用。
 */
export class StrikeAmountDriftError extends Error {
  /** 那条快照的出手者。 */
  readonly attacker: EntityId;
  /** 第 ② 步冻结下来的数值。 */
  readonly frozen: number;
  /** 应用那一刻的生效 atk；`undefined` = 攻击者已经不在实体表里（同样是违约）。 */
  readonly actual: number | undefined;
  /** 抛错前排空的事件（见类说明）。 */
  readonly events: readonly GameEvent[];

  constructor(
    attacker: EntityId,
    frozen: number,
    actual: number | undefined,
    events: readonly GameEvent[],
  ) {
    super(
      `快照冻结的出手数值在批次中途被改动：攻击者 ${attacker} 冻结 ${frozen}、` +
        `应用时是 ${actual}（v2 §4.2 第 ② 步「记录后全部冻结」）`,
    );
    this.name = "StrikeAmountDriftError";
    this.attacker = attacker;
    this.frozen = frozen;
    this.actual = actual;
    this.events = events;
  }
}

/**
 * ★ 运行时哨兵：应用一条快照**之前**，确认攻击者的生效 atk 仍等于冻结的那个数。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────────
 * {@link PlannedStrike.amount} 讲了 M3 的现状：冻结值**没法**随 `act.strike` 一起压进栈
 * （IR v1 的 `act.strike` 没有 `amount` 字段），真正打出去的数由 `handlers/damage.ts`
 * 的 `strikeHandler` 在应用那一刻重读 `attacker.tags.atk`。两者在 M3 里必然相等，
 * 但那是一条**结构性论证**（第 ③ 步不结算死亡、不跑触发器，`refreshAuras` 又只从
 * 没变过的 `base` 重算），不是一行代码。论证没有防线：M5 往拦截器 / 触发器里填真语义的
 * 那一天，它会**静默**失效，而失效的表现只是"伤害数字变了一点"。
 *
 * ── 为什么是哨兵，而不是一条留红的测试 ────────────────────────────────────
 * 留红抓不到它要抓的事：实现今天就不冻结，所以 M5 破坏之前它红、之后**还是红** ——
 * 它唯一能产生的跃迁是 red→green，而不是"M5 破坏时大声红掉"。
 * 而代价是整套测试恒 exit 1（`.github/workflows/ci.yml` 的 `turbo test` 是必过步骤），
 * 从那个提交起没人能再拿"测试绿"当闸门：新引入的真回归只会表现为「还是红」。
 * 哨兵把两件事都反过来：
 *   - **M3 里它恒真** ⇒ 全套测试转绿，CI 的信号恢复；
 *   - **M5 一旦引入能在批次中途改 atk 的拦截器 / 触发器，第一次跑就当场抛** ⇒
 *     这才是被要求的"大声红掉"，而且它把「M5 弄坏了冻结」与「M3 的已知状态」分得开。
 *
 * ── 为什么不顺手把实现改对 ───────────────────────────────────────────────
 * 另外两条路现在付代价、却拿不到收益：给 IR 的 `act.strike` 加可选 `amount` 要 bump
 * `irVersion` 并牵动 M11 的色轮 lint（而 M3 不碰 `packages/ir`）；让战斗自己发 `struck`
 * + 压一条冻结的 `act.hit`，则丢掉 `act.strike` 这一层拦截点（M5 的圣盾 / 减伤 /
 * 「改为…」要能拦在那里，v2 §3.4），并与 `strikeHandler` 分叉出第二份出手实现。
 * 哨兵一行都不碰 IR，也不分叉。
 *
 * ── ⚠ 临时防线，不是终局方案 ─────────────────────────────────────────────
 * 它只能**让坏掉的批次停下来**，不能让那一击按冻结值打出去。M5 必须回到
 * {@link PlannedStrike.amount} 的 TODO(M5) 二选一里挑一条，把冻结值真的送进管线，
 * **然后把本函数与 {@link StrikeAmountDriftError} 一起删掉**。两处互相指认。
 *
 * 攻击者**取不到实体**（`undefined`）同样判违约：M3 里它不可能发生（第 ③ 步不结算死亡，
 * 而 `getEntity` 不管实体在哪个区），真发生了也说明有人在批次中途动了实体表 ——
 * 与 atk 被改是同一类故障，不值得为它分出第二个错误类。
 */
function assertFrozenAmount(state: GameState, planned: PlannedStrike): void {
  const actual = getEntity(state, planned.attacker)?.tags.atk;
  if (actual !== planned.amount) {
    throw new StrikeAmountDriftError(
      planned.attacker,
      planned.amount,
      actual,
      drainEventLog(state),
    );
  }
}

/** 一条快照对应的动作节点（IR v1 §5.6 的运行时超集：引擎自造，目标用 `sel.entity` 冻结）。 */
function strikeActOf(planned: PlannedStrike): Act {
  return {
    op: "act.strike",
    attacker: { op: "sel.entity", id: planned.attacker },
    target: { op: "sel.entity", id: planned.target },
  };
}

/**
 * 一条快照的上下文：SELF = 出手者，TARGET = 快照钉住的那个目标。
 *
 * 绑 `target` 而不是只绑 `self`（`testkit` 的 `strikeNow` 只绑了 self）：战斗出手的目标
 * 是**快照定下来**的，把它写进上下文，M5 的拦截器与触发器就能用 `sel.target`
 * 读到"这一击本来要打谁"。`strikeHandler` 随后压 `act.hit` 时会再覆盖一次，两者一致。
 */
function strikeCtxOf(planned: PlannedStrike): CtxBindings {
  return withCtx(createCtx(planned.attacker), { target: planned.target });
}

/**
 * 把主栈上 `floor` 之上**新长出来的那一截**整段摘到本地链条（保持栈序）。
 *
 * 见文件头「本地链条是怎么把连锁与触发器分开的」：摘的时机决定了分类，
 * 所以调用点只有两处，都紧贴在 handler 跑完之后、{@link TriggerQueue} 之前。
 */
function harvest(state: GameState, floor: number, chain: PendingAction[]): void {
  for (const item of state.stack.splice(floor)) {
    chain.push(item);
  }
}

/**
 * 第 ③ 步「事件 → 触发器排队」的接线。生产恒为 `resolve/triggers.ts` 的 `queueTriggers`
 * （{@link resolveStrikes} 的默认值），签名与它逐字相同：返回入栈条目数。
 *
 * ── ★ 为什么它是一个参数 ★ ───────────────────────────────────────────────
 * 第 ③ 步的第二个「不」（**触发器只入栈不结算**）在 M3 是**不可观测**的：
 * `collectTriggerSubscriptions` 恒返回空（匹配是 M5），于是排队恒 0 条 ——
 * 把 {@link harvest} 挪到排队**之后**（等价于"批次中途就把触发器跑了"）会得到
 * 逐字相同的事件流与状态。一条只靠注释守着的时序规则，正是文件头说的
 * "最容易写错的地方"，而 M3 任务书对这两个「不」的要求是
 * **必须有独立测试、不能靠 fuzz 兜**。
 * 做成参数，测试就能塞一个**会真排队**的源进来，把「先摘连锁、后排触发器」这个顺序
 * 钉死（`rules/__tests__/combat.test.ts` 的「★ 触发器只入栈不结算」）。
 *
 * 这与 `resolve/deps.ts` 把 handler 表做成注入是同一条理由的延伸：**引擎的外部接线
 * 一律显式传入，不做模块级注册表**（框架 §3.2）。但它**没有**进 `ResolveDeps` ——
 * 同文件头「把只有战斗看得见的特殊性关在一个文件里，比做成公共 API 更安全」的取舍：
 * `resolve()` 的第 ④ 步不需要这个旋钮，就不该为战斗多长一个。
 *
 * M5 有了真触发器源之后，那条测试可以换成真触发器，本参数即可退役。
 */
export type TriggerQueue = (state: GameState, events: readonly GameEvent[]) => number;

/**
 * 第 ③ 步：把快照逐条应用出去，走 `act.strike` → `act.hit` 管线。
 *
 * 每条快照跑一条**本地链条**（LIFO，与主栈同构），链条上的每一步都跑
 * 框架 §4.1 的六步流水线，只有两处偏离，且两处都是 v2 §4.2 明文要求的：
 *   ★ **跳过第 ⑤ 步死亡结算** —— 同归于尽的全部原因；
 *   ★ **第 ④ 步排出来的触发器留在主栈上** —— 只入栈不结算，等第 ④ 步开闸。
 *
 * `state.winner` 与 `state.pendingInput` 在本步都不可能变：判负只在 `processDeaths`
 * 里发生（已跳过），挂起在 M3 里没有源（见文件头的原子性说明）。
 *
 * 步数上限与 `resolve()` 同源（IR v1 §7：单次结算栈深度 256），计的同样是**弹栈次数**，
 * 跨整个批次累计 —— 一整轮战斗满打满算 18 击 × 2 步 = 36，离 256 很远；
 * 真撞上它就说明拦截器链成了环（M5），那与 `resolve()` 里那一条是同一类故障，
 * 所以复用同一个异常。抛错前排空事件日志（`events/log.ts` 的不变量对抛错路径同样成立），
 * 但**只带得走日志里还剩的那一批**：第 ① 步已经排空过一次，那批事件在 `phase.ts` 手里。
 *
 * `queue` 是第 ④ 步排队的接线（见 {@link TriggerQueue}），生产恒为 `queueTriggers`。
 */
function applyStrikes(
  state: GameState,
  plan: readonly PlannedStrike[],
  deps: ResolveDeps,
  queue: TriggerQueue,
): void {
  let guard = 0;
  for (const planned of plan) {
    // ★ 运行时哨兵：这一击的冻结值必须仍然等于攻击者的生效 atk（见 assertFrozenAmount）。
    //   M3 里恒真；M5 引入"能在批次中途改 atk 的东西"时它会当场抛。
    assertFrozenAmount(state, planned);

    // 用 `pushAct` 造条目再整段摘下来 —— 栈条目的构造只有 `resolve/push.ts` 一处，
    // 本文件不自己写 `{ via: "inline", ... }` 字面量。
    const chain: PendingAction[] = [];
    const seed = state.stack.length;
    pushAct(state, strikeActOf(planned), strikeCtxOf(planned));
    harvest(state, seed, chain);

    while (chain.length > 0) {
      guard += 1;
      if (guard > MAX_RESOLUTION_DEPTH) {
        throw new ResolutionLoopError(MAX_RESOLUTION_DEPTH, drainEventLog(state));
      }
      const pending = chain.pop();
      // `pop()` 的 `undefined` 在 `chain.length > 0` 下不可能出现，但不用 `!` 抹掉。
      if (pending === undefined) {
        break;
      }

      // ① 绑定上下文
      const ctx = bindContext(state, pending);
      const act = actOfPending(state, pending, deps);
      if (act === null) {
        continue;
      }

      // 这一步自己压出来的东西全部落在 `floor` 之上，摘走它们即得本击的连锁。
      const floor = state.stack.length;

      // ② 替换效果（圣盾、免疫、"改为…"，M5）
      const action = applyInterceptors(state, ctx, act);
      if (isCancelled(action)) {
        // 被取消 ≠ 什么都没发生：拦截器的 `then` 照样执行（IR v1 §4.2），
        // 它属于"这一击"的连锁，收进链条继续跑；第 ④~⑥ 步与 `resolve()` 一样跳过。
        harvest(state, floor, chain);
        continue;
      }

      // ③ 执行，产出事件
      const mark = state.eventLog.length;
      runHandler(state, ctx, action, deps.handlers);
      harvest(state, floor, chain);

      // ④ 事后触发：★ 只入栈不结算 —— 压在主栈上，留给第 ④ 步开闸
      //   ⚠ 必须排在上面那次 `harvest` **之后**：反过来的话这一批刚排队的触发器会被
      //     一起摘进本地链条，等于批次中途就把它们跑了（见 {@link TriggerQueue}）。
      queue(state, state.eventLog.slice(mark));

      // ⑤ ★★ 死亡结算在本步被**跳过** ★★（v2 §4.2 第 ③ 步，见文件头）

      // ⑥ 光环重算（时序规则 4：每步重算，不做增量）
      refreshAuras(state);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ④ 结算栈开闸（v2 §4.2 第 ④ 步）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 第 ④ 步：统一死亡 → 亡语 → 光环重算 → 循环至不动点。
 *
 * 三段，顺序即规范原文：
 * 1. `processDeaths` —— 本轮**所有**致死单位一次性收走（批量 + 波次不动点，时序规则 3），
 *    并在末尾做 base 归零判负（v2 §4.1「任意时刻」）。同归于尽在这里成立：
 *    第 ③ 步没人离场，所以互相打死的两个单位在**同一波**里被收走。
 * 2. `refreshAuras` —— 一波单位离场会让依附它们的光环失效，按六步顺序补上这一步。
 * 3. `resolve()` —— **开闸**：第 ③ 步排在主栈上的触发器、以及 `processDeaths` 排出来的
 *    亡语，从这里开始跑。它们每弹一条都带自己的第 ⑤ 步死亡结算，
 *    于是"亡语又打死了人"会自然地再收一轮 —— 这就是"循环至不动点"，
 *    不需要在这里另写一个外层循环（写了反而与 `resolve()` 的不动点语义重复）。
 *
 * 返回这一段排空的事件流（`resolve()` 的返回值）。
 *
 * ⚠ 第 3 段那次 `resolve()` 是**开闸本身**，删掉它整个第 ③ 步排上主栈的东西就永远不跑。
 *   `processDeaths` 那一环有 5 条测试钉着，开闸这一环单独钉在
 *   `rules/__tests__/combat.test.ts` 的「★ 第 ④ 步给结算栈开闸」上 ——
 *   M3 没有真触发器源，所以那条测试直接往主栈上摆一条站位条目。
 */
function settleCombat(state: GameState, deps: ResolveDeps): GameEvent[] {
  processDeaths(state);
  refreshAuras(state);
  return resolve(state, deps);
}

// ═══════════════════════════════════════════════════════════════════════════
// 对外入口
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 战斗的第 ②③④ 步：快照 → 逐条应用 → 统一死亡（v2 §4.2）。
 *
 * 由 `phase.ts` 的 `runCombat` 在 `combat_began`（第 ① 步，含"结算栈完全清空"）之后、
 * `combat_ended`（第 ⑤ 步）之前调用一次。返回这一段排空的事件流。
 *
 * 调用之后 `state.winner` 可能已经非空（战斗打穿了 base）——
 * 调用方必须先判它再决定要不要继续走第 ⑤ 步（`resolve/resolve.ts` 的偏离 B 同款理由：
 * 对局结束之后不该再有后续时序）。
 *
 * `queue` 只有测试会传（见 {@link TriggerQueue}）：生产恒走默认值 `queueTriggers`，
 * `phase.ts` 的 `runCombat` 也只传两个参数。
 */
export function resolveStrikes(
  state: GameState,
  deps: ResolveDeps,
  queue: TriggerQueue = queueTriggers,
): GameEvent[] {
  const plan = planStrikes(state);
  applyStrikes(state, plan, deps, queue);
  return settleCombat(state, deps);
}
