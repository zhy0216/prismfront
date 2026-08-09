// 服务端传输隔离层。
//
// rooms/ 只依赖这些接口，不导入 Colyseus。这样房间核心可以在 Bun、Node、测试假客户端
// 或将来的另一种实时框架上复用；唯一带有 Colyseus API 的文件是 colyseus.ts。

import type { ClientIntent, ResyncRequest, ServerMsg, Transport } from "@prismfront/shared";

export interface TransportClient {
  /** 这是当前连接的传输句柄，不得进入引擎状态或对外协议。 */
  readonly connectionId: string;
  send(message: ServerMsg): void;
}

export interface TimerHandle {
  clear(): void;
}

export interface RoomTransport {
  readonly clients: readonly TransportClient[];
  onIntent(callback: (client: TransportClient, intent: ClientIntent) => void): () => void;
  onResync(callback: (client: TransportClient, request: ResyncRequest) => void): () => void;
  schedule(delayMs: number, callback: () => void): TimerHandle;
  allowReconnection(client: TransportClient, seconds: number): Promise<TransportClient>;
  send(client: TransportClient, message: ServerMsg): void;
  broadcast(message: ServerMsg): void;
}

/** 客户端侧可替换 Transport 的最小实现辅助。 */
export interface ClientTransport extends Transport {}
