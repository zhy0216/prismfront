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
import type { Card, Cond, EntityId } from "@prismfront/ir";
import type { GameEvent } from "../../events/index.ts";
import { ACT_HANDLERS, DEFAULT_DEPS, hitHandler, NO_DEPS } from "../../handlers/index.ts";
import type { ResolveDeps } from "../../resolve/index.ts";
import { pushAct, ResolutionLoopError, refreshAuras, suspend } from "../../resolve/index.ts";
import type { GameState } from "../../state/index.ts";
import { cloneState, createCtx, getEntity, getZone, maskWith } from "../../state/index.ts";
import {
  baseIdOf,
  cardDeps,
  damageOf,
  eventNames,
  fightOnce,
  openGame,
  passThroughCombat,
  putCard,
  putUnit,
  scriptCard,
  setFlag,
} from "../../testkit/index.ts";
import { planStrikes, resolveStrikes, runCombat } from "../index.ts";

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
 * 一张**真亡语卡**：死掉时把一个 4/5 的护卫召唤到自己那一侧的 8 号格。
 *
 * ── M5/T1 之前这里是一张桩 handler（`summonOnFirstHit`）────────────────────
 * M3 没有触发器源（`resolve/triggers.ts` 的匹配是 M5），真亡语造不出来，所以当时用
 * 一张"在第 ③ 步的 `act.hit` 之后直接 `placeOnSlot`"的 handler 站位，
 * 并在它的文档注释里论证了等价性（盘面上发生的事情相同，且上场时刻更早 ⇒ 更强的构造）。
 * M5/T1 落地后按 `todos/done/M03` 的要求换成了这张真卡：
 * 一个单位被 `processDeaths` 收走 → 亡语触发器入栈 → 第 ④ 步开闸 → `act.summon` 上场。
 * **断言一条都没改**，因为被测性质只关心"第 ② 步之后站上格子的单位不获得本轮出手"。
 *
 * `at` 写死成 `slot.at`（8 号格）而不是 `slot.random_empty`：后者会消耗 RNG，
 * 让这条战斗测试莫名其妙地依赖随机流（v2 §3.4 允许 `at` 是任意 SlotRef）。
 * 8 号格的对位是 p0 的 8 号格（空）⇒ 护卫一旦出手就会打进 p0 基地，很好抓。
 */
const DEATH_GUARD: Card = scriptCard("T_DEATH_GUARD", {
  deathrattle: [
    {
      op: "act.summon",
      player: { op: "sel.controller" },
      card: "T_GUARD",
      at: { op: "slot.at", side: "friendly", index: 8 },
    },
  ],
});

/** 被召唤出来的那个护卫。4/5：一旦获得出手就会往 p0 基地上打 4 点，断言抓得住。 */
const GUARD: Card = scriptCard("T_GUARD", {}, { tags: { atk: 4, health: 5 } });

