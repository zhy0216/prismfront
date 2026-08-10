import { AUTO, Game, Scale } from "phaser";
import { RENDER_HEIGHT, RENDER_WIDTH } from "./core/rendering.ts";
import beamThroughEmpty from "./generated/replays/beam-through-empty.json";
import colorGateBlackout from "./generated/replays/color-gate-blackout.json";
import combatTradeoff from "./generated/replays/combat-tradeoff.json";
import deploy from "./generated/replays/deploy-r1-r2.json";
import diagonalStrike from "./generated/replays/diagonal-strike.json";
import discoverSuspend from "./generated/replays/discover-suspend.json";
import initiative from "./generated/replays/initiative-first-passer.json";
import thorns from "./generated/replays/thorns-dies-but-retaliates.json";
import { BootScene } from "./scenes/boot.ts";
import { HudScene } from "./scenes/hud.ts";
import { MatchScene } from "./scenes/match.ts";
import { OverlayScene } from "./scenes/overlay.ts";
import { ColyseusTransport } from "./transport/colyseus.ts";
import { HotseatTransport } from "./transport/hotseat.ts";
import { type GoldenReplay, MockTransport } from "./transport/mock.ts";

const REPLAYS: Readonly<Record<string, GoldenReplay>> = {
  "beam-through-empty": beamThroughEmpty as unknown as GoldenReplay,
  "color-gate-blackout": colorGateBlackout as unknown as GoldenReplay,
  "combat-tradeoff": combatTradeoff as unknown as GoldenReplay,
  "deploy-r1-r2": deploy as unknown as GoldenReplay,
  "diagonal-strike": diagonalStrike as unknown as GoldenReplay,
  "discover-suspend": discoverSuspend as unknown as GoldenReplay,
  "initiative-first-passer": initiative as unknown as GoldenReplay,
  "thorns-dies-but-retaliates": thorns as unknown as GoldenReplay,
};

const query = new URLSearchParams(location.search);
const replayName = query.get("replay") ?? "deploy-r1-r2";
const replay = REPLAYS[replayName] ?? REPLAYS["deploy-r1-r2"];
if (replay === undefined) throw new Error("missing bundled replay");
const seat = query.get("seat") === "1" ? 1 : 0;
const server = query.get("server");
const hotseat = query.get("hotseat");
const pve = query.get("pve");
const endpoint = pve ?? hotseat ?? server;
const demoOptions = {
  seed: 7001,
  firstPlayer: 0,
  actionTimeoutMs: 8_000,
  rules: {
    board: { slots: 9 },
    crystals: { initial: 5, growth: 1, capMax: 10 },
    pass: { combatAfterConsecutivePasses: 1 },
    initiative: "alternate",
    baseHp: 1,
    deck: { size: 2, maxCopies: 3, startingHand: 1, drawPerRound: 0, fatigue: false },
    playerActions: ["play_card"],
    actionSeconds: 8,
    reconnectSeconds: 5,
    heroes: { perDeck: 0, deploySchedule: [], respawnDelay: 1 },
  },
  decks: [
    ["DEMO_CARD", "DEMO_CARD"],
    ["DEMO_CARD", "DEMO_CARD"],
  ],
} as const;
const transport =
  endpoint === null
    ? new MockTransport(replay, seat)
    : pve !== null
      ? new HotseatTransport(endpoint, demoOptions, { seats: [1], fixedSeat: 0 })
      : hotseat === null
        ? new ColyseusTransport(endpoint, "match", demoOptions)
        : new HotseatTransport(endpoint, demoOptions, query.has("autoplay"));
document.body.dataset.replay = replay.name;
document.body.dataset.eventCount = "0";
document.body.dataset.transport =
  pve !== null ? "pve" : hotseat !== null ? "hotseat" : server !== null ? "online" : "mock";

new Game({
  type: AUTO,
  parent: "game-root",
  width: RENDER_WIDTH,
  height: RENDER_HEIGHT,
  backgroundColor: "#0c1222",
  antialias: true,
  roundPixels: true,
  scale: { mode: Scale.FIT, autoCenter: Scale.CENTER_BOTH, autoRound: true },
  scene: [BootScene, new MatchScene(transport), HudScene, OverlayScene],
});

setTimeout(() => {
  if (transport instanceof MockTransport) void transport.play(220);
  else void transport.connect();
}, 0);

if (query.has("disconnect")) {
  setTimeout(
    () => {
      if (transport instanceof ColyseusTransport || transport instanceof HotseatTransport) {
        transport.simulateDisconnect();
      }
    },
    query.has("hotseat") || query.has("pve") ? 1_000 : 2_000,
  );
}
