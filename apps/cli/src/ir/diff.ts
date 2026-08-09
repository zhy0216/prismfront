// `ir:diff <旧 bundle> <新 bundle>` —— IR 平衡性变更日志命令行入口。
//
// 这里只负责"读文件 → 校验 bundle → 调 diffBundles → 写 stdout → 定退出码"；
// 稳定的 diff 逻辑在 `packages/ir`，避免 apps 侧复制 IR 结构知识。

import { readFileSync } from "node:fs";
import type { Bundle, BundleDiff } from "@prismfront/ir";
import { diffBundles, formatIssues, validateL3 } from "@prismfront/ir";

const USAGE = `用法：ir:diff <旧 bundle.json> <新 bundle.json>

输出两份 IR bundle 的卡牌与附魔平衡性变更日志。`;

const SECTIONS = [
  ["addedCards", "新增卡牌"],
  ["removedCards", "移除卡牌"],
  ["changedCards", "变更卡牌"],
  ["addedEnchantments", "新增附魔"],
  ["removedEnchantments", "移除附魔"],
  ["changedEnchantments", "变更附魔"],
] as const satisfies readonly (readonly [keyof BundleDiff, string])[];

function readBundle(path: string): Bundle | undefined {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`ir:diff：无法读取或解析 ${path}：${reason}`);
    return undefined;
  }

  const result = validateL3(document);
  if (!result.ok) {
    console.error(`ir:diff：${path} 不是合法 bundle：`);
    console.error(formatIssues(result.issues));
    return undefined;
  }
  return document as Bundle;
}

function formatDiff(diff: BundleDiff): string {
  const lines = ["平衡性变更日志："];
  for (const [key, label] of SECTIONS) {
    const ids = diff[key];
    if (ids.length > 0) {
      lines.push(`${label}（${ids.length}）：`);
      lines.push(...ids.map((id) => `  - ${id}`));
    }
  }
  return lines.length === 1 ? "平衡性变更日志：无差异" : lines.join("\n");
}

function main(argv: readonly string[]): number {
  if (argv.length !== 2) {
    console.error(USAGE);
    return 2;
  }
  const [beforePath, afterPath] = argv;
  if (beforePath === undefined || afterPath === undefined) {
    console.error(USAGE);
    return 2;
  }
  const before = readBundle(beforePath);
  const after = readBundle(afterPath);
  if (before === undefined || after === undefined) {
    return 1;
  }
  console.log(formatDiff(diffBundles(before, after)));
  return 0;
}

process.exit(main(process.argv.slice(2)));
