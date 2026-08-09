// 非阻塞的比赛结果持久化队列。

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { MatchResultRecord } from "../rooms/match-room-core.ts";

export type MatchResultSink = (result: MatchResultRecord) => void | Promise<void>;

const resultDirectory = resolve(import.meta.dir, "../../reports/matches");

async function fileSink(result: MatchResultRecord): Promise<void> {
  await mkdir(resultDirectory, { recursive: true });
  const safeRoom = (result.roomId ?? "room").replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  const path = resolve(resultDirectory, `${safeRoom}-${result.seed}-${result.seq}.json`);
  await Bun.write(path, `${JSON.stringify(result)}\n`);
}

/** 串行队列防止同一进程的结果写入互相争用；enqueue 本身不等待 I/O。 */
export class MatchResultQueue {
  private pending: Promise<void> = Promise.resolve();
  private readonly sink: MatchResultSink;

  constructor(sink: MatchResultSink = fileSink) {
    this.sink = sink;
  }

  enqueue(result: MatchResultRecord): void {
    this.pending = this.pending
      .then(() => this.sink(result))
      .catch((error: unknown) => {
        console.error("failed to persist match result", error);
      });
  }

  async drained(): Promise<void> {
    await this.pending;
  }
}

export const matchResultQueue = new MatchResultQueue();

export function enqueueMatchResult(result: MatchResultRecord): void {
  matchResultQueue.enqueue(result);
}
