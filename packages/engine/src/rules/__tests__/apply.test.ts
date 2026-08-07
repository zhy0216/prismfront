// rules/apply 的单元测试：**挂起 / 回应**这条支路，以及几处只有非法输入才走得到的分支。
//
// 走查测试（`src/__tests__/walkthrough.test.ts`）跑的是成功路径，
// 这里补的是框架 §4.2 的另一半 —— 结算中途停下来等玩家选择，然后 `respond` 接着跑。
// M2 的临时 handler 里没有会挂起的动作（`act.discover` 是 M4），所以本文件自己
// 注入一张会挂起的 handler 表：**`apply` 的 `deps` 参数就是为这种事留的**。
//
// 注：本文件**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1）。

import { expect, test } from "bun:test";
import type { CardId, RulesConfig } from "@prismfront/ir";
import { M2_HANDLERS, strikeHandler } from "../../handlers/index.ts";
import type { HandlerTable, ResolveDeps } from "../../resolve/index.ts";
import { pushAct, ResolutionLoopError, suspend } from "../../resolve/index.ts";
import type { GameState } from "../../state/index.ts";
import { getEntity, getZone } from "../../state/index.ts";
import type { ApplyResult, Intent } from "../index.ts";
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

const DECK: readonly CardId[] = ["PF_X"];

function expectOk(result: ApplyResult): { state: GameState; events: readonly unknown[] } {
  if (!result.ok) {
    throw new Error(`意图被拒：${result.code}`);
  }
  return { state: result.state, events: result.events };
}

/** 双方各上场一个单位（p0 是 3/9 的攻击方，p1 是 1/9 的挨打方）。 */
function boardState(): { state: GameState; p0Unit: number; p1Unit: number } {
  const start = createGame(RULES, [DECK, DECK], 1, { shuffle: false });
  for (const player of [0, 1] as const) {
    const top = getZone(start, player, "deck")[0];
    const card = top === undefined ? undefined : getEntity(start, top);
    if (card === undefined) {
      throw new Error("夹具错误：牌库是空的");
    }
    card.base.atk = player === 0 ? 3 : 1;
    card.base.health = 9;
  }
  const p0Unit = getZone(start, 0, "deck")[0] ?? 0;
  const p1Unit = getZone(start, 1, "deck")[0] ?? 0;

  const intents: readonly Intent[] = [
    { t: "draw", player: 0 },
    { t: "draw", player: 1 },
    { t: "play_unit", player: 0, card: p0Unit, slot: 0 },
    { t: "play_unit", player: 1, card: p1Unit, slot: 0 },
  ];
  let state = start;
  for (const intent of intents) {
    state = expectOk(apply(state, intent)).state;
  }
  return { state, p0Unit, p1Unit };
}

/**
 * 一张会在出手前挂起的 handler 表。
 *
 * 遵守 `resolve/suspend.ts` 的挂起契约：**先把续跑动作压回栈，再 `suspend`**。
 * 用 `ctx.chosen === null` 区分"第一次进来"与"玩家回应之后续跑"——
 * `resume` 会把选择写进栈顶条目的 `ctx.chosen`，也就是刚压回去的那条 strike。
 */
function suspendingDeps(options: readonly number[]): ResolveDeps {
  const handlers: HandlerTable = {
    ...M2_HANDLERS,
    "act.strike": (state, ctx, act) => {
      if (ctx.chosen === null) {
        pushAct(state, act, ctx);
        suspend(state, {
          player: 0,
          kind: "select_target",
          options,
          optional: false,
          deadline: null,
        });
        return;
      }
      strikeHandler(state, ctx, act);
    },
  };
  return { handlers };
}

// ═══════════════════════════════════════════════════════════════════════════
// 框架 §4.2：挂起 → respond
// ═══════════════════════════════════════════════════════════════════════════

test("挂起：apply 照常 ok:true，pendingInput 留在返回的状态里，续跑动作还在栈上", () => {
  const { state, p0Unit, p1Unit } = boardState();
  const deps = suspendingDeps([p1Unit]);

  const step = expectOk(
    apply(state, { t: "strike", player: 0, attacker: p0Unit, target: p1Unit }, deps),
  );

  expect(step.events).toEqual([]);
  expect(step.state.pendingInput?.kind).toBe("select_target");
  expect(step.state.stack).toHaveLength(1);
  expect(step.state.eventLog).toEqual([]); // 挂起路径同样排空事件日志
  expect(step.state.seq).toBe(state.seq + 1);
  // 整个挂起点可以直接落盘（框架 §4.2）：状态里没有任何不可序列化的东西。
  expect(JSON.stringify(JSON.parse(JSON.stringify(step.state)))).toBe(JSON.stringify(step.state));
});

