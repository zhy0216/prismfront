// 基础标识与文本类型。
// 来源：IR v1 §2.1（bundle）、§2.2（card）、§9（TS 权威类型）。

/** 卡牌 id。bundle 的 `cards` 以它为键（IR v1 §2.1）。例：`"BASE_R09"`、`"GRID_001"`。 */
export type CardId = string;

/** 附魔 id。`act.buff.ench` 指向它（IR v1 §3.4）。例：`"GRID_001e"`。 */
export type EnchantId = string;

/**
 * 运行时实体 id。
 *
 * 只出现在 `sel.entity`（IR v1 §5.6 的**运行时超集**）——编写期 bundle 里出现即校验错误。
 * 运行时超集只由引擎自己生成，永不来自外部输入，这是 UGC 场景的安全边界。
 */
export type EntityId = number;

/**
 * bundle 的不可变标识（IR v1 §2.1）。例：`"pf1@2026.08.07-1"`。
 * 每场对局开始时钉住一个 bundleId 并写进回放，平衡性补丁才不会让历史回放失真。
 */
export type BundleId = string;

/** 卡集标识（IR v1 §2.2 的 `card.set`）。例：`"pf1"`。 */
export type SetId = string;

/** 文案语言。中文为权威文案（《世界观与背景故事》§11：中文侧一律原生词）。 */
export type Locale = "zh" | "en";

/** 本地化文本（IR v1 §2.2 `data.name` / `data.text`、§9 `chooseOne[].text`）。 */
export interface LocalizedText {
  zh: string;
  en?: string;
}
