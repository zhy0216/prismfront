// @prismfront/server —— Colyseus 房间与投影（架构 §2.3）
//
// 房间本身不使用 Colyseus Schema：棋盘走 snapshot/events 普通消息，serializerId 保持
// "none"。Colyseus 的 API 和 MatchRoom 生命周期适配器都只在 transport/ 下出现。

import {
  buildBundle,
  CARD_SOURCES,
  ENCHANTMENT_SOURCES,
  resolveCreatedAt,
} from "@prismfront/cards";
import { defineCard } from "@prismfront/ir";
import { startColyseusServer } from "./transport/colyseus.ts";
import { MatchRoom } from "./transport/match-room.ts";

// A tiny colourless card keeps the browser smoke harness deterministic without
// coupling it to a particular PF1 faction/light source setup. It is not part
// of the published card bundle; it only exists for the demo room's deck.
const DEMO_CARD = defineCard({
  id: "DEMO_CARD",
  name: "Demo unit",
  kind: "minion",
  cost: 0,
  colors: [],
  collectible: false,
  atk: 1,
  health: 1,
});

MatchRoom.cardRegistry = {
  bundle: buildBundle({
    cards: CARD_SOURCES,
    enchantments: ENCHANTMENT_SOURCES,
    createdAt: resolveCreatedAt("0"),
  }),
  cards: [...CARD_SOURCES, DEMO_CARD],
  enchantments: ENCHANTMENT_SOURCES,
};

export type {
  MatchResultRecord,
  MatchRoomCardRegistry,
  MatchRoomOptions,
} from "./rooms/match-room-core.ts";
export {
  bindClientIntent,
  MatchRoomCore,
  makeCardRegistry,
  snapshotFor,
} from "./rooms/match-room-core.ts";
export type {
  ClientTransport,
  RoomTransport,
  TimerHandle,
  TransportClient,
} from "./transport/index.ts";
export { MatchRoom } from "./transport/match-room.ts";

export const MATCH_ROOM_NAME = "match";

export async function startServer(port = Number(Bun.env.PORT ?? "2567")) {
  return startColyseusServer(MATCH_ROOM_NAME, MatchRoom, port);
}

if (import.meta.main) {
  const port = Number(Bun.env.PORT ?? "2567");
  await startServer(port);
  console.log(`PRISMFRONT_SERVER_READY ${port}`);
}
