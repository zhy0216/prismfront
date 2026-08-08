// **M1 完成标志的第三条**：用 builder 写出规范文档里的示例卡，产出与文档里手写的 JSON
// 逐字节一致的规范形式。
//
// 比对方法（每个用例都点名比的是哪一段）：
//   1. 两边都过同一套 `canonicalize*`（同一套规则，不给任何一边开小灶）
//   2. 再比 `JSON.stringify` 的字符串 —— 字符串相等 = 逐字节一致
//
// 文档里的 JSON 有些是片段（只给了 `script.play` 或 `auras` 那一段），按片段比对；
// 三张卡（v2 §8.4-8.6）文档根本没给 JSON，这类用例的标题里写明"文档未给 JSON，按规范推导"，
// 不冒充文档原文。与文档不一致之处全部在 `fixtures/*.ts` 的头注释里逐条列出。

import { describe, expect, test } from "bun:test";
import {
  canonicalizeActs,
  canonicalizeAura,
  canonicalizeCard,
  canonicalizeCardScript,
  canonicalizeEnchantment,
  canonicalizeIntercept,
  canonicalizeTrigger,
  canonicalJson,
} from "../builder/index.ts";
import type { Act, Aura, CardScript, Enchantment, Intercept, Trigger } from "../types/index.ts";
import {
  DOC_8_1_SCRIPT_PLAY,
  DOC_8_2_AURAS,
  DOC_8_3_PLAY,
  DOC_8_4_PLAY,
  DOC_8_5_ENCHANTMENT,
  DOC_8_5_TRIGGERS,
  DOC_8_6_TRIGGERS,
  GRID_001,
  GRID_001E,
  GRID_002,
  GRID_003,
  GRID_004,
  GRID_005,
  GRID_005E,
  GRID_006,
  GRID_CARDS,
  GRID_ENCHANTMENTS,
} from "./fixtures/grid-cards.ts";
import {
  CORE_001,
  CORE_020,
  CORE_030_AURA,
  CORE_030_AURA_AS_DOCUMENTED_JSON,
  CORE_040,
  CORE_050_PLAY,
  DIVINE_SHIELD_INTERCEPT,
  DOC_10_1_SCRIPT,
  DOC_10_2_TRIGGERS,
  DOC_10_3_AURAS,
  DOC_10_4_SCRIPT,
  DOC_10_5_PLAY,
  DOC_10_6_INTERCEPTS,
} from "./fixtures/ir-v1-cards.ts";

const actsJson = (acts: Act | readonly Act[] | undefined): string =>
  canonicalJson(canonicalizeActs(acts));

const aurasJson = (auras: readonly Aura[] | undefined): string =>
  canonicalJson((auras ?? []).map(canonicalizeAura));

const triggersJson = (triggers: readonly Trigger[] | undefined): string =>
  canonicalJson((triggers ?? []).map(canonicalizeTrigger));

const interceptsJson = (intercepts: readonly Intercept[] | undefined): string =>
  canonicalJson((intercepts ?? []).map(canonicalizeIntercept));

const scriptJson = (script: CardScript): string => canonicalJson(canonicalizeCardScript(script));

const enchantmentJson = (ench: Enchantment): string => canonicalJson(canonicalizeEnchantment(ench));

