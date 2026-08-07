// 色轮机制归属表 —— 《红蓝绿卡牌数值基准》§1.2「机制归属表（= lint 规则）」的机器可读形式。
//
// 该文档 §7 明确要求：「色轮归属表（§1.2）进卡牌 lint，数据来源就是那张表
// （做成 JSON 常量，人和 lint 读同一份）」。所以这里的 COLOR_OWNERSHIP 就是那张表本身，
// 逐行逐格照抄，不做任何"合并同类项"；下面的查询函数全部由它派生，没有第二份真相。
//
// 消费方：M11 的「色轮越权 lint」（IR §7 L3 的一条），典型判据是
//   ownsOp("red", "act.swap") === false   →  红卡出现 act.swap 报错
//
// 本文件零依赖、零 I/O、无 Bun.* / bun:*（架构 §2.2 禁令 2 & 5）。
// `Color` 取自 types/（IR 权威类型，唯一一份）；但 op / TagKey / FlagName 名刻意只用
// 字符串字面量记录，不 import Act["op"] 等联合类型 —— 这张表描述的是"文档说了什么"，
// 让它能先于（并独立于）类型层演进，对齐由本文件的测试逐条兜底。

import type { Color } from "./types/card-kind.ts";

/**
 * 归属档位。《数值基准》§1.2：
 * - `primary`（主）  原价
 * - `secondary`（副）价格 ×1.25，向上取整
 * - `forbidden`（禁）不出现 —— lint 报错的唯一档位
 */
export const OWNERSHIP_RANKS = ["primary", "secondary", "forbidden"] as const;

export type Ownership = (typeof OWNERSHIP_RANKS)[number];

/** 副色溢价系数（《数值基准》§1.2 表头）。计价怎么用是 M12 的事，这里只登记常数。 */
export const SECONDARY_COST_MULTIPLIER = 1.25;

/** 权威出处，供 lint 拼错误信息用，避免各处手写文档章节号。 */
export const COLOR_OWNERSHIP_SOURCE = "《红蓝绿卡牌数值基准》§1.2 机制归属表";

/** 一条能力在三色上的归属。键序同文档表格列序。 */
export interface ColorRanks {
  readonly red: Ownership;
  readonly blue: Ownership;
  readonly green: Ownership;
}

/**
 * §1.2 表格的一行。
 *
 * `ops` / `tagKeys` / `flags` / `keywords` 是这行能力在 IR 里的四种露头方式，
 * lint 按哪种匹配取决于能力本身：
 * - `ops`      —— 直接看 Act 节点的 `op` 字段（绝大多数行）
 * - `tagKeys`  —— 看 `act.set_tag` / `act.mod_tag` 的 `tag` 字段，或附魔 `mods` 的键
 *                 （「方向操作」只能这样查：set_tag/mod_tag 本身是通用节点，不归任何颜色）
 * - `flags`    —— 看 `act.set_flag` / `cond.has_flag` 的 `flag` 字段（眩晕、圣盾）
 * - `keywords` —— 根本不是 IR 节点，是由触发器组合出来的关键词（v2 §8.7），
 *                 靠卡面关键词标注匹配（Cleave / Siege / Retaliate / 成长 / 光环 / 圣盾）
 *
 * 四个数组都必填，无对应露头方式时为空数组 —— 空数组本身是有信息量的：
 * 它说明这行能力在 IR 里没有独占 op，lint 不能靠 op 抓它。
 */
export interface CapabilityEntry {
  /** 稳定 slug，跨文档/日志引用用它，不要用中文 label。 */
  readonly id: string;
  /** 表格第一列的中文能力名，原样保留（人读同一份）。 */
  readonly label: string;
  readonly ops: readonly string[];
  readonly tagKeys: readonly string[];
  readonly flags: readonly string[];
  readonly keywords: readonly string[];
  readonly ownership: ColorRanks;
  /** 表格颜色单元格里的括号注解，如红色推拉的「推进坏位」。 */
  readonly colorNotes: Readonly<Partial<Record<Color, string>>>;
  /** 行级补充：检测方式说明或文档正文的设计意图。无则空串。 */
  readonly note: string;
}

