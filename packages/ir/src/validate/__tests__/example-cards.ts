// 校验器的正例语料：规范里手写的示例卡，逐张写成今天（`IR_VERSION`）的规范形式 IR。
//
// 两组共 12 张：
//   - v2 §8.1-8.6 的六张格子战斗示例卡（GRID_001…GRID_006）—— M1 完成标志点名的那六张
//   - IR v1 §10.1-10.6 的六个示例（CORE_*）—— 老规范的表达力，迁到今天的规范后仍须成立
//
// 全部标注成 T1 的 `Card` / `Enchantment` / `Bundle`：**类型说它们合法，校验器也必须说合法**。
// 这就是这组语料的意义 —— 校验器与权威类型对同一份数据的判断不许分叉。
//
// 从 v1 迁到今天的规范时按规范做的三处调整（每处都在对应卡上留了注释）：
//   1. `zone: "hero"` → `"base"`（架构 §10 第 3 项）
//   2. `act.summon` 的 `at` 在规范形式里必填，旧卡补 `slot.random_empty`（v2 §3.4 / §10 第 3 条）
//   3. v1 的 `HasFaction("mage")`（v2.1 §11.4 faction 已废）→ 发现示例改用 `cond.has_color`
//      筛蓝色（决策 #9 在 2.2.0 补的 op，《数值基准》§1.1：蓝 = 魔法）
//
// 这不是 builder 的产物 —— builder 是 T3/T4 的活。这里手写，正是为了让校验器独立于 builder 成立。

import type { Bundle, Card, Enchantment, NodeOp } from "../../types/index.ts";
import { IR_VERSION } from "../../types/index.ts";

// ── v2 §8 的六张 ────────────────────────────────────────────────────────────

/** v2 §8.1 斜刺长枪兵 —— direction 就是一个 Tag，战吼只是挂一张带 `direction` 的附魔。 */
export const GRID_001: Card = {
  id: "GRID_001",
  set: "pf1",
  data: {
    name: { zh: "斜刺长枪兵", en: "Slanted Pikeman" },
    text: { zh: "战吼：战斗方向变为斜左。" },
    kind: "minion",
    cost: 3,
    colors: ["red"],
    tags: { atk: 3, health: 2 },
  },
  script: {
    play: [{ op: "act.buff", target: { op: "sel.self" }, ench: "GRID_001e" }],
  },
};

/** v2 §8.2 空袭猎手 —— 位置条件光环，每步重算，不需要触发器。 */
export const GRID_002: Card = {
  id: "GRID_002",
  set: "pf1",
  data: {
    name: { zh: "空袭猎手" },
    text: { zh: "对面格子没有单位时，攻击力 +2。" },
    kind: "minion",
    cost: 2,
    colors: ["green"],
    tags: { atk: 2, health: 3 },
  },
  script: {
    auras: [
      {
        affects: { op: "sel.self" },
        mods: { atk: 2 },
        cond: {
          op: "cond.not",
          of: {
            op: "cond.occupied",
            slot: { op: "slot.opposite", of: { op: "slot.of", of: { op: "sel.self" } } },
          },
        },
        zone: "board",
      },
    ],
  },
};

/** v2 §8.3 裂地冲锋 —— 位移 + 伤害。 */
export const GRID_003: Card = {
  id: "GRID_003",
  set: "pf1",
  data: {
    name: { zh: "裂地冲锋" },
    text: { zh: "对一个敌方单位造成 2 点伤害，并将其推移一格。" },
    kind: "spell",
    cost: 2,
    colors: ["red"],
  },
  script: {
    target: { op: "sel.zone", side: "enemy", zone: "board" },
    play: [
      { op: "act.hit", target: { op: "sel.target" }, amount: 2 },
      { op: "act.shift", target: { op: "sel.target" }, delta: 1 },
    ],
  },
};

/** v2 §8.4 换位术 —— 双目标 = `script.target` + 一个挂起点。 */
export const GRID_004: Card = {
  id: "GRID_004",
  set: "pf1",
  data: {
    name: { zh: "换位术" },
    text: { zh: "选择两个友方单位，交换它们的位置。" },
    kind: "spell",
    cost: 1,
    colors: ["blue"],
  },
  script: {
    target: { op: "sel.zone", side: "friendly", zone: "board" },
    play: [
      {
        op: "act.select_target",
        from: {
          op: "sel.minus",
          of: { op: "sel.zone", side: "friendly", zone: "board" },
          exclude: { op: "sel.target" },
        },
      },
      { op: "act.swap", a: { op: "sel.target" }, b: { op: "sel.chosen" } },
    ],
  },
};