describe("DSL v2 §8 六张示例卡 —— 与文档 JSON 逐字节比对", () => {
  test("§8.1 斜刺长枪兵 GRID_001：比 script.play 段（文档原文给的就是这一段）", () => {
    expect(actsJson(GRID_001.script.play)).toBe(actsJson(DOC_8_1_SCRIPT_PLAY));
  });

  test("§8.1 的附魔 GRID_001e：direction 落在 mods 上，duration 取默认 permanent", () => {
    // 文档只给了 `defineEnchantment({ id: "GRID_001e", direction: -1 })`，没给 JSON；
    // 期望值按 IR §2.3 + v2 §2.3/§3.5 推导："方向 -1"就是一张带 {direction:-1} 的普通附魔。
    expect(enchantmentJson(GRID_001E)).toBe(
      canonicalJson({
        id: "GRID_001e",
        attachesTo: "minion",
        mods: { direction: -1 },
        duration: "permanent",
      }),
    );
  });

  test("§8.2 空袭猎手 GRID_002：比 auras 段（文档原文给的就是这一段）", () => {
    expect(aurasJson(GRID_002.script.auras)).toBe(aurasJson(DOC_8_2_AURAS));
  });

  test("§8.3 裂地冲锋 GRID_003：比 play 段（文档原文给的就是这一段）", () => {
    expect(actsJson(GRID_003.script.play)).toBe(actsJson(DOC_8_3_PLAY));
  });

  test("§8.4 换位术 GRID_004：比 play 段（★ 文档未给 JSON，期望值按规范推导）", () => {
    expect(actsJson(GRID_004.script.play)).toBe(actsJson(DOC_8_4_PLAY));
  });

  test("§8.5 战地号手 GRID_005：比 triggers 段（★ 文档未给 JSON，期望值按规范推导）", () => {
    expect(triggersJson(GRID_005.script.triggers)).toBe(triggersJson(DOC_8_5_TRIGGERS));
  });

  test("§8.5 的附魔 GRID_005e：end_of_combat（★ 文档未给 JSON，期望值按规范推导）", () => {
    expect(enchantmentJson(GRID_005E)).toBe(enchantmentJson(DOC_8_5_ENCHANTMENT));
  });

  test("§8.6 荆棘卫士 GRID_006：比 triggers 段（★ 文档未给 JSON，期望值按规范推导）", () => {
    expect(triggersJson(GRID_006.script.triggers)).toBe(triggersJson(DOC_8_6_TRIGGERS));
  });

  test("六张卡都是规范形式的不动点：canonicalizeCard 幂等", () => {
    for (const card of GRID_CARDS) {
      expect(canonicalJson(canonicalizeCard(card))).toBe(canonicalJson(card));
    }
    for (const ench of GRID_ENCHANTMENTS) {
      expect(enchantmentJson(ench)).toBe(canonicalJson(ench));
    }
  });

  test("六张卡的 data 段：v2.1 §11.4 的 colors 必填且已归一成数组", () => {
    for (const card of GRID_CARDS) {
      expect(Array.isArray(card.data.colors)).toBe(true);
      expect(card.data.colors.length).toBe(1);
    }
  });
});

describe("IR §10 六个示例 —— 与文档 JSON 逐字节比对", () => {
  test("§10.1 火球术 CORE_001：比 script 段（zone 的 hero 已按架构 §10 第 3 项改成 base）", () => {
    expect(scriptJson(CORE_001.script)).toBe(scriptJson(DOC_10_1_SCRIPT));
  });

  test("§10.2 光明守护者 CORE_020：比 script.triggers 段（同样 hero → base）", () => {
    expect(triggersJson(CORE_020.script.triggers)).toBe(triggersJson(DOC_10_2_TRIGGERS));
  });

  test("§10.3 野猪王：比 auras 段 —— 对上的是 where 在内、minus 在外的那个写法", () => {
    // ⚠ 文档 §10.3 的 TS 源码与 JSON 自相矛盾（详见 fixtures/ir-v1-cards.ts）：
    // 源码 `FRIENDLY_MINIONS.not(SELF).where(...)` 从左往右是 where 包 minus，
    // JSON 却是 minus 包 where。两者语义等价、结构不同，不可能同时逐字节一致。
    // 本仓库按链式从左往右实现，因此与文档 JSON 对上的是显式写成那个顺序的版本。
    expect(aurasJson([CORE_030_AURA_AS_DOCUMENTED_JSON])).toBe(aurasJson(DOC_10_3_AURAS));
  });

  test("§10.3 的另一读法：链式从左往右 = where 在外，与文档 JSON 结构不同（如实记录冲突）", () => {
    expect(aurasJson([CORE_030_AURA])).not.toBe(aurasJson(DOC_10_3_AURAS));
  });

  test("§10.4 谜之勇士 CORE_040：比 script 段（summon 按 v2 §3.4 补了必填的 at）", () => {
    expect(scriptJson(CORE_040.script)).toBe(scriptJson(DOC_10_4_SCRIPT));
  });

  test("§10.5 发现：比 play 段（两个子句都在，HasFaction → IsBlue，见 fixtures 差异 3）", () => {
    // M1 时 `HasFaction("mage")` 没有对应 op，这条只比对了 `IsSpell()` 那一半；
    // M4 / 决策 #9 加了 `cond.has_color`（IR 2.2.0）之后，卡池过滤恢复成文档的 `cond.and` 两子句，
    // 与文档 JSON 只差"阵营词汇 → 颜色词汇"这一层翻译（faction mage → 蓝，《数值基准》§1.1）。
    expect(actsJson(CORE_050_PLAY)).toBe(actsJson(DOC_10_5_PLAY));
  });

  test("§10.5 的卡池过滤真的用上了 cond.has_color（不是又退回单子句）", () => {
    expect(actsJson(CORE_050_PLAY)).toContain(
      '{"op":"cond.has_color","of":{"op":"sel.it"},"color":"blue"}',
    );
  });

  test("§10.6 圣盾：比 intercepts 段（这一段与今天的规范无差异，纯逐字节）", () => {
    expect(interceptsJson([DIVINE_SHIELD_INTERCEPT])).toBe(interceptsJson(DOC_10_6_INTERCEPTS));
  });
});