/**
 * 《数值基准》§1.2 全表，15 行，行序与文档一致。
 *
 * 表里没有的 op（控制流 act.when/repeat/for_each、通用写入 act.set_tag/mod_tag/set_flag、
 * 资源 act.gain_crystal(_cap)、act.give/shuffle/discard/steal/move/select_target/nothing 等）
 * = **不受色轮约束**，查询函数对它们返回 undefined，`ownsOp` 返回 true。
 * 这是刻意的：表是黑名单不是白名单，新增 op 不该默认变成三色全禁。
 */
export const COLOR_OWNERSHIP = [
  {
    id: "damage",
    label: "单体/AoE 伤害",
    ops: ["act.hit"],
    tagKeys: [],
    flags: [],
    keywords: [],
    ownership: { red: "primary", blue: "secondary", green: "forbidden" },
    colorNotes: {},
    note: "绿完全没有直接伤害，它的解牌是决斗（见 duel 行）。",
  },
  {
    id: "duel",
    label: "决斗",
    ops: ["act.strike"],
    tagKeys: [],
    flags: [],
    keywords: [],
    ownership: { red: "secondary", blue: "forbidden", green: "primary" },
    colorNotes: { green: "用自己单位的攻击力当解牌" },
    note: "绿的解牌手段：解场质量取决于自己的场面，贴合「随从」身份。",
  },
  {
    id: "direction",
    label: "方向操作",
    ops: [],
    tagKeys: ["direction"],
    flags: [],
    keywords: [],
    ownership: { red: "primary", blue: "secondary", green: "forbidden" },
    colorNotes: {},
    note:
      "direction 是普通 Tag 不是新 op（v2 §2.3）。lint 匹配条件：" +
      'act.set_tag / act.mod_tag 的 tag === "direction"，或附魔 mods 含 direction 键。' +
      "不能把 set_tag/mod_tag 整个 op 归给红——它们同样承载 atk/health 增益。",
  },
  {
    id: "shift",
    label: "推拉",
    ops: ["act.shift"],
    tagKeys: [],
    flags: [],
    keywords: [],
    ownership: { red: "secondary", blue: "primary", green: "forbidden" },
    colorNotes: { red: "推进坏位" },
    note: "builder 糖 Push/Pull 都编译成 act.shift，lint 只看 IR 不看糖。",
  },
  {
    id: "reposition",
    label: "换位/瞬移",
    ops: ["act.swap", "act.move_to"],
    tagKeys: [],
    flags: [],
    keywords: [],
    ownership: { red: "forbidden", blue: "primary", green: "forbidden" },
    colorNotes: {},
    note: "文档 §1.2 的示范判例：红卡出现 act.swap → 报错。",
  },
  {
    id: "card_advantage",
    label: "抽牌/发现",
    ops: ["act.draw", "act.discover"],
    tagKeys: [],
    flags: [],
    keywords: [],
    ownership: { red: "forbidden", blue: "primary", green: "secondary" },
    colorNotes: {},
    note: "",
  },
  {
    id: "disable",
    label: "沉默/眩晕",
    ops: ["act.silence"],
    tagKeys: [],
    flags: ["stunned"],
    keywords: [],
    ownership: { red: "forbidden", blue: "primary", green: "forbidden" },
    colorNotes: {},
    note:
      "眩晕没有专属 op（《数值基准》§7：act.set_flag 现成），" +
      'lint 靠 flag === "stunned" 匹配。',
  },
  {
    id: "hard_removal",
    label: "硬解",
    ops: ["act.destroy", "act.transform"],
    tagKeys: [],
    flags: [],
    keywords: [],
    ownership: { red: "forbidden", blue: "primary", green: "forbidden" },
    colorNotes: {},
    note: "",
  },
  {
    id: "buff",
    label: "属性增益 / 光环",
    ops: ["act.buff"],
    tagKeys: [],
    flags: [],
    keywords: ["aura"],
    ownership: { red: "secondary", blue: "forbidden", green: "primary" },
    colorNotes: { red: "仅加攻" },
    note:
      "光环不是 op 而是 Card 的 auras 段，靠 keyword 'aura' 匹配。" +
      "红的副色权限被 colorNotes 进一步限制为「只能加攻」，" +
      "该细则超出「颜色 × op」二元判据，需要 lint 额外读 colorNotes.red。",
  },
  {
    id: "growth",
    label: "成长（战斗后 +X/+X）",
    ops: [],
    tagKeys: [],
    flags: [],
    keywords: ["growth"],
    ownership: { red: "forbidden", blue: "forbidden", green: "primary" },
    colorNotes: {},
    note: "由 end_of_combat 触发器 + act.buff 组合而成，没有独占 op，靠关键词标注匹配。",
  },
  {
    id: "heal",
    label: "治疗/护甲",
    ops: ["act.heal", "act.gain_armor"],
    tagKeys: [],
    flags: [],
    keywords: [],
    ownership: { red: "forbidden", blue: "secondary", green: "primary" },
    colorNotes: {},
    note: "文档这一行没写 op 名，按 IR §9 op 表补 act.heal / act.gain_armor 两个。",
  },
  {
    id: "cleave_siege",
    label: "Cleave / Siege",
    ops: [],
    tagKeys: [],
    flags: [],
    keywords: ["cleave", "siege"],
    ownership: { red: "primary", blue: "forbidden", green: "forbidden" },
    colorNotes: {},
    note:
      "v2 §8.7：两者都是 struck 触发器 + 现有选择器的组合，无独占 op，靠关键词标注匹配。" +
      "文档把它们并成一行，这里照抄为一条（两个 keyword）。",
  },
  {
    id: "retaliate",
    label: "Retaliate（荆棘）",
    ops: [],
    tagKeys: [],
    flags: [],
    keywords: ["retaliate"],
    ownership: { red: "forbidden", blue: "forbidden", green: "primary" },
    colorNotes: {},
    note: "v2 §8.7：on(Struck({target: SELF}), Hit(EVENT.source, X))，无独占 op。",
  },
  {
    id: "divine_shield",
    label: "圣盾",
    ops: [],
    tagKeys: [],
    flags: ["divine_shield"],
    keywords: ["divine_shield"],
    ownership: { red: "forbidden", blue: "secondary", green: "primary" },
    colorNotes: {},
    note: "IR §10.6：圣盾是拦截器 + divine_shield flag，无独占 op。",
  },
  {
    id: "token",
    label: "Token 生成",
    ops: ["act.summon"],
    tagKeys: [],
    flags: [],
    keywords: [],
    ownership: { red: "secondary", blue: "forbidden", green: "primary" },
    colorNotes: {},
    note: "",
  },
] as const satisfies readonly CapabilityEntry[];

