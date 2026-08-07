// M0 spike S1 · 编排脚本：起服务端子进程 → 跑客户端剧本 → 断言 → 自己退出。
// 入口：`bun run spike:colyseus`（根 package.json 转发到 apps/server 的 `spike` 脚本）。
//
// 成功：stdout 出现 joined / echo / reconnected 三个标记，退出码 0。
// 失败：打印失败原因与服务端最后的输出，退出码 1。任何情况下都不会留下常驻进程。

import { runSpikeClient } from "./client.ts";

const SERVER_BOOT_TIMEOUT_MS = 15_000;
const READY_PREFIX = "SPIKE_SERVER_READY";

/** 让内核挑一个空闲端口，避免 spike 之间/与 dev server 撞端口。 */
async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) {
    throw new Error("Bun.serve did not report a port");
  }
  return port;
}

type Pump = {
  done: Promise<void>;
  /** 等到某一行满足 match 为止；超时或流结束都会 reject。 */
  waitFor: (match: (line: string) => boolean, ms: number, what: string) => Promise<string>;
  tail: () => string[];
};

function pump(stream: ReadableStream<Uint8Array>, prefix: string): Pump {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  const waiters: Array<{ match: (line: string) => boolean; resolve: (line: string) => void }> = [];
  let ended = false;
  const endWaiters: Array<() => void> = [];

  const emit = (line: string): void => {
    lines.push(line);
    console.log(`${prefix} ${line}`);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (waiter === undefined) {
        continue;
      }
      if (!waiter.match(line)) {
        continue;
      }
      waiters.splice(i, 1);
      waiter.resolve(line);
    }
  };

  const done = (async () => {
    const reader = stream.getReader();
    let buffered = "";
    for (;;) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      for (;;) {
        const idx = buffered.indexOf("\n");
        if (idx < 0) {
          break;
        }
        emit(buffered.slice(0, idx).replace(/\r$/, ""));
        buffered = buffered.slice(idx + 1);
      }
    }
    if (buffered.length > 0) {
      emit(buffered);
    }
    ended = true;
    for (const notify of endWaiters) {
      notify();
    }
  })();

  const waitFor = (match: (line: string) => boolean, ms: number, what: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const existing = lines.find(match);
      if (existing !== undefined) {
        resolve(existing);
        return;
      }
      if (ended) {
        reject(new Error(`stream ended before: ${what}`));
        return;
      }
      const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms while: ${what}`)), ms);
      endWaiters.push(() => {
        clearTimeout(timer);
        reject(new Error(`stream ended before: ${what}`));
      });
      waiters.push({
        match,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      });
    });

  return { done, waitFor, tail: () => lines.slice(-20) };
}

async function main(): Promise<number> {
  const port = await pickFreePort();
  const serverEntry = new URL("./server.ts", import.meta.url).pathname;

  console.log(`[spike] bun=${Bun.version} port=${port}`);
  console.log(`[spike] booting ${serverEntry}`);

  const proc = Bun.spawn(["bun", "run", serverEntry], {
    env: { ...process.env, SPIKE_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });

  const out = pump(proc.stdout, "[server]");
  const err = pump(proc.stderr, "[server:err]");

  let exitCode = 1;
  try {
    await Promise.race([
      out.waitFor((line) => line.includes(READY_PREFIX), SERVER_BOOT_TIMEOUT_MS, "server boot"),
      proc.exited.then((code) => {
        throw new Error(`server process exited early with code ${code}`);
      }),
    ]);
    console.log("[spike] server is up, running client scenario\n");

    const result = await runSpikeClient(port);

    console.log("");
    for (const mark of result.marks) {
      console.log(mark);
    }
    console.log("");
    console.log(`[spike] detail ${JSON.stringify(result.detail)}`);
    console.log(
      "[spike] PASS — @colyseus/sdk@0.17.43 <-> colyseus@0.17.10 on @colyseus/bun-websockets",
    );
    exitCode = 0;
  } catch (error) {
    console.error("");
    console.error(`[spike] FAIL — ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack !== undefined) {
      console.error(error.stack);
    }
    console.error("[spike] last server stderr:");
    for (const line of err.tail()) {
      console.error(`  ${line}`);
    }
  } finally {
    proc.kill();
    await proc.exited;
    await Promise.allSettled([out.done, err.done]);
  }

  return exitCode;
}

process.exit(await main());
