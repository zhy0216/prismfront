// @prismfront/cards —— 卡牌脚本源（架构 §2.3）
//
// 对外三样东西：
//   1. `CARD_SOURCES` / `ENCHANTMENT_SOURCES` —— TS 源（架构 §2.3 的对外契约）
//   2. `buildBundle`  —— 源 → `dist/cards.ir.json`（IR §2.1 的 bundle，架构 §5.1）
//   3. `projectClient` —— bundle → `dist/cards.client.json`（展示字段，架构 §5.2）
// 写文件的入口是 `scripts/ir-build.ts`（`bun run ir:build`），本包的 src 全部保持纯函数。
//
// 内部结构：`src/pf1/{R,G,B,heroes,tokens}/` + 同目录 `*.test.ts`（测试策略第 1 层：
// 每张卡 3 行，新增卡必须带测试）。
// 外加一个**不进卡集**的目录 `src/keywords/`（M5/T6）：DSL v2 §8.7 四条 Artifact
// 关键词的**范式**与它们的表达力验收测试。它刻意不从本文件导出、也不在 `PF1_CARDS` 里
// —— 那几张卡不进 bundle，理由写在该目录的文件头。
// 铁律：运行时只依赖 @prismfront/ir；对 @prismfront/engine 只能是 devDependency
// （架构 §2.2 禁令 4）。不含引擎逻辑。

import type { Card, Enchantment } from "@prismfront/ir";
import { PF1_CARDS, PF1_ENCHANTMENTS } from "./pf1/index.ts";

// 导出面刻意收窄到"外面真的要用的东西"：`bundleIdOf` / `fingerprint` 这些是
// 构建管线的内部零件，只由 `src/build/` 内部与它们各自的测试直接引用。
export type { BuildInput } from "./build/bundle.ts";
export { BUNDLE_EPOCH, buildBundle, resolveCreatedAt } from "./build/bundle.ts";
export type { ClientBundle, ClientCard } from "./build/client.ts";
export { projectClient } from "./build/client.ts";
export { PF1_CARDS, PF1_ENCHANTMENTS } from "./pf1/index.ts";

/**
 * 参与构建的全部卡（架构 §2.3 定的对外名字）。
 *
 * 今天它就是 PF1 一个卡集；将来出第二个卡集时，这里是各卡集之和，
 * 而 `PF1_CARDS` 仍然指"PF1 这一集"—— 两个名字不重复，各有各的用处。
 */
export const CARD_SOURCES: readonly Card[] = PF1_CARDS;

/** 参与构建的全部附魔。 */
export const ENCHANTMENT_SOURCES: readonly Enchantment[] = PF1_ENCHANTMENTS;