/** 表里登记的能力 id 字面量联合。 */
export type CapabilityId = (typeof COLOR_OWNERSHIP)[number]["id"];

/** 表里登记的 op 名字面量联合（≠ 全部 Act["op"]，只是受色轮约束的那些）。 */
export type OwnedOp = (typeof COLOR_OWNERSHIP)[number]["ops"][number];

/** 表里登记的关键词字面量联合。 */
export type OwnedKeyword = (typeof COLOR_OWNERSHIP)[number]["keywords"][number];

// ---------------------------------------------------------------------------
// 派生索引（唯一真相仍是上面的 COLOR_OWNERSHIP，这里只是它的倒排）
// ---------------------------------------------------------------------------

const EMPTY_ENTRIES: readonly CapabilityEntry[] = [];

function invert(
  pick: (entry: CapabilityEntry) => readonly string[],
): ReadonlyMap<string, readonly CapabilityEntry[]> {
  const index = new Map<string, CapabilityEntry[]>();
  for (const entry of COLOR_OWNERSHIP) {
    for (const key of pick(entry)) {
      const bucket = index.get(key);
      if (bucket === undefined) {
        index.set(key, [entry]);
      } else {
        bucket.push(entry);
      }
    }
  }
  return index;
}

const BY_ID = new Map<string, CapabilityEntry>(
  COLOR_OWNERSHIP.map((entry): [string, CapabilityEntry] => [entry.id, entry]),
);
const BY_OP = invert((entry) => entry.ops);
const BY_TAG_KEY = invert((entry) => entry.tagKeys);
const BY_FLAG = invert((entry) => entry.flags);
const BY_KEYWORD = invert((entry) => entry.keywords);

/** 按 id 取一行。未登记返回 undefined。 */
export function capabilityById(id: string): CapabilityEntry | undefined {
  return BY_ID.get(id);
}

