import { expect, test } from "bun:test";
import {
  type CapabilityEntry,
  COLOR_OWNERSHIP,
  capabilitiesByRank,
  capabilitiesForFlag,
  capabilitiesForKeyword,
  capabilitiesForOp,
  capabilitiesForTagKey,
  capabilityById,
  colorsOwnOp,
  forbiddenOpsFor,
  OWNERSHIP_RANKS,
  type Ownership,
  ownershipForColors,
  ownershipOf,
  ownsOp,
  SECONDARY_COST_MULTIPLIER,
} from "./color-ownership.ts";
import { COLORS, type Color } from "./types/card-kind.ts";
// 权威词汇表：色轮归属登记的 op / tagKey / flag 必须从这里核，不能抄字符串。
import { ACT_OP_SET } from "./types/ops.ts";
import { FLAG_NAMES, TAG_KEYS } from "./types/tag.ts";

/** 宽化视图：常量是 as const 元组，测试里按接口读更省事。 */
const TABLE: readonly CapabilityEntry[] = COLOR_OWNERSHIP;

// ---------------------------------------------------------------------------
// 表格保真：下面是《红蓝绿卡牌数值基准》§1.2 的独立誊抄，与常量逐格比对。
// 改表必须两处同改，否则测试红 —— 这就是「人和 lint 读同一份」的机器保证。
// 列序：红 蓝 绿（同文档）。
// ---------------------------------------------------------------------------

type DocRow = readonly [id: string, red: Ownership, blue: Ownership, green: Ownership];

const DOC_TABLE: readonly DocRow[] = [
  ["damage", "primary", "secondary", "forbidden"],
  ["duel", "secondary", "forbidden", "primary"],
  ["direction", "primary", "secondary", "forbidden"],
  ["shift", "secondary", "primary", "forbidden"],
  ["reposition", "forbidden", "primary", "forbidden"],
  ["card_advantage", "forbidden", "primary", "secondary"],
  ["disable", "forbidden", "primary", "forbidden"],
  ["hard_removal", "forbidden", "primary", "forbidden"],
  ["buff", "secondary", "forbidden", "primary"],
  ["growth", "forbidden", "forbidden", "primary"],
  ["heal", "forbidden", "secondary", "primary"],
  ["cleave_siege", "primary", "forbidden", "forbidden"],
  ["retaliate", "forbidden", "forbidden", "primary"],
  ["divine_shield", "forbidden", "secondary", "primary"],
  ["token", "secondary", "forbidden", "primary"],
];

test("COLOR_OWNERSHIP 与 §1.2 表格逐格一致（15 行，行序一致）", () => {
  const actual: readonly DocRow[] = TABLE.map((entry) => [
    entry.id,
    entry.ownership.red,
    entry.ownership.blue,
    entry.ownership.green,
  ]);
  expect(actual).toEqual(DOC_TABLE);
});

test("每行的档位取值都在 OWNERSHIP_RANKS 内", () => {
  for (const entry of TABLE) {
    for (const color of COLORS) {
      expect(OWNERSHIP_RANKS).toContain(entry.ownership[color]);
    }
  }
});

test("每行至少有一种露头方式，否则 lint 永远抓不到它", () => {
  const blind = TABLE.filter(
    (e) => e.ops.length + e.tagKeys.length + e.flags.length + e.keywords.length === 0,
  ).map((e) => e.id);
  expect(blind).toEqual([]);
});

test("id 唯一，且同一个 op 不会落在两行上（ownershipOf 因此无歧义）", () => {
  const ids = TABLE.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);

  const ops = TABLE.flatMap((entry) => [...entry.ops]);
  expect(new Set(ops).size).toBe(ops.length);
});

test("★ 登记的每个 op 都真实存在于 Act 词汇表（改 types/act.ts 会让这条红）", () => {
  // 这一条必须**从权威类型 import**，不能再抄一份字符串数组：
  // 抄一份的话，删掉或改名 types/act.ts 里的 op 时这里不会红，
  // 而 M11 的色轮 lint 会静默失去对该行的判定能力。
  const registered = TABLE.flatMap((entry) => [...entry.ops]);
  const unknown = registered.filter((op) => !(op in ACT_OP_SET));
  expect(unknown).toEqual([]);
  // 同理反向钉住 tagKeys / flags：它们也参与归属判定（15 行里有 5 行没有独占 op）。
  // 这里要的是「成员资格」检查，所以把词汇表放宽成 readonly string[] 再 includes——
  // 不放宽的话 includes 的形参是窄联合，反而拒绝接受"可能不合法"的值，检查就没意义了。
  const tagVocab: readonly string[] = TAG_KEYS;
  const flagVocab: readonly string[] = FLAG_NAMES;
  const tagKeys: readonly string[] = TABLE.flatMap((entry) => [...(entry.tagKeys ?? [])]);
  expect(tagKeys.filter((k) => !tagVocab.includes(k))).toEqual([]);
  const flags: readonly string[] = TABLE.flatMap((entry) => [...(entry.flags ?? [])]);
  expect(flags.filter((f) => !flagVocab.includes(f))).toEqual([]);
});

