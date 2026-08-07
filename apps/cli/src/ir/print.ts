// `ir:print <cardId>` —— IR 反编译器的命令行外壳（IR §11、里程碑 M1 完成标志第 2 条）。
//
//   bun run ir:print GRID_001
//   bun run ir:print GRID_001 CORE_040 GRID_005e
//
// 分工：**反编译逻辑全在 `packages/ir`**（零依赖纯函数：IR 进，字符串出），
// 这里只负责"取参数 → 查表 → 写 stdout → 定退出码"。架构 §2.2 禁令 5 允许
// apps/* 使用 Bun / Node 全局，packages/* 不允许 —— 这条分界线就落在本文件。
//
// 退出码：
//   0  全部 id 都打出来了
//   1  有 id 查不到（**绝不静默打印空**：查不到就报错并列出可选 id）
//   2  没给参数（用法错误）
//
// ⚠ 查表用的是 `@prismfront/ir/tools/examples` —— 规范文档里的示例卡，**M1 脚手架**。
// M4 起 `packages/cards` 会编译出 `dist/cards.ir.json`（架构 §5.1），
// 那时把 `lookup` 换成"读 bundle 再按 id 直查"即可，本文件其余部分不用动。

import { printCard, printEnchantment } from "@prismfront/ir/tools";
import { findSpecCard, findSpecEnchantment, specIds } from "@prismfront/ir/tools/examples";

const USAGE = `用法：ir:print <cardId | enchantId> [更多 id...]

把 IR 反编译成 TS 风格文本（IR §11 的 ir:print）。
例：bun run ir:print GRID_001`;

/**
 * 从一份卡牌文档里收集它引用的附魔 id。
 *
 * 走的是**通用 JSON 遍历**而不是按 op 分派：Card 是纯数据，`act.buff` 可能藏在
 * play / deathrattle / trigger.do / intercept.then / act.when.then 等任意深处，
 * 通用遍历不会随 op 集增长而漏掉分支，也不需要在 apps 侧复制一份 IR 的结构知识。
 */
function collectEnchantIds(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectEnchantIds(item, out);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.op === "act.buff" && typeof record.ench === "string") {
    out.add(record.ench);
  }
  for (const child of Object.values(record)) {
    collectEnchantIds(child, out);
  }
}

/**
 * 反编译一个 id：先当卡查，再当附魔查。
 *
 * 卡打出来之后**顺带把它引用的附魔也打出来** —— v2 §8.1 / §8.5 的文档源码就是
 * `defineCard(...)` 与 `defineEnchantment(...)` 成对出现的，缺了附魔那段读不出
 * "战吼：方向 -1"到底改了什么。
 */
function render(id: string): string | undefined {
  const card = findSpecCard(id);
  if (card !== undefined) {
    const blocks = [printCard(card)];
    const enchantIds = new Set<string>();
    collectEnchantIds(card, enchantIds);
    for (const enchantId of enchantIds) {
      const ench = findSpecEnchantment(enchantId);
      if (ench !== undefined) {
        blocks.push(printEnchantment(ench));
      }
    }
    return blocks.join("\n\n");
  }
  const ench = findSpecEnchantment(id);
  return ench === undefined ? undefined : printEnchantment(ench);
}

function main(argv: readonly string[]): number {
  if (argv.length === 0) {
    console.error(USAGE);
    return 2;
  }
  let missing = 0;
  const blocks: string[] = [];
  for (const id of argv) {
    const text = render(id);
    if (text === undefined) {
      console.error(`ir:print：找不到 ${id}`);
      missing += 1;
      continue;
    }
    blocks.push(text);
  }
  if (blocks.length > 0) {
    console.log(blocks.join("\n\n"));
  }
  if (missing > 0) {
    console.error(`可用的 id：${specIds().join(" ")}`);
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
