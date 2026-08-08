// M2 的**完成标志**：架构 §6.1「确定性」的两条测试。
//
// ═══════════════════════════════════════════════════════════════════════════
// 架构 §6.1 原文（本文件逐条落地，语义不许变）
// ═══════════════════════════════════════════════════════════════════════════
// > test("同 seed 同意图序列 → 终局状态哈希一致", () => {
// >   const a = runMatch({ seed: 0x9F1, decks, intents });
// >   const b = runMatch({ seed: 0x9F1, decks, intents });
// >   expect(hash(a.state)).toBe(hash(b.state));
// > });
// >
// > test("序列化往返不改变结算结果", () => {
// >   const s = midGameState();
// >   const revived = JSON.parse(JSON.stringify(s));
// >   expect(hash(apply(s, intent).state)).toBe(hash(apply(revived, intent).state));
// > });
//
// **第二条是《框架设计》§13「已知的坑 3」的守卫**：状态里一旦混进函数 / class 实例 /
// Map，它立刻会红。它是架构腐化的探针 —— 红了要去改状态，不要来改这个文件。
//
// 两条测试各自守着一件不同的事：
//   第一条  「引擎是纯函数、随机只走 state.rng」（框架 §3.2 / §4.3）。
//           它一红，说明结算路径上混进了 Math.random / Date / 遍历顺序不定的容器
//           （Set / Map 的插入序、Object.keys 的巧合顺序……）。
//   第二条  「状态是纯数据」（框架 §3.1）。
//           它一红，说明状态里有东西 JSON 装不下。
//
// ═══════════════════════════════════════════════════════════════════════════
// 这个文件为什么这么长：**测试自己也要被测**
// ═══════════════════════════════════════════════════════════════════════════
// 上面两条测试都靠 `hash()` 说话，而 `hash()` 是本文件自己实现的（engine 零依赖，
// 不许引 crypto，也不许用 Bun API）。一个写错的哈希会让两条测试**恒绿** ——
// 那比没有测试更糟。所以本文件额外带三组自检：
//
//   1. `hash()` 的自检     —— 键序无关、数组序有关、类型有别、能看见非纯数据；
//   2. 第一条的反例自检     —— 换个 seed / 多一条意图，断言它**会红**；
//   3. 第二条的反例自检     —— 往状态里塞函数 / Map / Set / class / NaN，
//                             断言往返探针**会红**（反例只塞进测试里的副本，不动源码）。
//
// 还补了一条 §6.1 原文**没写、但必须有**的测试（详见「状态在对局的每个阶段都是纯数据」）：
// `apply()` 内部会 `cloneState()`（JSON 往返），它会把**建局期**混进状态的脏东西
// 悄悄洗掉，于是第二条测试对那一类腐化是瞎的 —— 实测在 `createInitialState` 里塞一个
// Map，第二条照样绿。探针因此必须同时扎在「还没被 clone 洗过」的状态上。
//
// 另外，两条测试跑的是**真实对局**（M3 起由相位机驱动：3 个回合、6 次上场、5 次 pass、
// 2 次战斗共 9 次出手、3 个单位阵亡、水晶回满 6 次、抽牌 6 次、1 次非法意图被拒，
// 往返探针那条还额外跑了一次挂起），不是拿两个空状态比哈希 —— 那样测试恒绿、毫无意义。

import { expect, test } from "bun:test";
import type { CardId, EntityId } from "@prismfront/ir";
import type { GameEvent } from "../events/index.ts";
import { M2_HANDLERS } from "../handlers/index.ts";
import type { ResolveDeps } from "../resolve/index.ts";
import { pushAct, suspend } from "../resolve/index.ts";
import type { Intent, RunMatchOptions } from "../rules/index.ts";
import { apply, createGame, DEFAULT_RULES, runMatch } from "../rules/index.ts";
import type { EntityData, GameState } from "../state/index.ts";
import { getEntity, getZone } from "../state/index.ts";
import { handOf, passOnce, putInHand, setFace, startMatch, strikeNow } from "../testkit/index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 一、hash(state) —— 稳定的结构化哈希
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么不直接 `JSON.stringify(state)` 比字符串：
//   1. **键序**。JSON 的键序是插入序。两份语义相同的状态，只要某个对象的键是按不同
//      顺序写进去的（例如 handler A 先写 `zone` 后写 `slot`、handler B 反过来），
//      字符串就不同 —— 那是**假红**。哈希必须对键序不敏感，所以这里对键排序。
//   2. **可见性**。`JSON.stringify` 会**悄悄吃掉**函数、`undefined`，把 Map / Set 变成
//      `{}`、把 NaN / Infinity 变成 `null`。用它当探针，等于让探针和被探测的腐化用同一
//      副眼镜 —— 看不见。本文件的规范化函数**认得**这些东西并给它们打上不同的标记，
//      于是「原件」与「JSON 往返件」的哈希必然不同，第二条测试才有牙。
//
// 反过来，有三件事哈希**必须**敏感，否则同样是假绿：
//   - **数组顺序**：`zones["p0:deck"]` 的顺序就是牌库顺序，换序 = 换局；
//   - **值的类型**：`1` 与 `"1"`、`null` 与 `"null"` 不是一回事；
//   - **嵌套结构**：`{a:{b:1}}` 与 `{"a.b":1}` 不是一回事。
// 这三条都在 `hash 自检` 一节里钉成了断言。

