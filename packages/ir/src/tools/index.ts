// packages/ir/src/tools —— IR 的**反编译器**（架构 §2.3 的 `printCard`）。
//
// IR §11：`ir:print <cardId>` = 「IR → TS 风格文本（反编译器）。调试和 admin 展示用」。
// IR §1 原则 3 给的理由：「可读性由工具解决，不由格式牺牲。」IR 故意写成机器友好的
// 嵌套 JSON，能读懂它的是这个目录。
//
// 分工：
//   format.ts     宽度感知的排版原语（能放下就一行，放不下就每元素一行）
//   names.ts      IR 节点 → 编写层名字的对照表（含还原策略的完整说明）
//   print-node.ts sel/slot/num/cond/card/act 六族的节点级反编译
//   print-card.ts Card / Enchantment / Trigger / Intercept / Aura → `defineCard({...})`
//   examples.ts   M1 脚手架：按 id 查规范文档里的示例卡（**刻意不从这里导出**）
//
// 纯函数、零运行时依赖、无 Bun.* / bun:*：IR 进，字符串出。
// 不读文件、不查 bundle、不校验、不求值 —— 命令行外壳在 `apps/cli`。
//
// 不在 M1 范围内的姊妹工具：`ir:diff`（`diffBundles`）与 `ir:schema`。

export type { BundleDiff } from "./diff-bundles.ts";
export { diffBundles } from "./diff-bundles.ts";
export type { PrintContext } from "./format.ts";
export {
  DEFAULT_PRINT_WIDTH,
  INDENT_STEP,
  nested,
  rootContext,
} from "./format.ts";
export {
  BOARD_KIND_CONSTANTS,
  EVENT_HELPER_NAMES,
  ZONE_CONSTANTS,
} from "./names.ts";
export type { PrintOptions } from "./print-card.ts";
export {
  printAura,
  printCard,
  printEnchantment,
  printIntercept,
  printTrigger,
} from "./print-card.ts";
export {
  printAct,
  printActs,
  printCardRef,
  printCond,
  printNum,
  printPool,
  printSel,
  printSelOrPool,
  printSlot,
} from "./print-node.ts";
