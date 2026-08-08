// 卡牌层面的标量词汇：kind / color / rarity。
// 单独成文件（而不是并进 card.ts）是为了让 cond.ts 这类节点文件能引用 CardKind
// 而不必依赖 Card 结构本身。
// 来源：IR v1 §2.2、DSL v2 §11.2/§11.4、《红蓝绿卡牌数值基准》§1.1。

/**
 * 卡牌种类（IR v1 §2.2）。`cond.is_kind` 的取值域。
 *
 * - `"minion"`：普通单位，占格参战
 * - `"spell"`：法术
 * - `"hero"`：**语义已被 DSL v2.1 §11.2 改写** —— 英雄不再是"承伤实体"，
 *   而是**卡组外 3 张、占格参战的单位**：在 9 格内占一格、有攻血、按方向出手、可被打，
 *   与单位同规则结算。承伤实体改名 base（见 `ZoneName`，架构 §10 第 3 项）。
 *   校验约束（v2.1 §11.4，L3/M11 落地）：`colors` 恰 1 个、无 `cost`、不计入 30 张卡组、
 *   **不写 `hero`**（`data.hero` 是「所属英雄」，英雄自己没有所属英雄，v2.1 §11.4b）
 * - `"token"`：衍生物，不可收藏
 * - `"weapon"` / `"hero_power"`：v1 遗留。PF1 无对应内容
 *   （v2 §5 删了 `weapon_equipped`，保留 `hero_power_used`，注明"玩法可能用不上"）。
 *   保留取值以对齐 v1 §2.2 词汇表
 */
export const CARD_KINDS = ["minion", "spell", "weapon", "hero", "hero_power", "token"] as const;

export type CardKind = (typeof CARD_KINDS)[number];

/**
 * 卡牌颜色（《数值基准》§1.1 色轮）。
 *
 * DSL v2.1 §11.4：`card.data.faction` **废弃** → `card.data.colors: Color[]`（长度 1-2）。
 * 长度 2 = 融合卡，需两色英雄同时在场。色门是 legality 层的事（M6），不进 DSL。
 *
 * 这里是全仓颜色定义的唯一出处：`src/color-ownership.ts`
 * （《数值基准》§1.2 色轮归属表）从本文件引入 `Color`，人和 lint 读同一份。
 */
export const COLORS = ["red", "blue", "green"] as const;

export type Color = (typeof COLORS)[number];

/**
 * 稀有度（IR v1 §2.2 `data.rarity`，架构 §5.2 列为客户端展示字段）。
 * 文档只出现过 `"common"`，其余三档按惯例阶梯补齐；纯展示数据，不参与任何规则。
 */
export const RARITIES = ["common", "rare", "epic", "legendary"] as const;

export type Rarity = (typeof RARITIES)[number];
