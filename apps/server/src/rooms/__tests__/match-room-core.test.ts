import { describe, expect, test } from "bun:test";
import { DEFAULT_RULES, ResolutionLoopError } from "@prismfront/engine";
import { defineCard } from "@prismfront/ir";
import type { ServerMsg } from "@prismfront/shared";
import { MatchRoomCore, type MatchRoomOptions } from "../match-room-core.ts";

type FakeClient = {
  connectionId: string;
  messages: ServerMsg[];
  send(message: ServerMsg): void;
};

function client(connectionId: string): FakeClient {
  return {
    connectionId,
    messages: [],
    send(message) {
      this.messages.push(message);
    },
  };
}

function smallOptions(overrides: Partial<MatchRoomOptions> = {}): MatchRoomOptions {
  return {
    rules: {
      ...DEFAULT_RULES,
      baseHp: 2,
      deck: { ...DEFAULT_RULES.deck, size: 1, startingHand: 1 },
      heroes: { ...DEFAULT_RULES.heroes, perDeck: 1, cardsPerHero: 1, deploySchedule: [1] },
    },
    decks: [["P0_HIDDEN"], ["P1_HIDDEN"]],
    firstPlayer: 0,
    actionTimeoutMs: 0,
    ...overrides,
  };
}

function send(core: MatchRoomCore, playerId: string, intent: Record<string, unknown>): void {
  core.receive(playerId, { ...intent, version: 1, seq: core.state.seq });
}

function open(core: MatchRoomCore): void {
  send(core, "p0", { t: "mulligan", toss: [] });
  send(core, "p1", { t: "mulligan", toss: [] });
}