test("登记的 op 集合快照（改表要两处同改）", () => {
  const ops = TABLE.flatMap((entry) => [...entry.ops]).sort();
  expect(ops).toEqual([
    "act.destroy",
    "act.discover",
    "act.draw",
    "act.gain_armor",
    "act.heal",
    "act.hit",
    "act.move_to",
    "act.shift",
    "act.silence",
    "act.strike",
    "act.summon",
    "act.swap",
    "act.transform",
  ]);
  for (const op of ops) {
    expect(op.startsWith("act.")).toBe(true);
  }
});

test("v2 §3.4 删除/改名的 v1 op 没有混进表里", () => {
  const ops = new Set(TABLE.flatMap((entry) => [...entry.ops]));
  for (const dead of ["act.attack", "act.gain_mana", "act.gain_max_mana"]) {
    expect(ops.has(dead)).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

test("§1.2 的示范判例：红卡出现 act.swap → 越权", () => {
  expect(ownsOp("red", "act.swap")).toBe(false);
  expect(ownershipOf("red", "act.swap")).toBe("forbidden");
  expect(ownsOp("blue", "act.swap")).toBe(true);
  expect(ownershipOf("blue", "act.swap")).toBe("primary");
  expect(ownsOp("green", "act.swap")).toBe(false);
});

test("主色 / 副色都放行，档位可区分（副色计价 ×1.25）", () => {
  expect(ownershipOf("red", "act.hit")).toBe("primary");
  expect(ownershipOf("blue", "act.hit")).toBe("secondary");
  expect(ownershipOf("green", "act.hit")).toBe("forbidden");
  expect(ownsOp("blue", "act.hit")).toBe(true);
  expect(SECONDARY_COST_MULTIPLIER).toBe(1.25);
});

test("未登记的 op 不受色轮约束（表是黑名单不是白名单）", () => {
  for (const op of ["act.when", "act.repeat", "act.gain_crystal", "act.set_tag", "act.nothing"]) {
    for (const color of COLORS) {
      expect(ownershipOf(color, op)).toBeUndefined();
      expect(ownsOp(color, op)).toBe(true);
    }
    expect(capabilitiesForOp(op)).toEqual([]);
  }
});

test("三色各自的 op 禁区清单", () => {
  expect([...forbiddenOpsFor("red")].sort()).toEqual([
    "act.destroy",
    "act.discover",
    "act.draw",
    "act.gain_armor",
    "act.heal",
    "act.move_to",
    "act.silence",
    "act.swap",
    "act.transform",
  ]);
  expect([...forbiddenOpsFor("blue")].sort()).toEqual(["act.strike", "act.summon"]);
  expect([...forbiddenOpsFor("green")].sort()).toEqual([
    "act.destroy",
    "act.hit",
    "act.move_to",
    "act.shift",
    "act.silence",
    "act.swap",
    "act.transform",
  ]);
});

test("禁区清单与 ownsOp 自洽", () => {
  for (const color of COLORS) {
    for (const op of forbiddenOpsFor(color)) {
      expect(ownsOp(color, op)).toBe(false);
    }
  }
});

test("融合卡取两色中最宽松的一档（§6.2 跨两色按主色原价）", () => {
  // 震荡波 红蓝：4 伤（任意）并推/拉 1 格 —— 单色做不到的组合
  expect(ownershipForColors(["red", "blue"], "act.hit")).toBe("primary");
  expect(ownershipForColors(["red", "blue"], "act.shift")).toBe("primary");
  expect(colorsOwnOp(["red", "blue"], "act.hit")).toBe(true);

  // 回春换位 蓝绿：交换两友方，各治疗 2
  expect(ownershipForColors(["blue", "green"], "act.swap")).toBe("primary");
  expect(ownershipForColors(["blue", "green"], "act.heal")).toBe("primary");

  // 野蛮决斗 红绿：决斗 —— 绿主 + 红副 → 取主
  expect(ownershipForColors(["red", "green"], "act.strike")).toBe("primary");

  // 两色都禁的东西，融合也不解锁
  expect(ownershipForColors(["red", "green"], "act.move_to")).toBe("forbidden");
  expect(colorsOwnOp(["red", "green"], "act.move_to")).toBe(false);
});

test("单色卡的多色查询等价于单色查询", () => {
  for (const color of COLORS) {
    for (const op of ["act.hit", "act.swap", "act.summon", "act.heal", "act.when"]) {
      expect(ownershipForColors([color], op)).toBe(ownershipOf(color, op));
      expect(colorsOwnOp([color], op)).toBe(ownsOp(color, op));
    }
  }
});

test("空 colors 视为无约束", () => {
  expect(ownershipForColors([], "act.swap")).toBeUndefined();
  expect(colorsOwnOp([], "act.swap")).toBe(true);
});

// ---------------------------------------------------------------------------
// 非 op 露头方式
// ---------------------------------------------------------------------------

test("方向操作按 TagKey 匹配，不按 op —— set_tag/mod_tag 本身不归任何颜色", () => {
  const direction = capabilitiesForTagKey("direction");
  expect(direction.map((entry) => entry.id)).toEqual(["direction"]);
  expect(direction[0]?.ownership).toEqual({
    red: "primary",
    blue: "secondary",
    green: "forbidden",
  });
  // 绿卡写 act.mod_tag(atk) 合法，写 act.mod_tag(direction) 才越权
  expect(capabilitiesForOp("act.mod_tag")).toEqual([]);
  expect(ownsOp("green", "act.mod_tag")).toBe(true);
  expect(capabilitiesForTagKey("atk").map((entry) => entry.id)).toEqual(["buff"]);
});

test("眩晕 / 圣盾按 FlagName 匹配（都没有独占 op）", () => {
  expect(capabilitiesForFlag("stunned").map((entry) => entry.id)).toEqual(["disable"]);
  expect(capabilitiesForFlag("divine_shield").map((entry) => entry.id)).toEqual(["divine_shield"]);
  expect(capabilitiesForFlag("taunt")).toEqual([]);
  expect(ownsOp("red", "act.set_flag")).toBe(true);
});

test("关键词类能力按 keyword 匹配（v2 §8.7：触发器组合，无独占 op）", () => {
  expect(capabilitiesForKeyword("cleave").map((entry) => entry.id)).toEqual(["cleave_siege"]);
  expect(capabilitiesForKeyword("siege").map((entry) => entry.id)).toEqual(["cleave_siege"]);
  expect(capabilitiesForKeyword("retaliate").map((entry) => entry.id)).toEqual(["retaliate"]);
  expect(capabilitiesForKeyword("growth").map((entry) => entry.id)).toEqual(["growth"]);
  expect(capabilitiesForKeyword("aura").map((entry) => entry.id)).toEqual(["buff"]);
  expect(capabilitiesForKeyword("divine_shield").map((entry) => entry.id)).toEqual([
    "divine_shield",
  ]);
  expect(capabilitiesForKeyword("charge")).toEqual([]);
});

test("capabilityById 覆盖全表，未登记返回 undefined", () => {
  for (const entry of TABLE) {
    expect(capabilityById(entry.id)?.label).toBe(entry.label);
  }
  expect(capabilityById("nope")).toBeUndefined();
});

test("capabilitiesByRank 按颜色分桶", () => {
  expect(capabilitiesByRank("green", "primary").map((entry) => entry.id)).toEqual([
    "duel",
    "buff",
    "growth",
    "heal",
    "retaliate",
    "divine_shield",
    "token",
  ]);
  expect(capabilitiesByRank("red", "primary").map((entry) => entry.id)).toEqual([
    "damage",
    "direction",
    "cleave_siege",
  ]);
  expect(capabilitiesByRank("blue", "primary").map((entry) => entry.id)).toEqual([
    "shift",
    "reposition",
    "card_advantage",
    "disable",
    "hard_removal",
  ]);
  // 三档分桶的并集恰好是全表
  for (const color of COLORS) {
    const total = OWNERSHIP_RANKS.reduce(
      (sum, rank) => sum + capabilitiesByRank(color, rank).length,
      0,
    );
    expect(total).toBe(TABLE.length);
  }
});

test("每种颜色都至少有主色能力，也都至少有禁区（表不是全放行）", () => {
  for (const color of COLORS) {
    expect(capabilitiesByRank(color, "primary").length).toBeGreaterThan(0);
    expect(capabilitiesByRank(color, "forbidden").length).toBeGreaterThan(0);
  }
});

test("colorNotes 只挂在非禁区的颜色上", () => {
  const seen: Array<readonly [string, Color, string]> = [];
  for (const entry of TABLE) {
    for (const color of COLORS) {
      const note = entry.colorNotes[color];
      if (note !== undefined) {
        expect(entry.ownership[color]).not.toBe("forbidden");
        seen.push([entry.id, color, note]);
      }
    }
  }
  expect(seen).toEqual([
    ["duel", "green", "用自己单位的攻击力当解牌"],
    ["shift", "red", "推进坏位"],
    ["buff", "red", "仅加攻"],
  ]);
});
