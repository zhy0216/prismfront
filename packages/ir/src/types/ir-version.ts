// IR 版本号。
// 来源：《卡牌 DSL 的 JSON IR 规范》§2.1（bundle 字段）、§8（semver 与迁移策略）。

/** semver 三段式。IR v1 §9 原文定义。 */
export type IRVersion = `${number}.${number}.${number}`;

/**
 * 本仓库产出与接受的 IR 版本。
 *
 * **架构 §10 第 1 项（规范一致性清理）**：DSL v2 §0 写 `"2.0.0"`、§11 写 `"2.1.0"`，
 * 两处不一致 —— **一律以 `"2.1.0"` 为准**（架构 §5.1 同样写死 2.1.0）。
 * 2.1.0 = v2 的格子战斗语义（major 2）+ v2.1 的英雄/色门/融合增补（minor 1）。
 *
 * 版本规则（IR v1 §8）：新增 op = minor；改变既有 op 的语义或字段 = major。
 * engine 声明支持区间，major 不匹配直接拒载，不做"尽力而为"。
 */
export const IR_VERSION = "2.1.0" satisfies IRVersion;

/** `typeof IR_VERSION`，用于把 bundle 的版本钉成字面量类型。 */
export type CurrentIRVersion = typeof IR_VERSION;

/** 当前 major。engine 用它做拒载判断（IR v1 §8）。 */
export const IR_VERSION_MAJOR = 2;
