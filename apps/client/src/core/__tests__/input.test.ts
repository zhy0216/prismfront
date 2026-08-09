import { expect, test } from "bun:test";
import type { LegalMoves } from "@prismfront/shared";
import deploy from "../../generated/replays/deploy-r1-r2.json";
import { type GoldenReplay, replayTimeline } from "../../transport/mock.ts";
import { HotseatSession } from "../hotseat.ts";
import { IntentController } from "../input.ts";

test("input emits only server-legal moves with authoritative seq", () => {
  const sent: unknown[] = [];
  const action = {
    intent: { t: "play_card", player: 0, card: 9, slot: 3 },
    t: "play_card",
    card: 9,
    slot: 3,
    legal: true,
    reason: null,
    illegalReason: null,
    missingColors: [],
    slots: [3],
  } as const;
  const pass = {
    ...action,
    intent: { t: "pass", player: 0 },
    t: "pass",
    card: null,
    slot: null,
  } as const;
  const legal: LegalMoves = { player: 0, actions: [action, pass], playCard: [action], pass };
  const input = new IntentController({ send: (intent) => sent.push(intent) }, 0);
  input.sync(17, legal);
  input.beginCard(9);
  expect(input.playAt(2)).toBe(false);
  input.beginCard(9);
  expect(input.playAt(3)).toBe(true);
  expect(sent).toEqual([{ t: "play_card", version: 1, seq: 17, card: 9, slot: 3 }]);
});

test("hotseat switches to authoritative priority and can emit a pass", () => {
  const sent: unknown[] = [];
  const session = new HotseatSession({
    send: (intent) => sent.push(intent),
    onMessage: () => () => {},
  });
  const snapshot = replayTimeline(deploy as unknown as GoldenReplay, 0).find(
    (message) =>
      message.t === "snapshot" && message.view.phase === "actions" && message.legal.pass.legal,
  );
  if (snapshot?.t !== "snapshot") throw new Error("fixture missing actionable snapshot");
  session.sync(snapshot);
  expect(session.viewer).toBe(snapshot.view.priority);
  expect(session.input.pass()).toBe(true);
  expect(sent).toEqual([{ t: "pass", version: 1, seq: snapshot.seq }]);
});
