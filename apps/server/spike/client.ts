// M0 spike S1 · 客户端剧本。
// 用官方浏览器 SDK @colyseus/sdk@0.17.43 连 colyseus@0.17.10 服务端。
//
// 关于 SDK 选型（M0 spike 的实测结论，已改架构文档 §1.1 / §1.2）：
// 文档原先钉的是 `colyseus.js@0.16.22`，前提是「官方浏览器 SDK 的 latest 停在 0.16.22」。
// 这个前提是错的 —— colyseus.js 是 **0.16 线的旧包名**，0.17 线的官方 SDK 改名叫
// `@colyseus/sdk`（colyseus@0.17.10 自己的 devDependencies 里写的就是 @colyseus/sdk）。
// 实测：colyseus.js@0.16.22 连 0.17 服务端会在 matchmaking 阶段就抛
//   TypeError: undefined is not an object (evaluating 'response.room.name')
// 原因不是 schema，而是座位预定（seat reservation）的 JSON 信封在 0.16→0.17 之间变了：
//   0.17 返回扁平的 {name, sessionId, roomId, processId}
//   0.16 期待嵌套的 {room: {name, roomId, processId}, sessionId}
// 换成 @colyseus/sdk@0.17.43 之后零适配层跑通，且它依赖 @colyseus/schema@^4.0.7
// —— 与服务端 @colyseus/core 同 major，§1.2 风险 A 的 schema 3/4 裂口从根上消失，
// bun install 的 incorrect peer dependency 警告也一并没有了。
//
// 本 spike 验证 §1.2 风险 A（不使用 Schema 时序列化器是否真的停在 none）与风险 B
// （@colyseus/bun-websockets 在 Bun 下能否 join / send / 重连）。
//
// 三个标记必须由真实往返产生，不许硬编码：
//   joined      —— joinOrCreate 成功并拿到 sessionId
//   echo        —— send 出去的 nonce 原样从服务端回来
//   reconnected —— 断开后用 reconnectionToken 重连，sessionId 不变，
//                  且服务端 allowReconnection 的 then 分支确实跑过（reconnectCount 从 0 变 1）

import { Client, type Room } from "@colyseus/sdk";

type PongMessage = {
  nonce: string;
  sessionId: string;
  reconnectCount: number;
  clients: number;
};

/** 房间元信息 —— 决策 #1：它走的是普通消息，不是 Schema patch。 */
type SeatMeta = {
  sessionId: string;
  joinedAt: number;
  reconnectCount: number;
};

export type SpikeResult = {
  marks: string[];
  detail: Record<string, string | number | boolean>;
};

function timeout(ms: number, what: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`timeout after ${ms}ms while: ${what}`)), ms);
  });
}

