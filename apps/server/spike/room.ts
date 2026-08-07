// M0 spike S1 · Colyseus × Bun —— 最小房间。
//
// 决策 #1（已拍板）：**不使用 Colyseus Schema**。
// 本文件不定义任何 Schema 类、不调用 setState()，房间的元信息（座位/阶段/计时器一类）
// 与棋盘一样走 send / onMessage（架构 §1.2 首选方案、§9）。
// 这样服务端序列化器停在 `none`，schema 编解码路径一次都不会执行。
//
// 注意：本仓已把浏览器 SDK 从 colyseus.js@0.16.22 换成 @colyseus/sdk@0.17.43，
// 后者依赖 @colyseus/schema@^4.0.7，与服务端 @colyseus/core 同 major，
// 所以 §1.2 风险 A 的 schema 3/4 裂口已经从依赖层面消失（见 client.ts 顶部注释）。
// 决策 #1「不用 Schema」仍然成立且仍然是首选 —— 它让联机层可替换，而不只是躲版本裂口。
// client.ts 里的 `assert(room.serializerId === "none")` 是这条不变量的机器可验证哨兵：
// M9 只要有人写一次 setState()，序列化器就会切到 schema，该断言当场变红。
//
// 这不是 M9 的房间逻辑，只是验证「join / 双向消息 / 断线重连」三件事的最小载体。

import { type Client, CloseCode, Room } from "colyseus";

export const SPIKE_ROOM_NAME = "spike";

/** 重连窗口。spike 里取小值，M9 的真实值见《框架设计》§13。 */
export const RECONNECT_WINDOW_SEC = 8;

/** 房间元信息 —— 普通对象，不是 Schema。 */
type SeatMeta = {
  sessionId: string;
  joinedAt: number;
  /** 该座位成功重连过几次。用来证明服务端的 allowReconnection 真的 resolve 了。 */
  reconnectCount: number;
};

type PingMessage = { nonce: string };

type PongMessage = {
  nonce: string;
  sessionId: string;
  reconnectCount: number;
  clients: number;
};

export class SpikeRoom extends Room {
  /** 元信息容器：一个普通 Map，没有 Schema，没有 patch，没有序列化器参与。 */
  private readonly seats = new Map<string, SeatMeta>();

  override onCreate(): void {
    this.maxClients = 2;

    // 客户端 → 服务端 → 客户端 的一个来回。echo 标记就靠它。
    this.onMessage<PingMessage>("ping", (client, message) => {
      const seat = this.seats.get(client.sessionId);
      const pong: PongMessage = {
        nonce: message.nonce,
        sessionId: client.sessionId,
        reconnectCount: seat?.reconnectCount ?? -1,
        clients: this.clients.length,
      };
      console.log(`[room] onMessage ping nonce=${message.nonce} from=${client.sessionId}`);
      client.send("pong", pong);
    });
  }

  override onJoin(client: Client): void {
    this.seats.set(client.sessionId, {
      sessionId: client.sessionId,
      joinedAt: Date.now(),
      reconnectCount: 0,
    });
    console.log(`[room] onJoin ${client.sessionId} (clients=${this.clients.length})`);
    // 元信息下发：普通消息，不是 Schema patch。
    this.broadcast("seats", [...this.seats.values()]);
  }

  override async onLeave(client: Client, code?: number): Promise<void> {
    if (code === CloseCode.CONSENTED) {
      console.log(`[room] onLeave ${client.sessionId} consented -> drop seat`);
      this.seats.delete(client.sessionId);
      this.broadcast("seats", [...this.seats.values()]);
      return;
    }

    console.log(
      `[room] onLeave ${client.sessionId} code=${code} -> allowReconnection(${RECONNECT_WINDOW_SEC}s)`,
    );
    this.broadcast("opponent_disconnected", { sessionId: client.sessionId }, { except: client });

    // 《框架设计》§13 坑 7：allowReconnection 返回的是 Promise（Deferred）。
    // 忘了 catch 会静默吞掉「窗口超时 ⇒ 判负」这条分支 —— 所以这里必须 try/catch，
    // 而且 catch 分支要真的做事（此处：删座位并广播），不能是空块。
    //
    // spike 实测补充坑 7 的一个细节：超时时 @colyseus/core 走的是
    // `reconnection.reject(false)`（Room.mjs:815），**reject 值是布尔 false，不是 Error**。
    // 所以 M9 里千万不要写 `catch (e) { if (e instanceof Error) ... }` 或
    // `catch (e) { throw e }` —— 那等于把判负吞回去。
    try {
      await this.allowReconnection(client, RECONNECT_WINDOW_SEC);
      const seat = this.seats.get(client.sessionId);
      if (seat !== undefined) {
        seat.reconnectCount += 1;
      }
      console.log(
        `[room] reconnected ${client.sessionId} reconnectCount=${seat?.reconnectCount ?? -1}`,
      );
      this.broadcast("opponent_reconnected", { sessionId: client.sessionId });
    } catch (err) {
      // err === false（超时）或 Error（房间正在 dispose）。两种都必须判负。
      console.log(
        `[room] reconnection window expired for ${client.sessionId}: ${String(err)} (${typeof err})`,
      );
      this.seats.delete(client.sessionId);
      this.broadcast("seats", [...this.seats.values()]);
    }
  }

  override onDispose(): void {
    console.log(`[room] onDispose ${this.roomId}`);
  }
}
