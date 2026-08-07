// Bundle：一次构建的产物（cards.ir.json）。
// 来源：IR v1 §2.1 + §8、架构 §5.1。

import type { Card } from "./card.ts";
import type { BundleId, CardId, EnchantId } from "./common.ts";
import type { Enchantment } from "./enchantment.ts";
import type { IRVersion } from "./ir-version.ts";
import type { NodeOp } from "./ops.ts";

/**
 * 一次构建的产物（IR v1 §2.1），即 `packages/cards/dist/cards.ir.json`（架构 §5.1）。
 *
 * `cards` / `enchantments` 用 `Record` 而不是数组：按 id 直查。
 * 注意仓库开了 `noUncheckedIndexedAccess`，所以下标访问的结果是 `T | undefined`，
 * 这正是我们要的 —— 引用完整性由 L3 校验，运行时不许假设存在。
 */
export interface Bundle {
  /**
   * 本规范的 semver（架构 §10 第 1 项定为 `"2.1.0"`，见 `IR_VERSION`）。
   * engine 声明支持区间（如 `>=2.0.0 <3.0.0`），major 不匹配直接拒载（IR v1 §8）。
   */
  irVersion: IRVersion;
  /**
   * 不可变标识。**每场对局在开始时钉住一个 bundleId 并写进回放**，
   * 这样平衡性补丁不会让历史回放失真（IR v1 §2.1 / §8、架构 §5.1）。
   */
  bundleId: BundleId;
  /** ISO 8601 时间戳。 */
  createdAt: string;
  /**
   * 用到的 op 全集。engine 启动时一次性比对自己支持的 op 集，**快速拒绝**，
   * 不用等到卡打出来才炸（IR v1 §2.1、架构 §5.1）。
   */
  opsUsed: readonly NodeOp[];
  cards: Readonly<Record<CardId, Card>>;
  enchantments: Readonly<Record<EnchantId, Enchantment>>;
}
