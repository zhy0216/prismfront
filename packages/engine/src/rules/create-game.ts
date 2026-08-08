// `createGame(rules, decks, seed)` —— 对外的建局入口（架构 §2.3 engine 对外 API）。
//
// 与 `state/create.ts` 的 `createInitialState` 的分工：
//   createInitialState  纯摊平：卡 id 列表 → 实体表 / 区域表 / 空战线。**不消耗 RNG**。
//   createGame          外部入口：校验规则 → `seed` → `RngState`，并做**要消耗 RNG 的
//                       建局工作**（掷首回合先手、洗牌），最后发起手牌。
//
// 分成两层的理由是 `state/create.ts` 文件头写的那条：建局与"推进随机流"混在一起，
// 「同 seed 同意图序列 ⇒ 同终局」就很难推理。把消耗 RNG 的部分收在本文件，
// 于是"这一局的随机流从哪里开始被推进"只有一个答案。
//
// ═══════════════════════════════════════════════════════════════════════════
// M3：建局期多做了三件事
// ═══════════════════════════════════════════════════════════════════════════
// 1. **规则校验**（`validate-config.ts`）—— 放在第一行。`rules` 会被写进状态、
//    跟着存档与回放一起流传，坏配置必须在这一刻撞墙。
// 2. **掷首回合先手**（v2 §36：首回合先手随机）。放在建局而不是第一个 `round_start`，
//    理由见 {@link CreateGameOptions.firstPlayer}。
// 3. **发起手牌** `rules.deck.startingHand` 张。发完 `phase` 停在 `mulligan`，
//    等一条 `mulligan` 意图把对局推进到 r1（`rules/phase.ts`）。
//
// **仍然不发事件**：返回值只有状态，`state.eventLog` 为空。建局期的洗牌与掷先手
// 因此也不下发 `engine.random_picked` —— 那时还没有观众，客户端拿到的是**整份初始状态**
// （投影后的，M7），先手是谁、手里是什么牌都从状态里读，不需要事件流复述一遍。
// 同理起手牌不发 `card_drawn`：那会让 M5 的「每当你抽到一张牌」在开局白白触发一轮。

import type { BundleId, CardId, EntityId, RulesConfig, ZoneName } from "@prismfront/ir";
import { moveToZone } from "../handlers/index.ts";
import { createRngState, nextInt } from "../rng/index.ts";
import type { CreateInitialStateOptions, GameState, PlayerId } from "../state/index.ts";
import { createInitialState, getEntity, getZone, PLAYER_IDS, zoneKey } from "../state/index.ts";
import { PLAYER_COUNT } from "./initiative.ts";
import { validateRulesConfig } from "./validate-config.ts";

/** {@link createGame} 的可选项。 */
export interface CreateGameOptions {
  /** 卡组外的英雄卡（v2.1 §11.1），落在 `fountain` 区。部署语义见 `rules/phase.ts`。 */
  readonly heroes?: readonly [readonly CardId[], readonly CardId[]];
  /** 本局钉住的 bundle 标识（IR v1 §2.1 / §6.2）。M2 无卡表，默认空串。 */
  readonly bundleId?: BundleId;
  /**
   * **钉住**首回合先手，同时初始化 `priority` 与 `initiative`。
   *
   * 缺省（不传）时按 v2 §36 **随机掷**一次并消耗 RNG —— 首回合先手是随机的，
   * 这件事与 `rules.initiative` 选了哪种策略**完全正交**（策略只管第 2 回合起怎么变，
   * 见 `initiative.ts` 的文件头）。
   *
   * 传值 = 不掷、不消耗 RNG。给三种场合用：golden replay 的夹具、
   * "用固定先手复现一个 bug"、以及需要断言先手相关时序的测试。
   *
   * ── 为什么这一掷放在建局而不是第一个 `round_start` ──────────────────────
   * 放到 `round_start` 就得让相位机知道"这是不是第一回合、要不要掷"，
   * 而"要不要掷"取决于调用方有没有钉住先手 —— 那是一条**建局期的信息**，
   * 要带进第一个回合就得往 `GameState` 里加一个只在一回合内有意义的字段，
   * 而状态里的每个字段都要被投影（M7）、回放、快照一路照顾到。
   * 收在建局则一次掷完、状态里只留结果，且与洗牌同属"要消耗 RNG 的建局工作"。
   */
  readonly firstPlayer?: PlayerId;
  /**
   * 是否洗牌，默认 `true`。
   *
   * 传 `false` 用于**需要牌序可预测**的场合：走查测试、golden replay 的夹具、
   * 以及"用固定牌序复现一个 bug"。
   *
   * 注意它只关掉洗牌：不传 `firstPlayer` 时那一掷照样消耗 RNG。要让一局
   * **一次 RNG 都不消耗**，两个选项都要给。
   */
  readonly shuffle?: boolean;
}

/**
 * 建一局并返回初始状态。
 *
 * 参数顺序与架构 §2.3 的 `createGame(rules, decks, seed)` 一致。
 *
 * `seed` **入状态**（框架 §4.3）：`{seed, deckLists, intents[]}` 三元组即可完整复现一局。
 * 种子由服务端生成、存库、**永不下发客户端**（可预测随机 = 泄露隐藏信息），
 * 投影层（M7）要把 `state.rng` 整个抹掉，而不是抹掉某个字段。
 *
 * **建局期消耗 RNG 的顺序是写死的**：先掷先手，再洗 p0 牌库，再洗 p1 牌库。
 * 换了顺序，同一个种子会产出另一局 —— 历史回放会静默失真。
 *
 * @throws RulesConfigError `rules` 不合法（见 `validate-config.ts`；
 *         `playerActions` 开了 `move_unit` / `set_direction` 就落在这里）。
 */
