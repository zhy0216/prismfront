const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const replays = [
  "beam-through-empty",
  "color-gate-blackout",
  "combat-tradeoff",
  "deploy-r1-r2",
  "diagonal-strike",
  "discover-suspend",
  "initiative-first-passer",
  "thorns-dies-but-retaliates",
];
const vite = Bun.spawn(["bunx", "--bun", "vite", "--host", "127.0.0.1", "--port", "5273"], {
  cwd: `${import.meta.dir}/..`,
  stdout: "pipe",
  stderr: "pipe",
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:5273/");
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Vite is still starting.
    }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("Vite did not start");
  for (const replay of replays) {
    const result = Bun.spawnSync([
      chrome,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--virtual-time-budget=6000",
      "--dump-dom",
      `http://127.0.0.1:5273/?replay=${replay}&autoplay=1`,
    ]);
    const dom = result.stdout.toString();
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    if (!dom.includes("<canvas") || !dom.includes('data-client-ready="true"')) {
      throw new Error(`browser did not boot Phaser replay=${replay}: ${dom.slice(0, 500)}`);
    }
    const eventCount = Number(dom.match(/data-event-count="(\d+)"/)?.[1] ?? 0);
    if (eventCount < 1 || !dom.includes(`data-replay="${replay}"`)) {
      throw new Error(`replay did not advance: replay=${replay} eventCount=${eventCount}`);
    }
    console.log(`browser-smoke ok canvas=true replay=${replay} events=${eventCount}`);
  }
} finally {
  vite.kill();
  await vite.exited;
}
