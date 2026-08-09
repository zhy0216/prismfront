// Colyseus 生命周期适配器。rooms/ 只有纯 MatchRoomCore，框架 API 全收口在 transport/。

import type { CardId, RulesConfig } from "@prismfront/ir";
import { enqueueMatchResult } from "../persistence/results.ts";
import {
  type MatchRoomCardRegistry,
  MatchRoomCore,
  type MatchRoomOptions,
} from "../rooms/match-room-core.ts";
import { type ColyseusClient, ColyseusRoom, isConsentedClose } from "./colyseus.ts";

export interface MatchRoomCreateOptions {
  rules?: RulesConfig;
  decks?: readonly [readonly CardId[], readonly CardId[]];
  heroes?: readonly [readonly CardId[], readonly CardId[]];
  seed?: number;
  firstPlayer?: 0 | 1;
  actionTimeoutMs?: number;
  reconnectSeconds?: number;
}

function readCreateOptions(value: unknown): MatchRoomCreateOptions {
  if (typeof value !== "object" || value === null) return {};
  const options = value as Record<string, unknown>;
  const out: MatchRoomCreateOptions = {};
  if (options.rules !== undefined) out.rules = options.rules as RulesConfig;
  if (Array.isArray(options.decks) && options.decks.length === 2) {
    out.decks = [
      Array.isArray(options.decks[0]) ? (options.decks[0] as CardId[]) : [],
      Array.isArray(options.decks[1]) ? (options.decks[1] as CardId[]) : [],
    ];
  }
  if (Array.isArray(options.heroes) && options.heroes.length === 2) {
    out.heroes = [
      Array.isArray(options.heroes[0]) ? (options.heroes[0] as CardId[]) : [],
      Array.isArray(options.heroes[1]) ? (options.heroes[1] as CardId[]) : [],
    ];
  }
  if (typeof options.seed === "number" && Number.isSafeInteger(options.seed))
    out.seed = options.seed;
  if (options.firstPlayer === 0 || options.firstPlayer === 1) out.firstPlayer = options.firstPlayer;
  if (typeof options.actionTimeoutMs === "number" && options.actionTimeoutMs >= 0) {
    out.actionTimeoutMs = options.actionTimeoutMs;
  }
  if (typeof options.reconnectSeconds === "number" && options.reconnectSeconds >= 0) {
    out.reconnectSeconds = options.reconnectSeconds;
  }
  return out;
}

export class MatchRoom extends ColyseusRoom {
  static cardRegistry: MatchRoomCardRegistry | undefined;

  private core!: MatchRoomCore;
  private readonly playerByConnection = new Map<string, string>();
  private generatedPlayer = 0;

  override onCreate(options: unknown): void {
    const coreOptions: MatchRoomOptions = {
      ...readCreateOptions(options),
      roomId: this.roomId,
      ...(MatchRoom.cardRegistry === undefined ? {} : { cardRegistry: MatchRoom.cardRegistry }),
      schedule: (delayMs, callback) => this.transport.schedule(delayMs, callback),
      persistResult: enqueueMatchResult,
    };
    // 构筑校验失败（DeckValidationError）让 onCreate 直接抛：Colyseus matchMaker
    // 会把它包成 ServerError 并透传 message 给客户端 join 调用方（建房被拒的原因
    // 因此可见），房间不创建、onJoin 不触发，客户端也不会误走重连路径。
    this.core = new MatchRoomCore(coreOptions);
    this.maxClients = 2;
    this.patchRate = null;
    this.transport.onIntent((client, intent) => {
      const playerId = this.playerByConnection.get(client.connectionId);
      if (playerId !== undefined) this.core.receive(playerId, intent);
    });
    this.transport.onResync((client, request) => {
      const playerId = this.playerByConnection.get(client.connectionId);
      if (playerId !== undefined && request.version === 1 && Number.isSafeInteger(request.seq)) {
        this.core.resync(playerId);
      }
    });
  }

  override onJoin(client: ColyseusClient): void {
    // M12 前无账号鉴权：忽略客户端自称身份，由服务端签发 opaque id。
    const playerId = `player-${this.generatedPlayer++}-${crypto.randomUUID()}`;
    const adapter = this.transport.adapter(client).view;
    this.playerByConnection.set(adapter.connectionId, playerId);
    client.userData = { playerId };
    this.core.join(playerId, adapter);
  }

  override async onLeave(client: ColyseusClient, code?: number): Promise<void> {
    const adapter = this.transport.adapter(client).view;
    const playerId = this.playerByConnection.get(adapter.connectionId);
    if (playerId === undefined) return;
    this.playerByConnection.delete(adapter.connectionId);
    if (isConsentedClose(code)) {
      this.core.forfeitPlayer(playerId, "concede");
      this.transport.forget(adapter);
      return;
    }
    this.core.markDisconnected(playerId);
    try {
      // Deferred 超时 reject 的可能是 false，必须 await/catch 整条分支。
      const reconnected = await this.transport.allowReconnection(
        adapter,
        this.core.reconnectWindowSeconds,
      );
      this.playerByConnection.set(reconnected.connectionId, playerId);
      this.core.markReconnected(playerId, reconnected);
    } catch {
      this.core.disconnectTimeout(playerId);
      this.transport.forget(adapter);
    }
  }

  override onDispose(): void {
    // MatchRoomCore 已 enqueue；销毁钩子绝不等待 I/O。
  }

  get game(): MatchRoomCore {
    return this.core;
  }
}