/**
 * 把任意值规范化成一个**确定的**字符串。
 *
 * 规则：
 * - 对象按**键名排序**后展开（键序无关的来源）；
 * - 数组按下标展开（顺序敏感）；
 * - 每种类型带自己的前缀标记（类型敏感）；
 * - 字符串与键名都带**长度前缀**，于是 `{a:1,b:2}` 与 `{ab:12}` 不会撞成同一串；
 * - 非纯数据（函数 / Map / Set / class 实例 / Symbol / BigInt / NaN）各有专属标记 ——
 *   这是第二条测试的牙齿所在。
 *
 * ⚠ 不做环检测。状态是无环的；真混进了环，`JSON.parse(JSON.stringify(s))` 会**先**抛
 *   TypeError，第二条测试照样红（有专门的反例自检钉住这一点）。为一个"探针会更早发现"
 *   的情况写一条走不到的分支，只会变成覆盖率噪声。
 */
function canonicalize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    // JSON 会把 `{a: undefined}` 的键整个丢掉 —— 状态里出现它就是「必填 + | null」
    // 这条规矩（state/index.ts 推论 3）被破坏了，必须能被看见。
    return "undefined";
  }
  const kind = typeof value;
  if (kind === "boolean") {
    return value === true ? "true" : "false";
  }
  if (kind === "number") {
    // `Object.is` 分得开 0 与 -0（`String` 分不开）。NaN / Infinity 原样落进标记里，
    // 而 JSON 会把它们写成 `null` —— 于是往返前后必然不同。
    return `num(${Object.is(value, -0) ? "-0" : String(value)})`;
  }
  if (kind === "string") {
    const text = String(value);
    return `str${text.length}:${text}`;
  }
  if (kind === "bigint") {
    return `bigint(${String(value)})`;
  }
  if (kind === "symbol") {
    // 注意不能用模板串插值 symbol（会抛 TypeError），只能显式 String()。
    return `symbol(${String(value)})`;
  }
  if (kind === "function") {
    return `function(${nameOfCallable(value)})`;
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      parts.push(canonicalize(item));
    }
    return `[${parts.join(",")}]`;
  }
  const proto: unknown = Object.getPrototypeOf(value as object);
  if (proto !== null && proto !== Object.prototype) {
    // Map / Set / Date / 任何 class 实例。它们的自有可枚举键往往是空的
    // （`new Map([[1,2]])` 一个自有键都没有），所以**必须**把构造器名写进标记里，
    // 否则它与 `{}` 会撞成同一个哈希 —— 那正是 JSON 往返之后的样子，探针就瞎了。
    return `exotic(${nameOfConstructor(value as object)}){${plainBody(value as object)}}`;
  }
  return `{${plainBody(value as object)}}`;
}

/** 展开一个纯对象的自有可枚举键，**按键名排序** —— 键序无关就是在这里实现的。 */
function plainBody(value: object): string {
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(`key${key.length}:${key}=${canonicalize(record[key])}`);
  }
  return parts.join(",");
}

