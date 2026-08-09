const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 2587;
const server = Bun.spawn(["bun", "run", "src/index.ts"], {
  cwd: `${import.meta.dir}/../../server`,
  env: { ...Bun.env, PORT: String(port) },
  stdout: "pipe",
  stderr: "pipe",
});
const vite = Bun.spawn(["bunx", "--bun", "vite", "--host", "127.0.0.1", "--port", "5273"], {
  cwd: `${import.meta.dir}/..`,
  stdout: "pipe",
  stderr: "pipe",
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.status < 500) {
        ready = true;
        break;
      }
    } catch {
      // Colyseus is still listening.
    }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error(`server did not start: ${await new Response(server.stderr).text()}`);
  let viteReady = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch("http://127.0.0.1:5273/")).ok) {
        viteReady = true;
        break;
      }
    } catch {
      // Vite is still starting.
    }
    await Bun.sleep(100);
  }
  if (!viteReady) throw new Error("vite did not start");
  const run = (query: string): string => {
    const result = Bun.spawnSync([
      chrome,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--virtual-time-budget=30000",
      "--dump-dom",
      `http://127.0.0.1:5273/?${query}`,
    ]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  };
  const runOnlinePair = async (): Promise<[string, string]> => {
    const args = (seat: number) => [
      chrome,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--virtual-time-budget=30000",
      "--dump-dom",
      `http://127.0.0.1:5273/?server=ws://127.0.0.1:2587&autoplay=1&seat=${seat}`,
    ];
    const p0 = Bun.spawn(args(0), { stdout: "pipe", stderr: "pipe" });
    const p1 = Bun.spawn(args(1), { stdout: "pipe", stderr: "pipe" });
    const read = async (p: typeof p0): Promise<string> => {
      const [dom] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      return dom;
    };
    return [await read(p0), await read(p1)];
  };
  const [online0, online1] = await runOnlinePair();
  for (const [seat, online] of [
    [0, online0],
    [1, online1],
  ] as const) {
    if (!online.includes('data-transport="online"') || !online.includes('data-client-ready="true"'))
      throw new Error(`online browser failed to boot seat=${seat}`);
    if (!online.includes('data-transport-messages="'))
      throw new Error(`online browser did not register protocol handler seat=${seat}`);
  }
  const onlineMessages = Number(online0.match(/data-transport-messages="(\d+)"/)?.[1] ?? 0);
  let hotseat = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    hotseat = run("hotseat=ws://127.0.0.1:2587&autoplay=1&seat=0");
    if (hotseat.includes('data-card-played="true"') && hotseat.includes('data-match-over="')) break;
  }
  if (
    !hotseat.includes('data-transport="hotseat"') ||
    !hotseat.includes('data-client-ready="true"')
  ) {
    throw new Error("hotseat browser failed to boot");
  }
  const hotseatEvents = Number(hotseat.match(/data-event-count="(\d+)"/)?.[1] ?? 0);
  const hotseatMessages = Number(hotseat.match(/data-transport-messages="(\d+)"/)?.[1] ?? 0);
  if (hotseatEvents < 1 || hotseatMessages < 4)
    throw new Error(
      `hotseat browser did not advance: events=${hotseatEvents} messages=${hotseatMessages}`,
    );
  if (!hotseat.includes('data-card-played="true"'))
    throw new Error("hotseat browser did not play a card");
  if (!hotseat.includes('data-match-over="'))
    throw new Error("hotseat browser did not reach terminal state");
  console.log(
    `online-browser-smoke ok onlineMessages=${onlineMessages} hotseatEvents=${hotseatEvents} hotseatMessages=${hotseatMessages}`,
  );
} finally {
  server.kill();
  await server.exited;
  vite.kill();
  await vite.exited;
}
