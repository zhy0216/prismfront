// @prismfront/engine/testkit —— 引擎测试夹具（架构 §4.1 的 exports 已点名 `"./testkit"`）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 这里放什么、为什么要有它
// ═══════════════════════════════════════════════════════════════════════════
// 一局对战从建局到"某个单位站在某一格上、轮到某人行动"要走一串固定动作：
// 建局 → 摆卡面 → 起手调度 → 打牌 → pass。每个测试都手写一遍，会出现两个问题：
//   1. 相位机改一次（比如多一个 deploy 相位），所有测试的推进代码一起碎掉；
//   2. 各测试的"推进到 actions 相位"写法微妙不同，红了要先分辨是夹具错还是引擎错。
// 所以推进逻辑收在本文件一处，测试只描述**盘面与断言**。
//
// 三类夹具，一个测试通常按这个顺序各用一次：
//   建局    {@link openGame}（+ {@link makeTestDeck}）—— 一步停在 r1 的 `actions` 相位
//   摆盘    {@link putUnit} / {@link setFace} / {@link setFlag} / {@link putInHand}
//   推进    {@link passOnce} / {@link passThroughCombat} / {@link fightOnce} / {@link playCard}
// 外加两条读盘的小工具（{@link damageOf} / {@link eventNames}）与一条绕开意图层的
// 直驱结算管线（{@link runActs}）。
//
// 使用方：`src/__tests__/`（走查与确定性）、M3 的四条战斗验收测试
// （`rules/__tests__/combat.test.ts`）、以及 `packages/cards` 的单卡测试（M4 起）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 两条约束
// ═══════════════════════════════════════════════════════════════════════════
// - 与 engine 主入口同样受架构 §2.2 禁令 5 约束：**不得使用 `Bun.*` 或 `bun:` 模块**
//   （`bun:test` 例外，见 biome.json）。本文件一个都没用到，它只是普通函数。
// - **不 import `@prismfront/ir` 的任何值**（禁令 1）：类型可以，值不行。
//
// ═══════════════════════════════════════════════════════════════════════════
// `setFace` 为什么必须存在（M4 之前）
// ═══════════════════════════════════════════════════════════════════════════
// 引擎不认识具体卡，卡面属性在 bundle 里，而**卡表是 M4**。`createGame` 造出来的
// 牌库实体 `atk/health/cost` 全是 0，而 0 血单位一上场就会在流水线第 ⑤ 步被判死
// （`state/entity.ts` 的血量记账：当前血量 = `tags.health - damage`）。
// 所以测试必须自己把卡面写进 `entity.base`。M4 接上卡表后本函数就没有存在的必要了。

import type { Act, CardId, EntityId, FlagName, RulesConfig, TagKey } from "@prismfront/ir";
import type { GameEvent } from "../events/index.ts";
import { M2_DEPS, moveToZone, placeOnSlot } from "../handlers/index.ts";
import type { ResolveDeps } from "../resolve/index.ts";
import { pushActs, resolve } from "../resolve/index.ts";
import type { ApplyResult, Intent } from "../rules/index.ts";
import { apply, createGame, DEFAULT_RULES } from "../rules/index.ts";
import type { EntityData, GameState, PlayerId } from "../state/index.ts";
import { cloneState, createCtx, getEntity, getZone, maskWith, playerData } from "../state/index.ts";