/** 某个 Act op 命中的能力行。未登记（= 不受色轮约束）返回空数组。 */
export function capabilitiesForOp(op: string): readonly CapabilityEntry[] {
  return BY_OP.get(op) ?? EMPTY_ENTRIES;
}

/** 某个 TagKey 命中的能力行（目前只有 direction）。 */
export function capabilitiesForTagKey(tagKey: string): readonly CapabilityEntry[] {
  return BY_TAG_KEY.get(tagKey) ?? EMPTY_ENTRIES;
}

/** 某个 FlagName 命中的能力行（stunned / divine_shield）。 */
export function capabilitiesForFlag(flag: string): readonly CapabilityEntry[] {
  return BY_FLAG.get(flag) ?? EMPTY_ENTRIES;
}

/** 某个关键词命中的能力行（aura / growth / cleave / siege / retaliate / divine_shield）。 */
export function capabilitiesForKeyword(keyword: string): readonly CapabilityEntry[] {
  return BY_KEYWORD.get(keyword) ?? EMPTY_ENTRIES;
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

const RANK_ORDER: Readonly<Record<Ownership, number>> = {
  primary: 0,
  secondary: 1,
  forbidden: 2,
};

/** 取更宽松的一档（primary < secondary < forbidden）。 */
function looser(current: Ownership | undefined, candidate: Ownership): Ownership {
  if (current === undefined) {
    return candidate;
  }
  return RANK_ORDER[candidate] < RANK_ORDER[current] ? candidate : current;
}

/**
 * 单色 × op 的归属档位。
 *
 * @returns `primary` / `secondary` / `forbidden`；op 未登记在 §1.2 表里则返回 `undefined`
 *          （= 该 op 不受色轮约束，例如 act.when、act.gain_crystal）。
 */
export function ownershipOf(color: Color, op: string): Ownership | undefined {
  let rank: Ownership | undefined;
  for (const entry of capabilitiesForOp(op)) {
    rank = looser(rank, entry.ownership[color]);
  }
  return rank;
}

/**
 * 该颜色能否使用该 op —— 色轮越权 lint 的主判据。
 * 只有明确判「禁」才为 false；未登记的 op 一律放行。
 *
 * ```ts
 * ownsOp("red", "act.swap");  // false —— 《数值基准》§1.2 的示范判例
 * ownsOp("red", "act.hit");   // true  （主色）
 * ownsOp("blue", "act.hit");  // true  （副色，计价 ×1.25）
 * ownsOp("red", "act.when");  // true  （未登记，不受约束）
 * ```
 */
export function ownsOp(color: Color, op: string): boolean {
  return ownershipOf(color, op) !== "forbidden";
}

/**
 * 多色卡（融合卡，colors 长度 2）× op 的归属档位：取各色中最宽松的一档。
 *
 * 依据《数值基准》§6.2：「融合卡可跨两色按主色原价取能力」。
 * colors 为空数组时返回 undefined。
 */
export function ownershipForColors(colors: readonly Color[], op: string): Ownership | undefined {
  let rank: Ownership | undefined;
  for (const color of colors) {
    const candidate = ownershipOf(color, op);
    if (candidate !== undefined) {
      rank = looser(rank, candidate);
    }
  }
  return rank;
}

/** `ownsOp` 的多色版本，直接吃 `card.data.colors`（v2 §11.4）。 */
export function colorsOwnOp(colors: readonly Color[], op: string): boolean {
  return ownershipForColors(colors, op) !== "forbidden";
}

/** 该颜色的 op 禁区清单，供 lint 报错时列举「你不该用的东西」。 */
export function forbiddenOpsFor(color: Color): readonly string[] {
  const ops: string[] = [];
  for (const entry of COLOR_OWNERSHIP) {
    if (entry.ownership[color] === "forbidden") {
      ops.push(...entry.ops);
    }
  }
  return ops;
}

/** 该颜色在某一档位上的全部能力行，用于生成设计侧的色轮速查表。 */
export function capabilitiesByRank(color: Color, rank: Ownership): readonly CapabilityEntry[] {
  return COLOR_OWNERSHIP.filter((entry) => entry.ownership[color] === rank);
}
