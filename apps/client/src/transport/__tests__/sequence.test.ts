import { expect, test } from "bun:test";
import type { ServerMsg } from "@prismfront/shared";
import beam from "../../generated/replays/beam-through-empty.json";
import blackout from "../../generated/replays/color-gate-blackout.json";
import tradeoff from "../../generated/replays/combat-tradeoff.json";
import deploy from "../../generated/replays/deploy-r1-r2.json";
import diagonal from "../../generated/replays/diagonal-strike.json";
import discover from "../../generated/replays/discover-suspend.json";
import initiative from "../../generated/replays/initiative-first-passer.json";
import thorns from "../../generated/replays/thorns-dies-but-retaliates.json";
import { type GoldenReplay, replayTimeline } from "../mock.ts";
import { ProtocolSequencer } from "../sequence.ts";

test("all golden captures contain meaningful protocol events and snapshots", () => {
  const replays = [beam, blackout, tradeoff, deploy, diagonal, discover, initiative, thorns];
  for (const fixture of replays) {
    const replay = fixture as unknown as GoldenReplay;
    const timeline = replayTimeline(replay, 0);
    expect(timeline.some((message) => message.t === "snapshot")).toBe(true);
    expect(timeline.some((message) => message.t === "events" && message.events.length > 0)).toBe(
      true,
    );
  }
  expect(replays).toHaveLength(8);
});

test("deploy capture contains all six real hero deployment events", () => {
  const timeline = replayTimeline(deploy as unknown as GoldenReplay, 0);
  const deployed = timeline
    .flatMap((message) => (message.t === "events" ? message.events : []))
    .filter((event) => event.name === "hero_deployed");
  expect(new Set(deployed.map((event) => event.target)).size).toBe(6);
});

test("sequence gate requests resync on a gap and accepts a full snapshot", () => {
  const timeline = replayTimeline(deploy as unknown as GoldenReplay, 0);
  const snapshot = timeline.find((message) => message.t === "snapshot");
  if (snapshot?.t !== "snapshot") throw new Error("fixture missing snapshot");
  const gate = new ProtocolSequencer();
  expect(gate.accept(snapshot)).toBe("accept");
  expect(gate.accept({ t: "events", version: 1, seq: snapshot.seq + 2, events: [] })).toBe(
    "resync",
  );
  expect(
    gate.accept({
      ...snapshot,
      seq: snapshot.seq + 2,
      view: { ...snapshot.view, seq: snapshot.seq + 2 },
    }),
  ).toBe("accept");
  expect(
    gate.accept({ t: "events", version: 1, seq: snapshot.seq + 1, events: [] } as ServerMsg),
  ).toBe("ignore");
});