test("战斗中亡语召唤的单位不获得本轮出手（快照已冻结）", () => {
  const deps = cardDeps([DEATH_GUARD, GUARD]);
  const state = openGame();
  const mine = putUnit(state, 0, 0, { atk: 2, health: 5 });
  // p1 的这一个会在本轮被打死（2/2 对 2/5）：它的亡语在第 ④ 步召唤出护卫。
  const theirs = putCard(state, 1, 0, DEATH_GUARD, { atk: 2, health: 2 });

  const combat = fightOnce(state, deps);

  // 护卫**真的**在这一轮上了场（否则这条测试什么都没验）。
  const guard = combat.state.slots[1][8];
  expect(guard).not.toBeNull();
  expect(getEntity(combat.state, guard ?? 0)?.cardId).toBe(GUARD.id);
  // ★ 但它本轮一击未出：快照在第 ② 步就冻结了，第 ③ 步只应用快照里的那两条。
  //   亡语链条排在两击**之后**（时序规则 2 + v2 §4.2 第 ④ 步开闸）。
  expect(eventNames(combat.events)).toEqual([
    "combat_began",
    "struck",
    "damaged",
    "struck",
    "damaged",
    "unit_died",
    "unit_summoned",
    "combat_ended",
  ]);
  const sources = combat.events
    .filter((event) => event.name === "struck")
    .map((event) => (event.name === "struck" ? event.source : null));
  expect(sources).toEqual([mine, theirs]);
  expect(damageOf(combat.state, baseIdOf(combat.state, 0))).toBe(0);

  // 下一回合它就正常出手了 —— 冻结的是**这一轮**的快照，不是这个单位。
  const next = fightOnce(combat.state, deps);
  const nextSources = next.events
    .filter((event) => event.name === "struck")
    .map((event) => (event.name === "struck" ? event.source : null));
  expect(nextSources).toContain(guard);
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
// M3 时它需要一个额外的接线口（`rules/combat.ts` 的 `TriggerQueue` 参数）：那时
// `collectTriggerSubscriptions` 恒返回空，一条触发器都排不出来 —— 把 `harvest`
// 挪到排队**之后**（等价于"批次中途就把触发器跑了"）会产出**逐字相同**的
// 事件流与状态，任何黑盒测试都区分不开。
// ★ M5/T1 落地后那个参数已退役：下面这条改用一张**真触发器卡**，事件流断言一字未改，
//   而第 ③ 步的排队从此只有一条路径（不再有生产/测试两条）。
// 第 ④ 步的「开闸」连触发器都不需要，直接往主栈上摆一条站位条目即可（下面第二条）。
//
// ⚠ 这一节对触发器的**先后**没有判别力：下面那两条 `card_drawn` 完全同形，调换读不出
//   差别。跨批次的顺序另有一节（「★ 跨批次的触发顺序」两条），两节各钉一半。

/**
 * 一张**真触发器卡**：每当有伤害落地（`damaged`，不加 `filter` ⇒ 谁被打都算），抽一张牌。
 *
 * 站位动作取 `act.draw` 而不是 `act.hit`：它发的 `card_drawn` 在事件名一栏里与战斗
 * 自己的 `struck` / `damaged` 一眼分得开，于是断言直接写事件顺序就够，不用按负载筛。
 */
const DRAW_ON_DAMAGED: Card = scriptCard("T_DRAW_ON_DAMAGED", {
  triggers: [
    { on: "damaged", zone: "board", do: [{ op: "act.draw", player: { op: "sel.controller" } }] },
  ],
});

test("★ 触发器只入栈不结算：批次中途排出来的触发器要等第 ④ 步开闸才跑", () => {
  const state = openGame();
  // 出手的这一个同时挂着「每当有伤害落地就抽一张牌」的触发器。
  putCard(state, 0, 0, DRAW_ON_DAMAGED, { atk: 2, health: 9 });
  putUnit(state, 0, 1, { atk: 2, health: 9 });
  putUnit(state, 1, 0, { atk: 0, health: 20 }); // 两个靶子：0 atk ⇒ 不还手
  putUnit(state, 1, 1, { atk: 0, health: 20 });
  state.phase = "combat"; // ②③④ 是 combat 相位里的三步（`phase.ts` 的 runCombat）

  // 直接驱动 ②③④：第 ① 步（把栈跑空）与第 ⑤ 步（combat_ended）与本条无关。
  const events = resolveStrikes(state, cardDeps([DRAW_ON_DAMAGED]));

  // ★ 两条 `card_drawn` 必须**全部排在两击之后**：第 ③ 步只把它们攒起来、整批结束
  //   才压上主栈，要到第 ④ 步开闸才跑。把入栈搬进循环、且搬到 `harvest` **之前**
  //   （= 刚排队的条目当场被摘进本地链条）会得到
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
  // 这条**不接任何触发器源**（`DEFAULT_DEPS` 没有 `scripts`），于是"开闸"这件事
  // 有一道独立于触发器匹配的防线：匹配写坏了它照样红得出来。
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
// ★ 跨批次的累积顺序：整批出手的触发器**没有被 LIFO 反转**
// ═══════════════════════════════════════════════════════════════════════════
// 上一节钉的是「触发器有没有在批次中途跑起来」，这一节钉的是它们最终**以什么顺序**跑。
// 两件事分得开，也各自可以单独写坏。
//
// ── 被测的是什么：**跨批次的累积顺序**（= 字典序的外层键，事件发出序）───────────
// 一整批出手要全部打完才开闸（v2 §4.2 第 ③→④ 步），期间有 N 次事件产出、N 次触发器
// 匹配。而结算栈是 LIFO —— 每匹配一批就当场压一次的写法会让**后排队的先跑**，
// 于是整场战斗按**逆因果序**结算（M5 的实测缺陷）。
// `rules/combat.ts` 的 `applyStrikes` 因此逐击只**匹配 + 排序**
// （`collectOrderedTriggers`），把有序条目累积起来，循环结束后才 `enqueueTriggers` 一次。
//
// ── ⚠ 下面两条**没有**走到时序规则 1 的排序键（别照标题理解）────────────────
// 两条卡都写了 `filter: {source: SELF}`，于是每一击匹配出来的批次都是**单元素** ——
// `sortTriggers` 在单元素上恒等，三级排序键一个都读不到。实测四种注入：把
// `compareOwnerOrder` 的 playOrder 级 / side 级分别反过来、把 `activePlayer` 翻面、
// 把 `sortTriggers` 整个退化成恒等 —— 这两条**全都保持绿**。
// 它们真正钉住的只有「累积顺序没有被 LIFO 反转」这一件事。
// 排序键本身另有两处钉着：`resolve/__tests__/triggers.test.ts` 的「规则 1 端到端」
// （单元层面）与下面那一节「★ 时序规则 1 在战斗路径上」（战斗路径，一批多元素）。
//
// ── 为什么这两条放在**战斗**测试里，而不是 `resolve/__tests__/triggers.test.ts` ──
// 「开闸之前经历多批」正是战斗第 ③ 步的常态（一整批出手），别处都没有这个形态：
// `resolve.ts` 的第 ④ 步每弹一条栈条目就开闸一次，相位机那几处也是调一次就开闸。
//（`resolve/deaths.ts` 的不动点循环是第二处，那一条钉在 triggers.test.ts 的「跨波」。）
//
// ── 两条的盘面都刻意让「事件发出序」与「时序规则 1」同向 ────────────────────
// 于是缺陷期实测到的那个顺序（整段倒过来）违反的是两种读法里的**每一种**，
// 断言不含歧义；也因此每条都用**可区分**的读数（伤害数值 / 玩家 id），
// 而不是两条同形事件。

/** 一批事件里每条 `damaged` 的「谁打的、打了多少」—— 数组顺序即结算顺序。 */
function damagedBy(events: readonly GameEvent[]): [EntityId | null, number][] {
  const out: [EntityId | null, number][] = [];
  for (const event of events) {
    if (event.name === "damaged") {
      out.push([event.source, event.amount]);
    }
  }
  return out;
}

/** 一批事件里每条 `card_drawn` 抽给了谁（`player` 是那一方的 base 实体 id）。 */
function drawnPlayers(events: readonly GameEvent[]): EntityId[] {
  const out: EntityId[] = [];
  for (const event of events) {
    if (event.name === "card_drawn") {
      out.push(event.player);
    }
  }
  return out;
}

/**
 * 「**我**打出一击时，往对面基地上敲**自己 atk** 点」。
 *
 * `amount` 取 `num.attr(SELF, atk)` 而不是写死一个数：两个订阅者用的是**同一张卡**
 * （差别就不可能出在卡的写法上，同 `resolve/__tests__/triggers.test.ts` 的成对摆盘规矩），
 * 而回声的伤害数值恰好就是「此刻在跑的是谁」的读数 —— 这是下面那条的判别力所在。
 * 换成两条同形的 `act.draw` 就只剩"响了两次"，先后调换读不出差别。
 *
 * `filter: {source: SELF}` 让每条 `struck` 只匹配出手的那一个 ⇒ 两击各自成一批、
 * 每批都是**单元素**，被测的正是**两批之间**的顺序（批**内**的排序键读不到，见本节 ⚠）。
 */
const ECHO_OWN_ATK: Card = scriptCard("T_ECHO_ATK", {
  triggers: [
    {
      on: "struck",
      filter: { source: { op: "sel.self" } },
      do: [
        {
          op: "act.hit",
          target: { op: "sel.opponent" },
          amount: { op: "num.attr", of: { op: "sel.self" }, tag: "atk" },
        },
      ],
    },
  ],
});

test("★ 跨批次的累积顺序：同侧两击 —— 先出手的那一击的触发器先跑", () => {
  const deps = cardDeps([ECHO_OWN_ATK]);
  const state = openGame();
  // 摆放顺序即 playOrder 升序，格序又与它同向 ⇒ `first` 先出手、也该先触发。
  const first = putCard(state, 0, 0, ECHO_OWN_ATK, { atk: 1, health: 9 });
  const second = putCard(state, 0, 1, ECHO_OWN_ATK, { atk: 2, health: 9 });
  // 两个 0 atk 的靶子：不还手（否则会多出两击、两批触发器），同时把出手伤害挡在
  // 基地之外 ⇒ p1 base 上的伤害只可能来自回声。
  putUnit(state, 1, 0, { atk: 0, health: 20 });
  putUnit(state, 1, 1, { atk: 0, health: 20 });

  const combat = fightOnce(state, deps);

  // 两条回声都排在两击之后（上一节那条性质在这个盘面上也成立）。
  expect(eventNames(combat.events)).toEqual([
    "combat_began",
    "struck",
    "damaged",
    "struck",
    "damaged",
    "damaged",
    "damaged",
    "combat_ended",
  ]);
  // ★ 本条的判别力：后两条回声必须是 `first` 在前。
  //   逐击入栈（LIFO ⇒ 后排队的先跑）会读到 [[first,1],[second,2],[second,2],[first,1]]。
  expect(damagedBy(combat.events)).toEqual([
    [first, 1],
    [second, 2],
    [first, 1],
    [second, 2],
  ]);
  // 回声真的落地了 —— 否则上面那串顺序断言可能是在验一组根本没发生的事。
  expect(damageOf(combat.state, baseIdOf(combat.state, 1))).toBe(1 + 2);
});

/**
 * 「**我**打出一击时，控制者抽一张牌」—— 用来把**两方**的触发器分开读。
 *
 * 可观测面取 `card_drawn.player`（那一方的 base 实体 id）而不是伤害：双方各出一击时
 * 两条回声会落在**不同的**基地上，用伤害读不出先后。
 */
const DRAW_ON_OWN_STRIKE: Card = scriptCard("T_DRAW_ON_STRIKE", {
  triggers: [
    {
      on: "struck",
      filter: { source: { op: "sel.self" } },
      do: [{ op: "act.draw", player: { op: "sel.controller" } }],
    },
  ],
});

test("★ 跨批次的累积顺序：两侧各一击 —— 先出手的那一侧的触发器先跑", () => {
  const deps = cardDeps([DRAW_ON_OWN_STRIKE]);
  // p0 先手 ⇒ 出手序里 p0 那一击在前（v2 §4.2 第 ② 步）。两个宿主分属两方，
  // 但每一批仍然只有一个订阅者 ⇒ 读到的是"两批之间"的顺序，不是规则 1 的 side 那一级。
  const state = openGame();
  // 两个都打**空对位** ⇒ 各打各的基地、谁也打不死谁，本轮恰好两击、两批触发器。
  const mine = putCard(state, 0, 0, DRAW_ON_OWN_STRIKE, { atk: 1, health: 9 });
  const theirs = putCard(state, 1, 1, DRAW_ON_OWN_STRIKE, { atk: 1, health: 9 });

  const combat = fightOnce(state, deps);

  // 出手序 = [initiative 方 0→8, 另一方 0→8]（v2 §4.2 第 ② 步）⇒ 先 p0 后 p1。
  const struck = combat.events
    .filter((event) => event.name === "struck")
    .map((event) => (event.name === "struck" ? event.source : null));
  expect(struck).toEqual([mine, theirs]);

  // ★ 本条的判别力：触发序必须跟着出手序，p0 那一击排出来的先跑。
  //   逐击入栈会读到 [p1, p0] —— 整段被 LIFO 倒过来。
  expect(drawnPlayers(combat.events)).toEqual([
    baseIdOf(combat.state, 0),
    baseIdOf(combat.state, 1),
  ]);
  // 两条 `card_drawn` 同样全部排在两击之后。
  expect(eventNames(combat.events)).toEqual([
    "combat_began",
    "struck",
    "damaged",
    "struck",
    "damaged",
    "card_drawn",
    "card_drawn",
    "combat_ended",
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 时序规则 1 在**战斗路径**上：一批之内按「当前回合玩家 → playOrder」排
// ═══════════════════════════════════════════════════════════════════════════
// 上一节的两条只钉住外层键（见那里的 ⚠：每批单元素，排序键读不到）。内层键 ——
// `sortTriggers` 的三级排序键 —— 要一批**多元素**的匹配结果才走得到，所以这一条的
// 三个宿主全都**不带 filter**：一条 `struck` 同时命中三个，它们落在**同一次**匹配、
// 同一次入栈里，先后完全由规则 1 决定。
//
// 三个宿主刻意**两侧交错**摆（playOrder 依次是 mine1 → theirs → mine2），于是
// playOrder 序与另外两者不同（后两者之间**相同**，原因见紧接着的 ⚠）：
//   playOrder 序                                          = [mine1, theirs, mine2]
//   实体枚举序（`collectTriggerSubscriptions` 按 id 升序扫）= [mine1, mine2, theirs]
//   规则 1（当前回合玩家优先 → playOrder 升序）             = [mine1, mine2, theirs]
// ⚠ 后两者在 `openGame` 的盘面上**恰好相同**：实体 id 是建局时按玩家分段发的
//   （p0 的整副牌在前），所以"p0 的排前面"这一级与 id 升序同向。
//   于是「排序整个被跳过」这一种写错在 p0 先手的盘面上读不出来 —— 本条因此跑**两遍**，
//   第二遍把 `initiative` 翻到 p1（规则 1 变成 [theirs, mine1, mine2]，与枚举序不同）。

/** 每当有出手发生（**不带 filter** ⇒ 谁出手都算），往自己对面的基地上敲 1 点。 */
const ECHO_ANY_STRIKE: Card = scriptCard("T_ECHO_ANY", {
  triggers: [{ on: "struck", do: [{ op: "act.hit", target: { op: "sel.opponent" }, amount: 1 }] }],
});

test("★ 时序规则 1：一击命中三个宿主 —— 当前回合玩家优先、同方按 playOrder 升序", () => {
  const deps = cardDeps([ECHO_ANY_STRIKE]);
  // p0 先手 ⇒ combat 相位的「当前回合玩家」取 initiative = p0（`resolve/triggers.ts`
  // 的 `activePlayer`：只有 actions 相位取 priority）。
  const state = openGame();
  // 摆放顺序即 playOrder 升序，**故意两侧交错**（见本节说明的三种序）。
  const mine1 = putCard(state, 0, 0, ECHO_ANY_STRIKE, { atk: 0, health: 9 });
  const theirs = putCard(state, 1, 0, ECHO_ANY_STRIKE, { atk: 0, health: 9 });
  const mine2 = putCard(state, 0, 1, ECHO_ANY_STRIKE, { atk: 0, health: 9 });
  // 本轮唯一的一击（三个宿主都是 0 atk，不出手）：对位是 p1 的 4 号格（空）⇒ 打进 p1 基地。
  const attacker = putUnit(state, 0, 4, { atk: 2, health: 9 });

  /** 三条回声的结算顺序（把出手那一条 `damaged` 摘掉）。 */
  const echoesOf = (events: readonly GameEvent[]): (EntityId | null)[] =>
    damagedBy(events)
      .filter(([source]) => source !== attacker)
      .map(([source]) => source);

  const combat = fightOnce(cloneState(state), deps);

  // ★ 本条的判别力：三条回声全在**一次**入栈里，先后完全由规则 1 定。
  //   playOrder 那一级反了            → [mine2, mine1, theirs]
  //   side 那一级反了 / activePlayer 翻面 → [theirs, mine1, mine2]
  expect(damagedBy(combat.events)).toEqual([
    [attacker, 2],
    [mine1, 1],
    [mine2, 1],
    [theirs, 1],
  ]);
  // 三条回声真的落地了（按宿主归属分别落在两边基地上），否则上面是在验一组没发生的事。
  expect(damageOf(combat.state, baseIdOf(combat.state, 1))).toBe(2 + 1 + 1);
  expect(damageOf(combat.state, baseIdOf(combat.state, 0))).toBe(1);

  // 换手之后整体翻面：同一个盘面、同一批触发器，只是 `activePlayer` 变了。
  // ★ 这一半单独承担一件事：**排序有没有真的发生** —— 上面那一行的期望值恰好等于
  //   实体枚举序（见本节 ⚠），所以「`sortTriggers` 退化成恒等」只有在这里才读得出来。
  const flipped = cloneState(state);
  flipped.initiative = 1;
  expect(echoesOf(fightOnce(flipped, deps).events)).toEqual([theirs, mine1, mine2]);
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 匹配**不能**跟着入栈一起推迟：`collectOrderedTriggers` 读的是**当下**的盘面
// ═══════════════════════════════════════════════════════════════════════════
// `applyStrikes` 把第 ④ 步拆成两半：逐击**匹配 + 排序**、整批之后**一次入栈**。
// 「入栈推迟」由上面两节钉着；「匹配不许跟着推迟」在此之前只是一句注释 ——
// 实测把匹配也挪到批次末尾一次性做，整套测试全绿。这一条补上那道防线。
//
// ── 判别力从哪来：批次期间**会变、而且触发器读得到**的读数 ────────────────────
// 第一反应是"让第一击打死的单位带触发器、再用 `zone` 判它还在不在场"—— 那条路走不通：
// 第 ③ 步**跳过死亡结算**，被打死的单位仍然站在场上，`zone` 全程是 `board`
// （那种形态属于 `resolve/deaths.ts` 的多波结算，不属于战斗批次）。
// 会变的是**血量**：`cond.dead` 判的是 `damage >= tags.health`
// （`state/queries.ts` 的 `isLethal`），而伤害是一击一击累加的。
//
// 盘面：三击打同一个 2 血的靶子；宿主挂着一对**互斥**的触发器 ——「靶子还活着」敲 5 点、
// 「靶子已致死」敲 9 点。`struck` 在 `act.hit` **之前**发出（v2 §3.4：strike 内部走 hit
// 管线），所以三次匹配时靶子的累计伤害分别是 0 / 1 / 2 ⇒ 逐击匹配读到 [5, 5, 9]；
// 整批打完再匹配则三次都拿最终盘面判（累计 3 点，早就致死）⇒ [9, 9, 9]。

test("★ 匹配不能推迟到批次末尾：逐击匹配读到的是**那一刻**的盘面", () => {
  const state = openGame();
  // 2 血的靶子（0 atk ⇒ 不还手）：三击各 1 点，第 3 击出手时它已经致死 ——
  // 但第 ③ 步不结算死亡，它仍然站在场上。
  const victim = putUnit(state, 1, 0, { atk: 0, health: 2 });
  const victimDead: Cond = { op: "cond.dead", of: { op: "sel.entity", id: victim } };
  const aliveProbe: Card = scriptCard("T_ALIVE_PROBE", {
    triggers: [
      {
        on: "struck",
        cond: { op: "cond.not", of: victimDead },
        do: [{ op: "act.hit", target: { op: "sel.opponent" }, amount: 5 }],
      },
      {
        on: "struck",
        cond: victimDead,
        do: [{ op: "act.hit", target: { op: "sel.opponent" }, amount: 9 }],
      },
    ],
  });
  const deps = cardDeps([aliveProbe]);
  const probe = putCard(state, 0, 4, aliveProbe, { atk: 0, health: 9 });
  // 三个 1 攻的攻击者，靠 direction 全部对准 p1 的 0 号格（v2 §2.3：direction 可为负）。
  const first = putUnit(state, 0, 0, { atk: 1, health: 9 });
  const second = putUnit(state, 0, 1, { atk: 1, health: 9, direction: -1 });
  const third = putUnit(state, 0, 2, { atk: 1, health: 9, direction: -2 });

  const combat = fightOnce(state, deps);

  // ★ 三条回声的数值就是三次匹配各自看到的盘面：
  //   逐击匹配（本实现）→ [5, 5, 9]
  //   批次末尾一次性匹配 → [9, 9, 9]（三次都拿最终盘面判）
  expect(damagedBy(combat.events)).toEqual([
    [first, 1],
    [second, 1],
    [third, 1],
    [probe, 5],
    [probe, 5],
    [probe, 9],
  ]);
  // 三击真的都落在同一个靶子身上（direction 摆错会让这一行先红，顺序断言就不会误导）。
  expect(damageOf(combat.state, victim)).toBe(3);
  expect(damageOf(combat.state, baseIdOf(combat.state, 1))).toBe(5 + 5 + 9);
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
 * 沿用 M3 的桩手法（在 `act.hit` 之后挂一段自己的逻辑；同批的另一张桩已被
 * {@link DEATH_GUARD} 这张真亡语卡取代），也同样把"只生效一次"的判据写成**状态**
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
        // 这个桩不接 bundle，重算只需要把 `base` 派生到 `tags`（两个 Σ 都是空和）。
        refreshAuras(env.state, NO_DEPS);
      },
    },
  };
}

test("★ 批次中途改 atk ⇒ 那一击仍按冻结值打出（v2 §4.2：记录后全部冻结）", () => {
  // ── 这条测试断言的是「打出去的数是冻结的那个」 ──────────────────────────
  // M3 做不到这件事：IR 的 `act.strike` 当时没有 `amount` 字段，冻结值没法随动作
  // 走管线，真打出去的数由 `strikeHandler` 在应用那一刻重读 `attacker.tags.atk`。
  // 那时这里断言的是一道**运行时哨兵**会不会抛（`StrikeAmountDriftError`）。
  // M5/T5 给 IR 加了运行时超集字段 `act.strike.amount`（irVersion 2.3.0），
  // `rules/combat.ts` 的 `strikeActOf` 把冻结值填进去、`strikeHandler` 直接用它 ——
  // 哨兵与它的错误类一并删除，这条测试按 M3 留下的话改写：**桩与盘面一行没动，
  // 只换了最后几行断言**。
  //
  // 桩在这里的角色不变：站位"能在批次中途改 atk 的东西"。真卡形态的两条路径
  // （拦截器的 `then` / 光环中途失效）各有一条真卡测试，见下面与
  // `resolve/__tests__/auras.test.ts`。
  const state = openGame();
  const first = putUnit(state, 0, 0, { atk: 2, health: 9 }); // 先出手
  const second = putUnit(state, 0, 1, { atk: 3, health: 9 }); // 快照冻的是 3
  const victimA = putUnit(state, 1, 0, { atk: 0, health: 20 }); // 靶子：0 atk ⇒ 不还手
  const victimB = putUnit(state, 1, 1, { atk: 0, health: 20 });

  const plan = planStrikes(state);
  expect(plan.map((planned) => planned.attacker)).toEqual([first, second]);
  expect(plan.map((planned) => planned.amount)).toEqual([2, 3]);

  // 第一击的伤害一落地，就把 `second` 的 atk 从 3 拉到 9。
  const step = fightOnce(state, boostAtkOnFirstHit(second, 9));

  // ★ 第二击照样只打 3 —— 冻结值随 `act.strike.amount` 走完了管线。
  //   `strikeActOf` 里删掉 `amount:` 那一行（IR 里它是可选字段，**不会有类型错误**）
  //   会读到 9：这正是 M5/T5 之前的行为。
  expect(damageOf(step.state, victimA)).toBe(2);
  expect(damageOf(step.state, victimB)).toBe(3);
  // `struck` 是"出手这件事"，它的 amount 同样是冻结值（v2 §5 的负载定义）。
  const struck = step.events.filter((event) => event.name === "struck");
  expect(struck.map((event) => (event.name === "struck" ? event.amount : -1))).toEqual([2, 3]);
  // 而盘面上 `second` 的生效 atk 确实已经是 9 —— 断言这一条才能把"冻结生效了"与
  // "桩根本没跑起来"分开（少了它，一个空桩也能让上面两条绿）。
  expect(getEntity(step.state, second)?.tags.atk).toBe(9);
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ 冻结的两条**真卡**路径（M5/T5 实测：这两条都能在批次中途改 atk）
// ═══════════════════════════════════════════════════════════════════════════
// M5 落地之后，「批次中途没有任何东西能改 atk」这条 M3 的结构性论证已经**为假**。
// 实测三条路各自的结论（这不是推测，三张卡都跑过一局）：
//   触发器（T1）**改不了** —— 第 ③ 步只匹配、只排序，入栈推迟到整批之后，
//     一张 `on:"struck"` 自加攻的卡在批次期间盘面纹丝不动（它的效果落在下一轮，
//     由本节第二条测试正面钉住）。
//   拦截器（T2）**能改** —— `effect` 只改动作，但 `then` 是一串普通动作、被
//     `harvest` 收进本地链条当场跑。真卡测试在 `resolve/__tests__/auras.test.ts`
//     （拦截器 `then` 挂加攻附魔，由逐击的第 ⑥ 步重算进生效值）。
//   光环（T3）**能改，而且一个动作都不用执行** —— 下面这一条。

/**
 * 「**我还活着**时，友军全体 +2 攻」—— 一张普通的领主型光环卡，一条触发器都没有。
 *
 * `cond.dead` 的判据是**血量归零**（`eval/cond.ts` 复用 `isLethal`），
 * **不问在不在场** —— 而战斗第 ③ 步恰恰不结算死亡，被打成致死的单位仍站在格子上。
 * 于是「宿主中途变成致死」这一刻，整条光环失效，全场友军的生效 atk 当场掉 2，
 * 而这一步是第 ⑥ 步 `refreshAuras` 自己算出来的，没有任何动作参与。
 */
const ALIVE_LORD: Card = scriptCard("T_ALIVE_LORD", {
  auras: [
    {
      affects: { op: "sel.zone", side: "friendly", zone: ["board"] },
      mods: { atk: 2 },
      cond: { op: "cond.not", of: { op: "cond.dead", of: { op: "sel.self" } } },
    },
  ],
});

test("★ 光环在批次中途失效（宿主变致死）⇒ 后面那一击仍按冻结值打出", () => {
  // p0 先手 ⇒ 快照序 [p0 格 0→8, p1 格 0→8]：p0 那一击先落地，把光环源打成致死。
  const state = openGame();
  const slayer = putUnit(state, 0, 0, { atk: 5, health: 9 });
  const lord = putCard(state, 1, 0, ALIVE_LORD, { atk: 1, health: 1 });
  const ally = putUnit(state, 1, 1, { atk: 3, health: 9 }); // 生效 3+2 = 5
  const wall = putUnit(state, 0, 1, { atk: 0, health: 30 }); // ally 的靶子，不还手
  const deps = cardDeps([ALIVE_LORD]);

  // 摆盘夹具只写 `base`/`tags`，光环要等下一次重算才算得进去（真实路径上由
  // `rules/phase.ts` 的 `runStep` 负责）—— 这里手动补一次，好让下面那条断言读到
  // 战斗真正看到的那个盘面。
  refreshAuras(state, deps);
  // 快照读的是**生效值**：lord 冻的是 1+2 = 3，ally 冻的是 3+2 = 5。
  expect(planStrikes(state).map((planned) => planned.amount)).toEqual([5, 3, 5]);

  const step = fightOnce(state, deps);

  // 前提成立：lord 在自己出手**之前**就被打成致死（5 ≥ 1），第 ④ 步把它收进墓地。
  expect(getZone(step.state, 1, "graveyard")).toContain(lord);
  // ★ 致死那一刻光环当场失效 ⇒ 生效 atk 掉回去。但两击都已经冻结：
  expect(damageOf(step.state, slayer)).toBe(3); // lord 打的是冻结的 3，不是 1
  expect(damageOf(step.state, wall)).toBe(5); // ally 打的是冻结的 5，不是 3
  // 光环真的失效了 —— 少了这一条，一个"光环压根没生效"的实现也能让上面两条绿。
  //（lord 已经进墓地，读 ally 就够：它还在场上。）
  expect(getEntity(step.state, ally)?.tags.atk).toBe(3);
});

/**
 * 「每当**我**出手，我 +2 攻」（`act.mod_tag` 写 `base`，见 `handlers/tags.ts`）。
 *
 * 触发器在第 ③ 步只入栈不结算，所以这 +2 落在**第 ④ 步**（开闸）之后 ——
 * 对本轮已经冻结的出手毫无影响，但下一轮的快照读得到它。
 */
const RAGE_ON_STRIKE: Card = scriptCard("T_RAGE_ON_STRIKE", {
  triggers: [
    {
      on: "struck",
      filter: { source: { op: "sel.self" } },
      do: [{ op: "act.mod_tag", target: { op: "sel.self" }, tag: "atk", delta: 2 }],
    },
  ],
});

test("★ 冻结只冻**这一轮**：本轮加的攻下一轮的快照读得到", () => {
  const state = openGame();
  const rager = putCard(state, 0, 0, RAGE_ON_STRIKE, { atk: 3, health: 9 });
  const dummy = putUnit(state, 1, 0, { atk: 0, health: 30 });
  const deps = cardDeps([RAGE_ON_STRIKE]);

  // 第 1 轮：冻的是 3，打 3；触发器在第 ④ 步开闸后才把 atk 加到 5。
  const round1 = fightOnce(state, deps);
  expect(damageOf(round1.state, dummy)).toBe(3);
  expect(getEntity(round1.state, rager)?.tags.atk).toBe(5);

  // 第 2 轮：新快照读到 5，打 5（累计 8）。
  // ★ 这一条是「冻结」的反面：把冻结值缓存进状态、或让 `planStrikes` 只算一次，
  //   上面几条测试全绿，这一条会读到 6。
  const round2 = fightOnce(round1.state, deps);
  expect(damageOf(round2.state, dummy)).toBe(8);
  expect(getEntity(round2.state, rager)?.tags.atk).toBe(7);
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
