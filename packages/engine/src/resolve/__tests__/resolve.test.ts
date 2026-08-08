// resolve/ 的单元测试。
//
// 测的不是"函数返回了什么"，而是**框架 §4.1 的四条时序规则**与**框架 §4.2 的挂起能力**
// 这两样会随时间腐化的东西：
//   规则 1 → compareTriggerOrder / sortTriggers / activePlayer
//   规则 2 → queueTriggers 只入栈不执行；pushActs 的 LIFO 反转
//   规则 3 → processDeaths 批量、跑到不动点、base 归零判胜负
//   规则 4 → refreshAuras 整体重算（写 tags 会被抹掉、写 base 才留得住）
//   §4.2  → 挂起点可整个 JSON 落盘，revive 之后 resume 得到同样的结果
//
// 注：这里**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1：engine 对 ir 只能是
// 纯类型依赖），规则参数用本文件的字面量夹具。

import { expect, test } from "bun:test";
import type { Act, RulesConfig } from "@prismfront/ir";
import { emitEvent } from "../../events/index.ts";
import { NO_DEPS, NO_HANDLERS } from "../../handlers/index.ts";
import { createRngState } from "../../rng/index.ts";
import type { CtxBindings, EntityData, GameState, PlayerId } from "../../state/index.ts";
import {
  baseOf,
  cloneState,
  createCtx,
  createInitialState,
  createTagValues,
  getEntity,
  getZone,
  NO_FLAGS,
  zoneKey,
} from "../../state/index.ts";
import type { HandlerTable, QueuedTrigger, ResolveDeps } from "../index.ts";
import {
  activePlayer,
  applyInterceptors,
  compareTriggerOrder,
  defaultInputChoice,
  enqueueTriggers,
  InvalidChoiceError,
  isCancelled,
  MAX_RESOLUTION_DEPTH,
  NotSuspendedError,
  processDeaths,
  pushAct,
  pushActs,
  pushPending,
  pushPendingInOrder,
  pushScript,
  queueTriggers,
  ResolutionLoopError,
  refreshAuras,
  resolve,
  resume,
  resumeWithTimeout,
  runHandler,
  sortTriggers,
  suspend,
} from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════════════════

const RULES: RulesConfig = {
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
};

function freshState(): GameState {
  return createInitialState({
    rules: RULES,
    rng: createRngState(0x9f1),
    decks: [[], []],
    bundleId: "pf1@test",
  });
}

interface UnitInit {
  atk?: number;
  health?: number;
  /** 原始拥有者。缺省 = 控制者（`act.steal` 之后两者可以不同）。 */
  owner?: PlayerId;
}

/**
 * 直接摆一个单位到 `player` 的第 `slot` 格。
 *
 * M2 没有 `act.summon` 的真 handler（那是 M4），测试要盘面就自己摆 ——
 * 摆的时候维护 `state/index.ts` 列的四条一致性不变量（实体表 / 区域表 / 格位三处同步）。
 */
function placeUnit(state: GameState, player: PlayerId, slot: number, init: UnitInit): EntityData {
  const id = state.nextEntityId;
  state.nextEntityId += 1;
  const playOrder = state.nextPlayOrder;
  state.nextPlayOrder += 1;
  const key = zoneKey(player, "board");
  const tags = createTagValues({ atk: init.atk ?? 1, health: init.health ?? 1 });
  const entity: EntityData = {
    id,
    cardId: `TEST_${id}`,
    owner: init.owner ?? player,
    zone: key,
    slot,
    playOrder,
    base: createTagValues(tags),
    tags,
    baseFlags: NO_FLAGS,
    flags: NO_FLAGS,
    enchantments: [],
    damage: 0,
    respawnAt: null,
  };
  state.entities[id] = entity;
  state.zones[key].push(id);
  state.slots[player][slot] = id;
  return entity;
}

/** `act.hit` 的临时 handler：不求值 Sel，直接打 `ctx.target`，`amount` 只认字面量。 */
function hitAct(amount: number): Act {
  return { op: "act.hit", target: { op: "sel.target" }, amount };
}

