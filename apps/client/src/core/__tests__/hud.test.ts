import { expect, test } from "bun:test";
import blackout from "../../generated/replays/color-gate-blackout.json";
import { type GoldenReplay, replayTimeline } from "../../transport/mock.ts";
import { GOLDEN_HERO_COLORS, hudModel } from "../hud.ts";

test("color gate light goes lit, dark in fountain, then lit after redeploy", () => {
  const snapshots = replayTimeline(blackout as unknown as GoldenReplay, 0).filter(
    (message) => message.t === "snapshot",
  );
  const states = snapshots.map((message) =>
    hudModel(message.view, 0, GOLDEN_HERO_COLORS).lights.find((light) => light.color === "blue"),
  );
  expect(states.some((light) => light?.lit === true)).toBe(true);
  expect(states.some((light) => light?.lit === false && light.returnsIn === 1)).toBe(true);
  const afterBlackout = states.findIndex((light) => light?.lit === false && light.returnsIn === 1);
  expect(states.slice(afterBlackout + 1).some((light) => light?.lit === true)).toBe(true);
});