test("挂起期间只接受 respond，别的意图一律 awaiting_input", () => {
  const { state, p0Unit, p1Unit } = boardState();
  const deps = suspendingDeps([p1Unit]);
  const suspended = expectOk(
    apply(state, { t: "strike", player: 0, attacker: p0Unit, target: p1Unit }, deps),
  ).state;

  expect(apply(suspended, { t: "draw", player: 0 }, deps)).toEqual({
    ok: false,
    code: "awaiting_input",
  });
  expect(apply(suspended, { t: "play_unit", player: 0, card: p0Unit, slot: 1 }, deps)).toEqual({
    ok: false,
    code: "awaiting_input",
  });
});

test("respond：选择写进栈顶 ctx.chosen，结算从中断处继续", () => {
  const { state, p0Unit, p1Unit } = boardState();
  const deps = suspendingDeps([p1Unit]);
  const suspended = expectOk(
    apply(state, { t: "strike", player: 0, attacker: p0Unit, target: p1Unit }, deps),
  ).state;

  const resumed = expectOk(apply(suspended, { t: "respond", player: 0, chosen: p1Unit }, deps));

  expect(resumed.state.pendingInput).toBeNull();
  expect(resumed.events).toEqual([
    { name: "struck", source: p0Unit, target: p1Unit, amount: 3 },
    { name: "damaged", source: p0Unit, target: p1Unit, amount: 3 },
  ]);
  expect(getEntity(resumed.state, p1Unit)?.damage).toBe(3);
  expect(resumed.state.seq).toBe(suspended.seq + 1);
});

test("respond 的两类拒绝：不该他选（wrong_player）、选了候选集外的（invalid_choice）", () => {
  const { state, p0Unit, p1Unit } = boardState();
  const deps = suspendingDeps([p1Unit]);
  const suspended = expectOk(
    apply(state, { t: "strike", player: 0, attacker: p0Unit, target: p1Unit }, deps),
  ).state;
  const before = JSON.stringify(suspended);

  expect(apply(suspended, { t: "respond", player: 1, chosen: p1Unit }, deps)).toEqual({
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
  const { state, p0Unit, p1Unit } = boardState();
  const handlers: HandlerTable = {
    ...M2_HANDLERS,
    "act.strike": (s, ctx, act) => {
      pushAct(s, act, ctx); // 自我复制 = 真环
    },
  };

  let caught: unknown = null;
  try {
    apply(state, { t: "strike", player: 0, attacker: p0Unit, target: p1Unit }, { handlers });
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

test("strike 的三条校验：实体存在、在场上、由发起方控制", () => {
  const { state, p0Unit, p1Unit } = boardState();

  expect(apply(state, { t: "strike", player: 0, attacker: 9999, target: p1Unit })).toEqual({
    ok: false,
    code: "unknown_entity",
  });
  // base 实体不在 board 区（v2.1 §11.2：它不占格），因此不能出手。
  expect(
    apply(state, { t: "strike", player: 0, attacker: state.players[0].baseId, target: p1Unit }),
  ).toEqual({ ok: false, code: "wrong_zone" });
  expect(apply(state, { t: "strike", player: 1, attacker: p0Unit, target: p1Unit })).toEqual({
    ok: false,
    code: "not_controlled",
  });
  // 打自己人是合法意图（能不能打到是 handler 的事）。
  expect(apply(state, { t: "strike", player: 0, attacker: p0Unit, target: p0Unit }).ok).toBe(true);
});

test("play_unit：被偷来的牌（owner 是对手）落在**控制者**的战线上", () => {
  const start = createGame(RULES, [DECK, DECK], 1, { shuffle: false });
  const drawn = expectOk(apply(start, { t: "draw", player: 0 })).state;
  const card = getZone(drawn, 0, "hand")[0];
  expect(card).toBeDefined();
  if (card === undefined) {
    return;
  }
  const entity = getEntity(drawn, card);
  if (entity === undefined) {
    return;
  }
  entity.base.health = 3;
  entity.tags.health = 3;
  entity.owner = 1; // act.steal 之后的形态：owner 是 p1，却握在 p0 手里

  const played = expectOk(apply(drawn, { t: "play_unit", player: 0, card, slot: 2 }));

  expect(played.state.slots[0][2]).toBe(card);
  expect(getEntity(played.state, card)?.zone).toBe("p0:board");
  expect(getEntity(played.state, card)?.owner).toBe(1); // 归属没变
});
