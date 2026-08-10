import { resolve } from "node:path";

type Mode = "pve" | "pvp";

const root = resolve(import.meta.dir, "..");
const serverDir = resolve(root, "apps/server");
const clientDir = resolve(root, "apps/client");
const serverPort = 2567;
const clientPort = 5273;
const endpoint = `ws://127.0.0.1:${serverPort}`;
const args = process.argv.slice(2);
const mode = args.find((arg) => !arg.startsWith("--")) as Mode | undefined;
const noOpen = args.includes("--no-open");

if (args.includes("--help") || args.includes("-h")) {
  console.log("用法：bun pve | bun pvp [--no-open]");
  console.log("  bun pve       启动一个人工玩家 + 一个自动玩家");
  console.log("  bun pvp       启动单浏览器双人热座");
  console.log("  --no-open     只启动服务并打印 URL，不自动打开浏览器");
  process.exit(0);
}

if (mode !== "pve" && mode !== "pvp") {
  console.error("用法：bun pve | bun pvp [--no-open]");
  console.error("  bun pve       启动一个人工玩家 + 一个自动玩家");
  console.error("  bun pvp       启动单浏览器双人热座");
  console.error("  --no-open     只启动服务并打印 URL，不自动打开浏览器");
  process.exit(2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForHttp(url: string, label: string): Promise<void> {
  // Vite under Bun can accept an eager connection before its middleware stack
  // is ready and leave that first request hanging. Give both children one tick
  // to finish binding before the readiness probes begin.
  await sleep(300);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // The child process is still starting.
    }
    await sleep(100);
  }
  throw new Error(`${label} 启动超时：${url}`);
}

function openBrowser(url: string): void {
  if (noOpen) return;
  let command: string[];
  if (process.platform === "darwin") {
    command = ["open", "-a", "Google Chrome", url];
  } else if (process.platform === "linux") {
    command = ["xdg-open", url];
  } else if (process.platform === "win32") {
    command = ["cmd", "/c", "start", "", url];
  } else {
    console.warn(`未识别的系统，请手动打开：${url}`);
    return;
  }
  Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
}

const server = Bun.spawn(["bun", "run", "src/index.ts"], {
  cwd: serverDir,
  env: { ...Bun.env, PORT: String(serverPort) },
  stdout: "inherit",
  stderr: "inherit",
});
const vite = Bun.spawn(
  ["bunx", "--bun", "vite", "--host", "127.0.0.1", "--port", String(clientPort)],
  {
    cwd: clientDir,
    stdout: "inherit",
    stderr: "inherit",
  },
);

let stopped = false;
function stopChildren(): void {
  if (stopped) return;
  stopped = true;
  server.kill();
  vite.kill();
}

process.on("SIGINT", () => {
  stopChildren();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stopChildren();
  process.exit(143);
});

try {
  await Promise.all([
    waitForHttp(`http://127.0.0.1:${serverPort}/`, "服务端"),
    waitForHttp(`http://127.0.0.1:${clientPort}/`, "客户端"),
  ]);

  const parameter = mode === "pve" ? "pve" : "hotseat";
  const browserUrl = `http://127.0.0.1:${clientPort}/?${parameter}=${encodeURIComponent(endpoint)}`;
  console.log(`\nPrismfront ${mode.toUpperCase()} 已就绪`);
  if (mode === "pve") {
    console.log(`人工玩家：${browserUrl}`);
    console.log("AI 玩家：座位 1，由合法动作自动控制");
  } else {
    console.log(`双人热座：${browserUrl}`);
  }
  openBrowser(browserUrl);
  if (noOpen) console.log("已使用 --no-open；请复制上面的 URL 到浏览器。\n");
  else console.log("按 Ctrl-C 同时停止客户端和服务端。\n");

  await Promise.race([server.exited, vite.exited]);
} finally {
  stopChildren();
  await Promise.allSettled([server.exited, vite.exited]);
}