/** 记录 handler 调用顺序的接线。M2 的 handler 是手写临时件，测试里就地造即可。 */
function tracingDeps(): { deps: ResolveDeps; trace: string[] } {
  const trace: string[] = [];
  const handlers: HandlerTable = {
    ...NO_HANDLERS,
    "act.nothing": () => {
      trace.push("nothing");
    },
    "act.hit": (env, act) => {
      const amount = typeof act.amount === "number" ? act.amount : 0;
      trace.push(`hit:${amount}`);
      const target = env.ctx.target === null ? undefined : getEntity(env.state, env.ctx.target);
      if (target === undefined) {
        return;
      }
      target.damage += amount;
      emitEvent(env.state, { name: "damaged", source: env.ctx.self, target: target.id, amount });
    },
  };
  return { deps: { handlers }, trace };
}

/** 互相出手一次的临时 handler：`self` 与 `ctx.target` 同时挨打 —— 用来验"同归于尽"。 */
const MUTUAL_STRIKE: HandlerTable = {
  ...NO_HANDLERS,
  "act.strike": (env) => {
    const attacker = getEntity(env.state, env.ctx.self);
    const target = env.ctx.target === null ? undefined : getEntity(env.state, env.ctx.target);
    if (attacker === undefined || target === undefined) {
      return;
    }
    const out = attacker.tags.atk;
    const back = target.tags.atk;
    target.damage += out;
    emitEvent(env.state, { name: "struck", source: attacker.id, target: target.id, amount: out });
    attacker.damage += back;
    emitEvent(env.state, { name: "struck", source: target.id, target: attacker.id, amount: back });
  },
};

const STRIKE: Act = {
  op: "act.strike",
  attacker: { op: "sel.self" },
  target: { op: "sel.target" },
};

function ctxOf(self: number, target: number | null = null): CtxBindings {
  return { self, target, chosen: null, it: null, event: null };
}

// ═══════════════════════════════════════════════════════════════════════════
// 六步流水线本身
// ═══════════════════════════════════════════════════════════════════════════

test("resolve 把栈跑空并返回事件流，返回后 eventLog 必为空", () => {
  const state = freshState();
  const unit = placeUnit(state, 1, 0, { health: 5 });
  const { deps } = tracingDeps();

  pushAct(state, hitAct(2), ctxOf(0, unit.id));
  const events = resolve(state, deps);

  expect(state.stack).toHaveLength(0);
  // events/log.ts 的不变量：apply() / resume() 返回时 state.eventLog 必为空。
  expect(state.eventLog).toHaveLength(0);
  expect(events).toHaveLength(1);
  expect(events[0]?.name).toBe("damaged");
  expect(unit.damage).toBe(2);
});

test("Act[] 按数组下标升序执行（栈是 LIFO，反转只在 push.ts 里发生）", () => {
  const state = freshState();
  const { deps, trace } = tracingDeps();

  pushActs(state, [hitAct(1), hitAct(2), hitAct(3)], createCtx(0));
  resolve(state, deps);

  expect(trace).toEqual(["hit:1", "hit:2", "hit:3"]);
});

test("静默跳过的 op 不打断流水线：前后两条照跑", () => {
  const state = freshState();
  const { deps, trace } = tracingDeps();

  // act.silence 在这张表里是静默跳过的（M4 起表是完整的，占位与真 handler 都在表里），
  // 它夹在两个有副作用的动作中间。
  pushActs(
    state,
    [hitAct(1), { op: "act.silence", target: { op: "sel.self" } }, hitAct(2)],
    createCtx(0),
  );
  const events = resolve(state, deps);

  expect(trace).toEqual(["hit:1", "hit:2"]);
  expect(events).toHaveLength(0); // 没有目标，两次 hit 都没发事件
  // ★ 表收紧成 `Record<ActOp, …>` 之后 `runHandler` 只在**无效槽**时回 false，
  //   「表里漏了一项」已经是编译错误而不是运行期的一条 false（见 `deps.ts`）。
  expect(runHandler(state, createCtx(0), { op: "act.nothing" }, NO_DEPS)).toBe(true);
});