/** v2 §8.5 战地号手 —— combat_began 触发 + `end_of_combat` 附魔。 */
export const GRID_005: Card = {
  id: "GRID_005",
  set: "pf1",
  data: {
    name: { zh: "战地号手" },
    text: { zh: "战斗开始时，所有友方单位本次战斗攻击力 +1。" },
    kind: "minion",
    cost: 4,
    colors: ["green"],
    tags: { atk: 2, health: 4 },
  },
  script: {
    triggers: [
      {
        on: "combat_began",
        zone: "board",
        do: [
          {
            op: "act.buff",
            target: { op: "sel.zone", side: "friendly", zone: "board" },
            ench: "GRID_005e",
          },
        ],
      },
    ],
  },
};

/** v2 §8.6 荆棘卫士 —— `struck` 触发反伤（Artifact 的 Retaliate）。 */
export const GRID_006: Card = {
  id: "GRID_006",
  set: "pf1",
  data: {
    name: { zh: "荆棘卫士" },
    text: { zh: "每当受到单位的出手伤害，对出手者造成 1 点伤害。" },
    kind: "minion",
    cost: 3,
    colors: ["green"],
    tags: { atk: 1, health: 6 },
  },
  script: {
    triggers: [
      {
        on: "struck",
        filter: { target: { op: "sel.self" } },
        zone: "board",
        do: [{ op: "act.hit", target: { op: "sel.event", field: "source" }, amount: 1 }],
      },
    ],
  },
};

// ── IR v1 §10 的六个 ────────────────────────────────────────────────────────

/** IR v1 §10.1 火球术。目标域的 `"hero"` 已按架构 §10 第 3 项改成 `"base"`。 */
export const CORE_001: Card = {
  id: "CORE_001",
  set: "pf1",
  data: {
    name: { zh: "火球术" },
    kind: "spell",
    cost: 4,
    colors: ["red"],
  },
  script: {
    target: { op: "sel.zone", side: "both", zone: ["board", "base"] },
    play: [{ op: "act.hit", target: { op: "sel.target" }, amount: 6, spellDamage: true }],
  },
};

/** IR v1 §10.2 光明守护者 —— 触发 + 附魔。 */
export const CORE_020: Card = {
  id: "CORE_020",
  set: "pf1",
  data: {
    name: { zh: "光明守护者" },
    kind: "minion",
    cost: 1,
    colors: ["green"],
    tags: { atk: 1, health: 2 },
  },
  script: {
    triggers: [
      {
        on: "healed",
        filter: { target: { op: "sel.zone", side: "both", zone: ["board", "base"] } },
        zone: "board",
        do: [{ op: "act.buff", target: { op: "sel.self" }, ench: "CORE_020e" }],
      },
    ],
  },
};

/** IR v1 §10.3 野猪王 —— 光环 + `sel.minus` / `sel.where` / `cond.has_tribe`。 */
export const CORE_030: Card = {
  id: "CORE_030",
  set: "pf1",
  data: {
    name: { zh: "野猪王" },
    kind: "minion",
    cost: 5,
    colors: ["green"],
    rarity: "legendary",
    tribe: "beast",
    tags: { atk: 4, health: 4 },
  },
  script: {
    auras: [
      {
        affects: {
          op: "sel.minus",
          of: {
            op: "sel.where",
            of: { op: "sel.zone", side: "friendly", zone: "board" },
            cond: { op: "cond.has_tribe", of: { op: "sel.it" }, tribe: "beast" },
          },
          exclude: { op: "sel.self" },
        },
        mods: { atk: 1 },
        zone: "board",
      },
    ],
  },
};

/**
 * IR v1 §10.4 谜之勇士 —— costMod + 亡语 + 条件分支。
 * 亡语里的 `act.summon` 按 v2 §3.4 补了 `at`（规范形式必填）。
 * 双色 = 融合卡（v2.1 §11.4），顺带让 `colors` 的长度 2 分支进正例。
 */
export const CORE_040: Card = {
  id: "CORE_040",
  set: "pf1",
  data: {
    name: { zh: "谜之勇士" },
    kind: "minion",
    cost: 5,
    colors: ["blue", "red"],
    collectible: true,
    art: "pf1/riddle-champion",
    tags: { atk: 4, health: 4 },
  },
  script: {
    requires: null,
    costMod: {
      op: "num.neg",
      of: { op: "num.count", of: { op: "sel.zone", side: "friendly", zone: "board" } },
    },
    deathrattle: [
      {
        op: "act.summon",
        player: { op: "sel.controller" },
        card: "CORE_TOKEN_01",
        at: { op: "slot.random_empty", side: "friendly" },
      },
    ],
    play: [
      {
        op: "act.when",
        cond: {
          op: "cond.gte",
          l: { op: "num.attr", of: { op: "sel.self" }, tag: "atk" },
          r: 3,
        },
        then: [
          {
            op: "act.hit",
            target: {
              op: "sel.random",
              of: { op: "sel.zone", side: "enemy", zone: "board" },
              n: 2,
            },
            amount: {
              op: "num.mul",
              of: [{ op: "num.count", of: { op: "sel.zone", side: "friendly", zone: "board" } }, 2],
            },
          },
        ],
        else: [{ op: "act.draw", player: { op: "sel.controller" } }],
      },
    ],
  },
};

