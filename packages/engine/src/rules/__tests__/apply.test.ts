// rules/apply 的单元测试：**挂起 / 回应**这条支路，以及几处只有非法输入才走得到的分支。
//
// 走查测试（`src/__tests__/walkthrough.test.ts`）跑的是成功路径，
// 这里补的是框架 §4.2 的另一半 —— 结算中途停下来等玩家选择，然后 `respond` 接着跑。
// M2/M3 的临时 handler 里没有会挂起的动作（`act.discover` 是 M4），所以本文件自己
// 注入一张会挂起的 handler 表：**`apply` 的 `deps` 参数就是为这种事留的**。
//
// M3 起唯一能被玩家意图直接触到的动作是 `act.move`（`play_card` 压的就是它）——
// `act.strike` 不再有对应的意图（v2 §3.4 删掉 `act.attack`，出手只由战斗快照与
// 卡牌效果驱动），所以挂起点挂在 `act.move` 上，模拟一张「打出时：选一个目标」的牌。
//
// 注：本文件**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1）。

import { expect, test } from "bun:test";
import type { CardId, RulesConfig } from "@prismfront/ir";
import { ACT_HANDLERS, moveHandler } from "../../handlers/index.ts";
import type { HandlerTable, ResolveDeps } from "../../resolve/index.ts";
import { pushAct, ResolutionLoopError, suspend } from "../../resolve/index.ts";
import type { GameState } from "../../state/index.ts";
import { getEntity } from "../../state/index.ts";
import { expectOk, handOf, playCard, setFace, startMatch } from "../../testkit/index.ts";
import type { Intent } from "../index.ts";
import { apply, createGame } from "../index.ts";

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

const DECK: readonly CardId[] = ["PF_X1", "PF_X2", "PF_X3", "PF_X4", "PF_X5", "PF_X6"];

/** p0 起手的第一张（实体 id 写死：p0 base=1、p1 base=2、p0 牌库从 3 起）。 */
const P0_CARD = 3;
/** p1 起手的第一张（p1 牌库从 3 + DECK.length = 9 起）。 */
const P1_CARD = 9;

/**
 * 推进到第 1 回合的 `actions` 相位，p0 已经在 0 号格放了一个 3/9、p1 放了一个 1/9。
 *
 * 不洗牌 + 钉先手：本文件断言的是 `apply` 的分支，盘面必须完全可预测。
 */
function boardState(): GameState {
  const start = createGame(RULES, [DECK, DECK], 1, { shuffle: false, firstPlayer: 0 });
  for (const player of [0, 1] as const) {
    for (const id of handOf(start, player)) {
      setFace(start, id, { atk: 1, health: 9, cost: 0 });
    }
  }
  setFace(start, P0_CARD, { atk: 3, health: 9, cost: 0 });
  setFace(start, P1_CARD, { atk: 1, health: 9, cost: 0 });

  const opened = startMatch(start).state;
  const a = playCard(opened, P0_CARD, 0).state;
  return playCard(a, P1_CARD, 0).state;
}

/**
 * 一张会在把牌放上场之前挂起的 handler 表。
 *
 * 遵守 `resolve/suspend.ts` 的挂起契约：**先把续跑动作压回栈，再 `suspend`**。
 * 用 `ctx.chosen === null` 区分"第一次进来"与"玩家回应之后续跑"——
 * `resume` 会把选择写进栈顶条目的 `ctx.chosen`，也就是刚压回去的那条 `act.move`。
 */
function suspendingDeps(options: readonly number[]): ResolveDeps {
  const handlers: HandlerTable = {
    ...ACT_HANDLERS,
    // 包一层的 handler 要把**全部**参数转交给被包的那个，位置参数 `slots` 也不例外
    // （`resolve/act-slots.ts`：`slots` 是惰性解析器，转交的是"怎么求"而不是求好的值；
    //  自己另造一份就绕过了记忆化，`slot.random_empty` 会多抽一次随机）。
    "act.move": (env, act, slots) => {
      if (env.ctx.chosen === null) {
        pushAct(env.state, act, env.ctx);
        suspend(env.state, {
          player: 0,
          kind: "select_target",
          options,
          optional: false,
          deadline: null,
        });
        return;
      }
      moveHandler(env, act, slots);
    },
  };
  return { handlers };
}

/** 当前 `priority` 方手里的第一张牌。 */
function nextCard(state: GameState): number {
  const card = handOf(state, state.priority)[0];
  if (card === undefined) {
    throw new Error("夹具错误：手牌是空的");
  }
  return card;
}

// ═══════════════════════════════════════════════════════════════════════════
// 框架 §4.2：挂起 → respond
// ═══════════════════════════════════════════════════════════════════════════

test("挂起：apply 照常 ok:true，pendingInput 留在返回的状态里，续跑动作还在栈上", () => {
  const state = boardState();
  const card = nextCard(state);
  const deps = suspendingDeps([card]);

  const step = expectOk(apply(state, { t: "play_card", player: 0, card, slot: 1 }, deps));

  // 相位机的记账段已经跑完（`action_taken` / `card_played` 都发了、行动权已换手），
  // 挂起的是**效果段** —— 这正是 `rules/phase.ts` 那条"先记账后结算"的设计。
  expect(step.events.map((e) => e.name)).toEqual(["action_taken", "card_played"]);
  expect(step.state.priority).toBe(1);
  expect(step.state.pendingInput?.kind).toBe("select_target");
  expect(step.state.stack).toHaveLength(1);
  expect(step.state.eventLog).toEqual([]); // 挂起路径同样排空事件日志
  expect(step.state.seq).toBe(state.seq + 1);
  // 整个挂起点可以直接落盘（框架 §4.2）：状态里没有任何不可序列化的东西。
  expect(JSON.stringify(JSON.parse(JSON.stringify(step.state)))).toBe(JSON.stringify(step.state));
});

