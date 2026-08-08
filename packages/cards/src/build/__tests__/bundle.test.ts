// `ir:build` 管线的测试（M4/E5）。
//
// 这里钉的是**管线的性质**，不是某张卡的数值（那是同目录 `pf1/**/*.test.ts` 的活）：
//   1. 确定性构建（IR §1 原则 1）—— 同一份源两次构建逐字节相同
//   2. bundleId 的语义 —— 卡表变则变、时间戳变则不变
//   3. opsUsed 收集 —— 藏在 script 深处的 op 也要收到
//   4. 产物必须能过校验器（builder → validate 的集成性质）
//
// 带 script 的卡是**测试夹具**，不是 PF1 的卡：E5 只做管线，真正的卡在 E6。
// 但 opsUsed 必须用有脚本的卡来测 —— 净水卡一个 op 都没有，测不出遍历漏没漏。

import { describe, expect, test } from "bun:test";
import type { Card } from "@prismfront/ir";
import {
  defineCard,
  defineEnchantment,
  ENEMY_UNITS,
  Hit,
  IR_VERSION,
  TARGET,
  validate,
} from "@prismfront/ir";
import { CARD_SOURCES, ENCHANTMENT_SOURCES } from "../../index.ts";
import { BUNDLE_EPOCH, buildBundle, resolveCreatedAt } from "../bundle.ts";

/** 夹具：一张有脚本的法术 + 它引用的附魔，用来把遍历的深处走一遍。 */
const SPELL: Card = defineCard({
  id: "TEST_S01",
  name: "试针",
  kind: "spell",
  cost: 1,
  colors: "red",
  target: ENEMY_UNITS,
  play: Hit(TARGET, 3),
});

const BUFFED: Card = defineCard({
  id: "TEST_M01",
  name: "试桩",
  kind: "minion",
  cost: 1,
  colors: "green",
  atk: 1,
  health: 1,
  deathrattle: { op: "act.buff", target: { op: "sel.self" }, ench: "TEST_M01e" },
});

const ENCH = defineEnchantment({ id: "TEST_M01e", atk: 1 });

const FIXTURE = { cards: [SPELL, BUFFED], enchantments: [ENCH] };

describe("buildBundle —— 确定性构建", () => {
  test("同一份源两次构建，产物逐字节相同（turbo 缓存与 golden replay 都押在这条上）", () => {
    expect(JSON.stringify(buildBundle(FIXTURE))).toBe(JSON.stringify(buildBundle(FIXTURE)));
  });

  test("卡表的书写顺序不影响产物（卡按 id 排序写入）", () => {
    const forward = buildBundle({ cards: [SPELL, BUFFED], enchantments: [ENCH] });
    const backward = buildBundle({ cards: [BUFFED, SPELL], enchantments: [ENCH] });
    expect(JSON.stringify(forward)).toBe(JSON.stringify(backward));
    expect(Object.keys(forward.cards)).toEqual(["TEST_M01", "TEST_S01"]);
  });

  test("改一张卡的数值 → bundleId 必须变（回放靠它区分卡表版本）", () => {
    const nerfed = defineCard({
      id: "TEST_M01",
      name: "试桩",
      kind: "minion",
      cost: 1,
      colors: "green",
      atk: 1,
      health: 2,
    });
    expect(buildBundle({ ...FIXTURE, cards: [SPELL, nerfed] }).bundleId).not.toBe(
      buildBundle(FIXTURE).bundleId,
    );
  });

  test("★ createdAt 变了 bundleId 不变 —— 时间戳不属于卡表内容", () => {
    const a = buildBundle({ ...FIXTURE, createdAt: "2026-01-01T00:00:00.000Z" });
    const b = buildBundle({ ...FIXTURE, createdAt: "2030-12-31T23:59:59.000Z" });
    expect(a.bundleId).toBe(b.bundleId);
    expect(a.createdAt).not.toBe(b.createdAt);
  });

  test("id 形如 pf1@<16 位指纹>", () => {
    expect(buildBundle(FIXTURE).bundleId).toMatch(/^pf1@[0-9a-f]{16}$/);
  });

  test("撞 id 直接炸，不静默丢卡", () => {
    expect(() => buildBundle({ cards: [SPELL, SPELL], enchantments: [] })).toThrow("id 重复");
  });
});

describe("buildBundle —— bundle 字段（IR §2.1）", () => {
  test("irVersion 取 @prismfront/ir 的 IR_VERSION，不写字面量", () => {
    expect(buildBundle(FIXTURE).irVersion).toBe(IR_VERSION);
  });

  test("createdAt 缺省 = 构建纪元常量", () => {
    expect(buildBundle(FIXTURE).createdAt).toBe(BUNDLE_EPOCH);
  });

  test("opsUsed 收全 script 深处的 op（含 deathrattle 与目标域）", () => {
    expect(buildBundle(FIXTURE).opsUsed).toEqual([
      "act.buff",
      "act.hit",
      "sel.self",
      "sel.target",
      "sel.zone",
    ]);
  });

  test("字段顺序 = IR §2.1 的声明顺序（规范形式里键序是产物的一部分）", () => {
    expect(Object.keys(buildBundle(FIXTURE))).toEqual([
      "irVersion",
      "bundleId",
      "createdAt",
      "opsUsed",
      "cards",
      "enchantments",
    ]);
  });

  test("★ 产物必须能过校验器（L1 + L2）—— builder 与校验器不许分叉", () => {
    const result = validate(buildBundle(FIXTURE));
    expect(result.issues.map((issue) => `${issue.path}: ${issue.message}`)).toEqual([]);
  });
});

describe("resolveCreatedAt —— 确定性 vs 真实构建时间", () => {
  test("没设 SOURCE_DATE_EPOCH → 固定纪元（默认路径可复现）", () => {
    expect(resolveCreatedAt(undefined)).toBe(BUNDLE_EPOCH);
    expect(resolveCreatedAt("   ")).toBe(BUNDLE_EPOCH);
  });

  test("设了就用它（reproducible-builds 的既有约定：秒 → ISO 8601）", () => {
    expect(resolveCreatedAt("1770000000")).toBe("2026-02-02T02:40:00.000Z");
  });

  test("坏值直接炸，不悄悄回落（回落会让人以为发布时间戳生效了）", () => {
    expect(() => resolveCreatedAt("昨天")).toThrow("SOURCE_DATE_EPOCH");
    expect(() => resolveCreatedAt("-1")).toThrow("SOURCE_DATE_EPOCH");
  });
});

describe("真正的卡表（CARD_SOURCES）", () => {
  test("能构建、能过校验", () => {
    const bundle = buildBundle({ cards: CARD_SOURCES, enchantments: ENCHANTMENT_SOURCES });
    expect(validate(bundle).issues).toEqual([]);
    // M4/E6 的首批 10 张（键按 id 排序写入，与源文件的聚合顺序无关）。
    expect(Object.keys(bundle.cards)).toEqual([
      "PF1_B01",
      "PF1_B02",
      "PF1_G01",
      "PF1_G02",
      "PF1_G03",
      "PF1_G04",
      "PF1_G05",
      "PF1_R01",
      "PF1_R07",
      "PF1_R09",
    ]);
  });

  test("卡表里没有重复 id（撞 id 会在这里先炸）", () => {
    const ids = CARD_SOURCES.map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