test("展不开的脚本引用静默跳过（M2 没有卡表，expandScript 缺省）", () => {
  const state = freshState();
  const { deps, trace } = tracingDeps();

  pushScript(state, "CORE_050#play.1", createCtx(0));
  const events = resolve(state, deps);

  expect(trace).toEqual([]);
  expect(events).toHaveLength(0);
  expect(state.stack).toHaveLength(0);
});

test("接上 expandScript 之后，栈里的引用条目照常执行（M4 的接线点）", () => {
  const state = freshState();
  const { deps, trace } = tracingDeps();
  const expanded: string[] = [];

  pushScript(state, "CORE_050#play.1", createCtx(0));
  pushScript(state, "CORE_050#play.404", createCtx(0));
  resolve(state, {
    ...deps,
    expandScript: (_s, ref) => {
      expanded.push(ref);
      return ref.endsWith(".1") ? hitAct(7) : null; // 查不到的路径 → null → 静默跳过
    },
  });

  expect(expanded).toEqual(["CORE_050#play.404", "CORE_050#play.1"]);
  expect(trace).toEqual(["hit:7"]);
});

test("pushPendingInOrder：给的是执行顺序，入栈时由 push.ts 做那一次 LIFO 反转", () => {
  const state = freshState();
  const { deps, trace } = tracingDeps();
  const ctx = createCtx(0);

  pushPending(state, { via: "inline", act: hitAct(9), ctx });
  pushPendingInOrder(state, [
    { via: "inline", act: hitAct(1), ctx },
    { via: "inline", act: hitAct(2), ctx },
  ]);
  resolve(state, deps);

  // 先压的 9 在栈底，最后跑；成批压入的 1、2 保持给定顺序。
  expect(trace).toEqual(["hit:1", "hit:2", "hit:9"]);
});

test("步数超过 MAX_RESOLUTION_DEPTH → ResolutionLoopError，抛错前已排空事件日志", () => {
  const state = freshState();
  const handlers: HandlerTable = {
    ...NO_HANDLERS,
    "act.nothing": (env) => {
      emitEvent(env.state, { name: "player_passed", player: 0 });
      pushAct(env.state, { op: "act.nothing" }, env.ctx); // 自我复制 = 真环
    },
  };
  pushAct(state, { op: "act.nothing" }, createCtx(0));

  let caught: unknown = null;
  try {
    resolve(state, { handlers });
  } catch (error) {
    caught = error;
  }

  expect(caught instanceof ResolutionLoopError).toBe(true);
  const loop = caught as ResolutionLoopError;
  expect(loop.limit).toBe(MAX_RESOLUTION_DEPTH);
  // 抛错路径同样遵守「返回时 eventLog 为空」，事件挂在错误对象上不丢。
  expect(state.eventLog).toHaveLength(0);
  expect(loop.events).toHaveLength(MAX_RESOLUTION_DEPTH);
});

// ═══════════════════════════════════════════════════════════════════════════
// 三个 M5 挂钩点：恒等空实现（不是抛异常的占位符）
// ═══════════════════════════════════════════════════════════════════════════

test("拦截器：M2 恒等 —— 动作原样返回，永不 CANCELLED", () => {
  const state = freshState();
  const act = hitAct(3);
  const result = applyInterceptors(state, createCtx(0), act);

  expect(isCancelled(result)).toBe(false);
  expect(result).toBe(act);
});

test("触发：M2 无订阅源 —— queueTriggers 一条都不入栈", () => {
  const state = freshState();
  const queued = queueTriggers(state, [
    { name: "unit_died", target: 1, slot: 0 },
    { name: "engine.random_picked", origin: "shuffle", max: 4, result: 2 },
  ]);

  expect(queued).toBe(0);
  expect(state.stack).toHaveLength(0);
});

