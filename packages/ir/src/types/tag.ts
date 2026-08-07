// 实体属性键、全局量、标志位、部族。
// 来源：IR v1 §3.2/§3.3/§3.4/§9、DSL v2 §2.3/§3.3/§7、《红蓝绿卡牌数值基准》§7、架构 §10 第 5 项。

/**
 * 实体属性键（DSL v2 §7 的 `TagKey`，原文以省略号留白，这里补全）。
 *
 * 用于 `num.attr` / `num.sum` / `cond.has_tag` / `act.set_tag` / `act.mod_tag` /
 * `sel.sort.by`，以及附魔与光环的 `mods`。
 *
 * 生效值统一走同一条管线（DSL v2 §2.3）：
 * ```
 * 生效值 = base + Σ附魔 + Σ生效光环
 * ```
 *
 * - `"atk"`：攻击力。战斗快照的出手条件读它（DSL v2 §4.2，见 {@link FlagName} 的 `stunned`）
 * - `"health"`：血量。附魔 `mods.health` 是血量加成（IR v1 §2.3 的 `{atk:2,health:1}` = +2/+1）；
 *   **当前血量与血量上限如何记账是引擎侧的事（M2 定），不额外开 TagKey**
 * - `"cost"`：费用（水晶）。`costMod` 之外的直接改费走它
 * - `"direction"`：战斗方向。**DSL v2 §2.3 的核心：它是一个普通 Tag，不是新机制**。
 *   默认 0 = 正对面，目标格 = 敌方行的 `自己格索引 + 生效direction`。
 *   由此免费获得：附魔改方向、光环批量改方向、**沉默自动重置方向**、
 *   `num.attr(of,"direction")` 可读、`act.set_tag/mod_tag` 可写。方向不限幅，
 *   指出界 = 指空格 = 打基地（v2 §2.3 / §4.3）
 * - `"armor"`：护甲。`act.gain_armor` 的落点（IR v1 §3.4）
 *
 * 新增取值 = minor 版本（IR v1 §8）。
 */
export const TAG_KEYS = ["atk", "health", "cost", "direction", "armor"] as const;

export type TagKey = (typeof TAG_KEYS)[number];

/**
 * `num.tag` 读取的全局量（DSL v2 §3.3 原文：`round`、`crystals`、`crystal_cap`、`fatigue`）。
 * v1 的 `turn` / `mana` 已随回合与资源改名一并作废。
 */
export const GLOBAL_TAGS = ["round", "crystals", "crystal_cap", "fatigue"] as const;

export type GlobalTag = (typeof GLOBAL_TAGS)[number];

/**
 * 布尔标志位（IR v1 §3.3 `cond.has_flag` / §3.4 `act.set_flag` / §2.3 附魔 `flags`）。
 *
 * - `"divine_shield"`：圣盾（主题名"辉膜"）。挡一次出手，实现是拦截器
 *   `intercept: "act.hit"` + `effect.kind: "cancel"` + `then` 清标志（IR v1 §10.6）
 * - `"stunned"`：眩晕（主题名"滞光"）。
 *   **架构 §10 第 5 项（规范一致性清理）**：《数值基准》§7 要求把它写进 DSL v2 §4.2 的
 *   战斗快照条件，v2 正文尚未回写 —— 定案为
 *   **战斗快照的出手条件 = `atk > 0 && !stunned`**，回合结束清除。
 *   DSL 无新 op（`act.set_flag` 现成）
 * - `"silenced"`：已被沉默。`act.silence` 的落点，供 `cond.has_flag` 查询
 *
 * v1 §2.3 示例里的 `"taunt"` **不保留**：v2 没有攻击 intent、战斗目标由 `direction`
 * 唯一决定（v2 §4.2），嘲讽在格子战斗下没有语义。真要做"强制改箭头"用附魔改
 * `direction`（v2 §8.7 Compel 类）。
 */
export const FLAG_NAMES = ["divine_shield", "stunned", "silenced"] as const;

export type FlagName = (typeof FLAG_NAMES)[number];

/**
 * 部族（IR v1 §3.3 `cond.has_tribe`、§2.2 `data.tribe`）。
 *
 * PF1 卡池（《数值基准》§6 的 33 张）**没有部族设计**，此处只保留 v1 §10.3 野猪王示例
 * 用到的 `"beast"`，使那份示例仍可表达。M11 定卡池时若要引入部族，在这里扩充即可
 * （新增取值 = minor，IR v1 §8）。
 */
export const TRIBE_NAMES = ["beast"] as const;

export type TribeName = (typeof TRIBE_NAMES)[number];
