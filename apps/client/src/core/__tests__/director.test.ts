import { describe, expect, test } from "bun:test";
import type { ClientEvent } from "@prismfront/shared";
import { Director, planBeats, type RenderContext } from "../director.ts";

test("combat becomes prep, simultaneous volley, deaths, and end", () => {
  const events: ClientEvent[] = [
    { name: "combat_began" },
    { name: "struck", source: 3, target: 4 },
    { name: "damaged", source: 3, target: 4 },
    { name: "unit_died", target: 4 },
    { name: "combat_ended" },
  ];
  expect(planBeats(events).map((beat) => beat.kind)).toEqual([
    "VolleyPrep",
    "Volley",
    "Deaths",
    "CombatEnd",
  ]);
});

describe("fast forward", () => {
  test("aborts an awaiting play and applies its terminal state exactly once", async () => {
    const terminals: string[] = [];
    let release: (() => void) | undefined;
    const context: RenderContext = {
      animate: (_kind, _events, _duration, signal) =>
        new Promise((resolve) => {
          release = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      complete: (kind) => terminals.push(kind),
      idle: () => {},
    };
    const director = new Director(context);
    director.enqueue([{ name: "card_played" }]);
    await Promise.resolve();
    director.fastForward();
    release?.();
    await Promise.resolve();
    expect(terminals).toEqual(["PlayCard"]);
    expect(director.pendingCount).toBe(0);
  });
});