test("光环：重算而非增量 —— 写 tags 会被抹掉，写 base 才留得住", () => {
  const state = freshState();
  const unit = placeUnit(state, 0, 0, { atk: 2, health: 3 });

  unit.tags.atk = 99; // 写进派生值 = 写进一个下一步就被覆盖的缓存
  unit.base.atk = 5; // 写进 base 才是持久的
  refreshAuras(state);

  expect(unit.tags.atk).toBe(5);
  expect(unit.tags.health).toBe(3);
  expect(unit.flags).toBe(unit.baseFlags);
});

test("光环重算覆盖全部实体（手牌里的牌也吃光环，例如费用修正）", () => {
  const state = freshState();
  const base0 = baseOf(state, 0);
  expect(base0).toBeDefined();
  if (base0 === undefined) {
    return;
  }
  base0.tags.health = 1;
  refreshAuras(state);
  expect(base0.tags.health).toBe(RULES.baseHp);
});

// ═══════════════════════════════════════════════════════════════════════════
// 时序规则 1：触发排序
// ═══════════════════════════════════════════════════════════════════════════

test("activePlayer：actions 相位看 priority，其余相位看 initiative", () => {
  const state = freshState();
  state.initiative = 0;
  state.priority = 1;

  state.phase = "actions";
  expect(activePlayer(state)).toBe(1);

  state.phase = "combat";
  expect(activePlayer(state)).toBe(0);
  state.phase = "round_start";
  expect(activePlayer(state)).toBe(0);
});

test("规则 1：当前回合玩家优先，同方按 playOrder 升序", () => {
  const state = freshState();
  state.phase = "actions";
  state.priority = 0;

  const mine1 = placeUnit(state, 0, 0, {}); // playOrder 小
  const theirs = placeUnit(state, 1, 0, {});
  const mine2 = placeUnit(state, 0, 1, {}); // playOrder 大

  const q = (owner: number): QueuedTrigger => ({
    owner,
    pending: { via: "inline", act: { op: "act.nothing" }, ctx: createCtx(owner) },
  });
  const ordered = sortTriggers(state, [q(theirs.id), q(mine2.id), q(mine1.id)]);

  expect(ordered.map((t) => t.owner)).toEqual([mine1.id, mine2.id, theirs.id]);
  // 换成对手持有优先权，顺序整体翻面。
  state.priority = 1;
  const flipped = sortTriggers(state, [q(mine1.id), q(theirs.id), q(mine2.id)]);
  expect(flipped.map((t) => t.owner)).toEqual([theirs.id, mine1.id, mine2.id]);
});

test("规则 2：触发只入栈不执行，且排在前面的先出栈（enqueueTriggers 的逆序）", () => {
  const state = freshState();
  const { deps, trace } = tracingDeps();
  const ctx = createCtx(0);
  const q = (owner: number, amount: number): QueuedTrigger => ({
    owner,
    pending: { via: "inline", act: hitAct(amount), ctx },
  });

  const pushed = enqueueTriggers(state, [q(1, 1), q(2, 2), q(3, 3)]);

  expect(pushed).toBe(3);
  expect(trace).toEqual([]); // 只入栈，一条都没执行
  expect(state.stack).toHaveLength(3);
  resolve(state, deps);
  expect(trace).toEqual(["hit:1", "hit:2", "hit:3"]);
});

