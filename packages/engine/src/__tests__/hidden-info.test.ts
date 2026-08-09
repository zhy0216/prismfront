// M7 隐藏信息与合法动作的最小 CI 探针。

import { expect, test } from "bun:test";
import type { CardData, CardId } from "@prismfront/ir";
import type { GameEvent } from "../events/index.ts";
import { getEntity, getZone, playerData } from "../state/index.ts";
import { openGame, putOnSlot } from "../testkit/index.ts";
import { legalActions, project, projectEvent } from "../view/index.ts";

const RED_CARD: CardData = {
  name: { zh: "红牌" },
  kind: "minion",
  colors: ["red"],
  tags: { atk: 1, health: 1 },
};

const RED_CARDS = (cardId: CardId): CardData | undefined =>
  cardId.startsWith("A") ? RED_CARD : undefined;

test("投影隐藏对手手牌：保留稳定 entityId、cardId 置 null、牌库只给数量", () => {
  const state = openGame();
  const p0Hand = getZone(state, 0, "hand");
  const p1Hand = getZone(state, 1, "hand");
  const view = project(state, 1);
  const wire = JSON.stringify(view);

  for (const id of p0Hand) {
    const card = getEntity(state, id);
    expect(card).toBeDefined();
    expect(wire).not.toContain(card?.cardId as string);
    expect(view.zones["p0:hand"]).toContain(id);
    expect(view.entities[id]).toEqual({ id, cardId: null });
  }
  for (const id of p1Hand) {
    const card = getEntity(state, id);
    expect(view.entities[id]?.cardId).toBe(card?.cardId);
  }

  expect(view.zones["p0:deck"]).toEqual([]);
  expect(view.zones["p1:deck"]).toEqual([]);
  expect(view.zoneCounts["p0:deck"]).toBe(getZone(state, 0, "deck").length);
  expect(view.zoneCounts["p1:deck"]).toBe(getZone(state, 1, "deck").length);
  expect("rng" in view).toBe(false);
  expect("stack" in view).toBe(false);
  expect("eventLog" in view).toBe(false);
});

test("事件投影隐藏对手抽牌身份、公开打出身份", () => {
  const state = openGame();
  const hiddenId = getZone(state, 0, "hand")[0];
  if (hiddenId === undefined) {
    throw new Error("test fixture has no p0 hand");
  }
  const hidden = projectEvent(
    state,
    { name: "card_drawn", player: playerData(state, 0).baseId, target: hiddenId, cardId: "A1" },
    1,
  );
  expect(hidden).toEqual({
    name: "card_drawn",
    player: playerData(state, 0).baseId,
    target: hiddenId,
    cardId: null,
  });

  const ownDraw = projectEvent(
    state,
    { name: "card_drawn", player: playerData(state, 0).baseId, target: hiddenId, cardId: "A1" },
    0,
  );
  expect(ownDraw !== null && "cardId" in ownDraw ? ownDraw.cardId : undefined).toBe("A1");

  // The reveal boundary is the event itself, so callers may safely project
  // against either the pre- or post-event state.
  expect(
    projectEvent(
      state,
      { name: "card_played", player: playerData(state, 0).baseId, target: hiddenId, cardId: "A1" },
      1,
    ),
  ).toEqual({
    name: "card_played",
    player: playerData(state, 0).baseId,
    target: hiddenId,
    cardId: "A1",
  });

  const board = getZone(state, 1, "hand")[0];
  if (board === undefined) {
    throw new Error("test fixture has no p1 hand");
  }
  putOnSlot(state, 1, board, 0);
  const publicEvent: GameEvent = {
    name: "card_played",
    player: playerData(state, 1).baseId,
    target: board,
    cardId: "B1",
  };
  expect(projectEvent(state, publicEvent, 0)).toEqual(publicEvent);

  const p1Card = getZone(state, 1, "hand")[0];
  if (p1Card === undefined) {
    throw new Error("test fixture has no p1 hand");
  }
  expect(
    projectEvent(
      state,
      { name: "card_drawn", player: playerData(state, 1).baseId, target: p1Card, cardId: "B1" },
      1,
    ),
  ).toEqual({
    name: "card_drawn",
    player: playerData(state, 1).baseId,
    target: p1Card,
    cardId: "B1",
  });
  expect(
    projectEvent(
      state,
      {
        name: "card_added_to_hand",
        player: playerData(state, 0).baseId,
        target: hiddenId,
        cardId: "A1",
      },
      1,
    ),
  ).toEqual({
    name: "card_added_to_hand",
    player: playerData(state, 0).baseId,
    target: hiddenId,
    cardId: null,
  });
  expect(
    projectEvent(
      state,
      { name: "transformed", target: hiddenId, fromCardId: "A1", toCardId: "A2" },
      1,
    ),
  ).toEqual({ name: "transformed", target: hiddenId, fromCardId: null, toCardId: null });
  expect(
    projectEvent(
      state,
      { name: "transformed", target: 999_999, fromCardId: "A1", toCardId: "A2" },
      1,
    ),
  ).toEqual({ name: "transformed", target: 999_999, fromCardId: null, toCardId: null });
  expect(
    projectEvent(state, { name: "engine.random_picked", origin: "shuffle", max: 2, result: 1 }, 1),
  ).toEqual({ name: "engine.random_picked", origin: "shuffle", max: 2, result: 1 });
  expect(
    projectEvent(
      state,
      {
        name: "secret_revealed",
        player: playerData(state, 0).baseId,
        target: hiddenId,
        cardId: "A1",
      },
      1,
    ),
  ).toEqual({
    name: "secret_revealed",
    player: playerData(state, 0).baseId,
    target: hiddenId,
    cardId: "A1",
  });

  state.pendingInput = {
    player: 1,
    kind: "discover",
    options: ["SECRET_CARD", hiddenId],
    optional: false,
    deadline: null,
  };
  const pendingView = project(state, 0);
  expect(pendingView.pendingInput?.options).toEqual([null, hiddenId]);
});