/** 取函数名；匿名函数给空串。 */
function nameOfCallable(value: unknown): string {
  const name: unknown = (value as { readonly name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

/** 取构造器名（`Map` / `Set` / `Date` / 自定义 class）。取不到给 `anonymous`。 */
function nameOfConstructor(value: object): string {
  const ctor: unknown = (value as { readonly constructor?: unknown }).constructor;
  if (typeof ctor === "function") {
    const name = nameOfCallable(ctor);
    if (name.length > 0) {
      return name;
    }
  }
  return "anonymous";
}

/**
 * 结构化哈希：规范化 → 64 位混合（cyrb53 的双累加器变体）。
 *
 * 只用 `Math.imul` 与位运算，因此在任何 JS 运行时上逐位一致（同 `rng/rng.ts` 的论证）：
 * 引擎零依赖，不许引 crypto；`Bun.hash` 更是被 biome.json 直接封死。
 * 这不是密码学哈希，也不需要是 —— 它只要**同输入同输出、异输入异输出**。
 *
 * ⚠ 哈希天然有碰撞。所以凡是"必须相等"的断言，本文件都**同时**比 `canonicalize()`
 *   的原串：碰撞能骗过 `hash`，骗不过原串。凡是"必须不等"的断言则只比 `hash` 就够了
 *   （碰撞只会让它更严，不会让它假绿）。
 */
function hash(value: unknown): string {
  const text = canonicalize(value);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return toHex32(h2 >>> 0) + toHex32(h1 >>> 0);
}

/** 32 位字 → 定长 8 位十六进制（定长是为了拼接之后仍然无歧义）。 */
function toHex32(word: number): string {
  return word.toString(16).padStart(8, "0");
}

/** JSON 往返 —— 架构 §6.1 第二条里的 `JSON.parse(JSON.stringify(s))`。 */
function reviveJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、hash 自检：证明这把尺子本身是直的
// ═══════════════════════════════════════════════════════════════════════════

test("hash 自检：键序不同、内容相同的两个对象，哈希必须相等", () => {
  // 任务书点名的那一条。键序不定的哈希会让第一条测试变成随机红 / 随机绿。
  const a = { alpha: 1, beta: { gamma: 2, delta: [3, 4] }, epsilon: null };
  const b = { epsilon: null, beta: { delta: [3, 4], gamma: 2 }, alpha: 1 };
  expect(hash(b)).toBe(hash(a));
  expect(canonicalize(b)).toBe(canonicalize(a));

  // 仿一个 GameState 的形状再来一次：嵌套更深、既有记录也有数组。
  const left = {
    zones: { "p0:hand": [7, 3], "p0:deck": [9] },
    entities: { 3: { id: 3, zone: "p0:hand", tags: { atk: 1, health: 2 } } },
  };
  const right = {
    entities: { 3: { tags: { health: 2, atk: 1 }, zone: "p0:hand", id: 3 } },
    zones: { "p0:deck": [9], "p0:hand": [7, 3] },
  };
  expect(hash(right)).toBe(hash(left));
});

test("hash 自检：内容不同就必须不等（否则第一条测试恒绿）", () => {
  // 数组顺序 —— zones 的顺序就是牌库顺序，这一条要是不敏感，洗牌就白洗了。
  expect(hash([1, 2])).not.toBe(hash([2, 1]));
  // 值的类型
  expect(hash({ a: 1 })).not.toBe(hash({ a: "1" }));
  expect(hash(null)).not.toBe(hash("null"));
  expect(hash(0)).not.toBe(hash(false));
  // 键名与结构
  expect(hash({ a: 1 })).not.toBe(hash({ b: 1 }));
  expect(hash({ a: { b: 1 } })).not.toBe(hash({ "a.b": 1 }));
  // 长度前缀的作用：拼起来长得像的两份数据不许撞
  expect(hash({ a: 1, b: 2 })).not.toBe(hash({ ab: 12 }));
  // 缺键 ≠ 键在但值是 undefined（JSON 会把后者变成前者）
  expect(hash({ a: 1 })).not.toBe(hash({ a: 1, b: undefined }));
  // 数值 —— NaN / -0 / Infinity 都是 JSON 装不下的东西，必须看得见
  expect(hash(Number.NaN)).not.toBe(hash(null));
  expect(hash(-0)).not.toBe(hash(0));
  expect(hash(Number.POSITIVE_INFINITY)).not.toBe(hash(null));
});

test("hash 自检：看得见函数 / Map / Set / class 实例（第二条测试的牙齿）", () => {
  // JSON 眼里这四样东西全部塌缩成 `{}` 或直接消失。哈希必须分得开，
  // 否则「往返前后哈希一致」在腐化发生时依然成立 —— 那就是假绿。
  expect(hash({ a: new Map([[1, 2]]) })).not.toBe(hash({ a: {} }));
  expect(hash({ a: new Set([1, 2]) })).not.toBe(hash({ a: {} }));
  expect(hash({ a: new Set([1, 2]) })).not.toBe(hash({ a: new Map([[1, 2]]) }));
  expect(hash({ a: new Marker() })).not.toBe(hash({ a: { kind: "marker" } }));
  expect(hash({ a: () => 0 })).not.toBe(hash({}));
  expect(hash({ a: () => 0 })).not.toBe(hash({ a: {} }));
});

/** 一个最普通的 class 实例 —— 框架 §13 坑 3 点名的东西之一。 */
class Marker {
  kind = "marker";
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、对局夹具：一局**真的在做功**的对战
// ═══════════════════════════════════════════════════════════════════════════
//
// M3 之前没有卡表（那是 M4），`createGame` 造出来的牌库实体卡面全是 0，
// 所以走查/确定性测试都得自己把卡面写进 `entity.base`（`setup` 钩子的用途，
// 见 rules/run-match.ts）。写 `base` 而不是 `tags`：`tags` 是派生值，
// 每一步都会被 `refreshAuras` 从 `base` 重算覆盖（框架 §4.1 时序规则 4）。
//
// 实体 id 的分配顺序是写死的（state/create.ts：p0 base → p1 base → p0 牌库 → p1 牌库），
// 且**与种子无关** —— 洗牌只动 `zones` 里的 id 顺序，不动实体身份。
// 于是下面这些 id 在任何种子下都指向同一张牌，意图流可以直接按 id 写死。
//
// ⚠ 但"这张牌在不在手里"是**随种子变**的（M3 起 `createGame` 会发起手牌）。
//   所以 `setup` 用 `putInHand` 把六个参战单位强行塞进手牌 —— 于是意图流在任何种子下
//   都合法，"换种子"这个反例就被精确地限制在**看不见的差异**上（起手发到了哪几张、
//   牌库剩下的顺序、随机流走到哪了），这正是反例自检想要的对照。

const P0_BASE: EntityId = 1;
const P1_BASE: EntityId = 2;

/** p0 的三个单位（牌库里的第 1/2/3 张，id 与洗牌无关）。 */
const P0_UNIT_A: EntityId = 3;
const P0_UNIT_B: EntityId = 4;
const P0_UNIT_C: EntityId = 5;
/** p1 的三个单位。 */
const P1_UNIT_A: EntityId = 15;
const P1_UNIT_B: EntityId = 16;
const P1_UNIT_C: EntityId = 17;

const DECK_SIZE = 12;

function makeDeck(prefix: string): readonly CardId[] {
  const cards: CardId[] = [];
  for (let i = 1; i <= DECK_SIZE; i += 1) {
    cards.push(`${prefix}${String(i).padStart(2, "0")}`);
  }
  return cards;
}

const DECKS: readonly [readonly CardId[], readonly CardId[]] = [makeDeck("PF_A"), makeDeck("PF_B")];

/** 参战单位的卡面：`[实体 id, atk, health, cost]`。数值挑得让「几击致死」一目了然。 */
const FACES: readonly (readonly [EntityId, number, number, number])[] = [
  [P0_UNIT_A, 4, 5, 2], // 4/5：一击打死 P1_UNIT_A
  [P0_UNIT_B, 2, 3, 2], // 2/3
  [P0_UNIT_C, 3, 2, 1], // 3/2
  [P1_UNIT_A, 3, 4, 2], // 3/4
  [P1_UNIT_B, 1, 6, 2], // 1/6
  [P1_UNIT_C, 5, 2, 1], // 5/2
];

/** 六个参战单位，按 `[玩家, 实体 id]`。摆盘时强行塞进各自的手牌（见本节 ⚠）。 */
const ROSTER: readonly (readonly [0 | 1, EntityId])[] = [
  [0, P0_UNIT_A],
  [0, P0_UNIT_B],
  [0, P0_UNIT_C],
  [1, P1_UNIT_A],
  [1, P1_UNIT_B],
  [1, P1_UNIT_C],
];

/**
 * 建局之后的一次性摆盘。
 *
 * 按**实体 id** 写卡面，不按牌库位置 —— 于是"哪张牌是 4/5"与种子无关，
 * 换种子只改变**发到手里的是哪几张、牌库剩下的顺序**，不改变每张牌是什么。
 * 这正是第一条测试的反例自检想要的对照：打出来的每一步都一样，只有看不见的部分不同。
 */
function setup(state: GameState): void {
  for (const player of [0, 1] as const) {
    for (const id of [...getZone(state, player, "deck"), ...handOf(state, player)]) {
      // 没被点名的牌给个 1/1、0 费，免得留一堆 0 血牌在手里，也免得费用挡住意图流。
      setFace(state, id, { atk: 1, health: 1, cost: 0 });
    }
  }
  for (const [id, atk, health, cost] of FACES) {
    setFace(state, id, { atk, health, cost });
  }
  for (const [player, id] of ROSTER) {
    putInHand(state, player, id);
  }
}

/**
 * 一局完整的意图流：起手调度 → 三轮打牌 → 双 pass 进战斗 → 跨两个回合，
 * 中间夹一条**非法意图**。
 *
 * 逐条对应相位机的一条性质，改动它之前先看这份账：
 *   索引 0        起手调度（双方都不换）→ 相位机跑完 r1 的 round_start
 *   索引 1..4     行动交替：p0 / p1 轮流打牌，每次 `priority` 换手
 *   索引 5        **非法**（这张牌已经在场上）→ `wrong_zone`。被拒的路径也必须确定
 *                 （rules/run-match.ts：非法意图记进 rejected，不中断）
 *   索引 6..8     ★ **pass 不锁定**：p0 pass 之后 p1 照样能打牌，计数清零，p0 又能再打
 *   索引 9..10    双 pass → combat → round_end → r2
 *   索引 11..12   r2 再一次双 pass → r3（此时 initiative 已经轮换过一次）
 *
 * 六个参战单位由 `setup` 强行塞进手牌，所以每一条 `play_card` 在**任何种子下**都合法。
 */
const INTENTS: readonly Intent[] = [
  { t: "mulligan", player: 0, toss: [[], []] },
  { t: "play_card", player: 0, card: P0_UNIT_A, slot: 0 },
  { t: "play_card", player: 1, card: P1_UNIT_A, slot: 0 },
  { t: "play_card", player: 0, card: P0_UNIT_B, slot: 1 },
  { t: "play_card", player: 1, card: P1_UNIT_B, slot: 1 },
  { t: "play_card", player: 0, card: P0_UNIT_A, slot: 3 }, // 非法：已经在场上
  { t: "pass", player: 0 },
  { t: "play_card", player: 1, card: P1_UNIT_C, slot: 2 }, // 对手行动 ⇒ pass 计数清零
  { t: "play_card", player: 0, card: P0_UNIT_C, slot: 2 },
  { t: "pass", player: 1 },
  { t: "pass", player: 0 }, // 连续两次 → combat → r2
  { t: "pass", player: 1 },
  { t: "pass", player: 0 }, // 再来一次 → r3
];

/**
 * 架构 §6.1 的 `{ seed, decks, intents }` 三元组（`rules` 缺省 = 引擎自带的 DEFAULT_RULES）。
 *
 * **钉住先手**：M3 起首回合先手是随机掷的（v2 §36），不钉住的话换种子会连
 * "谁先行动"一起换掉，静态意图流就不再是同一局 —— 那样反例自检验的就不是哈希了。
 * 洗牌照常进行，随机流仍然由种子驱动。
 */
function matchOptions(seed: number, intents: readonly Intent[] = INTENTS): RunMatchOptions {
  return { seed, decks: DECKS, intents, setup, game: { firstPlayer: 0 } };
}

const SEED = 0x9f1;
const OTHER_SEED = 0x9f2;

function nameOf(event: GameEvent): string {
  return event.name;
}

function namesOf(events: readonly GameEvent[]): string[] {
  return events.map(nameOf);
}

function countOf(events: readonly GameEvent[], name: string): number {
  let total = 0;
  for (const event of events) {
    if (event.name === name) {
      total += 1;
    }
  }
  return total;
}

/** 断言 `apply` 成功并取出结果；失败时把原因码带进报错信息。 */
function applyOk(
  state: GameState,
  intent: Intent,
  deps?: ResolveDeps,
): { state: GameState; events: GameEvent[] } {
  const result = apply(state, intent, deps);
  if (!result.ok) {
    throw new Error(`意图被拒：${result.code}`);
  }
  return { state: result.state, events: result.events };
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、架构 §6.1 第一条：同 seed 同意图序列 → 终局状态哈希一致
// ═══════════════════════════════════════════════════════════════════════════

test("同 seed 同意图序列 → 终局状态哈希一致", () => {
  const a = runMatch(matchOptions(SEED));
  const b = runMatch(matchOptions(SEED));

  // ── 架构 §6.1 原文的那一行 ───────────────────────────────────────────────
  expect(hash(a.state)).toBe(hash(b.state));
  // 抗碰撞兜底：哈希相等还不够，规范化原串也必须逐字相等。
  expect(canonicalize(b.state)).toBe(canonicalize(a.state));

  // ── 事件流同样是输出的一部分（框架 §3.3：输出是事件流，不是状态 diff）──────
  expect(b.events).toEqual(a.events);
  expect(b.rejected).toEqual(a.rejected);

  // ── 这一局真的在做功 ─────────────────────────────────────────────────────
  // 不加这一段，两个"什么都没发生"的空状态也能让上面的断言全绿。
  // 三个回合 × 双方：3 次 round_start（各发一次水晶、抽一张）、2 次战斗、6 次上场、5 次 pass。
  expect(countOf(a.events, "round_began")).toBe(3);
  expect(countOf(a.events, "round_ended")).toBe(2);
  expect(countOf(a.events, "combat_began")).toBe(2);
  expect(countOf(a.events, "combat_ended")).toBe(2);
  expect(countOf(a.events, "crystal_gained")).toBe(6);
  expect(countOf(a.events, "card_drawn")).toBe(6);
  expect(countOf(a.events, "action_taken")).toBe(6);
  expect(countOf(a.events, "card_played")).toBe(6);
  expect(countOf(a.events, "unit_summoned")).toBe(6);
  expect(countOf(a.events, "player_passed")).toBe(5);
  // 两次战斗真的打了（v2 §4.2）：r1 六个单位对位互殴 6 击、死 3 个；
  // r2 场上只剩 3 个还能出手的单位 ⇒ 3 击、无人阵亡。
  expect(countOf(a.events, "struck")).toBe(9);
  expect(countOf(a.events, "damaged")).toBe(9);
  expect(countOf(a.events, "unit_died")).toBe(3);
  expect(a.rejected).toEqual([{ index: 5, code: "wrong_zone" }]);
  expect(a.state.seq).toBe(INTENTS.length - 1); // 被拒的那条不推进 seq
  expect(a.state.eventLog).toEqual([]); // 事件不在状态里积压
  // 六个单位都真的站上了战线（双方同索引对齐，v2 §0 规则 1），随后被战斗清掉三个：
  //   0 号格 4/5 vs 3/4 → 对面死；1 号格 2/3 vs 1/6 → 都活；2 号格 3/2 vs 5/2 → 同归于尽。
  expect(a.state.slots[0]).toEqual([P0_UNIT_A, P0_UNIT_B, null, ...Array(6).fill(null)]);
  expect(a.state.slots[1]).toEqual([null, P1_UNIT_B, null, ...Array(6).fill(null)]);
  expect(getZone(a.state, 0, "graveyard")).toEqual([P0_UNIT_C]);
  expect(getZone(a.state, 1, "graveyard")).toEqual([P1_UNIT_A, P1_UNIT_C]);
  // 相位机真的跑了三个回合：水晶上限递增、先手轮换（alternate）、行动权回到先手方。
  expect(a.state.round).toBe(3);
  expect(a.state.phase).toBe("actions");
  expect(a.state.players[0].crystalCap).toBe(7); // min(5 + (3-1)*1, 10)
  expect(a.state.initiative).toBe(0); // r1 p0 → r2 p1 → r3 p0
  expect(a.state.priority).toBe(0);
  expect(a.state.consecutivePasses).toBe(0);
  // r2 的战斗里 p0 的 0 号格对着一个空格 ⇒ 4 点打进 p1 基地；p0 基地对位都有人挡着。
  expect(getEntity(a.state, P1_BASE)?.damage).toBe(4);
  expect(getEntity(a.state, P0_BASE)?.damage).toBe(0);
  expect(a.state.winner).toBeNull();
  // 洗牌真的推进了随机流（否则"同 seed"这件事无从谈起）。
  expect(a.state.rng).not.toEqual({ s0: 0, s1: 0 });
});

test("反例自检：换一个 seed，第一条测试立刻会红", () => {
  const a = runMatch(matchOptions(SEED));
  const other = runMatch(matchOptions(OTHER_SEED));

  // 两局**打出来的每一步都一样** —— 事件名逐条相同、被拒的意图也相同。
  // 也就是说，差异只藏在"看不见"的地方：牌库/手牌的顺序，以及随机流的位置。
  expect(namesOf(other.events)).toEqual(namesOf(a.events));
  expect(other.rejected).toEqual(a.rejected);

  // 而哈希必须把这种差异抓出来 —— 抓不出来，第一条测试就成了摆设。
  expect(hash(other.state)).not.toBe(hash(a.state));
  expect(getZone(other.state, 0, "hand")).not.toEqual([...getZone(a.state, 0, "hand")]);
  expect(other.state.rng).not.toEqual(a.state.rng);
});

test("反例自检：意图流多一条，第一条测试立刻会红", () => {
  const a = runMatch(matchOptions(SEED));
  const longer = runMatch(
    matchOptions(SEED, [...INTENTS, { t: "pass", player: 0 }, { t: "pass", player: 1 }]),
  );

  expect(hash(longer.state)).not.toBe(hash(a.state));
  expect(longer.state.round).toBe(4); // 多打完一个回合
  expect(longer.state.players[0].crystalCap).toBe(8);
});

// ═══════════════════════════════════════════════════════════════════════════
// 五、架构 §6.1 第二条：序列化往返不改变结算结果 ★ 架构腐化的探针 ★
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一个**局中**状态：双方各有单位在场、有人挂了彩、墓地非空、手牌非空、
 * 随机流已推进、`seq` 非零，且轮到 p0 行动。
 *
 * 取完整意图流的前 6 条（r1 的四次上场 + 那条被拒的），再手工打两次出手 ——
 * 出手用 `testkit` 的 `strikeNow` 驱动，走的是与战斗快照**同一条**
 * `act.strike → act.hit` 管线，只是绕开了"哪个相位允许出手"这层外壳。
 * 这里刻意**不**靠战斗阶段来制造伤害：战斗是双向同时结算的，
 * 而本夹具要的是一个"一边挂了彩、另一边没死透"的不对称局面。
 * 局中状态必须带上死亡与伤害：那是纯数据探针最容易被腐化的一块
 * （`damage` 写在实体上、墓地是 `zones` 的重排、`playOrder` 要保留）。
 */
function woundedMidState(): GameState {
  const opened = runMatch(matchOptions(SEED, INTENTS.slice(0, 6))).state;
  const killed = strikeNow(opened, P0_UNIT_A, P1_UNIT_A); // 4 打 3/4 → 死
  return strikeNow(killed.state, P1_UNIT_B, P0_UNIT_B).state; // 1 打 2/3 → 剩 2
}

/** 在 {@link woundedMidState} 之上再 pass 一次：`consecutivePasses` 停在 1，轮到 p1。 */
function midGameState(): GameState {
  return passOnce(woundedMidState()).state;
}

/**
 * 落在这个局中状态上的下一条意图：p1 的第二次 pass。
 *
 * 挑它而不是挑一条"打一张牌"，是因为它是**跨相位边界**的那一步 ——
 * 双 pass → combat → round_end → round_start，一条意图带出一整段相位推进，
 * 顺带把水晶回满、抽牌、先手轮换全走一遍。往返探针扎在这种步子上才有意思。
 */
const MID_INTENT: Intent = { t: "pass", player: 1 };

test("序列化往返不改变结算结果", () => {
  const s = midGameState();
  const revived = reviveJson(s);

  // ── 前置：状态本身能逐字往返 ─────────────────────────────────────────────
  // 这一条先红，说明状态里已经有 JSON 装不下的东西了（框架 §13 坑 3）。
  expect(hash(revived)).toBe(hash(s));
  expect(canonicalize(revived)).toBe(canonicalize(s));
  expect(JSON.stringify(revived)).toBe(JSON.stringify(s));

  // ── 架构 §6.1 原文的那一行 ───────────────────────────────────────────────
  const direct = applyOk(s, MID_INTENT);
  const fromDisk = applyOk(revived, MID_INTENT);
  expect(hash(direct.state)).toBe(hash(fromDisk.state));
  expect(canonicalize(fromDisk.state)).toBe(canonicalize(direct.state)); // 抗碰撞兜底
  expect(fromDisk.events).toEqual(direct.events);

  // ── 这一步真的在做功 ─────────────────────────────────────────────────────
  // 一条 pass 带出整段相位推进；换成一条什么都不做的意图，本测试就成了空转。
  expect(namesOf(direct.events)).toEqual([
    "player_passed",
    "combat_began",
    // 战斗快照（v2 §4.2）：p0 的 0 号格对着一个空格 → 打基地；1 号格两边对位互殴。
    "struck",
    "damaged",
    "struck",
    "damaged",
    "struck",
    "damaged",
    "combat_ended",
    "round_ended",
    "round_began",
    "crystal_gained",
    "crystal_gained",
    "card_drawn",
    "card_drawn",
  ]);
  expect(direct.state.round).toBe(2);
  expect(direct.state.initiative).toBe(1); // alternate：r1 是 p0，r2 换手
  expect(direct.state.players[0].crystalCap).toBe(6);
  // 局中状态确实是"局中"：手牌、墓地、伤害、seq 全都非空。
  expect(getZone(s, 0, "hand").length).toBeGreaterThan(0);
  expect(getZone(s, 1, "graveyard")).toEqual([P1_UNIT_A]);
  expect(getEntity(s, P0_UNIT_B)?.damage).toBe(1);
  expect(s.slots[0][0]).toBe(P0_UNIT_A);
  expect(s.seq).toBeGreaterThan(0);
  // apply 是纯函数：两次结算互不干扰，入参状态一字未改（框架 §3.2）。
  expect(hash(s)).toBe(hash(revived));
});

type Polluted = GameState & { hack?: unknown };
type PollutedEntity = EntityData & { hack?: unknown };

/** 取一个在场实体，并把它当作"可以被塞脏东西"的对象看待（只用于反例自检）。 */
function entityForPollution(state: GameState, id: EntityId): PollutedEntity {
  const entity = getEntity(state, id);
  if (entity === undefined) {
    throw new Error(`夹具错误：实体 ${id} 不存在`);
  }
  return entity as PollutedEntity;
}

test("反例自检：状态里混进函数 / Map / Set / class 实例 / NaN，第二条测试立刻会红", () => {
  // 先立一个对照组：干净状态往返前后哈希一致 —— 这是第二条测试成立的前提。
  const clean = midGameState();
  expect(hash(reviveJson(clean))).toBe(hash(clean));

  // 下面每一样都是框架 §13「已知的坑 3」点名的东西。**只塞进测试里的副本，不动源码。**
  const cases: readonly (readonly [string, (state: Polluted) => void])[] = [
    [
      "函数（闭包 / 方法 —— 把状态 class 化的第一步）",
      (state) => {
        state.hack = () => 0;
      },
    ],
    [
      "Map（JSON 往返之后塌缩成 {}）",
      (state) => {
        state.hack = new Map([[1, 2]]);
      },
    ],
    [
      "Set",
      (state) => {
        state.hack = new Set([1, 2]);
      },
    ],
    [
      "class 实例",
      (state) => {
        state.hack = new Marker();
      },
    ],
    [
      "NaN（JSON 往返之后变成 null）",
      (state) => {
        state.hack = Number.NaN;
      },
    ],
    [
      "藏在实体里的函数（腐化通常从这里开始，而不是顶层）",
      (state) => {
        entityForPollution(state, P0_UNIT_A).hack = () => 0;
      },
    ],
    [
      "挂在实体上的方法（= 实体变成了 class）",
      (state) => {
        entityForPollution(state, P0_UNIT_A).hack = new Marker();
      },
    ],
  ];

  for (const [label, pollute] of cases) {
    const dirty = midGameState() as Polluted;
    pollute(dirty);
    // 往返之后哈希还一样 ⇒ 探针瞎了。用 [label, ...] 的形状断言，
    // 失败信息里能直接看出是哪一种腐化没被抓住。
    const survivesRoundTrip = hash(reviveJson(dirty)) === hash(dirty);
    expect([label, survivesRoundTrip]).toEqual([label, false]);
  }
});

/** 建局 + 摆盘，**没有经过任何 `apply`**，因此也没有被 `cloneState` 洗过。 */
function freshState(): GameState {
  const state = createGame(DEFAULT_RULES, DECKS, SEED);
  setup(state);
  return state;
}

test("状态在对局的每个阶段都是纯数据（★ 只查 apply 之后的状态是不够的 ★）", () => {
  // ── 这条测试为什么必须存在 ───────────────────────────────────────────────
  // `apply()` 内部第一件事就是 `cloneState(state)`（rules/apply.ts），而 `cloneState`
  // 是 **JSON 往返**（state/queries.ts）。也就是说：**建局期混进状态的函数 / Map /
  // class 实例，会在第一次 apply 时被悄悄洗掉** —— 洗完之后原件与往返件长得一模一样，
  // 上面那条 §6.1 的往返测试于是什么都看不见。
  //
  // 这不是假设：往 `createInitialState` 的返回值里塞一个 `new Map([[1,2]])`，
  // 本文件除本测试之外的**全部测试依然全绿**。所以探针必须同时扎在**还没被 clone
  // 洗过**的那一份状态上 —— 也就是 `createGame` 刚吐出来的东西。
  //
  // 覆盖面（合起来才是完整的「纯数据」不变量）：
  //   建局期腐化 → 由前两个阶段抓（未经 clone）；
  //   结算期腐化 → 由后三个阶段抓（handler / 死亡结算 / 挂起写进去的东西还没被下一次
  //                clone 洗掉）。
  const stages: readonly (readonly [string, GameState])[] = [
    ["建局：createGame 的直接产物", createGame(DEFAULT_RULES, DECKS, SEED)],
    ["建局 + 摆盘：setup 钩子改过的那一份", freshState()],
    ["一次 apply 之后：起手调度与 round_start 刚写过的状态", startMatch(freshState()).state],
    ["局中：单位在场、有伤害、墓地非空", midGameState()],
    ["挂起：stack 非空、pendingInput 非空", suspendedMidState()],
    ["终局：跑完整条意图流", runMatch(matchOptions(SEED)).state],
  ];
  for (const [label, state] of stages) {
    // 逐字往返 ⇒ 这一份状态里没有 JSON 装不下的东西。
    const isPureData = hash(reviveJson(state)) === hash(state);
    expect([label, isPureData]).toEqual([label, true]);
  }
});

test("反例自检：BigInt 与循环引用让往返探针直接抛错（更响的红）", () => {
  // 这两样连 `JSON.stringify` 都过不去 —— 第二条测试的第一行就会抛，
  // 根本走不到 hash 比对。所以这里断言的是"抛"，而不是"哈希不等"。
  const withBigInt = midGameState() as Polluted;
  withBigInt.hack = BigInt(1);
  expect(() => JSON.stringify(withBigInt)).toThrow();

  const cyclic = midGameState() as Polluted;
  cyclic.hack = cyclic; // 实体之间存对象引用而不是 id，走到极端就是这样
  expect(() => JSON.stringify(cyclic)).toThrow();
});

// ═══════════════════════════════════════════════════════════════════════════
// 六、挂起态也要能落盘（框架 §4.2）
// ═══════════════════════════════════════════════════════════════════════════
//
// 框架 §4.2 的原话是：「序列化整个 state 存起来，玩家断线重连也不丢」。
// 上面第二条测试跑的是**栈已经排空**的状态；挂起态才是最难的那一种 ——
// 它的 `stack` 非空、`pendingInput` 非空，栈条目里还带着上下文绑定。
// **栈条目里一旦放进闭包或 class 实例，这个能力立刻失效**（框架 §13 坑 3），
// 而那正好是 JSON 往返看不出、哈希看得出的差别。

/**
 * 一张会**挂起**的 handler 表：`act.move` 改成"先压续跑动作、再挂起等对手选目标"。
 *
 * 挂在 `act.move` 上是因为 M3 之后**只有它能被玩家意图直接触到**
 * （`play_card` 压的就是它）—— `act.strike` 已经没有对应的意图了（v2 §3.4 删掉了
 * `act.attack`，出手只由战斗快照与卡牌效果驱动）。这张表模拟的是一张
 * 「打出时：由对手选一个单位受到 6 点伤害」的牌，M4 起这类效果会由真求值器展开。
 *
 * 顺序（先 push 再 suspend）是 `resolve/suspend.ts` 文件头写死的契约：
 * `resume()` 把玩家的选择写进**栈顶条目**的 `ctx.chosen`，所以续跑动作必须先在栈顶。
 * 续跑动作的目标写成 `sel.chosen` —— 于是玩家的选择**真的**决定了打谁，
 * 这个挂起点不是摆设。
 */
const SUSPENDING_DEPS: ResolveDeps = {
  handlers: {
    ...M2_HANDLERS,
    "act.move": (state, ctx) => {
      pushAct(state, { op: "act.hit", target: { op: "sel.chosen" }, amount: 6 }, ctx);
      suspend(state, {
        player: 1,
        kind: "select_target",
        options: [P0_UNIT_B, P1_UNIT_B],
        optional: false,
        deadline: null,
      });
    },
  },
};

/** 「打出时由对手选目标」的那条意图：p0 用 1 费打出 UNIT_C（此时 `priority` 正是 p0）。 */
const SUSPENDING_INTENT: Intent = { t: "play_card", player: 0, card: P0_UNIT_C, slot: 2 };

/** 局中状态 + 一次会挂起的打牌 ⇒ `stack` 非空、`pendingInput` 非空。 */
function suspendedMidState(): GameState {
  return applyOk(woundedMidState(), SUSPENDING_INTENT, SUSPENDING_DEPS).state;
}

test("挂起态整个落盘再 resume，结果与不落盘逐字一致（框架 §4.2 + 架构 §6.1 第二条）", () => {
  const live = suspendedMidState();
  const fromDisk = reviveJson(live);

  // 挂起点确实成立：结算在半路停下，续跑动作留在栈上。
  expect(live.pendingInput?.kind).toBe("select_target");
  expect(live.pendingInput?.options).toEqual([P0_UNIT_B, P1_UNIT_B]);
  expect(live.stack).toHaveLength(1);
  // ★ 相位记账在结算之前就做完了（rules/phase.ts 的设计）：水晶已扣、行动权已换手，
  //   所以这个挂起点可以安全地落盘 —— 恢复之后"这个行动算不算做完了"没有歧义。
  expect(live.players[0].crystals).toBe(0);
  expect(live.priority).toBe(1);
  expect(hash(fromDisk)).toBe(hash(live));
  expect(canonicalize(fromDisk)).toBe(canonicalize(live));

  const respond: Intent = { t: "respond", player: 1, chosen: P0_UNIT_B };
  const direct = applyOk(live, respond, SUSPENDING_DEPS);
  const revived = applyOk(fromDisk, respond, SUSPENDING_DEPS);

  expect(hash(revived.state)).toBe(hash(direct.state));
  expect(canonicalize(revived.state)).toBe(canonicalize(direct.state));
  expect(revived.events).toEqual(direct.events);

  // 选择真的驱动了续跑动作：sel.chosen 选中 P0_UNIT_B，6 点打在只剩 2 血的它身上 → 死。
  expect(namesOf(direct.events)).toEqual(["damaged", "unit_died"]);
  expect(direct.state.pendingInput).toBeNull();
  expect(direct.state.stack).toEqual([]);
  expect(getZone(direct.state, 0, "graveyard")).toEqual([P0_UNIT_B]);

  // 反例自检：换一个选择就是另一局 —— 挂起点不是一个走过场的形式。
  const other = applyOk(fromDisk, { t: "respond", player: 1, chosen: P1_UNIT_B }, SUSPENDING_DEPS);
  expect(hash(other.state)).not.toBe(hash(direct.state));
  expect(getZone(other.state, 1, "graveyard")).toEqual([P1_UNIT_A, P1_UNIT_B]);
});