test("规则 1：宿主实体已消失 → 排到最后，而不是抛错", () => {
  const state = freshState();
  state.phase = "actions";
  state.priority = 0;
  const alive = placeUnit(state, 1, 0, {});
  const q = (owner: number): QueuedTrigger => ({
    owner,
    pending: { via: "inline", act: { op: "act.nothing" }, ctx: createCtx(owner) },
  });

  expect(compareTriggerOrder(state, q(alive.id), q(9999)) < 0).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 时序规则 3：死亡结算
// ═══════════════════════════════════════════════════════════════════════════

test("规则 3：批量判定 —— 同归于尽成立（先死的照样打出伤害）", () => {
  const state = freshState();
  const a = placeUnit(state, 0, 3, { atk: 3, health: 3 });
  const b = placeUnit(state, 1, 3, { atk: 3, health: 3 });

  pushAct(state, STRIKE, ctxOf(a.id, b.id));
  const events = resolve(state, { handlers: MUTUAL_STRIKE });

  expect(getEntity(state, a.id)?.zone).toBe("p0:graveyard");
  expect(getEntity(state, b.id)?.zone).toBe("p1:graveyard");
  expect(state.slots[0][3]).toBeNull();
  expect(state.slots[1][3]).toBeNull();
  // 两次 struck + 两条 unit_died；死亡事件按 playOrder 升序（a 先上场）。
  expect(events.map((e) => e.name)).toEqual(["struck", "struck", "unit_died", "unit_died"]);
  expect(events[2]).toEqual({ name: "unit_died", target: a.id, slot: 3 });
  expect(events[3]).toEqual({ name: "unit_died", target: b.id, slot: 3 });
});

test("规则 3：一波之内批量处理，处理完即到不动点", () => {
  const state = freshState();
  const first = placeUnit(state, 0, 0, { health: 1 });
  const second = placeUnit(state, 0, 1, { health: 1 });
  first.damage = 1;
  second.damage = 1;

  const report = processDeaths(state);

  // 两个一起死 = 一波，而不是一人一波（"批量"是同归于尽能成立的全部原因）。
  // 多于一波要等 M5 的亡语（亡语造成的新伤害才会引出第二波）。
  expect(report.waves).toBe(1);
  expect(report.died).toEqual([first.id, second.id]);
  expect(processDeaths(state).waves).toBe(0);
});

test("死亡的单位回**原主**的墓地（被偷走的单位不改变牌张归属）", () => {
  const state = freshState();
  // owner = p0，却站在 p1 的战线上 —— act.steal 之后的形态。
  const stolen = placeUnit(state, 1, 2, { health: 1, owner: 0 });
  stolen.damage = 1;

  processDeaths(state);

  expect(stolen.zone).toBe("p0:graveyard");
  expect(stolen.slot).toBeNull();
  expect(getZone(state, 0, "graveyard")).toEqual([stolen.id]);
  expect(getZone(state, 1, "board")).toEqual([]);
});

test("手牌/牌库里的实体不参与死亡判定（它们 health 为 0）", () => {
  const state = createInitialState({
    rules: RULES,
    rng: createRngState(1),
    decks: [["A", "B"], ["C"]],
  });
  const report = processDeaths(state);

  expect(report.died).toEqual([]);
  expect(getZone(state, 0, "deck")).toHaveLength(2);
  expect(getZone(state, 0, "graveyard")).toHaveLength(0);
});

test("base 归零 → winner + phase over；base 不进墓地、不发 unit_died", () => {
  const state = freshState();
  const base1 = baseOf(state, 1);
  expect(base1).toBeDefined();
  if (base1 === undefined) {
    return;
  }
  base1.damage = RULES.baseHp;

  const report = processDeaths(state);

  expect(state.winner).toBe(0);
  expect(state.phase).toBe("over");
  expect(report.died).toEqual([]);
  expect(base1.zone).toBe("p1:base");
  expect(state.eventLog).toHaveLength(0);
});

test("双方 base 同时归零 → 平局", () => {
  const state = freshState();
  for (const player of [0, 1] as const) {
    const base = baseOf(state, player);
    if (base !== undefined) {
      base.damage = RULES.baseHp;
    }
  }
  processDeaths(state);
  expect(state.winner).toBe("draw");
  expect(state.phase).toBe("over");
});

test("对局结束后 resolve 立即停下，栈上剩余条目原样保留", () => {
  const state = freshState();
  const base1 = baseOf(state, 1);
  if (base1 === undefined) {
    return;
  }
  base1.damage = RULES.baseHp - 1;
  const { deps, trace } = tracingDeps();

  pushActs(state, [hitAct(1), hitAct(1)], ctxOf(0, base1.id));
  resolve(state, deps);

  expect(state.winner).toBe(0);
  expect(trace).toEqual(["hit:1"]); // 第二条没跑
  // 栈上的剩余条目由 `rules/phase.ts` 的 `concludeMatch` 在这一整段结算之后清掉
  //（`advancePhases` 观察到 winner 时），`resolve()` 自己留着它 —— 复现"终局那一刻
  // 栈里还有什么"要用它，见 resolve.ts 文件头偏离 B。
  expect(state.stack).toHaveLength(1);
});

test("★ winner 进来时就非空 ⇒ resolve 一条都不弹（判断在 pop 之前）", () => {
  // 上一条测的是"结算中途判出胜负"，这一条测的是**入口**：战斗第 ④ 步打穿 base 之后，
  // 相位机与 `settleCombat` 都会拿着一个 `winner` 已非空的状态再调一次 `resolve()`。
  // 判断若留在循环体末尾，这里会先弹掉并执行栈顶一条才退出 —— 而那一条多半是亡语或
  // 触发器，正是偏离 B 说的"在终局之后凭空生效"。
  const state = freshState();
  const unit = placeUnit(state, 1, 0, { health: 9 });
  const { deps, trace } = tracingDeps();

  pushActs(state, [hitAct(1), hitAct(2)], ctxOf(0, unit.id));
  // `winner !== null ⇔ phase === "over"`（`state/game-state.ts`）：两个字段一起写。
  state.winner = 0;
  state.phase = "over";

  const events = resolve(state, deps);

  expect(trace).toEqual([]);
  expect(events).toEqual([]);
  expect(state.stack).toHaveLength(2);
  expect(unit.damage).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 框架 §4.2：挂起与恢复
// ═══════════════════════════════════════════════════════════════════════════

/** 挂起类动作的 handler 契约：**先把续跑动作压回栈，再 suspend**（见 suspend.ts 文件头）。 */
const DISCOVER_THEN_HIT: HandlerTable = {
  ...NO_HANDLERS,
  "act.discover": (env) => {
    pushAct(env.state, hitAct(4), env.ctx);
    suspend(env.state, {
      player: 0,
      kind: "discover",
      options: [101, 102],
      optional: false,
      deadline: null,
    });
  },
  "act.hit": (env, act) => {
    const amount = typeof act.amount === "number" ? act.amount : 0;
    const target = env.ctx.target === null ? undefined : getEntity(env.state, env.ctx.target);
    if (target === undefined) {
      return;
    }
    target.damage += amount;
    emitEvent(env.state, {
      name: "damaged",
      source: typeof env.ctx.chosen === "number" ? env.ctx.chosen : null,
      target: target.id,
      amount,
    });
  },
};

function suspendedState(): { state: GameState; unitId: number } {
  const state = freshState();
  const unit = placeUnit(state, 1, 0, { health: 9 });
  pushAct(state, { op: "act.discover", from: { op: "sel.self" } }, ctxOf(0, unit.id));
  const events = resolve(state, { handlers: DISCOVER_THEN_HIT });
  expect(events).toHaveLength(0);
  return { state, unitId: unit.id };
}

test("挂起：pendingInput 一置上，结算循环 break，续跑动作留在栈上", () => {
  const { state } = suspendedState();

  expect(state.pendingInput?.kind).toBe("discover");
  expect(state.stack).toHaveLength(1);
  expect(state.eventLog).toHaveLength(0);
});

test("挂起点可以整个 JSON 落盘再 resume，结果与不落盘完全一致（§4.2 / 架构 §6.1 第二条）", () => {
  const direct = suspendedState();
  const revivedPair = suspendedState();
  const revived = cloneState(revivedPair.state);

  // 落盘 → 复活：状态逐字相等，说明栈条目与挂起点里没有任何不可序列化的东西。
  expect(JSON.stringify(revived)).toBe(JSON.stringify(revivedPair.state));

  const a = resume(direct.state, { chosen: 102 }, { handlers: DISCOVER_THEN_HIT });
  const b = resume(revived, { chosen: 102 }, { handlers: DISCOVER_THEN_HIT });

  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  expect(JSON.stringify(direct.state)).toBe(JSON.stringify(revived));
});

test("resume 把选择写进栈顶条目的 ctx.chosen，栈顶动作从中断处继续", () => {
  const { state, unitId } = suspendedState();

  const events = resume(state, { chosen: 102 }, { handlers: DISCOVER_THEN_HIT });

  expect(state.pendingInput).toBeNull();
  expect(state.stack).toHaveLength(0);
  expect(events).toEqual([{ name: "damaged", source: 102, target: unitId, amount: 4 }]);
  expect(getEntity(state, unitId)?.damage).toBe(4);
  expect(state.eventLog).toHaveLength(0);
});

test("resume 校验：不在候选集内 / 不可放弃却放弃 → InvalidChoiceError", () => {
  const bad = suspendedState().state;
  expect(() => resume(bad, { chosen: 999 }, { handlers: DISCOVER_THEN_HIT })).toThrow(
    "不在 pendingInput.options 内",
  );
  expect(bad.pendingInput).not.toBeNull();

  const giveUp = suspendedState().state;
  let caught: unknown = null;
  try {
    resume(giveUp, { chosen: null }, { handlers: DISCOVER_THEN_HIT });
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof InvalidChoiceError).toBe(true);
});

test("resume 校验：没有挂起点 → NotSuspendedError", () => {
  const state = freshState();
  let caught: unknown = null;
  try {
    resume(state, { chosen: 1 }, NO_DEPS);
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof NotSuspendedError).toBe(true);
});

test("可放弃的挂起点允许 chosen: null", () => {
  const state = freshState();
  suspend(state, {
    player: 0,
    kind: "select_target",
    options: [1, 2],
    optional: true,
    deadline: null,
  });
  const events = resume(state, { chosen: null }, NO_DEPS);

  expect(events).toEqual([]);
  expect(state.pendingInput).toBeNull();
});

test("超时兜底（IR v1 §6.1）：discover 取第一项；可放弃的 select_target 跳过", () => {
  expect(
    defaultInputChoice({
      player: 0,
      kind: "discover",
      options: ["A", "B"],
      optional: false,
      deadline: null,
    }),
  ).toBe("A");
  expect(
    defaultInputChoice({
      player: 1,
      kind: "select_target",
      options: [7, 8],
      optional: true,
      deadline: null,
    }),
  ).toBeNull();
  expect(
    defaultInputChoice({
      player: 1,
      kind: "select_target",
      options: [7, 8],
      optional: false,
      deadline: null,
    }),
  ).toBe(7);
});

test("resumeWithTimeout 走兜底选择；没有挂起点时同样报 NotSuspendedError", () => {
  const { state, unitId } = suspendedState();
  const events = resumeWithTimeout(state, { handlers: DISCOVER_THEN_HIT });

  // discover 兜底取 options[0] = 101。
  expect(events).toEqual([{ name: "damaged", source: 101, target: unitId, amount: 4 }]);

  let caught: unknown = null;
  try {
    resumeWithTimeout(freshState(), NO_DEPS);
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof NotSuspendedError).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 纯数据（框架 §3.1 / §13 坑 3）—— 流水线跑过之后状态里不许长出不可序列化的东西
// ═══════════════════════════════════════════════════════════════════════════

test("结算全程不往状态里塞函数 / class 实例（序列化往返逐字相等）", () => {
  const state = freshState();
  const a = placeUnit(state, 0, 4, { atk: 2, health: 2 });
  const b = placeUnit(state, 1, 4, { atk: 2, health: 5 });
  pushAct(state, STRIKE, ctxOf(a.id, b.id));
  resolve(state, { handlers: MUTUAL_STRIKE });

  expect(JSON.stringify(cloneState(state))).toBe(JSON.stringify(state));
});
