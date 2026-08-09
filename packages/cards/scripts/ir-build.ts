// `ir:build` —— 卡牌编译：`src/**.ts` → IR bundle + 客户端展示数据。
//
//   bunx turbo ir:build            # 走缓存
//   cd packages/cards && bun run ir:build
//
// 分工（架构 §2.2 禁令 5 的分界线就落在本文件）：
//   编译逻辑全在 `src/build/`（纯函数：卡进、JSON 出，不碰文件系统、不读时钟）；
//   这里只负责"取源 → 调纯函数 → 写四个文件 → 打一行摘要"。
//
// 产物（架构 §5.1 / §5.2）：
//   packages/cards/dist/cards.ir.json          引擎的输入（含 script）
//   packages/cards/dist/cards.client.json      客户端的输入（**绝不含 script**）
//   apps/client/src/generated/cards.client.json  同一份客户端数据，直接被 client import
//
// 为什么客户端那份要复制过去而不是让 client 依赖本包：架构 §2.2 禁令 3 —— client
// 不得依赖 cards/engine 的脚本产物，否则它就持有了卡牌逻辑，可以预判隐藏信息。
// 复制一份纯展示 JSON 过去，boundaries 的 deny 成立，数据依然自动同步（架构 §3.1 的注）。
//
// ⚠ 已知边界：根 turbo.json 的 `ir:build.outputs` 只声明了 `dist/` 两份
//   （turbo 的 outputs 不能指向包外，本条目也不改根配置）。所以 **turbo 缓存命中时
//   只会还原 dist/，不会还原 apps/client/src/generated/**。那个目录被删掉之后要恢复，
//   跑 `bunx turbo ir:build --force`（或直接 `bun run ir:build`）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  buildBundle,
  CARD_SOURCES,
  ENCHANTMENT_SOURCES,
  projectClient,
  resolveCreatedAt,
} from "../src/index.ts";

/** 路径一律从模块自身解析，不吃 cwd —— turbo 与手跑的 cwd 不一定相同。 */
const DIST_DIR = new URL("../dist/", import.meta.url);
const CLIENT_GENERATED_DIR = new URL("../../../apps/client/src/generated/", import.meta.url);
const CLIENT_REPLAY_DIR = new URL("replays/", CLIENT_GENERATED_DIR);
const GOLDEN_REPLAY_DIR = new URL("../../../replays/golden/", import.meta.url);

/**
 * 产物用两空格缩进写出，不用紧凑形式。
 *
 * 这不影响确定性：规范形式管的是**键序**（IR §1 原则 1），而键序由 builder 与
 * `buildBundle` 定死，与缩进无关；`bundleId` 的指纹也是在紧凑的规范 JSON 上算的
 * （见 `src/build/bundle.ts`），排版怎么改都动不了它。换来的是产物可以直接用眼睛读。
 */
function writeJson(dir: URL, name: string, value: unknown): string {
  mkdirSync(dir, { recursive: true });
  const target = new URL(name, dir);
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return target.pathname;
}

const bundle = buildBundle({
  cards: CARD_SOURCES,
  enchantments: ENCHANTMENT_SOURCES,
  createdAt: resolveCreatedAt(process.env.SOURCE_DATE_EPOCH),
});
const client = projectClient(bundle);

const written = [
  writeJson(DIST_DIR, "cards.ir.json", bundle),
  writeJson(DIST_DIR, "cards.client.json", client),
  writeJson(CLIENT_GENERATED_DIR, "cards.client.json", client),
];

mkdirSync(CLIENT_REPLAY_DIR, { recursive: true });
for (const file of [
  "beam-through-empty.json",
  "color-gate-blackout.json",
  "combat-tradeoff.json",
  "deploy-r1-r2.json",
  "diagonal-strike.json",
  "discover-suspend.json",
  "initiative-first-passer.json",
  "thorns-dies-but-retaliates.json",
]) {
  writeFileSync(
    new URL(file, CLIENT_REPLAY_DIR),
    readFileSync(new URL(file, GOLDEN_REPLAY_DIR), "utf8"),
  );
}

console.log(
  `ir:build ✓ ${bundle.bundleId}（irVersion ${bundle.irVersion}）` +
    ` ${Object.keys(bundle.cards).length} 张卡 /` +
    ` ${Object.keys(bundle.enchantments).length} 个附魔 /` +
    ` ${bundle.opsUsed.length} 个 op`,
);
for (const path of written) {
  console.log(`  → ${path}`);
}