describe("MatchRoomCore service outlet", () => {
  test("projects opponent hand without leaking card ids", () => {
    const p0 = client("session-0");
    const p1 = client("session-1");
    const core = new MatchRoomCore(smallOptions());
    core.join("p0", p0);
    core.join("p1", p1);
    expect(JSON.stringify(p1.messages)).not.toContain("P0_HIDDEN");
    expect(JSON.stringify(p1.messages)).toContain("P1_HIDDEN");
  });

  test("requires protocol version and exact current seq before apply", () => {
    const p0 = client("s0");
    const core = new MatchRoomCore(smallOptions());
    core.join("p0", p0);
    core.join("p1", client("s1"));
    core.receive("p0", { t: "mulligan", seq: 0, toss: [] });
    expect(p0.messages.at(-1)).toMatchObject({ t: "rejected", code: "protocol_mismatch" });
    core.receive("p0", { t: "mulligan", version: 1, seq: 99, toss: [] });
    expect(p0.messages.at(-1)).toMatchObject({ t: "rejected", code: "stale_seq" });
    core.receive("p0", { t: "mulligan", version: 1, seq: 0, toss: ["bad-id"] });
    expect(p0.messages.at(-1)).toMatchObject({ t: "rejected", code: "unknown_intent" });
    expect(core.state.phase).toBe("mulligan");
  });

  test("revalidates priority and keeps state unchanged", () => {
    const p0 = client("s0");
    const p1 = client("s1");
    const core = new MatchRoomCore(smallOptions());
    core.join("p0", p0);
    core.join("p1", p1);
    open(core);
    const before = JSON.stringify(core.state);
    send(core, "p1", { t: "pass" });
    expect(JSON.stringify(core.state)).toBe(before);
    expect(p1.messages.at(-1)).toMatchObject({ t: "rejected", code: "wrong_player" });
  });

  test("duplicate opaque identity cannot take over connected or disconnected seat", () => {
    const core = new MatchRoomCore(smallOptions());
    core.join("stable", client("one"));
    expect(() => core.join("stable", client("attacker"))).toThrow("already connected");
    core.markDisconnected("stable");
    expect(() => core.join("stable", client("attacker-2"))).toThrow("reconnection proof");
  });

  test("reconnect path restores full snapshot and unpauses opponent", () => {
    const original = client("old");
    const replacement = client("new");
    const opponent = client("other");
    const core = new MatchRoomCore(smallOptions());
    core.join("p0", original);
    core.join("p1", opponent);
    core.markDisconnected("p0");
    send(core, "p1", { t: "mulligan", toss: [] });
    expect(opponent.messages.at(-1)).toMatchObject({ t: "rejected", code: "match_paused" });
    core.markReconnected("p0", replacement);
    expect(replacement.messages.at(-1)).toMatchObject({ t: "snapshot", playerId: "p0" });
  });

  test("invalid secret submission does not erase honest pending mulligan", () => {
    const p0 = client("p0c");
    const p1 = client("p1c");
    const core = new MatchRoomCore(smallOptions());
    core.join("p0", p0);
    core.join("p1", p1);
    send(core, "p0", { t: "mulligan", toss: [] });
    send(core, "p1", { t: "mulligan", toss: [999] });
    expect(p1.messages.at(-1)).toMatchObject({ t: "rejected", code: "unknown_entity" });
    send(core, "p1", { t: "mulligan", toss: [] });
    expect(core.state.phase).toBe("actions");
    expect(core.state.seq).toBe(1);
  });

  test("secret mulligan timeout supplies missing empty choices", () => {
    const core = new MatchRoomCore(smallOptions());
    core.join("p0", client("s0"));
    core.join("p1", client("s1"));
    send(core, "p0", { t: "mulligan", toss: [] });
    core.timeoutAction();
    expect(core.state.phase).toBe("actions");
  });

  test("deploy choices aggregate without leaking and invalid retry preserves honest choice", () => {
    const hero = defineCard({
      id: "TEST_HERO",
      name: { zh: "测试英雄" },
      kind: "hero",
      colors: "red",
      collectible: false,
      atk: 1,
      health: 2,
    });
    const rules = {
      ...DEFAULT_RULES,
      board: { slots: 2 },
      deck: { ...DEFAULT_RULES.deck, size: 0, startingHand: 0 },
      heroes: { perDeck: 1, deploySchedule: [1], respawnDelay: 1 },
    };
    const p0 = client("d0");
    const p1 = client("d1");
    const core = new MatchRoomCore({
      rules,
      decks: [[], []],
      heroes: [[hero.id], [hero.id]],
      firstPlayer: 0,
      actionTimeoutMs: 0,
      cardRegistry: { cards: [hero] },
    });
    core.join("p0", p0);
    core.join("p1", p1);
    open(core);
    expect(core.state.phase).toBe("deploy");
    const p0Hero = core.state.zones["p0:fountain"][0];
    const p1Hero = core.state.zones["p1:fountain"][0];
    expect(p0Hero).toBeNumber();
    expect(p1Hero).toBeNumber();
    send(core, "p0", { t: "deploy", picks: [{ hero: p0Hero, slot: 0 }] });
    expect(JSON.stringify(p1.messages)).not.toContain(`"hero":${p0Hero}`);
    send(core, "p1", { t: "deploy", picks: [{ hero: 999, slot: 0 }] });
    expect(p1.messages.at(-1)).toMatchObject({ t: "rejected", code: "unknown_entity" });
    send(core, "p1", { t: "deploy", picks: [{ hero: p1Hero, slot: 1 }] });
    expect(core.state.phase).toBe("actions");
    expect(core.state.slots[0][0]).toBe(p0Hero);
    expect(core.state.slots[1][1]).toBe(p1Hero);
  });

  test("deploy timeout chooses first deployable heroes and free slots", () => {
    const hero = defineCard({
      id: "TIMEOUT_HERO",
      name: { zh: "超时英雄" },
      kind: "hero",
      colors: "blue",
      collectible: false,
      atk: 1,
      health: 2,
    });
    const core = new MatchRoomCore({
      rules: {
        ...DEFAULT_RULES,
        board: { slots: 1 },
        deck: { ...DEFAULT_RULES.deck, size: 0, startingHand: 0 },
        heroes: { perDeck: 1, deploySchedule: [1], respawnDelay: 1 },
      },
      decks: [[], []],
      heroes: [[hero.id], [hero.id]],
      firstPlayer: 0,
      actionTimeoutMs: 0,
      cardRegistry: { cards: [hero] },
    });
    core.join("p0", client("a"));
    core.join("p1", client("b"));
    open(core);
    core.timeoutAction();
    expect(core.state.phase).toBe("actions");
    expect(core.state.slots[0][0]).not.toBeNull();
    expect(core.state.slots[1][0]).not.toBeNull();
  });

  test("concede and disconnect timeout use engine result and enqueue persistence", async () => {
    const persisted: string[] = [];
    const core = new MatchRoomCore(
      smallOptions({
        persistResult: async (result) => {
          persisted.push(result.reason);
        },
      }),
    );
    core.join("p0", client("s0"));
    core.join("p1", client("s1"));
    send(core, "p0", { t: "concede" });
    await Promise.resolve();
    expect(core.outcome).toMatchObject({ winner: 1, reason: "concede" });
    expect(persisted).toEqual(["concede"]);

    const disconnected = new MatchRoomCore(smallOptions());
    disconnected.join("p0", client("a"));
    disconnected.join("p1", client("b"));
    disconnected.markDisconnected("p0");
    disconnected.disconnectTimeout("p0");
    expect(disconnected.outcome).toMatchObject({ winner: 1, reason: "disconnect_timeout" });
  });

  test("ResolutionLoopError voids match without mutating authoritative input", () => {
    const core = new MatchRoomCore(
      smallOptions({
        applyGame: (state) => {
          expect(state.seq).toBe(0);
          throw new ResolutionLoopError(256, []);
        },
      }),
    );
    core.join("p0", client("a"));
    core.join("p1", client("b"));
    const before = JSON.stringify(core.state);
    send(core, "p0", { t: "concede" });
    expect(JSON.stringify(core.state)).toBe(before);
    expect(core.outcome).toMatchObject({ winner: null, reason: "engine_fault" });
  });

  test("uses one cancellable timer per action", () => {
    const scheduled: Array<{ callback: () => void; cleared: boolean }> = [];
    const core = new MatchRoomCore(
      smallOptions({
        actionTimeoutMs: 10,
        schedule: (delayMs, callback) => {
          expect(delayMs).toBe(10);
          const item = { callback, cleared: false };
          scheduled.push(item);
          return { clear: () => (item.cleared = true) };
        },
      }),
    );
    core.join("p0", client("s0"));
    core.join("p1", client("s1"));
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.callback();
    expect(core.state.phase).toBe("actions");
    expect(scheduled).toHaveLength(2);
  });

  test("engine-rejected intent cannot clear or refresh the active player's timer", () => {
    const scheduled: Array<{ callback: () => void; cleared: boolean }> = [];
    const core = new MatchRoomCore(
      smallOptions({
        actionTimeoutMs: 10,
        schedule: (_delayMs, callback) => {
          const item = { callback, cleared: false };
          scheduled.push(item);
          return { clear: () => (item.cleared = true) };
        },
      }),
    );
    core.join("p0", client("s0"));
    core.join("p1", client("s1"));
    open(core);
    expect(core.state.priority).toBe(0);
    expect(scheduled).toHaveLength(2);
    const active = scheduled[1];
    expect(active?.cleared).toBe(false);

    send(core, "p1", { t: "pass" });

    expect(scheduled).toHaveLength(2);
    expect(active?.cleared).toBe(false);
    expect(core.state.priority).toBe(0);
  });
});
