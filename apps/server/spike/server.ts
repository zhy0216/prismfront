// M0 spike S1 · 服务端进程入口。
// 验证目标（架构 §1.2 风险 B）：colyseus@0.17.10 + @colyseus/bun-websockets@0.17.13
// 能否在 Bun 1.3.x 下起得来、能否服务 matchmake 的 HTTP 路由 + WebSocket 升级。
//
// 由 spike/index.ts 以子进程方式拉起；就绪后往 stdout 打一行 SPIKE_SERVER_READY <port>。

import { BunWebSockets } from "@colyseus/bun-websockets";
import { Server } from "colyseus";
import { SPIKE_ROOM_NAME, SpikeRoom } from "./room.ts";

const port = Number(Bun.env.SPIKE_PORT ?? "2570");

const gameServer = new Server({
  transport: new BunWebSockets(),
  greet: false,
  // spike 自己负责收尾：编排脚本跑完直接 kill 子进程，不要框架抢 SIGTERM。
  gracefullyShutdown: false,
});

gameServer.define(SPIKE_ROOM_NAME, SpikeRoom);

await gameServer.listen(port);

console.log(`SPIKE_SERVER_READY ${port}`);
