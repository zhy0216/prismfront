// 光环（持续效果）的编写层构造器（IR §4.3、DSL v2 §2.3、v2 §8.2）。
//
// 光环是**声明式**的：不写"加上"和"减掉"，只声明"在什么条件下，谁获得什么"。
// 引擎每步重算 `tags = base + Σ附魔 + Σ生效光环`，于是"光环失效忘了减回去"
// 这一整类 bug 在表达层面就不存在。`direction` 走同一条管线，所以光环可以批量改方向。
//
// ★ 确定性硬约束（IR §5.4 规则 5 + v2 §3.1）：`affects` 与 `cond` 内**不得消耗 RNG**
//   （`.random(...)` / `RandomInt` / `RandomCard` / `RandomEmptySlot`）—— L3（M11）会拦。

import type { Aura as AuraNode, Cond, FlagName, Sel, TagKey, ZoneName } from "../types/index.ts";

/** {@link aura} 的入参。 */
export interface AuraSpec {
  affects: Sel;
  mods?: Partial<Record<TagKey, number>>;
  flags?: FlagName | readonly FlagName[];
  cond?: Cond;
  /** 光环在哪个区域生效。省略 → 规范形式补 `"board"`（IR §4.3 默认值）。 */
  zone?: ZoneName;
}

/**
 * 完整形式的光环构造器。字段顺序即规范键序：`affects, mods, flags, cond, zone`。
 * `zone` 缺省写死 `"board"` —— IR §10.3 与 v2 §8.2 的规范 JSON 都带着它。
 */
export function aura(spec: AuraSpec): AuraNode {
  const head: {
    affects: Sel;
    mods?: Partial<Record<TagKey, number>>;
    flags?: readonly FlagName[];
    cond?: Cond;
  } = { affects: spec.affects };
  if (spec.mods !== undefined) {
    head.mods = spec.mods;
  }
  if (spec.flags !== undefined) {
    head.flags = typeof spec.flags === "string" ? [spec.flags] : spec.flags;
  }
  if (spec.cond !== undefined) {
    head.cond = spec.cond;
  }
  return { ...head, zone: spec.zone ?? "board" };
}

/**
 * `Aura(affects, mods?, cond?)` —— IR §10.3 野猪王与 v2 §8.2 空袭猎手用的位置参数形式：
 *
 * ```ts
 * Aura(FRIENDLY_MINIONS.not(SELF).where(HasTribe(IT, "beast")), { atk: +1 })
 * Aura(SELF, { atk: +2 }, Not(Occupied(SlotOf(SELF).opposite())))
 * ```
 */
export function Aura(affects: Sel, mods?: Partial<Record<TagKey, number>>, cond?: Cond): AuraNode {
  const spec: AuraSpec = { affects };
  if (mods !== undefined) {
    spec.mods = mods;
  }
  if (cond !== undefined) {
    spec.cond = cond;
  }
  return aura(spec);
}