/**
 * IR v1 §10.5 发现 —— 挂起点。
 * v1 的 `HasFaction("mage")`：`data.faction` 已被 `colors` 取代（v2.1 §11.4），
 * 2.2.0 起用 `cond.has_color` 筛颜色（决策 #9），所以卡池条件是 `is_kind` + `has_color` 两句。
 */
export const CORE_050: Card = {
  id: "CORE_050",
  set: "pf1",
  data: {
    name: { zh: "灵光一闪" },
    kind: "spell",
    cost: 2,
    colors: ["blue"],
  },
  script: {
    play: [
      {
        op: "act.discover",
        from: {
          op: "card.pool",
          filter: {
            op: "cond.and",
            of: [
              { op: "cond.is_kind", of: { op: "sel.it" }, kind: "spell" },
              { op: "cond.has_color", of: { op: "sel.it" }, color: "blue" },
            ],
          },
        },
        show: 3,
        pick: 1,
      },
      {
        op: "act.give",
        player: { op: "sel.controller" },
        card: { op: "card.of", of: { op: "sel.chosen" } },
      },
    ],
  },
};

/** IR v1 §10.6 圣盾 —— 拦截器 + `num.field` + `effect.cancel`。 */
export const CORE_060: Card = {
  id: "CORE_060",
  set: "pf1",
  data: {
    name: { zh: "辉膜卫士" },
    kind: "minion",
    cost: 3,
    colors: ["green"],
    tags: { atk: 2, health: 3 },
  },
  script: {
    intercepts: [
      {
        intercept: "act.hit",
        filter: { target: { op: "sel.self" } },
        cond: {
          op: "cond.and",
          of: [
            { op: "cond.has_flag", of: { op: "sel.self" }, flag: "divine_shield" },
            { op: "cond.gt", l: { op: "num.field", field: "amount" }, r: 0 },
          ],
        },
        effect: { kind: "cancel" },
        then: [
          {
            op: "act.set_flag",
            target: { op: "sel.self" },
            flag: "divine_shield",
            value: false,
          },
        ],
        priority: 100,
      },
    ],
  },
};

/** v2 §8 的六张（M1 完成标志点名的那六张）。 */
export const V2_EXAMPLE_CARDS: readonly Card[] = [
  GRID_001,
  GRID_002,
  GRID_003,
  GRID_004,
  GRID_005,
  GRID_006,
];

/** IR v1 §10 的六个示例。 */
export const V1_EXAMPLE_CARDS: readonly Card[] = [
  CORE_001,
  CORE_020,
  CORE_030,
  CORE_040,
  CORE_050,
  CORE_060,
];

export const EXAMPLE_CARDS: readonly Card[] = [...V2_EXAMPLE_CARDS, ...V1_EXAMPLE_CARDS];

export const EXAMPLE_ENCHANTMENTS: readonly Enchantment[] = [
  // v2 §8.1：方向 -1，沉默即复位（v2 §2.3）
  { id: "GRID_001e", attachesTo: "minion", mods: { direction: -1 }, duration: "permanent" },
  // v2 §8.5：只活到本次战斗结束（v2 §3.5 新增的 duration）
  { id: "GRID_005e", attachesTo: "minion", mods: { atk: 1 }, duration: "end_of_combat" },
  // IR v1 §10.2：+1/+0
  { id: "CORE_020e", attachesTo: "minion", mods: { atk: 1 }, duration: "permanent" },
];

/** 扫出所有出现过的 op —— `bundle.opsUsed` 就是这个集合（IR §2.1）。 */
const collectOps = (value: unknown, into: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectOps(item, into);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "op" && typeof child === "string") into.add(child);
    else collectOps(child, into);
  }
};

const usedOps = (): readonly NodeOp[] => {
  const ops = new Set<string>();
  collectOps(EXAMPLE_CARDS, ops);
  collectOps(EXAMPLE_ENCHANTMENTS, ops);
  return [...ops].sort() as readonly NodeOp[];
};

const byId = <T extends { readonly id: string }>(
  items: readonly T[],
): Readonly<Record<string, T>> => Object.fromEntries(items.map((item) => [item.id, item]));

/** 12 张示例卡 + 3 个附魔组成的一份完整 bundle（IR §2.1 的形状）。 */
export const EXAMPLE_BUNDLE: Bundle = {
  irVersion: IR_VERSION,
  bundleId: "pf1@2026.08.07-1",
  createdAt: "2026-08-07T09:00:00.000Z",
  opsUsed: usedOps(),
  cards: byId(EXAMPLE_CARDS),
  enchantments: byId(EXAMPLE_ENCHANTMENTS),
};