test("合法动作只枚举 play_card/pass，并带色门缺色信息", () => {
  const state = openGame();
  const moves = legalActions(state, 0, RED_CARDS);
  expect(moves.actions).toHaveLength(getZone(state, 0, "hand").length + 1);
  const play = moves.actions.find((move) => move.intent.t === "play_card");
  expect(play?.intent.t).toBe("play_card");
  expect(play?.legal).toBe(false);
  expect(play?.reason).toBe("color_locked");
  expect(play?.missingColors).toEqual(["red"]);
  expect(moves.actions.at(-1)?.intent.t).toBe("pass");
  expect(moves.actions.at(-1)?.legal).toBe(true);
  expect(moves.actions.every((move) => ["play_card", "pass"].includes(move.intent.t))).toBe(true);
});

test("合法动作快照覆盖公共门、资源与落点原因", () => {
  const state = openGame();
  const first = getZone(state, 0, "hand")[0];
  if (first === undefined) {
    throw new Error("test fixture has no p0 hand");
  }
  const firstEntity = getEntity(state, first);
  if (firstEntity === undefined) {
    throw new Error("test fixture has no first card entity");
  }
  firstEntity.tags.cost = 99;
  expect(legalActions(state, 1).pass.reason).toBe("wrong_player");
  expect(legalActions(state, 0, { cards: RED_CARDS }).playCard[0]?.reason).toBe("color_locked");

  firstEntity.tags.cost = 0;
  state.slots[0].fill(1);
  expect(legalActions(state, 0).playCard[0]?.reason).toBe("slot_occupied");

  state.slots[0].fill(null);
  state.pendingInput = {
    player: 0,
    kind: "discover",
    options: [],
    optional: false,
    deadline: null,
  };
  expect(legalActions(state, 0).pass.reason).toBe("awaiting_input");
  state.pendingInput = null;
  state.winner = 0;
  expect(legalActions(state, 0).pass.reason).toBe("game_over");

  state.winner = null;
  state.phase = "mulligan";
  state.zones["p0:hand"].push(999_999);
  expect(legalActions(state, 0).actions).toHaveLength(getZone(state, 0, "hand").length);
});

test("投影结果与权威状态不共享可变嵌套引用", () => {
  const state = openGame();
  const view = project(state, 0);
  view.rules.board.slots = 1;
  view.players[0].crystals = 0;
  const boardEntity = Object.values(view.entities).find(
    (entity) => "zone" in entity && entity.zone === "p0:base",
  );
  if (boardEntity === undefined || !("zone" in boardEntity) || boardEntity.cardId === null) {
    throw new Error("test fixture has no visible base");
  }
  boardEntity.tags.health = 1;
  expect(state.rules.board.slots).toBe(9);
  expect(state.players[0].crystals).not.toBe(0);
  expect(getEntity(state, boardEntity.id)?.tags.health).not.toBe(1);
});
