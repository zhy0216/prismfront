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
//   第二个「不」（触发器只入栈不结算）→ 「★ 触发器只入栈不结算」那一条。
//     ★ M3 时它需要一个 `TriggerQueue` 参数往第 ③ 步塞一个"会真排队"的桩源，因为那时
//     `collectTriggerSubscriptions` 恒返回空、排队恒 0 条，把 {@link harvest} 挪到排队之后
//     不改变任何可观测结果。**M5/T1 落地后那个参数已经退役**：测试改用一张真触发器卡
//     （`on:"damaged"` + `act.draw`，经 `deps.scripts` 注入），断言一字未改。
//     于是第 ③ 步的排队现在**只有一条路径**，不再有"生产走一条、测试走另一条"的分叉。
//   ★ 第 ③ 步的**跨批次触发顺序**→ 三条，各钉一半，别混为一谈：
//     a.「★ 跨批次的累积顺序」两条 —— 整批的累积序**没有被 LIFO 反转**（= 字典序的
//        外层键：事件发出序）。⚠ 这两条的卡都带 `filter: {source: SELF}`，每批只有
//        一个订阅者，**走不到**时序规则 1 的排序键（实测四种排序键注入 —— side 级反转、
//        playOrder 级反转、`activePlayer` 翻面、`sortTriggers` 退化成恒等 —— 它们全绿）。
//     b.「★ 时序规则 1：一击命中三个宿主」一条 —— 三个**不带 filter** 的宿主落在同一批，
//        这才是排序键（内层键）在战斗路径上的防线。
//     c.「★ 匹配不能推迟到批次末尾」一条 —— 逐击**匹配**读的是那一刻的盘面。
//     三者与上面那个「不」是**不同的事**：那一条管的是触发器有没有在批次中途跑起来。
//     a/c 由 {@link applyStrikes} 里相邻的两件事各自兑现（`harvest` 的位置 /
//     入栈推迟到整批之后 / 匹配留在循环里），见那个函数的注释。
//   第 ④ 步的「开闸」→ 「★ 第 ④ 步给结算栈开闸」那一条（往主栈上摆一条站位触发器，
//     看它是不是**到第 ④ 步才**跑）。
//   第 ② 步的「记录后全部冻结」→ 见 {@link PlannedStrike.amount}：M5/T5 起冻结值
//     **随动作走完管线**（`act.strike.amount`），不再是一条只靠论证成立的等式。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 设计选择：**旁路管线**，而不是给 `resolve()` 加「抑制死亡结算」的模式 ★
// ═══════════════════════════════════════════════════════════════════════════
// 两条路都能实现第 ③ 步，取舍如下。
//
// 【选中】旁路管线（本文件的 {@link applyStrikes}）：自己弹一条**本地链条**，
//   逐条跑六步流水线，但跳过第 ⑤ 步，并且把第 ④ 步排出来的触发器攒到整批结束
//   才压上主栈（留给第 ④ 步开闸）。
//   代价：六步的**顺序**在本仓出现了第二处实现（另一处是 `resolve/resolve.ts`）。
//   缓解：本文件不自己实现任何一步，六步全部调 `resolve/` 导出的同名函数
//   （`bindContext` / `applyInterceptors` / `runHandler` / `collectOrderedTriggers` +
//   `enqueueTriggers` / `processDeaths` / `refreshAuras`）。
//   于是 M5 往那些函数里填真语义时，战斗自动跟上；
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
//   2. **触发器**：第 ④ 步排出来的条目 —— 它们是「这一击做完之后的反应」。
// 两类东西本来会落在同一个 `state.stack` 上，靠位置分不开。但它们的**产生时刻**是分开的：
// 连锁在 handler（第 ③ 步）里压，触发器在第 ④ 步产出。于是只要在 handler 跑完、
// 第 ④ 步之前把「新长出来的那一截」整段摘走（{@link harvest}），分类就是精确的，
// 不需要给栈条目加任何标记（那会污染 `PendingAction` 这个纯数据类型）。
// 第 ④ 步本身则连主栈都不碰：它把有序条目攒进一个局部数组，整批结束才一次性入栈
// （跨批次顺序的理由见 {@link applyStrikes}），于是这两类东西在批次期间根本不在同一个容器里。
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
//
// ── M5/T2（拦截器落地）之后这条约束的状态：**仍然成立** ──────────────────────
// 四种 `effect`（`cancel` / `set_field` / `mod_field` / `retarget`）都只改写动作节点，
// 一个都不挂起；`then` 是**入栈**的，`applyInterceptors` 返回时还没执行
// （在这里它被下面那次 `harvest` 收进本地链条，随后照常逐条跑六步）。
// ⚠ 唯一能打破它的写法是**把会挂起的动作写进 `intercept.then`**
//   （`act.select_target` / `act.discover`）：那样批次会带着一个已置位的 `pendingInput`
//   继续跑完。在 L3 补上「`intercept.then` 不得含挂起点」之前，这是一条**写卡约束**，
//   两处注释互相指认（另一处在 `resolve/interceptors.ts` 文件头的「边界」一节）。
//
// ── 顺带：拦截器**能**改批次中途的 atk，只是不经 `effect` 那条路 ────────────
// 四种 `effect` 改的都是**动作**（`act.hit.amount` 之类），不碰攻击者的 `tags.atk`；
// 但 `then` 是一串普通动作，`act.mod_tag(atk)` / `act.buff` 写进去就能改**尚未出手**
// 那一方的 atk，而 `then` 正是在本文件的本地链条里跑的（见下面 `applyStrikes`）。
// 光环那一支还要更隐蔽：`refreshAuras` 每一步都跑，一条 `cond` 依赖盘面的光环
// （例如「我还活着时友军 +2 攻」，判据 `cond.dead` = 血量归零而**不问在不在场**）
// 会在宿主中途被打成致死的那一刻整条失效 —— 一张动作都没执行，atk 就变了。
// 两条路 M5 都实测踩到过，各有一条测试：光环那一支在 `__tests__/combat.test.ts`
// （「★ 光环在批次中途失效」），拦截器那一支在 `resolve/__tests__/auras.test.ts`
// （「★ 批次中途挂上加攻附魔」）。触发器那一支**踩不到**（第 ③ 步只入栈不结算）。
// **这不再是故障**：M5/T5 起冻结值随 `act.strike.amount` 走完管线，
// 批次中途的 atk 变化影响的是**下一轮**的快照，而不是这一轮已经冻结的出手。

