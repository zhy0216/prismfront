// IR 版本号。
// 来源：《卡牌 DSL 的 JSON IR 规范》§2.1（bundle 字段）、§8（semver 与迁移策略）。

/** semver 三段式。IR v1 §9 原文定义。 */
export type IRVersion = `${number}.${number}.${number}`;

/**
 * 本仓库产出与接受的 IR 版本。
 *
 * **架构 §10 第 1 项（规范一致性清理）**：DSL v2 §0 写 `"2.0.0"`、§11 写 `"2.1.0"`，
 * 两处不一致 —— **规范基线一律以 `"2.1.0"` 为准**（架构 §5.1 同样写死 2.1.0）。
 * 2.1.0 = v2 的格子战斗语义（major 2）+ v2.1 的英雄/色门/融合增补（minor 1）。
 *
 * 版本规则（IR v1 §8）：新增 op = minor；改变既有 op 的语义或字段 = major。
 * engine 声明支持区间，major 不匹配直接拒载，不做"尽力而为"。
 *
 * **2.1.0 → 2.2.0（M4 / 决策 #9）**：新增 `cond.has_color`（v2.1 §11.4 用
 * `data.colors` 取代 `faction` 后留下的"按颜色筛卡池"缺口）。只加了一个 op，
 * 既有 op 的语义与字段一个没动 —— 按 §8 就是 **minor**，major 仍是 2，旧 bundle 照常加载。
 *
 * **2.2.0 → 2.3.0（M5/T5）**：给 `act.strike` 加一个可选的 `amount`
 * （战斗第 ② 步冻结下来的出手数值，v2 §4.2；退役了 `rules/combat.ts` 那道运行时哨兵）。
 *
 * ── 为什么这条记 minor 而不是 major ────────────────────────────────────────
 * §8 那句「改变既有 op 语义或字段 = major」管的是**会让既有文档换个含义**的改动 ——
 * major 不匹配是**直接拒载**，代价是全部历史 bundle 与回放一起作废，
 * 所以判据只能是"旧文档还能不能按原意读"。这一条两头都没动：
 *   1. `amount` 是**运行时超集**字段（IR §5.6），编写子集不开放、构建产物里永不出现
 *      ⇒ 既有 bundle 的字节与含义**一字未变**，新引擎读旧 bundle 结果完全相同；
 *   2. 缺省语义就是 v2 §3.4 原本那句「`amount` = attacker 当前 atk」
 *      ⇒ 没写这个字段的 `act.strike` 行为逐字不变。
 * 于是它与「新增 op」在兼容性上是同一形态（多一种引擎认得、旧文档用不到的写法），
 * 按 §8 的意图记 **minor**，major 仍是 2。
 * ⚠ 哪天把 `amount` 开放给编写子集（让卡面写得出"出手但伤害改为 X"），那才是
 *   改 `act.strike` 的语义 —— 那一次必须 major。
 */
export const IR_VERSION = "2.3.0" satisfies IRVersion;

/** `typeof IR_VERSION`，用于把 bundle 的版本钉成字面量类型。 */
export type CurrentIRVersion = typeof IR_VERSION;

/** 当前 major。engine 用它做拒载判断（IR v1 §8）。 */
export const IR_VERSION_MAJOR = 2;
