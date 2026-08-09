// M9 完成命令：起真实 Colyseus+Bun WebSocket 服务，再让两个 SDK bot 客户端打完一局。

import { Client, type Room } from "@colyseus/sdk";
import type { ClientIntent, ServerMsg } from "@prismfront/shared";
import { MATCH_ROOM_NAME, startServer } from "./index.ts";

function argument(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const inline = Bun.argv.find((value) => value.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const at = Bun.argv.indexOf(`--${name}`);
  return at >= 0 ? (Bun.argv[at + 1] ?? fallback) : fallback;
}

function waitFor<T>(register: (resolve: (value: T) => void) => void, label: string): Promise<T> {
  return Promise.race([
    new Promise<T>(register),
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), 10_000);
    }),
  ]);
}

function botIntent(message: ServerMsg, seat: 0 | 1): ClientIntent | null {
  if (message.t !== "snapshot") return null;
  if (message.view.phase === "mulligan") {
    return { t: "mulligan", version: 1, seq: message.seq, toss: [] };
  }
  if (message.view.phase === "deploy") {
    return { t: "deploy", version: 1, seq: message.seq, picks: [] };
  }
  if (message.view.pendingInput?.player === seat) {
    return {
      t: "respond",
      version: 1,
      seq: message.seq,
      chosen: message.view.pendingInput.options[0] ?? null,
    };
  }
  if (message.view.phase === "actions" && message.view.priority === seat) {
    return { t: "pass", version: 1, seq: message.seq };
  }
  return null;
}

async function main(): Promise<void> {
  const p0Kind = argument("p0", "bot");
  const p1Kind = argument("p1", "bot");
  if (p0Kind !== "bot" || p1Kind !== "bot") {
    throw new Error("play:online currently supports --p0 bot --p1 bot");
  }
  const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) throw new Error("failed to allocate port");
  const server = await startServer(port);
  const endpoint = `ws://127.0.0.1:${port}`;
  const options = {
    seed: 0x9f1,
    firstPlayer: 0,
    actionTimeoutMs: 2_000,
    rules: {
      board: { slots: 1 },
      crystals: { initial: 5, growth: 1, capMax: 10 },
      pass: { combatAfterConsecutivePasses: 2 },
      initiative: "alternate",
      baseHp: 2,
      deck: { size: 0, maxCopies: 2, startingHand: 0, drawPerRound: 1, fatigue: true },
      playerActions: ["play_card"],
      actionSeconds: 2,
      reconnectSeconds: 2,
      heroes: { perDeck: 0, deploySchedule: [], respawnDelay: 1 },
    },
    decks: [[], []],
  };
  try {
    const sdk0 = new Client(endpoint);
    const sdk1 = new Client(endpoint);
    const room0 = await sdk0.create(MATCH_ROOM_NAME, { ...options, playerId: "online-p0" });
    const room1 = await sdk1.joinById(room0.roomId, { playerId: "online-p1" });
    const play = (room: Room, seat: 0 | 1): Promise<ServerMsg> =>
      waitFor<ServerMsg>((resolve) => {
        room.onMessage<ServerMsg>("server", (message) => {
          const intent = botIntent(message, seat);
          if (intent !== null) room.send("intent", intent);
          if (message.t === "events") room.send("resync", { version: 1, seq: message.seq });
          if (message.t === "over") resolve(message);
        });
        room.send("resync", { version: 1, seq: 0 });
      }, `online bot p${seat} result`);
    const [over0, over1] = await Promise.all([play(room0, 0), play(room1, 1)]);
    if (over0.t !== "over" || over1.t !== "over" || over0.seq !== over1.seq) {
      throw new Error("clients disagree on final result");
    }
    console.log(
      `ONLINE_MATCH_OVER winner=${over0.winner === null ? "draw" : over0.winner} reason=${over0.reason} seq=${over0.seq}`,
    );
    await Promise.all([room0.leave(true), room1.leave(true)]);
  } finally {
    await server.shutdown();
  }
}

await main();