/** 发一条 ping，等到 nonce 对得上的 pong 为止。 */
function roundTrip(room: Room, nonce: string, what: string): Promise<PongMessage> {
  const received = new Promise<PongMessage>((resolve) => {
    room.onMessage<PongMessage>("pong", (message) => {
      if (message.nonce === nonce) {
        resolve(message);
      }
    });
    room.send("ping", { nonce });
  });
  return Promise.race([received, timeout(5000, what)]);
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

export async function runSpikeClient(port: number): Promise<SpikeResult> {
  const endpoint = `ws://127.0.0.1:${port}`;
  // 0.17 线 SDK 直连 0.17 服务端，不需要任何适配层。
  const client = new Client(endpoint);
  const marks: string[] = [];
  const detail: Record<string, string | number | boolean> = {
    endpoint,
    sdkVersion: String(Client.VERSION),
    seatReservationShim: false,
  };

  // ---------------------------------------------------------------- joined
  const room = await Promise.race([
    client.joinOrCreate("spike", { who: "spike-client" }),
    timeout(8000, "joinOrCreate"),
  ]);
  assert(typeof room.sessionId === "string" && room.sessionId.length > 0, "sessionId is empty");
  assert(typeof room.roomId === "string" && room.roomId.length > 0, "roomId is empty");
  // 序列化器必须是 none —— 这就是「没有走 schema」的机器可验证证据。
  assert(room.serializerId === "none", `serializerId=${room.serializerId}, expected "none"`);

  const sessionId = room.sessionId;
  detail.sessionId = sessionId;
  detail.roomId = room.roomId;
  detail.serializerId = room.serializerId;
  marks.push(
    `joined       sessionId=${sessionId} roomId=${room.roomId} serializer=${room.serializerId}`,
  );

  // 决策 #1 的正面验证：座位表这种「本该放 Schema 的元信息」用普通消息也能到。
  // 服务端 onJoin 里 broadcast("seats", ...) 是在 JOIN_ROOM 之前入队的，
  // 会在客户端 ack JOIN_ROOM 之后被 flush，所以这里注册来得及。
  const seats = await Promise.race([
    new Promise<SeatMeta[]>((resolve) => {
      room.onMessage<SeatMeta[]>("seats", resolve);
    }),
    timeout(5000, "seats metadata (plain message, no Schema)"),
  ]);
  assert(
    Array.isArray(seats) && seats.length === 1,
    `unexpected seats payload: ${JSON.stringify(seats)}`,
  );
  assert(seats[0]?.sessionId === sessionId, "seats metadata carries a different sessionId");
  detail.seatsOverPlainMessage = JSON.stringify(seats);

  // ------------------------------------------------------------------ echo
  const nonce = `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = performance.now();
  const pong = await roundTrip(room, nonce, "echo round-trip");
  const rtt = Math.round((performance.now() - startedAt) * 100) / 100;
  assert(pong.nonce === nonce, `nonce mismatch: sent ${nonce}, got ${pong.nonce}`);
  assert(pong.sessionId === sessionId, "server saw a different sessionId");
  assert(pong.reconnectCount === 0, `expected reconnectCount 0, got ${pong.reconnectCount}`);
  detail.echoNonce = nonce;
  detail.echoRttMs = rtt;
  marks.push(`echo         nonce=${nonce} round-trip=${rtt}ms clientsInRoom=${pong.clients}`);

  // ----------------------------------------------------------- reconnected
  const reconnectionToken = room.reconnectionToken;
  assert(
    typeof reconnectionToken === "string" && reconnectionToken.includes(":"),
    `bad reconnectionToken: ${reconnectionToken}`,
  );
  detail.reconnectionToken = reconnectionToken;

  // consented=false ⇒ 直接关 socket，服务端走 onLeave 的非自愿分支 ⇒ allowReconnection。
  const leaveCode = await Promise.race([room.leave(false), timeout(5000, "leave(false)")]);
  detail.leaveCode = leaveCode;

  const rejoined = await Promise.race([
    client.reconnect(reconnectionToken),
    timeout(8000, "reconnect"),
  ]);
  assert(
    rejoined.sessionId === sessionId,
    `sessionId changed across reconnect: ${sessionId} -> ${rejoined.sessionId}`,
  );
  // 重连是新的 Room 实例，处理器要重新注册。这条同时吃掉服务端的 opponent_reconnected 广播。
  rejoined.onMessage<{ sessionId: string }>("opponent_reconnected", (message) => {
    detail.reconnectBroadcastFor = message.sessionId;
  });

  // 关键断言：再跑一次往返，服务端报的 reconnectCount 必须是 1。
  // 它只有在 room.onLeave 里 `await this.allowReconnection(...)` 真的 resolve 之后才会 +1，
  // 所以这一条同时证明了「客户端重连成功」与「服务端的 Promise 分支没有被静默吞掉」。
  const nonce2 = `${nonce}-again`;
  const pong2 = await roundTrip(rejoined, nonce2, "post-reconnect round-trip");
  assert(pong2.nonce === nonce2, "post-reconnect nonce mismatch");
  assert(
    pong2.reconnectCount === 1,
    `server-side allowReconnection did not resolve: reconnectCount=${pong2.reconnectCount}`,
  );
  detail.reconnectCount = pong2.reconnectCount;
  marks.push(
    `reconnected  sessionId=${rejoined.sessionId} (unchanged) leaveCode=${leaveCode} serverReconnectCount=${pong2.reconnectCount}`,
  );

  await rejoined.leave(true);
  return { marks, detail };
}