test("挂起期间只接受 respond，别的意图一律 awaiting_input", () => {
  const state = boardState();
  const card = nextCard(state);
  const deps = suspendingDeps([card]);
  const suspended = expectOk(
    apply(state, { t: "play_card", player: 0, card, slot: 1 }, deps),
  ).state;

  expect(apply(suspended, { t: "pass", player: 1 }, deps)).toEqual({
    ok: false,
    code: "awaiting_input",
  });
  expect(apply(suspended, { t: "play_card", player: 1, card: P1_CARD, slot: 2 }, deps)).toEqual({
    ok: false,
    code: "awaiting_input",
  });
  // 认输在别的相位都合法，挂起期间同样要让位给 respond —— 否则栈上的续跑动作会被
  // 一个"对局已结束"的状态吞掉，重连回来对不上账。
  expect(apply(suspended, { t: "concede", player: 1 }, deps)).toEqual({
    ok: false,
    code: "awaiting_input",
  });
});

test("respond：选择写进栈顶 ctx.chosen，结算从中断处继续", () => {
  const state = boardState();
  const card = nextCard(state);
  const deps = suspendingDeps([card]);
  const suspended = expectOk(
    apply(state, { t: "play_card", player: 0, card, slot: 1 }, deps),
  ).state;

  const resumed = expectOk(apply(suspended, { t: "respond", player: 0, chosen: card }, deps));

  expect(resumed.state.pendingInput).toBeNull();
  expect(resumed.events.map((e) => e.name)).toEqual(["unit_summoned"]);
  expect(resumed.state.slots[0][1]).toBe(card);
  expect(resumed.state.seq).toBe(suspended.seq + 1);
  // 挂起点跨过去之后相位机接着走：还在 actions 相位，行动权在 p1 手里。
  expect(resumed.state.phase).toBe("actions");
  expect(resumed.state.priority).toBe(1);
});

test("respond 的两类拒绝：不该他选（wrong_player）、选了候选集外的（invalid_choice）", () => {
  const state = boardState();
  const card = nextCard(state);
  const deps = suspendingDeps([card]);
  const suspended = expectOk(
    apply(state, { t: "play_card", player: 0, card, slot: 1 }, deps),
  ).state;
  const before = JSON.stringify(suspended);

  expect(apply(suspended, { t: "respond", player: 1, chosen: card }, deps)).toEqual({
    ok: false,
    code: "wrong_player",
  });
  // 不可放弃的挂起点上放弃，同样是 invalid_choice（IR v1 §6.1）。
  expect(apply(suspended, { t: "respond", player: 0, chosen: 9999 }, deps)).toEqual({
    ok: false,
    code: "invalid_choice",
  });
  expect(apply(suspended, { t: "respond", player: 0, chosen: null }, deps)).toEqual({
    ok: false,
    code: "invalid_choice",
  });
  // 被拒之后状态一字未动 —— 挂起点还在，可以重发。
  expect(JSON.stringify(suspended)).toBe(before);
});

test("apply 不吞 ResolutionLoopError：结算成环是引擎/卡牌的 bug，不是非法意图", () => {
  const state = boardState();
  const card = nextCard(state);
  const handlers: HandlerTable = {
    ...ACT_HANDLERS,
    "act.move": (env, act) => {
      pushAct(env.state, act, env.ctx); // 自我复制 = 真环
    },
  };

  let caught: unknown = null;
  try {
    apply(state, { t: "play_card", player: 0, card, slot: 1 }, { handlers });
  } catch (error) {
    caught = error;
  }

  expect(caught instanceof ResolutionLoopError).toBe(true);
  // 抛错时状态不回滚，但**入参状态**没被碰过（改的是 clone 出来的 draft）。
  expect(state.stack).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 意图校验的其余分支
// ═══════════════════════════════════════════════════════════════════════════

test("play_card：被偷来的牌（owner 是对手）落在**控制者**的战线上", () => {
  const state = boardState();
  const card = nextCard(state);
  const entity = getEntity(state, card);
  expect(entity).toBeDefined();
  if (entity === undefined) {
    return;
  }
  entity.owner = 1; // act.steal 之后的形态：owner 是 p1，却握在 p0 手里

  const played = playCard(state, card, 2);

  expect(played.state.slots[0][2]).toBe(card);
  expect(getEntity(played.state, card)?.zone).toBe("p0:board");
  expect(getEntity(played.state, card)?.owner).toBe(1); // 归属没变
});

test("concede：任意相位任意一方都能认输，对手直接获胜且不发事件", () => {
  const fresh = createGame(RULES, [DECK, DECK], 1, { shuffle: false, firstPlayer: 0 });
  // mulligan 相位（还没进第 1 回合）就能认输。
  const early = expectOk(apply(fresh, { t: "concede", player: 1 }));
  expect(early.events).toEqual([]); // v2 §5 没有"对局结束"事件，胜负由 state.winner 承载
  expect(early.state.winner).toBe(0);
  expect(early.state.phase).toBe("over"); // winner !== null ⇔ phase === "over"
  expect(apply(early.state, { t: "pass", player: 0 })).toEqual({ ok: false, code: "game_over" });

  // actions 相位里，**不持有 priority 的一方**同样能认输。
  const mid = boardState();
  expect(mid.priority).toBe(0);
  const late = expectOk(apply(mid, { t: "concede", player: 1 }));
  expect(late.state.winner).toBe(0);
});

test("未知的 t 落到 unknown_intent（不可信输入的兜底）", () => {
  const state = boardState();
  const bogus = { t: "hack", player: 0 } as unknown as Intent;
  expect(apply(state, bogus)).toEqual({ ok: false, code: "unknown_intent" });
});
