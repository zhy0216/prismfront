// 战斗阶段的单元测试（M3 任务书第 5、6 项 + 「完成标志」点名的四条）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 任务书原话：这四条一条都不能少，而且**不能靠 fuzz 兜**
// ═══════════════════════════════════════════════════════════════════════════
// > **最容易写错的地方**：第 ③ 步那两个"不"。一旦在逐条应用中途做了死亡结算，
// > 同归于尽就不成立，整个战斗手感全变 —— 而这个 bug 在随机对局里未必立刻显形。
//
// 「未必立刻显形」在 M3 里是**字面意义**的：`sel.entity` 按 id 取实体，不管它在哪个区，
// 所以哪怕一个单位已经被搬进墓地，它那条冻结的 `act.strike` 照样打得出去、伤害数值也一样。
// 也就是说「中途结算死亡」这个 bug 在 M3 只有两处可观测：
//   1. **事件顺序** —— `unit_died` 会插到后面那些出手的**中间**（下面第 1 条测试）；
//   2. **base 归零** —— `processDeaths` 里的 `settleBases` 一旦提前判负，
//      整局当场结束，后面的出手全部作废，"双亡平局"就永远不会发生（第 2 条测试）。
// 两条都在下面钉死了。M5 接上亡语之后，第 1 条的事件顺序断言就是那道防线的正面。
//
// ═══════════════════════════════════════════════════════════════════════════
// 摆盘方式：`putUnit` 而不是 `play_card`
// ═══════════════════════════════════════════════════════════════════════════
// 本文件断言的是"某个盘面下战斗会怎么打"。走 `play_card` 摆盘会把费用、行动权、
// `consecutivePasses` 与 `unit_summoned` 一起搅进来 —— 那些是 `phase.test.ts` 的事。
//
// 建局 / 摆盘 / 推进这三件事一行状态字面量都不在本文件里写，全部走 `src/testkit`
// （`openGame` / `putUnit` / `fightOnce`）：相位机再改一次（比如 M6 往里插英雄部署），
// 碎的是夹具一处，而不是本文件每一条测试的前三行。
//
// 注：本文件**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1）。

import { expect, test } from "bun:test";
import type { EntityId } from "@prismfront/ir";
import { ACT_HANDLERS, DEFAULT_DEPS, hitHandler, placeOnSlot } from "../../handlers/index.ts";
import type { ResolveDeps } from "../../resolve/index.ts";
import { pushAct, ResolutionLoopError, refreshAuras, suspend } from "../../resolve/index.ts";
import type { GameState, PlayerId } from "../../state/index.ts";
import { createCtx, getEntity, getZone, maskWith, zoneKey } from "../../state/index.ts";
import {
  baseIdOf,
  damageOf,
  eventNames,
  fightOnce,
  handOf,
  openGame,
  passThroughCombat,
  putUnit,
  setFace,
  setFlag,
} from "../../testkit/index.ts";
import type { TriggerQueue } from "../index.ts";
import { planStrikes, resolveStrikes, runCombat, StrikeAmountDriftError } from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// ★ 完成标志 1：先被打死的单位本轮照样打出伤害（同归于尽成立）
// ═══════════════════════════════════════════════════════════════════════════

test("先被打死的单位本轮照样打出伤害（同归于尽成立）", () => {
  const state = openGame();
  // p0 先手 ⇒ 快照里 p0 的那一击排在前面，先把对面打死；对面照样要打回来。
  const striker = putUnit(state, 0, 0, { atk: 5, health: 1 });
  const doomed = putUnit(state, 1, 0, { atk: 1, health: 1 });

  const combat = fightOnce(state);

  // ★ 这条断言就是那道防线：`unit_died` 必须**全部排在两次出手之后**。
  //   若第 ③ 步中途结算了死亡，顺序会变成
  //   struck → damaged → unit_died → struck → damaged → unit_died —— 一眼可辨。
  expect(eventNames(combat.events)).toEqual([
    "combat_began",
    "struck",
    "damaged",
    "struck",
    "damaged",
    "unit_died",
    "unit_died",
    "combat_ended",
  ]);
  // 两击的数值与方向都对：5 打过去、1 打回来。
  expect(combat.events[1]).toEqual({
    name: "struck",
    source: striker,
    target: doomed,
    amount: 5,
  });
  expect(combat.events[3]).toEqual({ name: "struck", source: doomed, target: striker, amount: 1 });
  // 已经必死的 `doomed` 打出的那 1 点真的落在了 `striker` 身上 —— 同归于尽的实证。
  expect(damageOf(combat.state, striker)).toBe(1);
  expect(damageOf(combat.state, doomed)).toBe(5);
  // 两个都进了各自的墓地，战线清空（死亡是统一结算的第 ④ 步）。
  expect(getZone(combat.state, 0, "graveyard")).toEqual([striker]);
  expect(getZone(combat.state, 1, "graveyard")).toEqual([doomed]);
  expect(combat.state.slots[0][0]).toBeNull();
  expect(combat.state.slots[1][0]).toBeNull();
});

