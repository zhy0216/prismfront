// `ir:validate` —— 卡牌数据闸门（架构 §3.3 的 CI 第三步）。
//
//   bunx turbo ir:validate         # 会先跑 ir:build（根 turbo.json 里 dependsOn）
//
// 校验的是**磁盘上的产物**而不是内存里的对象，这是有意的：真正被 engine 载入的是
// `dist/cards.ir.json` 那份 JSON。从磁盘读回来再校验，顺带把"序列化 → 反序列化"
// 这一跳也覆盖了（校验器的入参本来就是 `unknown`，正是为了吃磁盘上的 JSON）。
//
// 今天跑的是 IR §7 的 **L1 结构 + L2 种类**（`validate()` 的默认层）。
// L3 语义、§7 的资源上限表、色轮归属 lint 是 M11 的事（op 集稳定之后才写，IR §12），
// 到时候只需在这里把层数补上，本文件其余部分不用动。
//
// 退出码：0 = 干净；1 = 有任何 issue（含告警级）。构建产物不留待办，
// 有问题就该在 CI 红，而不是等对局里炸。

import { readFileSync } from "node:fs";
import type { Bundle } from "@prismfront/ir";
import { formatIssues, validate } from "@prismfront/ir";

const IR_PATH = new URL("../dist/cards.ir.json", import.meta.url);

const document: unknown = JSON.parse(readFileSync(IR_PATH, "utf8"));
const result = validate(document);

if (result.issues.length > 0) {
  console.error(`ir:validate ✗ ${IR_PATH.pathname}：${result.issues.length} 处问题`);
  console.error(formatIssues(result.issues));
  process.exit(1);
}

// L1 + L2 全过 ⇒ 可以安全地按 `Bundle` 使用（validate.ts 的第 3 条约定）。
const bundle = document as Bundle;
console.log(
  `ir:validate ✓ ${bundle.bundleId}：${Object.keys(bundle.cards).length} 张卡通过 L1 + L2`,
);
