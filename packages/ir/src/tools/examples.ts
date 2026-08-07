// ⚠ **M1 脚手架，M4 起删除。**
//
// `ir:print <cardId>` 需要一个"按 id 查卡"的地方。真正的地方是 `packages/cards` 编译出的
// `dist/cards.ir.json`（架构 §5.1），但那是 M4 的事 —— 在它出现之前，命令行入口先从
// 规范文档的示例卡里查。这个文件就是那份查表，**不是**卡池、不是数据源。
//
// 卡本身仍然只有一份定义：`../__tests__/fixtures/`（T3 按 v2 §8 与 IR §10 照抄的夹具，
// 每张卡的偏离都在那里逐条注明）。这里只做聚合与查找，不重新定义任何一张卡 ——
// 复制一份就会有两份真相，而 M1 的全部意义就是"同一份源永远产出同一份 JSON"。
//
// 它刻意**不**从 `./index.ts` 导出：tools 的对外面是反编译器（`printCard`），
// 示例卡不该混进 packages/ir 的公开 API。命令行入口按子路径
// `@prismfront/ir/tools/examples` 直接引它。

import { GRID_CARDS, GRID_ENCHANTMENTS } from "../__tests__/fixtures/grid-cards.ts";
import { CORE_001, CORE_020, CORE_020E, CORE_040 } from "../__tests__/fixtures/ir-v1-cards.ts";
import type { Card, CardId, EnchantId, Enchantment } from "../types/index.ts";

/**
 * 规范文档里的示例卡：v2 §8 的六张（`GRID_001`…`GRID_006`）+ IR §10 里成卡的三张
 * （`CORE_001` 火球术 / `CORE_020` 光明守护者 / `CORE_040` 谜之勇士）。
 *
 * IR §10.3 / §10.5 / §10.6 只给了片段（光环 / play 段 / 拦截器），没有完整的卡，
 * 故不在此列 —— 它们在 printer 的测试里单独覆盖。
 */
export const SPEC_CARDS: readonly Card[] = [...GRID_CARDS, CORE_001, CORE_020, CORE_040];

/** 示例卡用到的附魔：v2 §8.1 / §8.5 与 IR §10.2 各一枚。 */
export const SPEC_ENCHANTMENTS: readonly Enchantment[] = [...GRID_ENCHANTMENTS, CORE_020E];

/** 按 id 查示例卡。查不到返回 `undefined`（命令行入口据此报错并非 0 退出）。 */
export function findSpecCard(cardId: CardId): Card | undefined {
  return SPEC_CARDS.find((card) => card.id === cardId);
}

/** 按 id 查示例附魔。 */
export function findSpecEnchantment(enchantId: EnchantId): Enchantment | undefined {
  return SPEC_ENCHANTMENTS.find((ench) => ench.id === enchantId);
}

/** 全部可查 id，按卡在前、附魔在后。命令行"找不到"时用它列出可选项。 */
export function specIds(): readonly string[] {
  return [...SPEC_CARDS.map((card) => card.id), ...SPEC_ENCHANTMENTS.map((ench) => ench.id)];
}