test("双方 base 同一次战斗归零 → 平局（中途结算死亡会让它永远打不出来）", () => {
  const state = openGame();
  // 一击打满 base 的血 —— 取**这一局**的 `rules.baseHp`（状态里就有），不写死 30。
  const { baseHp } = state.rules;
  // 两个对穿：各自的对位格是空的，于是都打进对方基地。
  putUnit(state, 0, 0, { atk: baseHp, health: 5 });
  putUnit(state, 1, 1, { atk: baseHp, health: 5 });

  const combat = fightOnce(state);

  // ★ 若第 ③ 步中途判死，先落的那一击会当场 `settleBases` 判出胜负、结算立刻停止，
  //   后一击根本打不出去 —— 结果会是"某一方获胜"而不是平局（v2 §4.1：双亡为 draw）。
  expect(combat.state.winner).toBe("draw");
  expect(combat.state.phase).toBe("over");
  expect(damageOf(combat.state, baseIdOf(combat.state, 0))).toBe(baseHp);
  expect(damageOf(combat.state, baseIdOf(combat.state, 1))).toBe(baseHp);
  // 对局结束就没有后续时序：不发 `combat_ended`、不进 round_end
  //（`resolve/resolve.ts` 的偏离 B 同款理由，见 `phase.ts` 的 runCombat）。
  expect(eventNames(combat.events)).toEqual([
    "combat_began",
    "struck",
    "damaged",
    "struck",
    "damaged",
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 完成标志 2：战斗中亡语召唤的单位不获得本轮出手（快照已冻结）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一张会在**战斗中途**把一个单位放上场的 handler 表 —— 站位是"亡语召唤"。
 *
 * ── 它与真亡语版本的等价性 ───────────────────────────────────────────────
 * 真亡语版本长这样：一个单位在第 ④ 步被 `processDeaths` 收走 → 亡语触发器入栈 →
 * 开闸结算 → `act.summon` 把一个新单位放上场。本桩把中间那三步替换成"在第 ③ 步的
 * `act.hit` 之后直接 `placeOnSlot`"，于是**盘面上发生的事情完全相同**：
 * 快照冻结之后，战线上多了一个本轮不在快照里的单位。
 * 被测的性质（"第 ② 步之后上场的单位不获得本轮出手"）只关心**这个单位是什么时候
 * 站上格子的**，与它是被谁、经哪条链条放上去的无关 —— 快照是一个在第 ② 步就
 * 算完的局部数组，第 ③④ 步再往战线上加东西都够不着它。
 * 而且本桩把上场时刻放得比真亡语**更早**（第 ③ 步中途，而不是第 ④ 步之后），
 * 所以它是一个更强的构造：这里都冻得住，第 ④ 步之后上场的更冻得住。
 *
 * ── 为什么现在就要有它 ───────────────────────────────────────────────────
 * M3 还没有触发器源（`resolve/triggers.ts` 的匹配是 M5），真亡语在这里造不出来。
 * 等到 M5 才第一次验证这条性质，它已经和亡语的匹配逻辑缠在一起，红了都分不清是谁的错。
 *
 * ── ⚠ M5 落地之后要做的事 ────────────────────────────────────────────────
 * 触发器匹配可用之后，**应当把本桩换成真亡语版本**：用一张带 `deathrattle` 的卡
 * （`on: "unit_died"` + `act.summon`）打出同一个盘面，断言保持不变。
 * 那时测的就是"亡语 → 召唤"这条真实链条，而不再依赖一个只存在于测试里的 handler。
 * 桩到那时可以整段删掉 —— 它的唯一职责是在 M3~M4 期间守住这条不变量。
 */
function summonOnFirstHit(reserve: EntityId, player: PlayerId, slot: number): ResolveDeps {
  return {
    handlers: {
      ...ACT_HANDLERS,
      // 包一层的 handler 要把**全部**参数转交给被包的那个，位置参数 `slots` 也不例外
      // （`resolve/act-slots.ts`：`slots` 是惰性解析器，转交的是"怎么求"而不是求好的值；
      //  自己另造一份就绕过了记忆化，`slot.random_empty` 会多抽一次随机）。
      "act.hit": (env, act, slots) => {
        hitHandler(env, act, slots);
        const entity = getEntity(env.state, reserve);
        // 只在第一次生效：上场之后它就不在手牌区了（判据是状态，不是闭包里的计数器 ——
        // handler 必须是状态的纯函数，否则 clone 出来的推演会串味）。
        if (entity !== undefined && entity.zone === zoneKey(player, "hand")) {
          placeOnSlot(env.state, entity, player, slot);
        }
      },
    },
  };
}

test("战斗中亡语召唤的单位不获得本轮出手（快照已冻结）", () => {
  const state = openGame();
  const mine = putUnit(state, 0, 0, { atk: 2, health: 5 });
  const theirs = putUnit(state, 1, 0, { atk: 2, health: 5 });

  // 预备队：p1 手里的一张 4/5，会在**第一次伤害落地时**被塞到 p1 的 8 号格。
  const reserve = handOf(state, 1)[0];
  expect(reserve).toBeDefined();
  if (reserve === undefined) {
    return;
  }
  setFace(state, reserve, { atk: 4, health: 5 });
  // 8 号格的对位是 p0 的 8 号格（空）⇒ 它一旦出手就会打进 p0 基地，很好抓。
  const combat = fightOnce(state, summonOnFirstHit(reserve, 1, 8));

  // 它**真的**在战斗中途上了场（否则这条测试什么都没验）。
  expect(combat.state.slots[1][8]).toBe(reserve);
  // ★ 但本轮一击未出：快照在第 ② 步就冻结了，第 ③ 步只应用快照里的那两条。
  expect(eventNames(combat.events)).toEqual([
    "combat_began",
    "struck",
    "damaged",
    "struck",
    "damaged",
    "combat_ended",
  ]);
  const sources = combat.events
    .filter((event) => event.name === "struck")
    .map((event) => (event.name === "struck" ? event.source : null));
  expect(sources).toEqual([mine, theirs]);
  expect(damageOf(combat.state, baseIdOf(combat.state, 0))).toBe(0);

  // 下一回合它就正常出手了 —— 冻结的是**这一轮**的快照，不是这个单位。
  const next = fightOnce(combat.state);
  const nextSources = next.events
    .filter((event) => event.name === "struck")
    .map((event) => (event.name === "struck" ? event.source : null));
  expect(nextSources).toContain(reserve);
  expect(damageOf(next.state, baseIdOf(next.state, 0))).toBe(4);
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 完成标志 3：方向指向空格/越界 → 伤害进敌方基地
// ═══════════════════════════════════════════════════════════════════════════

test("方向指向空格/越界 → 伤害进敌方基地", () => {
  const state = openGame();
  const p1Base = baseIdOf(state, 1);

  // 三种"打不到人"的情形，外加一个能打到人的对照组。
  const emptyFacing = putUnit(state, 0, 1, { atk: 3, health: 9 }); // 对位（1 号格）是空的
  const hitsWall = putUnit(state, 0, 2, { atk: 2, health: 9, direction: 1 }); // 3 号格有人
  const overRight = putUnit(state, 0, 4, { atk: 5, health: 9, direction: 5 }); // 4+5 = 9，越界
  const overLeft = putUnit(state, 0, 8, { atk: 7, health: 9, direction: -20 }); // 8-20 = -12，越界
  // 对照组的靶子：atk 0 ⇒ 它自己不进快照（v2 §4.2 的 `atk > 0`），只挨打。
  const wall = putUnit(state, 1, 3, { atk: 0, health: 20 });
  // ★ 三个"陷阱位"的守卫，专门用来区分"越界 → 基地"与另外两种常见的错误实现：
  //   - **夹到边上**（clamp）：9 → 8 号格、-12 → 0 号格 ⇒ 会打中 guard8 / guard0；
  //   - **绕回来**（取模）：9 → 0 号格、-12 → 6 号格 ⇒ 会打中 guard0 / guard6。
  // 任务书第 6 项的原话是"不 clamp、不取模、越界的结果是打进敌方基地，不是绕回来"，
  // 而这三条只有在**那几格站着人**的时候才区分得开 —— 空着的话三种实现都落到 base，
  // 断言全绿却什么都没验（这三个守卫就是为此存在的）。
  const guard0 = putUnit(state, 1, 0, { atk: 0, health: 20 });
  const guard6 = putUnit(state, 1, 6, { atk: 0, health: 20 });
  const guard8 = putUnit(state, 1, 8, { atk: 0, health: 20 });

  // 快照本身就能读出目标（`{attacker, target, amount}` 全部冻结）。
  // 顺序 = [先手方 0→8, 另一方 0→8]，所以是 1 号格 → 2 号格 → 4 号格 → 8 号格。
  expect(planStrikes(state)).toEqual([
    { attacker: emptyFacing, target: p1Base, amount: 3 },
    { attacker: hitsWall, target: wall, amount: 2 },
    { attacker: overRight, target: p1Base, amount: 5 },
    { attacker: overLeft, target: p1Base, amount: 7 },
  ]);

  const combat = fightOnce(state);
  // ★ 伤害**真的**落在了敌方 base 上（三击相加），而不是"没报错"。
  expect(damageOf(combat.state, p1Base)).toBe(3 + 5 + 7);
  expect(damageOf(combat.state, wall)).toBe(2);
  // 三个陷阱位一点伤害都没吃到。
  expect(damageOf(combat.state, guard0)).toBe(0);
  expect(damageOf(combat.state, guard6)).toBe(0);
  expect(damageOf(combat.state, guard8)).toBe(0);
  // base 只是挨打，不占格、不进墓地（v2.1 §11.2）。
  expect(getEntity(combat.state, p1Base)?.zone).toBe("p1:base");
});

test("方向不限幅、可为负：负方向照样能打到人，只是打的是别的格", () => {
  const state = openGame();
  const sniper = putUnit(state, 0, 3, { atk: 4, health: 9, direction: -3 });
  const victim = putUnit(state, 1, 0, { atk: 0, health: 9 });
  const bystander = putUnit(state, 1, 3, { atk: 0, health: 9 }); // 对位的那个，本轮不该挨打

  expect(planStrikes(state)).toEqual([{ attacker: sniper, target: victim, amount: 4 }]);

  const combat = fightOnce(state);
  expect(damageOf(combat.state, victim)).toBe(4);
  expect(damageOf(combat.state, bystander)).toBe(0);
  expect(damageOf(combat.state, baseIdOf(combat.state, 1))).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 完成标志 4：stunned 单位不进入快照
// ═══════════════════════════════════════════════════════════════════════════

test("stunned 单位不进入快照", () => {
  const state = openGame();
  const stunned = putUnit(state, 0, 0, { atk: 4, health: 9 });
  setFlag(state, stunned, "stunned");
  const toothless = putUnit(state, 0, 1, { atk: 0, health: 9 }); // `atk > 0` 那一半条件
  const healthy = putUnit(state, 0, 2, { atk: 3, health: 9 });
  // 对面来一击，打在滞光的那个身上：滞光只让它**不出手**，不让它免疫（《数值基准》§7）。
  const puncher = putUnit(state, 1, 0, { atk: 2, health: 9 });

  expect(planStrikes(state)).toEqual([
    { attacker: healthy, target: baseIdOf(state, 1), amount: 3 },
    { attacker: puncher, target: stunned, amount: 2 },
  ]);

  const combat = fightOnce(state);
  expect(damageOf(combat.state, stunned)).toBe(2); // 挨了打
  expect(damageOf(combat.state, toothless)).toBe(0);
  expect(damageOf(combat.state, puncher)).toBe(0); // 滞光的那个没能还手
  expect(damageOf(combat.state, baseIdOf(combat.state, 1))).toBe(3);

  // 解除滞光之后它就回来了 —— 条件读的是**生效**标志位，不是"这个单位天生不出手"。
  const freed = combat.state;
  setFlag(freed, stunned, "stunned", false);
  expect(planStrikes(freed).some((planned) => planned.attacker === stunned)).toBe(true);
});

test("★ 滞光读的是生效 flags 而不是卡面 baseFlags", () => {
  // 上一条用的 `setFlag` 夹具把 `baseFlags` 与 `flags` **一起**写了（摆盘的常规姿势），
  // 所以它证明不了引擎读的是哪一个。这一条把两者**拆开**，正反两向各钉一次 ——
  // 与下面 direction 那两条同一个套路。
  //
  // 为什么这件事重要：引擎读的是 `hasFlag(entity, "stunned")` → `entity.flags`，
  // 而 `flags` 是派生值（`resolve/auras.ts`：`flags = baseFlags + Σ附魔 + Σ光环`，
  // 两个 Σ 由 M5 填）。读对了这一个字段，M5 的「使敌方全体滞光」光环、
  // 「本回合滞光」附魔、以及沉默把滞光清掉，全部自动生效，战斗侧一行特判都不用写。
  //
  // 两个 Σ 现在还是空的，所以这里直接手写 `flags` 站位"光环算出来的那个值"——
  // `planStrikes` 是纯查询，调用它不会跑流水线，`refreshAuras` 不会把它盖掉。
  //
  // ⚠ 产线代码**不许**这么写（临时标志位要挂附魔，`resolve/auras.ts` 文件头）。
  const state = openGame();
  const shooter = putUnit(state, 0, 0, { atk: 3, health: 9 });
  const entity = getEntity(state, shooter);
  expect(entity).toBeDefined();
  if (entity === undefined) {
    return;
  }

  // 卡面干净、生效滞光（"敌方光环让它这回合动不了"的形态）⇒ 不进快照。
  // 读 `baseFlags` 的实现会在这一条上翻车。
  entity.flags = maskWith(entity.flags, "stunned", true);
  expect(planStrikes(state)).toEqual([]);

  // 反过来：卡面滞光、生效已清（"沉默把滞光清掉"的形态）⇒ 照样出手。
  // 上一条单独看还能靠"恒不出手"蒙对，所以这一条必须在。
  entity.baseFlags = maskWith(entity.baseFlags, "stunned", true);
  entity.flags = maskWith(entity.flags, "stunned", false);
  expect(planStrikes(state)).toEqual([
    { attacker: shooter, target: baseIdOf(state, 1), amount: 3 },
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 6 项：direction 是普通 Tag —— 战斗读**生效值**，不读卡面
// ═══════════════════════════════════════════════════════════════════════════

test("★ 战斗读的是生效 direction（tags）而不是卡面 direction（base）", () => {
  // 这是任务书第 6 项的**唯一**实质要求：生效值 = `base.direction + Σ附魔 + Σ光环`，
  // 与 atk/health 同一套管线（`resolve/auras.ts`）。两个 Σ 要到 M5 才有内容，
  // 所以这里直接手写 `tags.direction` 来站位"附魔/光环算出来的那个值"——
  // `planStrikes` 是纯查询，调用它不会跑流水线，因此 `refreshAuras` 不会把它盖掉。
  //
  // ⚠ 产线代码**不许**这么写（持久属性变更写 `base`，`resolve/auras.ts` 文件头）；
  //   这里是为了把"读 tags 还是读 base"这件事**单独**拎出来测。
  const state = openGame();
  const shooter = putUnit(state, 0, 0, { atk: 3, health: 9, direction: 0 });
  const facing = putUnit(state, 1, 0, { atk: 0, health: 9 });
  const offset = putUnit(state, 1, 2, { atk: 0, health: 9 });

  // 卡面 0、生效 +2（"某条光环让它转向"的形态）⇒ 打 2 号格。
  const entity = getEntity(state, shooter);
  expect(entity).toBeDefined();
  if (entity === undefined) {
    return;
  }
  entity.tags.direction = 2;
  expect(planStrikes(state)).toEqual([{ attacker: shooter, target: offset, amount: 3 }]);

  // 反过来：卡面 +2、生效 0（"沉默把方向重置回去"的形态）⇒ 打回 0 号格。
  // 读 `base` 的实现会在这一条上翻车 —— 上一条它也能蒙对，所以两条必须都在。
  entity.base.direction = 2;
  entity.tags.direction = 0;
  expect(planStrikes(state)).toEqual([{ attacker: shooter, target: facing, amount: 3 }]);
});

test("★ 战斗读的是生效 atk（tags）而不是卡面 atk（base）", () => {
  // 与 direction 同一套管线，顺手钉住：`atk > 0` 与 `amount` 都取派生值。
  const state = openGame();
  const shooter = putUnit(state, 0, 0, { atk: 3, health: 9 });
  const entity = getEntity(state, shooter);
  expect(entity).toBeDefined();
  if (entity === undefined) {
    return;
  }
  entity.tags.atk = 6;
  expect(planStrikes(state)).toEqual([
    { attacker: shooter, target: baseIdOf(state, 1), amount: 6 },
  ]);

  // 被减到 0（"本回合 -3 atk"的附魔）⇒ 整个不进快照。
  entity.tags.atk = 0;
  expect(planStrikes(state)).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 快照的遍历顺序（v2 §4.2 第 ② 步：`[initiative 方 0→8, 另一方 0→8]`）
// ═══════════════════════════════════════════════════════════════════════════

test("快照顺序 = [initiative 方 0→8, 另一方 0→8]，跟着先手换手", () => {
  const layout = (state: GameState): readonly [EntityId, EntityId, EntityId] => {
    // 故意让格序与摆放顺序相反，这样"按格序 0→8"与"按上场顺序"分得开。
    const late = putUnit(state, 0, 5, { atk: 1, health: 9 });
    const early = putUnit(state, 0, 1, { atk: 1, health: 9 });
    const enemy = putUnit(state, 1, 7, { atk: 1, health: 9 });
    return [early, late, enemy];
  };

  const byP0 = openGame();
  const [early0, late0, enemy0] = layout(byP0);
  expect(planStrikes(byP0).map((planned) => planned.attacker)).toEqual([early0, late0, enemy0]);

  const byP1 = openGame({ firstPlayer: 1 });
  const [early1, late1, enemy1] = layout(byP1);
  expect(planStrikes(byP1).map((planned) => planned.attacker)).toEqual([enemy1, early1, late1]);

  // 事件流也跟着这个顺序（快照顺序即应用顺序）。
  const combat = fightOnce(byP1);
  const sources = combat.events
    .filter((event) => event.name === "struck")
    .map((event) => (event.name === "struck" ? event.source : null));
  expect(sources).toEqual([enemy1, early1, late1]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 ③ 步的管线：`act.strike` → `act.hit`（v2 §3.4）
// ═══════════════════════════════════════════════════════════════════════════

test("战斗出手内部走 act.hit 管线（拦得住 act.hit 就拦得住战斗伤害）", () => {
  // v2 §3.4 要求 strike **内部走 `act.hit` 管线**，目的就是让 M5 的圣盾/减伤/
  // "改为受到 1 点伤害"这类拦截器在 `act.hit` 那一层同时对**战斗**生效。
  // 把 `act.hit` 换成空实现，等价于"所有伤害都被拦掉"：
  // `struck` 照发（出手确实发生了），但一点伤害都不该落地。
  const state = openGame();
  const attacker = putUnit(state, 0, 0, { atk: 4, health: 9 });
  const target = putUnit(state, 1, 0, { atk: 0, health: 9 });
  const shielded: ResolveDeps = { handlers: { ...ACT_HANDLERS, "act.hit": () => {} } };

  const combat = fightOnce(state, shielded);

  expect(eventNames(combat.events)).toEqual(["combat_began", "struck", "combat_ended"]);
  expect(combat.events[1]).toEqual({ name: "struck", source: attacker, target, amount: 4 });
  expect(damageOf(combat.state, target)).toBe(0);
});

test("战斗链条成环同样撞 ResolutionLoopError（步数上限与 resolve() 同源）", () => {
  // 第 ③ 步是一条**旁路管线**（`rules/combat.ts`），它自己弹自己的链条，
  // 所以 `resolve()` 的那道 256 步护栏管不到它 —— 必须在旁路里也有一道，
  // 否则一张坏卡（M5 的拦截器 `then` 自我复制）会把房间挂死而不是抛错。
  const state = openGame();
  putUnit(state, 0, 0, { atk: 1, health: 9 });
  const looping: ResolveDeps = {
    handlers: {
      ...ACT_HANDLERS,
      "act.hit": (env, act) => {
        pushAct(env.state, act, env.ctx); // 自我复制 = 真环
      },
    },
  };

  let caught: unknown = null;
  try {
    passThroughCombat(state, looping);
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof ResolutionLoopError).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 第 ③ 步的第二个「不」：触发器只入栈不结算 —— 与第 ④ 步的「开闸」
// ═══════════════════════════════════════════════════════════════════════════
// 任务书把这两个「不」并列，并要求它们**各有独立测试、不能靠 fuzz 兜**。
// 第一个「不」（不做中途死亡结算）在本文件开头两条里；第二个「不」在这里。
//
// 为什么它需要一个额外的接线口：M5 之前 `collectTriggerSubscriptions` 恒返回空
// （`resolve/triggers.ts`），于是 `queueTriggers` 一条都不排 —— 把 `harvest` 挪到
// `queueTriggers` **之后**（等价于"批次中途就把触发器跑了"）会产出**逐字相同**的
// 事件流与状态，任何黑盒测试都区分不开。所以这里从 `rules/combat.ts` 的
// `TriggerQueue` 塞一个会真排队的源进去。第 ④ 步的「开闸」则连这个都不需要，
// 直接往主栈上摆一条站位触发器即可（下面第二条）。

/**
 * 一个**会真排队**的触发器源：每收到一条 `damaged`，就往主栈上压一条 `act.draw`。
 *
 * ── 它与真触发器的等价性 ─────────────────────────────────────────────────
 * `queueTriggers` 的契约就是「把这一批事件匹配出的触发器压进**主栈**，返回条目数」。
 * 本桩只把"匹配"写死成"看见 `damaged` 就排一条"，其余逐字相同：同样用 `pushAct` 造条目
 * （栈条目的构造只有 `resolve/push.ts` 一处）、同样落在主栈上、同样只 push 不执行。
 * 被测的性质只关心「排在主栈上的东西**什么时候**被弹出来跑」，
 * 与它是被哪条事件、按什么规则匹配出来的无关 —— 那部分是 M5 的事（也有自己的测试）。
 *
 * 站位动作取 `act.draw` 而不是 `act.hit`：它发的 `card_drawn` 在事件名一栏里与战斗
 * 自己的 `struck` / `damaged` 一眼分得开，于是断言直接写事件顺序就够，不用按负载筛。
 */
function drawOnDamaged(owner: EntityId): TriggerQueue {
  return (state, events) => {
    let queued = 0;
    for (const event of events) {
      if (event.name !== "damaged") {
        continue;
      }
      pushAct(state, { op: "act.draw", player: { op: "sel.controller" } }, createCtx(owner));
      queued += 1;
    }
    return queued;
  };
}

test("★ 触发器只入栈不结算：批次中途排出来的触发器要等第 ④ 步开闸才跑", () => {
  const state = openGame();
  const first = putUnit(state, 0, 0, { atk: 2, health: 9 });
  putUnit(state, 0, 1, { atk: 2, health: 9 });
  putUnit(state, 1, 0, { atk: 0, health: 20 }); // 两个靶子：0 atk ⇒ 不还手
  putUnit(state, 1, 1, { atk: 0, health: 20 });
  state.phase = "combat"; // ②③④ 是 combat 相位里的三步（`phase.ts` 的 runCombat）

  // 直接驱动 ②③④：第 ① 步（把栈跑空）与第 ⑤ 步（combat_ended）与本条无关。
  const events = resolveStrikes(state, DEFAULT_DEPS, drawOnDamaged(first));

  // ★ 两条 `card_drawn` 必须**全部排在两击之后**：第 ③ 步只把它们压上主栈，
  //   要到第 ④ 步开闸才跑。把 `harvest` 挪到排队之后（= 批次中途就跑触发器）会得到
  //   struck → damaged → card_drawn → struck → damaged → card_drawn，一眼可辨 ——
  //   而那正是"快照白冻了"的形态：中途跑起来的触发器能改掉后面那一击落地的盘面。
  expect(eventNames(events)).toEqual([
    "struck",
    "damaged",
    "struck",
    "damaged",
    "card_drawn",
    "card_drawn",
  ]);
  // 开闸跑完主栈必须是空的（下一次战斗第 ① 步的前提）。
  expect(state.stack).toEqual([]);
});

test("★ 第 ④ 步给结算栈开闸：留在主栈上的条目到这里才跑", () => {
  const state = openGame();
  const attacker = putUnit(state, 0, 0, { atk: 2, health: 9 });
  const target = putUnit(state, 1, 0, { atk: 0, health: 20 });
  state.phase = "combat";

  // 站位「第 ③ 步排队的触发器 / `processDeaths` 排出来的亡语」—— 与
  // `enterCombatWithTrigger` 同一条论证：对第 ④ 步那次 `resolve()` 来说，
  // 一条**已经在栈上**的动作与一条**刚被排队压上去**的触发器完全同形。
  // 这条**不走** `TriggerQueue` 接线，于是"开闸"这件事有一道独立于那个接线的防线。
  pushAct(state, { op: "act.draw", player: { op: "sel.controller" } }, createCtx(attacker));

  const events = resolveStrikes(state, DEFAULT_DEPS);

  // ★ 第 ③ 步不许碰它（它在每一步的 `floor` 之下，`harvest` 摘不到），
  //   第 ④ 步的那次 `resolve()` 必须把它跑掉 —— 删掉那一行，`card_drawn` 就没了，
  //   而这一条会以"战斗返回的事件流少了一段、且栈没跑空"的形式红。
  expect(eventNames(events)).toEqual(["struck", "damaged", "card_drawn"]);
  expect(state.stack).toEqual([]);
  expect(damageOf(state, target)).toBe(2);
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 ① 步之后的那道判断：终局 / 挂起都不许开始快照
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 把状态摆成「刚进 `combat`，栈上压着一条 `combat_began` 的触发器」。
 *
 * M5 之前 `queueTriggers` 恒排 0 条（`resolve/triggers.ts` 的匹配是 M5），
 * 真触发器在这里造不出来。但第 ① 步做的事恰恰是「把结算栈跑到空」——
 * 一条**已经在栈上**的动作与一条**刚被排队压上去**的触发器，对那一次 `resolve()`
 * 来说完全同形（都是弹出来跑一遍），所以直接压栈是等价且更强的构造：
 * 它连"排队"这一环都不依赖。
 */
function enterCombatWithTrigger(
  state: GameState,
  source: EntityId,
  target: EntityId,
  amount: number,
): void {
  // SELF = 挂着这条触发器的那个单位，与真触发器的绑定一致（`resolve/context.ts`）。
  pushAct(
    state,
    { op: "act.hit", target: { op: "sel.entity", id: target }, amount },
    createCtx(source),
  );
  state.phase = "combat";
}

test("★ 第 ① 步就打穿 base ⇒ ②③④ 一步都不许跑（终局之后没有后续时序）", () => {
  const state = openGame();
  const { baseHp } = state.rules;
  // 这个单位对位是空格 ⇒ 它一旦进快照就会再往 p1 基地上补一击，很好抓。
  const owner = putUnit(state, 0, 0, { atk: 5, health: 9 });
  const p1Base = baseIdOf(state, 1);
  enterCombatWithTrigger(state, owner, p1Base, baseHp);

  const events = runCombat(state, DEFAULT_DEPS);

  expect(state.winner).toBe(0);
  expect(state.phase).toBe("over");
  // ★ 快照根本没开始：一条 `struck` 都没有。
  //   少了那道判断的话，这里是 combat_began → damaged → struck → damaged。
  expect(eventNames(events)).toEqual(["combat_began", "damaged"]);
  // ★ base 也就不会吃到超过 baseHp 的伤害（终局之后又挨了一击）。
  expect(damageOf(state, p1Base)).toBe(baseHp);
});

test("★ 第 ① 步挂起 ⇒ 同样不开始快照（战斗批次是原子的，半批无处可存）", () => {
  const state = openGame();
  const owner = putUnit(state, 0, 0, { atk: 5, health: 9 });
  const p1Base = baseIdOf(state, 1);
  enterCombatWithTrigger(state, owner, p1Base, 1);
  // 一张「战斗开始时：选一个目标」的站位卡。挂起契约是**先把续跑动作压回栈再 suspend**
  //（`resolve/suspend.ts`）。
  const asking: ResolveDeps = {
    handlers: {
      ...ACT_HANDLERS,
      "act.hit": (env, act, slots) => {
        if (env.ctx.chosen === null) {
          pushAct(env.state, act, env.ctx);
          suspend(env.state, {
            player: 0,
            kind: "select_target",
            options: [p1Base],
            optional: false,
            deadline: null,
          });
          return;
        }
        hitHandler(env, act, slots);
      },
    },
  };

  const events = runCombat(state, asking);

  expect(state.pendingInput?.kind).toBe("select_target");
  // 快照没开始 ⇒ 一击未出、相位也没往前走（还在 combat，`resume()` 之后接着来）。
  expect(eventNames(events)).toEqual(["combat_began"]);
  expect(damageOf(state, p1Base)).toBe(0);
  expect(state.phase).toBe("combat");
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 快照 amount 冻结（v2 §4.2 第 ② 步「记录后全部冻结」）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一张会在**第一次伤害落地时**改掉某个**尚未出手**的攻击者 atk 的 handler 表 ——
 * 站位是 M5 的「能在批次中途改 atk 的拦截器 / 触发器」。
 *
 * 与 {@link summonOnFirstHit} 同一套桩手法，也同样把"只生效一次"的判据写成**状态**
 * （`base.atk` 已经是目标值就不再动），而不是闭包里的计数器 ——
 * handler 必须是状态的纯函数，否则 clone 出来的推演会串味。
 *
 * 属性写 `base` 再 `refreshAuras`（`resolve/auras.ts` 文件头：持久变更写 `base`，
 * `tags` 是派生值），这正是 M5 的附魔/光环生效之后盘面会呈现的形态。
 */
function boostAtkOnFirstHit(attacker: EntityId, atk: number): ResolveDeps {
  return {
    handlers: {
      ...ACT_HANDLERS,
      "act.hit": (env, act, slots) => {
        hitHandler(env, act, slots);
        const entity = getEntity(env.state, attacker);
        if (entity === undefined || entity.base.atk === atk) {
          return;
        }
        entity.base.atk = atk;
        refreshAuras(env.state);
      },
    },
  };
}

test("★ 批次中途改 atk ⇒ 运行时哨兵当场抛（v2 §4.2：记录后全部冻结）", () => {
  // ── 这条测试断言的是「哨兵会响」，不是「第二击仍然打 3」 ─────────────────
  // `rules/combat.ts` 的 `strikeActOf` 丢掉了 `PlannedStrike.amount`
  //（IR v1 的 `act.strike` 没有 `amount` 字段），真正打出去的数值由
  // `handlers/damage.ts` 的 `strikeHandler` 在**应用那一刻**重读 `attacker.tags.atk`。
  // M3 里两者必然相等，但守着这条等式的只有一段**结构性论证**（批次中没有任何东西
  // 能改 `tags.atk`，见 `PlannedStrike.amount`），没有代码。
  // `rules/combat.ts` 的 `assertFrozenAmount` 把它变成一道**运行时哨兵**：
  // 等式一破就抛 `StrikeAmountDriftError`。
  //
  // 为什么不断言"第二击仍然是 3"：M3 做不到（要么给 IR 加 `amount` 字段，要么让战斗
  // 自己发 `struck` 从而与 `strikeHandler` 分叉，两处注释都写了代价），于是那样写出来
  // 的是一条**恒红**的测试 —— 它在 M5 破坏之前红、之后还是红，唯一能产生的跃迁是
  // red→green，而不是"M5 破坏时大声红掉"；代价却是整套测试恒 exit 1，
  // CI 的 `turbo test`（必过步骤）从此不再是闸门。哨兵把两件事都反过来。
  //
  // ⚠ M5 按 `PlannedStrike.amount` 的 TODO(M5) 二选一把冻结值真的送进管线之后，
  //   哨兵退役，**这条测试要改写成断言"第二击仍然是 3、victim 只吃 3 点"**——
  //   桩与盘面一行都不用动，只换最后那几行断言。
  const state = openGame();
  const first = putUnit(state, 0, 0, { atk: 2, health: 9 }); // 先出手
  const second = putUnit(state, 0, 1, { atk: 3, health: 9 }); // 快照冻的是 3
  putUnit(state, 1, 0, { atk: 0, health: 20 }); // 靶子：0 atk ⇒ 不还手
  putUnit(state, 1, 1, { atk: 0, health: 20 });

  const plan = planStrikes(state);
  expect(plan.map((planned) => planned.attacker)).toEqual([first, second]);
  expect(plan.map((planned) => planned.amount)).toEqual([2, 3]);

  // 第一击的伤害一落地，就把 `second` 的 atk 从 3 拉到 9 —— 站位 M5 的那类拦截器。
  let caught: unknown = null;
  try {
    fightOnce(state, boostAtkOnFirstHit(second, 9));
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof StrikeAmountDriftError).toBe(true);

  // 错误对象带得走「谁、冻结多少、现在是多少」—— 排 bug 时这是唯一有用的信息
  //（同 `ResolutionLoopError` 把事件流挂在错误上）。
  const drift = caught instanceof StrikeAmountDriftError ? caught : null;
  expect(drift?.attacker).toBe(second);
  expect(drift?.frozen).toBe(3);
  expect(drift?.actual).toBe(9);
});

test("战斗跑完结算栈必须是空的（下一次战斗第 ① 步的前提）", () => {
  const state = openGame();
  putUnit(state, 0, 0, { atk: 2, health: 3 });
  putUnit(state, 1, 0, { atk: 2, health: 3 });

  const after = passThroughCombat(state).state;
  expect(after.stack).toEqual([]);
  expect(after.eventLog).toEqual([]);
  expect(after.pendingInput).toBeNull();
  expect(after.phase).toBe("actions");
  expect(after.round).toBe(2);
});
