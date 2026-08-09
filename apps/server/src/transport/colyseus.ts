// Colyseus 适配器 —— 这是仓库唯一允许出现 Colyseus Room / Client API 的文件。

import { BunWebSockets } from "@colyseus/bun-websockets";
import type { ClientIntent, ResyncRequest, ServerMsg } from "@prismfront/shared";
import { type Client, CloseCode, Room, Server } from "colyseus";
import type { RoomTransport, TimerHandle, TransportClient } from "./index.ts";

/** 给业务房间继承的基类；不调用 setState()，保持 serializerId = "none"。 */
export abstract class ColyseusRoom extends Room {
  protected readonly transport = new ColyseusRoomTransport(this);
}

type ClientRecord = { readonly raw: Client; readonly view: TransportClient };

class ColyseusClientAdapter implements TransportClient {
  readonly connectionId: string;
  private readonly raw: Client;

  constructor(raw: Client) {
    this.raw = raw;
    this.connectionId = raw.sessionId;
  }

  send(message: ServerMsg): void {
    // 一个消息信道 + 协议内 t，避免不同 SDK 对同名消息的注册时序差异。
    this.raw.send("server", message);
  }
}

/** RoomTransport 的 Colyseus 实现。业务层只看 `TransportClient`。 */
export class ColyseusRoomTransport implements RoomTransport {
  private readonly adapters = new Map<string, ClientRecord>();
  private readonly room: Room;

  constructor(room: Room) {
    this.room = room;
  }

  get clients(): readonly TransportClient[] {
    return this.room.clients.map((client) => this.adapter(client).view);
  }

  onIntent(callback: (client: TransportClient, intent: ClientIntent) => void): () => void {
    return this.room.onMessage<ClientIntent>("intent", (client, message) => {
      callback(this.adapter(client).view, message);
    });
  }

  onResync(callback: (client: TransportClient, request: ResyncRequest) => void): () => void {
    return this.room.onMessage<ResyncRequest>("resync", (client, request) =>
      callback(this.adapter(client).view, request),
    );
  }

  schedule(delayMs: number, callback: () => void): TimerHandle {
    return this.room.clock.setTimeout(callback, delayMs);
  }

  async allowReconnection(client: TransportClient, seconds: number): Promise<TransportClient> {
    const record = this.adapters.get(client.connectionId);
    if (record === undefined) {
      throw new Error("unknown transport client for reconnection");
    }
    const reconnected = await this.room.allowReconnection(record.raw, seconds);
    this.adapters.delete(client.connectionId);
    return this.adapter(reconnected).view;
  }

  send(client: TransportClient, message: ServerMsg): void {
    const record = this.adapters.get(client.connectionId);
    record?.view.send(message);
  }

  broadcast(message: ServerMsg): void {
    for (const client of this.room.clients) {
      this.adapter(client).view.send(message);
    }
  }

  /** 仅生命周期适配器使用：把重连返回的新连接注册到 map。 */
  adapter(client: Client): ClientRecord {
    const existing = this.adapters.get(client.sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const view = new ColyseusClientAdapter(client);
    const record = { raw: client, view } satisfies ClientRecord;
    this.adapters.set(client.sessionId, record);
    return record;
  }

  forget(client: TransportClient): void {
    this.adapters.delete(client.connectionId);
  }
}

export type { Client as ColyseusClient } from "colyseus";
export { Room as ColyseusRoomBase } from "colyseus";

export function isConsentedClose(code: number | undefined): boolean {
  return code === CloseCode.CONSENTED;
}

export interface ColyseusServerHandle {
  shutdown(): Promise<void>;
}

export async function startColyseusServer(
  roomName: string,
  roomClass: new () => Room,
  port: number,
): Promise<ColyseusServerHandle> {
  const server = new Server({ transport: new BunWebSockets(), greet: false });
  server.define(roomName, roomClass);
  await server.listen(port);
  return { shutdown: () => server.gracefullyShutdown(false) };
}
