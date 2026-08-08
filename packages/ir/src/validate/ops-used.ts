// `bundle.opsUsed` 的来源（IR §2.1）。
//
// > `opsUsed`：用到的 op 全集。engine 启动时一次性比对自己支持的 op 集，快速拒绝，
// > 不用等到卡打出来才炸。
//
// 收集靠的是 `walk.ts` 那一份遍历（`WalkContext.onNode`），不是另写一个 JSON 扫描器：
// IR 的节点会长在 play / deathrattle / trigger.do / intercept.then / act.when.then …
// 任意深处，而"哪个字段位置上会有节点"这件事已经由 `schemas.ts` 的字段表说清楚了。
// 再写一份遍历就等于把同一份结构知识抄两遍，op 集一增长（如 2.2.0 的 `cond.has_color`）
// 必然有一份先漂移。
//
// 顺带的两个性质：
//   1. `layers: []` ⇒ 一个 issue 都不收 —— 收集与校验各跑各的，互不污染。
//   2. 只收 **op 已知**的节点（`onNode` 在 `NODE_SCHEMAS` 命中之后才回调），
//      所以结果类型是 `NodeOp`，不需要在调用方再断言一次。
//      喂进一份结构已经坏掉的文档时可能少收几个 op —— 那种文档本来就过不了
//      `validate()`，构建管线的顺序是"先校验再产出"，不会把它写进 bundle。

import type { NodeOp } from "../types/index.ts";
import type { FieldKind } from "./kinds.ts";
import { checkKind, createContext } from "./walk.ts";

/**
 * 扫出 `value` 里用到的 op 全集。
 *
 * `kind` 是这个值的字段种类 token，和 `validateNode` 是同一套：
 * 整份 bundle 传 `"bundle"`，单张卡传 `"cardDoc"`，单个附魔传 `"enchantment"`。
 * `into` 用于跨多次调用累积（逐卡收集时省掉一堆临时 Set）。
 *
 * ⚠ 顺序是遍历顺序，不是排序后的顺序。`bundle.opsUsed` 要的是**稳定**的产物，
 * 排序由调用方按自己的规范形式决定（`packages/cards` 的 `buildBundle` 取字典序）。
 */
export const collectOps = (
  value: unknown,
  kind: FieldKind,
  into: Set<NodeOp> = new Set(),
): Set<NodeOp> => {
  const ctx = createContext([], (op) => {
    into.add(op);
  });
  checkKind(value, kind, kind, ctx, 0);
  return into;
};