import type { Act, EntityId } from "@prismfront/ir";
import type { GameEvent } from "../events/index.ts";
import { drainEventLog } from "../events/index.ts";
import type { QueuedTrigger, ResolveDeps } from "../resolve/index.ts";
import {
  actOfPending,
  applyInterceptors,
  bindContext,
  collectOrderedTriggers,
  enqueueTriggers,
  isCancelled,
  MAX_RESOLUTION_DEPTH,
  processDeaths,
  pushAct,
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
   * ★ 这个数**真的会被打出去**：{@link strikeActOf} 把它填进 `act.strike.amount`，
   * `handlers/damage.ts` 的 `strikeHandler` 直接用（IR §5.6 的运行时超集字段，
   * irVersion 2.3.0，M5/T5 加的）。所以「冻结」在本仓是一条**有落点的实现**，
   * 不是一句注释里的承诺。
   *
   * ── M3 → M5 这条路上发生了什么（别再走回去）─────────────────────────────
   * M3 时 IR 的 `act.strike` 只有 `{op, attacker, target}`，冻结值没法随动作压进栈，
   * 真打出去的数由 `strikeHandler` 在应用那一刻重读 `attacker.tags.atk`。
   * 两者在 M3 **恒相等**，但那是一条**结构性论证**（第 ③ 步不结算死亡、不跑触发器，
   * `refreshAuras` 又只从没变过的 `base` 重算），M3 为它留了一道运行时哨兵兜底。
   * M5 把三分体系接上之后，论证的两个前提都塌了，**实测**两条路径都能在批次中途改 atk：
   *   1. **拦截器的 `then`**（T2）—— `then` 入栈后被 `harvest` 收进本地链条，
   *      在这一批出手里就跑；`act.mod_tag(atk)` / `act.buff` 写在那里即可；
   *   2. **光环重算**（T3）—— 第 ⑥ 步逐击都跑 `refreshAuras`，一条 `cond` 依赖盘面的
   *      光环（「我还活着时友军 +2 攻」，`cond.dead` 判的是血量归零、不问在不在场）
   *      会在宿主被打成致死的那一刻整条失效。这一支**一个动作都没执行**。
   * 触发器（T1）不在其中：第 ③ 步只匹配、只排序，入栈推迟到整批之后，
   * 它改不了批次中途的盘面 —— 这一条**也实测过**（一张 `on:"struck"` 自加攻的卡跑完
   * 整局，当时那道哨兵一次都没响）。它的效果落在第 ④ 步之后，于是被下一轮的快照读到，
   * 由 `__tests__/combat.test.ts` 的「★ 冻结只冻这一轮」正面钉住。
   *
   * ── 为什么选「给 IR 加字段」而不是「战斗自己发 struck + 压冻结的 act.hit」──
   * 后者会丢掉 `act.strike` 这一层拦截点（v2 §3.4 明写"拦截器两处都能拦"，圣盾 /
   * 减伤 / "改为…"要能拦在那里），并与 `strikeHandler` 分叉出第二份出手实现。
   * 前者在 M3 唯一的代价是「要 bump `irVersion`，而 M3 不碰 `packages/ir`」——
   * 那是一条里程碑边界，M5 已经不受它约束（M4 加 `cond.has_color` 走的就是同一套动作）。
   * 加的字段编写子集**不开放**（`builder` 的 `Strike` 恒两参、L3 待 M11 补禁令），
   * 于是既有 bundle 一字未变，版本按 minor 记（论证在 `ir/src/types/ir-version.ts`）。
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
 * 一条快照对应的动作节点 —— 三个字段**全部冻结**（IR v1 §5.6 的运行时超集：引擎自造）。
 *
 * `attacker` / `target` 冻成 `sel.entity`，`amount` 冻成字面量。
 * 这三行就是 v2 §4.2 第 ② 步「记录后列表与数值全部冻结」的**全部落点**：
 * `handlers/damage.ts` 的 `strikeHandler` 拿到 `amount` 就直接用，不再回头读
 * `attacker.tags.atk` —— 于是拦截器 `then` 改攻、光环中途失效都改不了这一击
 * （两条路径与它们的历史见 {@link PlannedStrike.amount}）。
 *
 * ⚠ 删掉 `amount` 这一行**不会有任何类型错误**（IR 里它是可选字段，`tsc --noEmit`
 *   实测通过），行为静默退回"应用那一刻重读 atk"。所以钉住它的只有测试 ——
 *   实测删掉这一行**恰好红 4 条**：
 *     `rules/__tests__/combat.test.ts`       「★ 批次中途改 atk」「★ 光环在批次中途失效」
 *     `resolve/__tests__/auras.test.ts`      「★ 批次中途挂上加攻附魔」
 *     `resolve/__tests__/interceptors.test.ts`「★ 拦 act.strike 的 amount」
 */
function strikeActOf(planned: PlannedStrike): Act {
  return {
    op: "act.strike",
    attacker: { op: "sel.entity", id: planned.attacker },
    target: { op: "sel.entity", id: planned.target },
    amount: planned.amount,
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
 * 所以调用点只有两处，都紧贴在 handler（或被取消时的拦截器）跑完之后、第 ④ 步之前。
 */
function harvest(state: GameState, floor: number, chain: PendingAction[]): void {
  for (const item of state.stack.splice(floor)) {
    chain.push(item);
  }
}

/**
 * 第 ③ 步：把快照逐条应用出去，走 `act.strike` → `act.hit` 管线。
 *
 * 每条快照跑一条**本地链条**（LIFO，与主栈同构），链条上的每一步都跑
 * 框架 §4.1 的六步流水线，只有两处偏离，且两处都是 v2 §4.2 明文要求的：
 *   ★ **跳过第 ⑤ 步死亡结算** —— 同归于尽的全部原因；
 *   ★ **第 ④ 步排出来的触发器留在主栈上** —— 只入栈不结算，等第 ④ 步开闸。
 *
 * ── ★ 跨批次顺序：整批只入栈**一次** ★ ──────────────────────────────────
 * 第二处偏离有一个不显眼但决定性的细节：**入栈的时机**。栈是 LIFO，`queueTriggers`
 * 每调一次就压一次 ⇒ **后压的那一批先跑**。而本函数在开闸之前会经历一整批出手，
 * 逐击调 `queueTriggers` 的写法于是让整场战斗的触发器按**逆因果序**结算 ——
 * 后出手的单位的触发器先响，整段倒过来（这正是本条修复的缺陷，两条测试见
 * `rules/__tests__/combat.test.ts` 的「★ 跨批次的累积顺序」）。
 * 同一个缺陷在 `resolve/deaths.ts` 的不动点循环上还有第二个实例（逐**波**入栈），
 * 那里用的是逐字相同的修法。
 *
 * 所以第 ④ 步在这里拆成两半：逐击调 {@link collectOrderedTriggers}（**只匹配、只排序**）
 * 把有序条目累积到 `queued`，循环跑完之后调一次 {@link enqueueTriggers}。
 * 最终顺序 = 「事件发出序为外层键、时序规则 1 为内层键」的字典序，
 * 也正是 `resolve/triggers.ts` 的 `queueTriggers` 声明的那条不变量。
 * ⚠ 上面那两条测试只钉住**外层键**（它们的卡带 `filter: {source: SELF}`，每批单元素）；
 *   内层键在战斗路径上由「★ 时序规则 1：一击命中三个宿主」那一条钉住。
 *
 * ⚠ **匹配不能跟着一起推迟**：`collectOrderedTriggers` 的 `zone` / `once` /
 *   `filter` / `cond` 与排序键读的都是**当前状态**。整批打完再匹配 = 拿最终盘面去判，
 *   `cond` 会看到后面几击的伤害。逐击匹配保住的正是「匹配时看到的世界」。
 *   这一条**有测试钉着**：「★ 匹配不能推迟到批次末尾」——`cond: cond.dead(靶子)` 的
 *   一对互斥触发器，逐击匹配读到 [5, 5, 9]，整批末尾匹配读到 [9, 9, 9]。
 *   （那条防线只能靠"血量"立起来：**死亡不会改变 `zone`** —— 第 ③ 步跳过死亡结算，
 *   中途被打死的单位仍站在场上，所以"中途死掉的订阅者整条消失"在战斗里不会发生。
 *   那是死亡结算那条路径上的形态，见 `resolve/deaths.ts`。）
 *
 * ⚠ 中途抛错（`ResolutionLoopError` / 拦截器那两个异常）时 `queued` 里已经攒下的条目
 *   **不会入栈** —— 与那些异常的既有契约一致：那份 `state` 是半跑的，本来就该被丢弃，
 *   不该拿去接着跑。（走 `apply()` 的一方丢的是 draft，**入参状态一字未改**，
 *   不必"从快照恢复"—— 权威表述见 `resolve/resolve.ts` 的 `ResolutionLoopError`。）
 *
 * `state.winner` 与 `state.pendingInput` 在本步都不可能变：判负只在 `processDeaths`
 * 里发生（已跳过），挂起在 M3 里没有源（见文件头的原子性说明）。
 *
 * 步数上限与 `resolve()` 同源（IR v1 §7：单次结算栈深度 256），计的同样是**弹栈次数**，
 * 跨整个批次累计 —— 一整轮战斗满打满算 18 击 × 2 步 = 36，离 256 很远；
 * 真撞上它就说明拦截器链成了环（M5），那与 `resolve()` 里那一条是同一类故障，
 * 所以复用同一个异常。抛错前排空事件日志（`events/log.ts` 的不变量对抛错路径同样成立），
 * 但**只带得走日志里还剩的那一批**：第 ① 步已经排空过一次，那批事件在 `phase.ts` 手里。
 */
function applyStrikes(state: GameState, plan: readonly PlannedStrike[], deps: ResolveDeps): void {
  let guard = 0;
  // ★ 整批出手排出来的触发器**先攒在这里**，循环跑完才一次性入栈（见下面 ④ 与函数注释）。
  const queued: QueuedTrigger[] = [];
  for (const planned of plan) {
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

      // ② 替换效果（圣盾、免疫、"改为…"）★ M5/T2 起是真实现
      //   ⚠ 拦 `act.hit` 对战斗同样生效：出手在第 ③ 步里走的是
      //     `act.strike` → `act.hit` 管线（v2 §3.4），而本地链条上的每一步都跑这里。
      const action = applyInterceptors(state, ctx, act, deps);
      if (isCancelled(action)) {
        // 被取消 ≠ 什么都没发生：拦截器的 `then` 照样执行（IR v1 §4.2），
        // 它属于"这一击"的连锁，收进链条继续跑；第 ④~⑥ 步与 `resolve()` 一样跳过。
        harvest(state, floor, chain);
        continue;
      }

      // ③ 执行，产出事件
      const mark = state.eventLog.length;
      runHandler(state, ctx, action, deps);
      harvest(state, floor, chain);

      // ④ 事后触发：★ 只匹配、只排序 —— **不压栈**，有序条目攒进 `queued`
      //   逐击匹配（而不是整批打完再匹配）是必须的：`collectOrderedTriggers` 的
      //   `zone` / `once` / `filter` / `cond` 与排序键读的都是**此刻**的盘面
      //   （「★ 匹配不能推迟到批次末尾」那一条测试钉着它）。
      //   压栈推迟到整批之后，理由见函数注释的「跨批次顺序」一段。
      //   ⚠ 仍然排在上面那次 `harvest` **之后**：这一步已经不往主栈上放东西，
      //     两行对调当下没有可观测差别；但「本击的连锁」与「本击之后的反应」这条
      //     分界就是由"handler 压的都在 harvest 之前、排队产物都在它之后"表达的，
      //     调换会让任何把入栈搬回循环里的改动当场泄漏进本地链条
      //     （`rules/__tests__/combat.test.ts` 的「★ 触发器只入栈不结算」钉着它）。
      for (const trigger of collectOrderedTriggers(state, state.eventLog.slice(mark), deps)) {
        queued.push(trigger);
      }

      // ⑤ ★★ 死亡结算在本步被**跳过** ★★（v2 §4.2 第 ③ 步，见文件头）

      // ⑥ 光环重算（时序规则 4：每步重算，不做增量）
      refreshAuras(state, deps);
    }
  }

  // ★ 整批只入栈这一次 —— 于是整场战斗的触发器是「事件发出序 × 时序规则 1」的字典序。
  //   逐击入栈会被 LIFO 整段倒过来（见函数注释的「跨批次顺序」）。
  enqueueTriggers(state, queued);
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
 *    ⚠ M5/T3 之后这一行是**幂等的复述**：`processDeaths` 自己在每一轮判死之前就重算
 *    （v2 §4.2 第 ④ 步原文把光环重算写在不动点循环里，见 `resolve/deaths.ts` 文件头），
 *    末轮那次退出前的重算已经把盘面算准。保留它是为了让本函数与规范第 ④ 步的三段
 *    逐字对齐 —— 删掉之后读者要跳到另一个文件才知道这一步在哪做的。
 *    也因此它**没有独立的可观测面**：注入 bug 到这一行不会有测试变红，
 *    真正被钉住的是 `processDeaths` 里的那次。
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
 *   那条测试**故意不接任何触发器源**，直接往主栈上摆一条站位条目：对这一次
 *   `resolve()` 来说，一条已经在栈上的动作与一条刚被排队压上去的触发器完全同形，
 *   于是"开闸"这件事有一道**独立于触发器匹配**的防线（M5 的匹配写坏了它照样红）。
 */
function settleCombat(state: GameState, deps: ResolveDeps): GameEvent[] {
  processDeaths(state, deps);
  refreshAuras(state, deps);
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
 */
export function resolveStrikes(state: GameState, deps: ResolveDeps): GameEvent[] {
  const plan = planStrikes(state);
  applyStrikes(state, plan, deps);
  return settleCombat(state, deps);
}
