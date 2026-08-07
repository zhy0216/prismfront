// `createGame(rules, decks, seed)` —— 对外的建局入口（架构 §2.3 engine 对外 API）。
//
// 与 `state/create.ts` 的 `createInitialState` 的分工：
//   createInitialState  纯摊平：卡 id 列表 → 实体表 / 区域表 / 空战线。**不消耗 RNG**。
//   createGame          外部入口：`seed` → `RngState`，并做**要消耗 RNG 的建局工作**
//                       （目前只有洗牌）。
//
// 分成两层的理由是 `state/create.ts` 文件头写的那条：建局与"推进随机流"混在一起，
// 「同 seed 同意图序列 ⇒ 同终局」就很难推理。把消耗 RNG 的部分收在本文件，
// 于是"这一局的随机流从哪里开始被推进"只有一个答案。
//
// M3 会把 mulligan / 起始手牌 / 第一个 round_start 接在这之后 —— 那些同样消耗 RNG，
// 属于相位机而不是建局，所以它们进 `apply()` 的相位推进，不进这里。

import type { BundleId, CardId, RulesConfig, ZoneName } from "@prismfront/ir";
import { createRngState, nextInt } from "../rng/index.ts";
import type { CreateInitialStateOptions, GameState, PlayerId } from "../state/index.ts";
import { createInitialState, PLAYER_IDS, zoneKey } from "../state/index.ts";

/** {@link createGame} 的可选项。 */
export interface CreateGameOptions {
  /** 卡组外的英雄卡（v2.1 §11.1），落在 `fountain` 区。语义是 M6。 */
  readonly heroes?: readonly [readonly CardId[], readonly CardId[]];
  /** 本局钉住的 bundle 标识（IR v1 §2.1 / §6.2）。M2 无卡表，默认空串。 */
  readonly bundleId?: BundleId;
  /** 先手方，同时初始化 `priority` 与 `initiative`。默认 p0。 */
  readonly firstPlayer?: PlayerId;
  /**
   * 是否洗牌，默认 `true`。
   *
   * 传 `false` 用于**需要牌序可预测**的场合：走查测试、golden replay 的夹具、
   * 以及"用固定牌序复现一个 bug"。注意关掉它会让本局**一次 RNG 都不消耗**。
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
 * **不发事件**：返回值只有状态，`state.eventLog` 为空。建局期的洗牌因此也不下发
 * `engine.random_picked` —— 那时还没有观众，而 `RANDOM_SOURCES` 里的 `"shuffle"`
 * 是留给对局中途的洗牌效果（`act.shuffle`，M4）用的。
 */
export function createGame(
  rules: RulesConfig,
  decks: readonly [readonly CardId[], readonly CardId[]],
  seed: number,
  options: CreateGameOptions = {},
): GameState {
  const init: CreateInitialStateOptions = {
    rules,
    rng: createRngState(seed),
    decks,
    bundleId: options.bundleId ?? "",
    firstPlayer: options.firstPlayer ?? 0,
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