export function createGame(
  rules: RulesConfig,
  decks: readonly [readonly CardId[], readonly CardId[]],
  seed: number,
  options: CreateGameOptions = {},
): GameState {
  validateRulesConfig(rules);

  const rng = createRngState(seed);
  // 掷先手要 RNG，而 RNG 要先建好；此时状态还没造出来，所以用一个只带 `rng` 的靶子 ——
  // `nextInt` 的入参声明成 `HasRng` 结构类型正是为了这种场合（见 `rng/rng.ts`）。
  const firstPlayer =
    options.firstPlayer ?? (nextInt({ rng }, PLAYER_COUNT) === 0 ? (0 as PlayerId) : 1);

  const init: CreateInitialStateOptions = {
    rules,
    rng,
    decks,
    bundleId: options.bundleId ?? "",
    firstPlayer,
  };
  // `exactOptionalPropertyTypes` 下不能把 `undefined` 塞进可选属性，只能有值才写。
  if (options.heroes !== undefined) {
    init.heroes = options.heroes;
  }

  const state = createInitialState(init);
  if (options.shuffle !== false) {
    // 顺序写死为 p0 → p1：随机流的推进顺序进回放，换了顺序历史回放就对不上。
    for (const player of PLAYER_IDS) {
      shuffleZone(state, player, "deck");
    }
  }
  dealStartingHands(state);
  return state;
}

/**
 * 原地洗一个区域的**有序列表**（Fisher–Yates，自后向前）。
 *
 * 洗的是 `zones[k]` 里的 id 顺序，**不动 `entities` 表**：实体 id 的分配顺序是写死的
 * （`state/create.ts`），id 会进回放，不能随种子漂移。于是同一副牌不同种子，
 * 只有牌序不同、实体身份完全一致 —— 排 bug 时这一点很省事。
 *
 * 随机一律走 `nextInt`（框架 §4.3；`Math.random` 已被 engine 的 biome.json 封死）。
 * 每一步的取值范围是 `[0, i]`，即 `nextInt(state, i + 1)`：这是无偏的 Fisher–Yates，
 * 写成 `nextInt(state, n)` 的那个常见变体（"Sattolo 反例"）会漏掉一部分排列。
 *
 * 对局中途的洗牌效果（`act.shuffle`，M4）复用本函数，但要发
 * `engine.random_picked{origin:"shuffle"}`；建局期不发（见文件头）。
 */
export function shuffleZone(state: GameState, player: PlayerId, zone: ZoneName): void {
  const list = state.zones[zoneKey(player, zone)];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = nextInt(state, i + 1);
    const a = list[i];
    const b = list[j];
    // `noUncheckedIndexedAccess` 下两者都是 `EntityId | undefined`。i、j 恒在界内，
    // 但不用 `!` 绕过去（M2 的硬约束之一），显式判一下更便宜也更诚实。
    if (a === undefined || b === undefined) {
      continue;
    }
    list[i] = b;
    list[j] = a;
  }
}

/**
 * 把牌库顶的一张牌**静默**移进手牌，返回它的 id；牌库空则返回 `null`。
 *
 * 「静默」= **不发事件**。它只服务两个隐藏信息交换的场合：建局发起手牌、
 * 起手调度的补抽（`rules/phase.ts` 的 `applyMulligan`）。对局中的抽牌请走
 * `handlers/draw.ts` 的 `drawOne` —— 那一条会发 `card_drawn`，两者不要混用。
 *
 * **牌库顶 = `zones["p{n}:deck"]` 的下标 0**（`state/create.ts` 的 `decks` 注释：
 * 「下标 0 = 牌堆顶」）。
 */
export function dealTop(state: GameState, player: PlayerId): EntityId | null {
  const topId = getZone(state, player, "deck")[0];
  if (topId === undefined) {
    return null;
  }
  const card = getEntity(state, topId);
  if (card === undefined) {
    return null;
  }
  moveToZone(state, card, player, "hand");
  return card.id;
}

/**
 * 发起手牌：每方 `rules.deck.startingHand` 张（v2 §6，默认 4）。
 *
 * 顺序写死 p0 → p1；牌库不够就发到没为止（引擎不做构筑校验，见 `validate-config.ts`）。
 * **不发事件、不消耗 RNG** —— 牌序在上一步已经洗定，发牌只是把前 N 张挪进手牌。
 *
 * ⚠ v2 没有规定"后手多发一张 / 硬币"这类先手补偿，这里也就不发明：双方同为
 *   `startingHand` 张。是否需要补偿属于数值试玩的结论（M12），
 *   真要加也只是改这一个函数，不影响相位机结构。
 */
export function dealStartingHands(state: GameState): void {
  for (const player of PLAYER_IDS) {
    for (let i = 0; i < state.rules.deck.startingHand; i += 1) {
      if (dealTop(state, player) === null) {
        break;
      }
    }
  }
}
