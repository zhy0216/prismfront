// Aura：持续效果（声明式）。
// 来源：IR v1 §4.3 + §9、DSL v2 §2.3（direction 也走同一条管线）、§8.2（位置条件光环）。

import type { Cond } from "./cond.ts";
import type { Sel } from "./sel.ts";
import type { FlagName, TagKey } from "./tag.ts";
import type { ZoneName } from "./zone.ts";

/**
 * 光环（IR v1 §4.3）。
 *
 * 光环是**声明式**的：不写"加上"和"减掉"，只声明"在什么条件下，谁获得什么"。
 * 引擎每步重算
 * ```
 * tags = base + Σ附魔 + Σ生效光环
 * ```
 * 这样"光环失效忘了减回去"这一整类 bug 在表达层面就不存在。
 * `direction` 同样走这条管线（v2 §2.3），所以光环可以批量改方向。
 *
 * ★ 确定性硬约束（IR v1 §5.4 规则 5 + v2 §3.1）：
 * 光环重算与死亡结算每步都跑，**不得消耗 RNG** ——
 * `affects` 与 `cond` 内出现 `sel.random` / `num.random` / `card.random` /
 * `slot.random_empty` 是校验期错误（L3/M11）。
 */
export interface Aura {
  /** 受影响的实体集合。每步重算，因此位置条件光环无需触发器（v2 §8.2）。 */
  affects: Sel;
  /** 属性加成，可含 `direction`（v2 §2.3）。 */
  mods?: Partial<Record<TagKey, number>>;
  /** 授予的标志位。 */
  flags?: readonly FlagName[];
  /** 生效条件，例：`Not(Occupied(SlotOf(SELF).opposite()))`（v2 §8.2 空袭猎手）。 */
  cond?: Cond;
  /** 光环在哪个区域生效，默认 `"board"`。 */
  zone?: ZoneName;
}