/** 一次推进的产物：新状态 + 这一段的事件流（与 `ApplyResult` 的 `ok:true` 分支同形）。 */
export interface Step {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/** 断言 `apply` 成功并取出结果；失败时把原因码带进报错信息。 */
export function expectOk(result: ApplyResult): Step {
  if (!result.ok) {
    throw new Error(`意图被拒：${result.code}`);
  }
  return { state: result.state, events: result.events };
}

/** 一串事件的名字（断言事件**顺序**时用；顺序本身就是被测性质，见 `rules/combat.ts`）。 */
export function eventNames(events: readonly GameEvent[]): string[] {
  return events.map((event) => event.name);
}

// ═══════════════════════════════════════════════════════════════════════════
// 建局
// ═══════════════════════════════════════════════════════════════════════════
// 本节的实现调用了下面两节的 `setFace` / `startMatch`（函数声明提升，顺序按
// 「建局 → 摆盘 → 推进」的阅读顺序排，不按定义顺序）。

/**
 * 一副测试用牌：`{prefix}1 … {prefix}N` 这样的 `CardId` 列表。
 *
 * 默认 30 张 = `deck.size` 的默认值：起手发 4 张之后还剩 26 张，
 * 跑十几个回合也不会撞上疲劳（`deck.fatigue`），于是"牌抽光了"不会混进无关的断言里。
 * 两方要用**不同前缀**，排 bug 时一眼能看出这张牌是谁的。
 */
export function makeTestDeck(prefix: string, size = 30): readonly CardId[] {
  const cards: CardId[] = [];
  for (let i = 1; i <= size; i += 1) {
    cards.push(`${prefix}${i}`);
  }
  return cards;
}

/** {@link openGame} 的可选项，全部有缺省值。 */
export interface OpenGameOptions {
  /** 规则参数，缺省用引擎自带的 {@link DEFAULT_RULES}（`rules/config.ts`）。 */
  readonly rules?: RulesConfig;
  /** 双方牌库，缺省是两副 {@link makeTestDeck} 造的 30 张牌。 */
  readonly decks?: readonly [readonly CardId[], readonly CardId[]];
  /** 种子。见下方说明：本函数**一次 RNG 都不消耗**，所以它只是被记进状态。 */
  readonly seed?: number;
  /** 钉住首回合先手，缺省 p0。 */
  readonly firstPlayer?: PlayerId;
  /** 写给**每一张**牌（双方、牌库+手牌）的卡面，缺省 0 费 1/1。 */
  readonly face?: Face;
}

/**
 * 建局 + 起手调度，一步停在**第 1 回合的 `actions` 相位**（战线全空）。
 *
 * 这是本文件三类夹具里的"建局"那一类，也是绝大多数测试的第一行。
 * 它把四件本来要在每个测试文件里各抄一遍的事收在一处：
 *   1. 一份 `RulesConfig` 字面量（12 个字段，抄错一个字段全文件的断言都会漂）；
 *   2. 两副牌的 `CardId` 列表；
 *   3. `createGame(..., { shuffle: false, firstPlayer })`；
 *   4. 给每张牌写卡面 + `startMatch` 推到 r1。
 *
 * ── 为什么恒 `shuffle: false` ────────────────────────────────────────────
 * 摆盘夹具（{@link putUnit}）按**牌库顶**取牌，洗过的牌库顶是随种子变的 ——
 * 那样每条断言都得先猜今天顶上是哪张。要测洗牌本身请直接调 `createGame`。
 * 加上 `firstPlayer` 默认钉住，本函数**一次 RNG 都不消耗**（`create-game.ts`：
 * 建局期的 RNG 只花在掷先手与洗牌上），于是 `seed` 取什么值都不影响结果。
 *
 * ── 为什么要给每张牌写卡面 ───────────────────────────────────────────────
 * 引擎不认识具体卡，`createGame` 造出来的牌 `atk/health/cost` 全是 0，
 * 而 0 血单位一上场就会在流水线第 ⑤ 步被判死（见文件头 `setFace` 那一段），
 * 0 费则是为了不让"水晶不够"混进与费用无关的断言里。
 *
 * ── 丢掉的那一段事件流 ───────────────────────────────────────────────────
 * 起手调度那一条 `apply` 会带出 `round_began` / `crystal_gained` / `card_drawn`。
 * 本函数只返回状态：要断言开局事件流的测试应当自己 `createGame` + {@link startMatch}。
 */
export function openGame(options: OpenGameOptions = {}): GameState {
  const rules = options.rules ?? DEFAULT_RULES;
  const decks = options.decks ?? [makeTestDeck("A"), makeTestDeck("B")];
  const face = options.face ?? { atk: 1, health: 1, cost: 0 };
  const start = createGame(rules, decks, options.seed ?? 1, {
    shuffle: false,
    firstPlayer: options.firstPlayer ?? 0,
  });
  for (const player of [0, 1] as const) {
    for (const id of [...getZone(start, player, "deck"), ...handOf(start, player)]) {
      setFace(start, id, face);
    }
  }
  return startMatch(start).state;
}

// ═══════════════════════════════════════════════════════════════════════════
// 摆盘
// ═══════════════════════════════════════════════════════════════════════════

/** 一张牌的卡面数值。缺省项保持原值（默认 0）。 */
export interface Face {
  readonly atk?: number;
  readonly health?: number;
  readonly cost?: number;
  /** 出手方向（v2 §2.3 是普通 Tag，可为负、不限幅）。战斗快照读**生效值**。 */
  readonly direction?: number;
}

/**
 * 给一个实体写上卡面数值。
 *
 * 写 `base` 而不是 `tags`：`tags` 是派生值，每一步都会被 `refreshAuras` 从 `base`
 * 重算覆盖（框架 §4.1 时序规则 4）。这里顺手把 `tags` 也对齐，
 * 免得在第一次重算之前读到旧值（`apply` 之前的断言会用到）。
 */
export function setFace(state: GameState, id: EntityId, face: Face): EntityData {
  const card = getEntity(state, id);
  if (card === undefined) {
    throw new Error(`夹具错误：实体 ${id} 不存在`);
  }
  const write = (tag: TagKey, value: number | undefined): void => {
    if (value === undefined) {
      return;
    }
    card.base[tag] = value;
    card.tags[tag] = value;
  };
  write("atk", face.atk);
  write("health", face.health);
  write("cost", face.cost);
  write("direction", face.direction);
  return card;
}

/** 给某方**牌库里的每一张**牌写同一份卡面（"剩下的牌随便给个 1/1"这种需求）。 */
export function setDeckFaces(state: GameState, player: PlayerId, face: Face): void {
  for (const id of getZone(state, player, "deck")) {
    setFace(state, id, face);
  }
}

/**
 * 给一个实体置/清一个卡面标志位（滞光、辉膜、已沉默）。
 *
 * 与 {@link setFace} 同一条规矩：写 `baseFlags`（卡面），顺手把派生的 `flags` 也对齐，
 * 免得在第一次 `refreshAuras` 之前读到旧值。M5 起 `flags` 还会加上附魔与光环的 Σ，
 * 那时"临时滞光"要挂附魔而不是改卡面 —— 本函数只服务摆盘。
 */
export function setFlag(state: GameState, id: EntityId, flag: FlagName, value = true): EntityData {
  const entity = getEntity(state, id);
  if (entity === undefined) {
    throw new Error(`夹具错误：实体 ${id} 不存在`);
  }
  entity.baseFlags = maskWith(entity.baseFlags, flag, value);
  entity.flags = maskWith(entity.flags, flag, value);
  return entity;
}

/**
 * 摆盘：把一个实体**直接**放到某方的某一格（不发事件、不扣水晶、不管相位）。
 *
 * 战斗测试要的是"某个盘面下战斗会怎么打"，走 `play_card` 摆盘会平白搅进
 * 费用、行动权、`consecutivePasses` 与 `unit_summoned` 事件 —— 那些属于相位机的测试。
 * 本函数复用 `handlers/board.ts` 的 `placeOnSlot`，所以三条位置一致性不变量
 * （`zones` / `slots` / `entity.slot`）与真实上场走的是同一份实现。
 */
export function putOnSlot(
  state: GameState,
  player: PlayerId,
  id: EntityId,
  slot: number,
): EntityData {
  const entity = getEntity(state, id);
  if (entity === undefined) {
    throw new Error(`夹具错误：实体 ${id} 不存在`);
  }
  if (!placeOnSlot(state, entity, player, slot)) {
    throw new Error(`夹具错误：p${player} 的第 ${slot} 格放不下实体 ${id}（越界或已被占）`);
  }
  return entity;
}

/**
 * 摆一个单位：从某方**牌库顶**取一张牌，写上卡面，直接放到第 `slot` 格。返回它的 id。
 *
 * 战斗测试的主力夹具 —— 一行描述一个"某格上站着一个 x/y、朝哪边"的事实，
 * 与 {@link openGame} 的 `shuffle: false` 配套（牌库顶可预测，所以不用先去找一张牌）。
 *
 * 取牌库顶而不是手牌：手牌张数受 `deck.startingHand` 与每回合抽牌影响，
 * 摆到第五个单位就会不够；牌库有 26 张，摆满一整行（9 格）都绰绰有余。
 */
export function putUnit(state: GameState, player: PlayerId, slot: number, face: Face): EntityId {
  const id = deckTop(state, player);
  setFace(state, id, face);
  putOnSlot(state, player, id, slot);
  return id;
}

/**
 * 把一个实体**直接**塞进某方手牌（摆盘用：不发事件、不消耗 RNG、不管它原来在哪）。
 *
 * 用途：让"这几张牌一定在手里"与**洗牌结果无关**。确定性测试需要这个 ——
 * 意图流是静态数组（`{seed, decks, intents}` 三元组的形状），而洗牌之后哪几张牌
 * 落在起手里是随种子变的；不固定住就没法写出一条"在任何种子下都合法"的意图流，
 * 也就没法把"换种子"这个反例精确地限制在**看不见的差异**上。
 */
export function putInHand(state: GameState, player: PlayerId, id: EntityId): EntityData {
  const card = getEntity(state, id);
  if (card === undefined) {
    throw new Error(`夹具错误：实体 ${id} 不存在`);
  }
  moveToZone(state, card, player, "hand");
  return card;
}

/** 某方手牌的**有序** id 列表（手牌顺序由 `zones` 表达）。 */
export function handOf(state: GameState, player: PlayerId): readonly EntityId[] {
  return getZone(state, player, "hand");
}

/** 某方牌库顶那张牌的 id（洗牌后的顺序由状态说了算）。 */
export function deckTop(state: GameState, player: PlayerId): EntityId {
  const top = getZone(state, player, "deck")[0];
  if (top === undefined) {
    throw new Error(`夹具错误：p${player} 牌库是空的`);
  }
  return top;
}

/** 某方手牌里第一张 `cardId` 匹配的牌（按卡名摆盘时比按 id 好读）。 */
export function handCardOf(state: GameState, player: PlayerId, cardId: CardId): EntityId {
  for (const id of handOf(state, player)) {
    if (getEntity(state, id)?.cardId === cardId) {
      return id;
    }
  }
  throw new Error(`夹具错误：p${player} 手里没有 ${cardId}`);
}

/** 某方 base 实体的 id（v2.1 §11.2：承伤与胜负判定的那个实体，它不占格、不进墓地）。 */
export function baseIdOf(state: GameState, player: PlayerId): EntityId {
  return playerData(state, player).baseId;
}

/**
 * 一个实体身上的**累计伤害**（`state/entity.ts` 的血量记账：当前血量 = `tags.health - damage`）。
 *
 * 断言伤害要读这个字段而不是"血量少了多少"：`tags.health` 是**生效上限**，
 * 附魔/光环随时会改它，而 `damage` 只被伤害与治疗动过。
 */
export function damageOf(state: GameState, id: EntityId): number {
  const entity = getEntity(state, id);
  if (entity === undefined) {
    throw new Error(`夹具错误：实体 ${id} 不存在`);
  }
  return entity.damage;
}

// ═══════════════════════════════════════════════════════════════════════════
// 相位推进
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 起手调度：**双方都不换牌**，把对局从 `mulligan` 推进到第 1 回合。
 *
 * 起手调度是双方聚合的单条 intent（`rules/intent.ts` 的文件头），
 * 所以"不换牌"就是两个空数组。要测调度本身请直接构造 intent，别用这个夹具。
 */
export function startMatch(state: GameState, deps: ResolveDeps = M2_DEPS): Step {
  return expectOk(apply(state, { t: "mulligan", player: 0, toss: [[], []] }, deps));
}

/** 让**当前持有 `priority` 的那一方** pass 一次。 */
export function passOnce(state: GameState, deps: ResolveDeps = M2_DEPS): Step {
  return expectOk(apply(state, { t: "pass", player: state.priority }, deps));
}

/**
 * 双方连续 pass 直到 `actions` 相位结束 —— 也就是**打完战斗、进入下一回合**。
 *
 * 事件流按顺序拼接，于是调用方能一次拿到
 * `player_passed → … → combat_began → combat_ended → round_ended → round_began → …`
 * 整段。
 *
 * ── ★ 为什么不是「pass 恰好 `combatAfterConsecutivePasses` 次」★ ─────────────
 * 阈值是**连续** pass 的计数，而 `state.consecutivePasses` 进来时不一定是 0：
 * 从一个"已经 pass 过一次"的状态出发，固定次数的循环会多 pass 一次，
 * **静默跨过一个回合边界**（实测返回 `{round: 2, consecutivePasses: 1}`）——
 * 调用方拿到的是下一回合的盘面，而它写的断言以为自己还在这一回合。
 * 现在所有调用点都从 0 起跳，所以这条边一次都没踩到过；正因为踩不到，
 * 它坏了也没人会发现，所以在这里按"这一回合的 actions 是否已经结束"来判。
 *
 * ⚠ 循环条件**不能**只写 `phase === "actions"`：战斗打完之后
 *   `combat → round_end → round_start` 三个自动相位会一路跑回**下一回合的**
 *   `actions`（`rules/phase.ts` 的 `advancePhases`），那个条件一进来就恒真 —— 死循环。
 *   所以要连回合号一起比：回合号变了 = 这一回合的 actions 已经结束。
 * **终止性**：每次 `passOnce` 让 `consecutivePasses` +1，阈值 ≥ 1
 * （`validate-config.ts` 保证），到阈值即转 `combat`，随后回合号必变。
 *
 * 入口相位不对时立刻报"夹具错误"（与 {@link fightOnce} 同一个风格）：否则循环会
 * 一次 pass 都不做就静默返回原状态，断言以"少了几条事件"的形式红，
 * 那时很难看出真正的原因。
 */
export function passThroughCombat(state: GameState, deps: ResolveDeps = M2_DEPS): Step {
  if (state.phase !== "actions") {
    throw new Error(`夹具错误：passThroughCombat 要从 actions 相位起跳（phase=${state.phase}）`);
  }
  let current = state;
  const events: GameEvent[] = [];
  while (current.phase === "actions" && current.round === state.round) {
    const step = passOnce(current, deps);
    current = step.state;
    for (const event of step.events) {
      events.push(event);
    }
  }
  return { state: current, events };
}

/**
 * 打完**一次战斗**，并只取出 `combat_began … combat_ended` 之间的那一段事件流。
 *
 * {@link passThroughCombat} 返回的是整条 `apply` 的事件流，尾巴上还挂着
 * `round_ended` / `round_began` / 水晶 / 抽牌（相位机把自动相位一口气跑完，见 `phase.ts`）。
 * 战斗测试要断言的是**战斗内部的事件顺序**（`unit_died` 排在哪几击之后 ——
 * 那是"中途结算死亡"这个 bug 在 M3 唯一的可观测面，见 `rules/combat.ts`），
 * 把回合切换的那几条留在数组里，每条断言都得跟着相位机的改动一起改。
 *
 * 对局**在战斗中结束**时没有 `combat_ended`（v2 §4.1：base 归零即刻分胜负，
 * 之后不该再有后续时序），这时取到末尾。
 */
export function fightOnce(state: GameState, deps: ResolveDeps = M2_DEPS): Step {
  const step = passThroughCombat(state, deps);
  const names = eventNames(step.events);
  const from = names.indexOf("combat_began");
  if (from < 0) {
    // 没打起来 —— 多半是相位没停在 `actions`，或者对局早就结束了。
    // 静默返回一段空事件流会让断言以"少了几条事件"的形式红，那时很难看出真正的原因。
    throw new Error(`夹具错误：这一段里没有 combat_began（phase=${step.state.phase}）`);
  }
  const to = names.indexOf("combat_ended");
  return { state: step.state, events: step.events.slice(from, to < 0 ? undefined : to + 1) };
}

/** 打出一张牌（由当前 `priority` 方发起时可省 `player`）。 */
export function playCard(
  state: GameState,
  card: EntityId,
  slot: number,
  deps: ResolveDeps = M2_DEPS,
  player: PlayerId = state.priority,
): Step {
  const intent: Intent = { t: "play_card", player, card, slot };
  return expectOk(apply(state, intent, deps));
}

// ═══════════════════════════════════════════════════════════════════════════
// 直接驱动结算管线
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 把一批**引擎自造的动作**压栈并跑完一次结算。
 *
 * 与 `apply()` 的 ②③ 段等价（clone → 压栈 → `resolve` → `seq += 1`），
 * 只是绕开了"意图校验"这一层 —— 因为这些动作**没有对应的玩家意图**：
 * v2 §3.4 已经删掉 `act.attack`，出手只由战斗阶段的快照（v2 §4.2）与卡牌效果驱动。
 *
 * 用途有二：
 * 1. 测**流水线本身**（拦截器 / 触发器 / 死亡结算 / 光环重算的时序），
 *    不想连带把一整个回合的相位推进也搅进断言里；
 * 2. 驱动**单向**的"出手 → 伤害 → 死亡"这条链 —— 走的是与战斗快照**同一条**
 *    `act.strike → act.hit` 管线，只是绕开了"哪个相位允许出手"这层外壳。
 *    战斗阶段（`rules/combat.ts`）落地之后它依然有用：战斗是**双向同时**结算的，
 *    要断言"攻击方毫发无伤"这类单向性质，只能用它。
 *
 * `acts` 按**执行顺序**给（LIFO 反转由 `resolve/push.ts` 负责）。
 */
export function runActs(
  state: GameState,
  acts: readonly Act[],
  self: EntityId,
  deps: ResolveDeps = M2_DEPS,
): Step {
  const draft = cloneState(state);
  pushActs(draft, acts, createCtx(self));
  const events = resolve(draft, deps);
  draft.seq += 1;
  return { state: draft, events };
}

/**
 * 让一个在场单位出手打一个目标（`act.strike`，v2 §3.4）。
 *
 * `amount` 由 handler 取 attacker 的**当前 atk** 并当场冻结，与战斗快照的取数一致。
 * 见 {@link runActs} 的第 2 条用途。
 */
export function strikeNow(
  state: GameState,
  attacker: EntityId,
  target: EntityId,
  deps: ResolveDeps = M2_DEPS,
): Step {
  return runActs(
    state,
    [
      {
        op: "act.strike",
        attacker: { op: "sel.entity", id: attacker },
        target: { op: "sel.entity", id: target },
      },
    ],
    attacker,
    deps,
  );
}
