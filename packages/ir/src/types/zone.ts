// 区域名与三处"侧别"取值集。
// 来源：IR v1 §3.1、DSL v2 §11.2/§11.3、架构 §10 第 3 项与第 4 项。

/**
 * 区域名。
 *
 * **架构 §10 第 3 项（规范一致性清理）**：IR v1 §3.1 的 ZoneName
 * 缺 v2.1 的 `"base"` 与 `"fountain"`，且 `"hero"` 的旧义已被 DSL v2 §11.2 推翻 ——
 * 此处**补齐 base / fountain，并删除 `"hero"`**。
 *
 * - `"board"`：9 格战线。DSL v2 §3.2 起**按格序 0→8 枚举**（v1 是无序列表 + playOrder）
 * - `"base"`：承接"方向指空格"伤害的实体（30 血，胜负判定）。
 *   即 v1 里叫 `"hero"` 的那个东西，v2.1 §11.2 改名 base；`ENEMY_HERO` → `ENEMY_BASE`
 * - `"fountain"`：复燃泉。英雄阵亡后进入，`respawnAt` 到期回到 deploy 阶段（v2.1 §11.3）
 * - `"hero"`：**已删除**。v2.1 的英雄是占格参战的单位（`kind:"hero"`，站在 board 上），
 *   不再是独立区域；旧义的承伤实体改叫 `"base"`
 * - `"weapon"` / `"secret"`：v1 遗留。PF1 无武器卡、无奥秘卡
 *   （DSL v2 §5 已删 `weapon_equipped` 事件，但保留 `secret_revealed`）。
 *   保留取值以对齐 v1 §3.1 词汇表，新卡池不应使用
 */
export const ZONE_NAMES = [
  "board",
  "hand",
  "deck",
  "graveyard",
  "secret",
  "weapon",
  "base",
  "fountain",
] as const;

export type ZoneName = (typeof ZONE_NAMES)[number];

/**
 * `slot.*` 的侧别（DSL v2 §7 里叫 `Side`）。
 *
 * **架构 §10 第 4 项（规范一致性清理）**：DSL v2 §7 的 `Side = "friendly"|"enemy"`
 * 与 IR v1 §3.1 中 `sel.zone` 的 `side`（**含 `"both"`**）同名不同集，
 * 此处拆成 `SlotSide` / `SelSide` 两个类型，取值集合确实不同，不许合并。
 *
 * 位置是 `(side, index)` 一维坐标，双方同索引对齐：友方 i 的"对面" = 敌方 i（v2 §0 规则 1）。
 */
export const SLOT_SIDES = ["friendly", "enemy"] as const;

export type SlotSide = (typeof SLOT_SIDES)[number];

/**
 * `sel.zone` 的侧别（IR v1 §3.1）。比 {@link SlotSide} 多一个 `"both"`。
 * 见 {@link SlotSide} 上的架构 §10 第 4 项说明。
 */
export const SEL_SIDES = ["friendly", "enemy", "both"] as const;

export type SelSide = (typeof SEL_SIDES)[number];

/**
 * `act.move.side`：移入本主的对应区，还是对手的对应区（IR v1 §3.4 / §9）。
 * 第三个同名不同集的"侧别"，同样单独成类型。
 */
export const MOVE_SIDES = ["owner", "opposite"] as const;

export type MoveSide = (typeof MOVE_SIDES)[number];
