// @prismfront/cli —— 对局 / 回放 / 批量模拟（M8）

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type Bot, createBot } from "@prismfront/bot";
import {
  buildBundle,
  CARD_SOURCES,
  DeckValidationError,
  ENCHANTMENT_SOURCES,
  KEYWORD_CARDS,
  KEYWORD_ENCHANTMENTS,
  resolveCreatedAt,
  validateConstructedDeck,
} from "@prismfront/cards";
import {
  ACT_HANDLERS,
  apply,
  cloneState,
  controllerOf,
  createGame,
  DEFAULT_DEPS,
  DEFAULT_RULES,
  deployCountFor,
  type GameEvent,
  type GameState,
  type HandlerTable,
  type Intent,
  legalActions,
  moveHandler,
  project,
  projectEvent,
  pushAct,
  type ResolveDeps,
  suspend,
} from "@prismfront/engine";
import type {
  CardData,
  CardId,
  CardScript,
  EnchantId,
  Enchantment,
  Card as ReplayCard,
  RulesConfig,
} from "@prismfront/ir";
import { PRESET_HEROES, PRESET_NAMES, type PresetName, presetDeck } from "./pf1-presets.ts";

interface ReplayFile {
  readonly name?: string;
  readonly scenario?: string;
  readonly seed: number;
  readonly rules: RulesConfig;
  readonly decks: readonly [readonly CardId[], readonly CardId[]];
  readonly heroes?: readonly [readonly CardId[], readonly CardId[]];
  readonly intents: readonly Intent[];
  readonly messagesPerSeat?: readonly [readonly unknown[], readonly unknown[]];
  readonly expectedEvents?: readonly string[];
  readonly expectedEventCounts?: Readonly<Record<string, number>>;
  readonly expectedEventSequence?: readonly EventExpectation[];
  readonly expectedRejects?: readonly string[];
  readonly expectedPending?: boolean;
  readonly suspendCard?: CardId;
  readonly suspendOptions?: readonly CardId[];
}

interface EventExpectation {
  readonly name: string;
  readonly source?: number | null;
  readonly target?: number;
  readonly amount?: number;
  readonly cardId?: CardId | null;
  readonly slot?: number;
  readonly respawnAt?: number;
}

const GOLDEN_CARDS: readonly ReplayCard[] = [
  {
    id: "GOLDEN_HERO_RED",
    set: "golden",
    data: {
      name: { zh: "金色红英雄" },
      kind: "hero",
      colors: ["red"],
      tags: { atk: 1, health: 1 },
    },
    script: {},
  },
  {
    id: "GOLDEN_HERO_BLUE",
    set: "golden",
    data: {
      name: { zh: "金色蓝英雄" },
      kind: "hero",
      colors: ["blue"],
      tags: { atk: 1, health: 1 },
    },
    script: {},
  },
  {
    id: "GOLDEN_RED_STRIKER",
    set: "golden",
    data: {
      name: { zh: "红色出手者" },
      kind: "minion",
      cost: 0,
      colors: [],
      tags: { atk: 3, health: 2 },
    },
    script: {},
  },
  {
    id: "GOLDEN_BLUE_STRIKER",
    set: "golden",
    data: {
      name: { zh: "蓝色出手者" },
      kind: "minion",
      cost: 0,
      colors: [],
      tags: { atk: 2, health: 2 },
    },
    script: {},
  },
  {
    id: "GOLDEN_DIAGONAL",
    set: "golden",
    data: {
      name: { zh: "斜击者" },
      kind: "minion",
      cost: 0,
      colors: [],
      tags: { atk: 2, health: 2, direction: 1 },
    },
    script: {},
  },
  {
    id: "GOLDEN_DIAGONAL_NEG",
    set: "golden",
    data: {
      name: { zh: "反向斜击者" },
      kind: "minion",
      cost: 0,
      colors: [],
      tags: { atk: 2, health: 2, direction: -1 },
    },
    script: {},
  },
  {
    id: "GOLDEN_BLUE_CARD",
    set: "golden",
    data: {
      name: { zh: "受色门约束的蓝卡" },
      kind: "minion",
      cost: 0,
      colors: ["blue"],
      tags: { atk: 1, health: 1 },
    },
    script: {},
  },
  {
    id: "GOLDEN_THORNS",
    set: "golden",
    data: {
      name: { zh: "荆棘卫士" },
      kind: "minion",
      cost: 0,
      colors: [],
      tags: { atk: 1, health: 1 },
    },
    script: KEYWORD_CARDS.find((card) => card.id === "KW_RETALIATE")?.script ?? {},
  },
];

const REPLAY_CARDS: readonly ReplayCard[] = [...CARD_SOURCES, ...KEYWORD_CARDS, ...GOLDEN_CARDS];
const REPLAY_CARD_BY_ID = new Map(REPLAY_CARDS.map((card) => [card.id, card]));
const REPLAY_ENCHANTMENTS: readonly Enchantment[] = [
  ...ENCHANTMENT_SOURCES,
  ...KEYWORD_ENCHANTMENTS,
];
const REPLAY_ENCHANTMENT_BY_ID = new Map(REPLAY_ENCHANTMENTS.map((ench) => [ench.id, ench]));
const REPLAY_DEPS: ResolveDeps = {
  ...DEFAULT_DEPS,
  cards: (cardId: CardId): CardData | undefined => REPLAY_CARD_BY_ID.get(cardId)?.data,
  scripts: (cardId: CardId): CardScript | undefined => REPLAY_CARD_BY_ID.get(cardId)?.script,
  enchantments: (id: EnchantId) => REPLAY_ENCHANTMENT_BY_ID.get(id),
};

const PF1_CARDS: readonly ReplayCard[] = [...CARD_SOURCES];
const PF1_CARD_BY_ID = new Map(PF1_CARDS.map((card) => [card.id, card]));
const PF1_ENCHANTMENT_BY_ID = new Map(ENCHANTMENT_SOURCES.map((ench) => [ench.id, ench]));
const PF1_DEPS: ResolveDeps = {
  ...DEFAULT_DEPS,
  cards: (cardId: CardId): CardData | undefined => PF1_CARD_BY_ID.get(cardId)?.data,
  scripts: (cardId: CardId): CardScript | undefined => PF1_CARD_BY_ID.get(cardId)?.script,
  enchantments: (id: EnchantId) => PF1_ENCHANTMENT_BY_ID.get(id),
};

function pf1Deps(): ResolveDeps {
  return PF1_DEPS;
}

function depsForReplay(replay: ReplayFile): ResolveDeps {
  if (replay.suspendCard === undefined) {
    return REPLAY_DEPS;
  }
  const suspendCard = replay.suspendCard;
  const options = [...(replay.suspendOptions ?? [])];
  const handlers: HandlerTable = {
    ...ACT_HANDLERS,
    "act.move": (env, act, slots) => {
      const self = env.state.entities[env.ctx.self];
      if (self?.cardId === suspendCard && env.ctx.chosen === null) {
        pushAct(env.state, act, env.ctx);
        suspend(env.state, {
          player: controllerOf(self),
          kind: "discover",
          options,
          optional: false,
          deadline: null,
        });
        return;
      }
      moveHandler(env, act, slots);
    },
  };
  return { ...REPLAY_DEPS, handlers };
}

function hydrateCardFaces(
  state: GameState,
  cards: ReadonlyMap<CardId, ReplayCard> = REPLAY_CARD_BY_ID,
): void {
  for (const entity of Object.values(state.entities)) {
    const card = cards.get(entity.cardId);
    if (card === undefined) {
      continue;
    }
    const tags = card.data.tags ?? {};
    entity.base = { ...entity.base, ...tags, cost: card.data.cost ?? entity.base.cost };
    entity.tags = { ...entity.tags, ...tags, cost: card.data.cost ?? entity.tags.cost };
  }
}

const USAGE = `用法：
  bun run play --seed 1 --p0 greedy --p1 random
  bun run replay <file> --step
  bun run sim --games=1000`;

const PLAY_HEROES = [
  "PF1_HERO_RED",
  "PF1_HERO_GREEN",
  "PF1_HERO_BLUE",
] as const satisfies readonly CardId[];

const INITIATIVE_NAMES = ["alternate", "first_passer"] as const;
type SimInitiative = (typeof INITIATIVE_NAMES)[number];

function argValue(args: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) {
    return inline.slice(prefix.length);
  }
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function numberOf(args: readonly string[], name: string, fallback: number): number {
  const raw = argValue(args, name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} 必须是非负安全整数`);
  }
  return parsed;
}

function deck(prefix: string, count = 30): CardId[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);
}

function playDeck(bundle: ReturnType<typeof buildBundle>): CardId[] {
  return PLAY_HEROES.flatMap((hero) =>
    Object.values(bundle.cards)
      .filter((card) => card.data.hero === hero)
      .slice(0, DEFAULT_RULES.heroes.cardsPerHero)
      .map((card) => card.id),
  );
}

function assertInvariants(state: GameState): void {
  const seen = new Set<number>();
  for (const [key, ids] of Object.entries(state.zones)) {
    for (const id of ids) {
      if (seen.has(id)) {
        throw new Error(`实体 ${id} 同时出现在多个区域`);
      }
      seen.add(id);
      const entity = state.entities[id];
      if (entity === undefined || entity.zone !== key) {
        throw new Error(`实体 ${id} 跨区：zone=${entity?.zone ?? "missing"}, list=${key}`);
      }
    }
  }
  if (seen.size !== Object.keys(state.entities).length) {
    throw new Error("实体表中存在未归属任何区域的孤儿实体");
  }
  for (const entity of Object.values(state.entities)) {
    if (
      (entity.zone.endsWith(":board") || entity.zone.endsWith(":base")) &&
      entity.tags.health - entity.damage < 0
    ) {
      throw new Error(
        `实体 ${entity.id} 血量为负: health=${entity.tags.health} damage=${entity.damage}`,
      );
    }
  }
  const occupied = new Set<number>();
  for (const [player, row] of state.slots.entries()) {
    for (const [slot, id] of row.entries()) {
      if (id === null) {
        continue;
      }
      if (occupied.has(id)) {
        throw new Error(`槽位重复占用：${id}`);
      }
      occupied.add(id);
      const entity = state.entities[id];
      if (entity === undefined || entity.zone !== `p${player}:board` || entity.slot !== slot) {
        throw new Error(`槽位 ${player}:${slot} 与实体 ${id} 不一致`);
      }
    }
  }
  for (const entity of Object.values(state.entities)) {
    const onBoard = entity.zone.endsWith(":board");
    if (onBoard !== occupied.has(entity.id)) {
      throw new Error(`实体 ${entity.id} 与槽位表不一致`);
    }
    if (!onBoard && entity.slot !== null) {
      throw new Error(`非战线实体 ${entity.id} 带有槽位 ${entity.slot}`);
    }
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function applyChecked(
  state: GameState,
  intent: Intent,
  deps: ResolveDeps,
): { state: GameState; events: GameEvent[] } | null {
  const before = JSON.stringify(state);
  const cloneResult = apply(cloneState(state), intent, deps);
  const result = apply(state, intent, deps);
  if (result.ok !== cloneResult.ok) {
    throw new Error("clone(state) 与原状态对同一 intent 的接受结果不一致");
  }
  if (!result.ok || !cloneResult.ok) {
    if (JSON.stringify(state) !== before) {
      throw new Error("非法 intent 改变了原状态");
    }
    return null;
  }
  if (!sameJson(result.state, cloneResult.state) || !sameJson(result.events, cloneResult.events)) {
    throw new Error("clone(state) 结算结果不一致");
  }
  assertInvariants(result.state);
  return { state: result.state, events: result.events };
}

function prepareState(options: RunBotOptions): GameState {
  const rules = options.rules ?? DEFAULT_RULES;
  const decks = options.decks ?? [deck("A", rules.deck.size), deck("B", rules.deck.size)];
  const createOptions = {
    shuffle: false,
    firstPlayer: 0,
    ...(options.heroes === undefined ? {} : { heroes: options.heroes }),
  } as const;
  const state = createGame(rules, decks, options.seed, createOptions);
  hydrateCardFaces(state, PF1_CARD_BY_ID);
  assertInvariants(state);
  return state;
}

function automaticIntent(state: GameState): Intent {
  if (state.pendingInput !== null) {
    return {
      t: "respond",
      player: state.pendingInput.player,
      chosen: state.pendingInput.options[0] ?? null,
    };
  }
  if (state.phase === "mulligan") {
    return { t: "mulligan", player: 0, toss: [[], []] };
  }
  if (state.phase === "deploy") {
    const picks = ([0, 1] as const).map((player) => {
      // 名额走 deployCountFor（含复活回场），与 checkDeploy 同一口径——
      // 只算首次排期会在复活回合生成空 picks 被拒，对局卡死在 deploy。
      const count = deployCountFor(state, player);
      const fountain = state.zones[`p${player}:fountain`];
      const heroes = fountain.filter((id) => {
        const entity = state.entities[id];
        return entity !== undefined && (entity.respawnAt ?? 0) <= state.round;
      });
      const slots = state.slots[player].flatMap((id, slot) => (id === null ? [slot] : []));
      return heroes.slice(0, Math.min(count, slots.length)).map((hero, index) => ({
        hero,
        slot: slots[index] ?? 0,
      }));
    });
    return { t: "deploy", player: 0, picks: [picks[0] ?? [], picks[1] ?? []] };
  }
  throw new Error(`无法为相位 ${state.phase} 自动生成意图`);
}

export interface RunBotOptions {
  readonly seed: number;
  readonly rules?: RulesConfig;
  readonly bots?: readonly [Bot, Bot];
  readonly maxSteps?: number;
  readonly print?: boolean;
  readonly decks?: readonly [readonly CardId[], readonly CardId[]];
  readonly heroes?: readonly [readonly CardId[], readonly CardId[]];
  readonly deps?: ResolveDeps;
  readonly onStep?: (state: GameState, events: readonly GameEvent[]) => void;
}

export function runBotGame(options: RunBotOptions): GameState {
  let state = prepareState(options);
  const bots = options.bots ?? [
    createBot("greedy", options.seed),
    createBot("random", options.seed ^ 0xa5a5a5a5),
  ];
  const maxSteps = options.maxSteps ?? 512;
  for (let step = 0; state.winner === null && step < maxSteps; step += 1) {
    const intent =
      state.phase === "actions"
        ? bots[state.priority].choose(
            project(state, state.priority),
            legalActions(state, state.priority, options.deps),
          )
        : automaticIntent(state);
    if (options.print) {
      console.log(`[${step}] ${JSON.stringify(intent)}`);
    }
    const applied = applyChecked(state, intent, options.deps ?? DEFAULT_DEPS);
    if (applied === null) {
      if (options.print) {
        console.log(`  rejected`);
      }
      continue;
    }
    state = applied.state;
    options.onStep?.(state, applied.events);
    if (options.print) {
      for (const event of applied.events) {
        console.log(`  ${JSON.stringify(event)}`);
      }
      console.log(
        `  state=${JSON.stringify({ phase: state.phase, round: state.round, priority: state.priority, winner: state.winner })}`,
      );
    }
  }
  if (state.winner === null) {
    throw new Error(`对局超过 ${maxSteps} 步仍未结束`);
  }
  assertInvariants(state);
  return state;
}

async function play(args: readonly string[]): Promise<number> {
  const seed = numberOf(args, "--seed", 1);
  const p0 = (argValue(args, "--p0") ?? "greedy") as "random" | "greedy";
  const p1 = (argValue(args, "--p1") ?? "random") as "random" | "greedy";
  if (!["random", "greedy"].includes(p0) || !["random", "greedy"].includes(p1)) {
    console.error(USAGE);
    return 2;
  }
  const bundle = buildBundle({
    cards: CARD_SOURCES,
    enchantments: ENCHANTMENT_SOURCES,
    createdAt: resolveCreatedAt("0"),
  });
  const constructed = playDeck(bundle);
  const decks: readonly [readonly CardId[], readonly CardId[]] = [constructed, constructed];
  for (const player of [0, 1] as const) {
    try {
      validateConstructedDeck(bundle, DEFAULT_RULES, PLAY_HEROES, decks[player]);
    } catch (error) {
      if (error instanceof DeckValidationError) {
        console.error(`玩家 ${player + 1} 组牌校验失败：${error.message}`);
        return 1;
      }
      throw error;
    }
  }
  const state = runBotGame({
    seed,
    decks,
    heroes: [PLAY_HEROES, PLAY_HEROES],
    bots: [createBot(p0, seed), createBot(p1, seed ^ 0x51ed270b)],
    deps: pf1Deps(),
    print: true,
  });
  console.log(`over=${state.winner ?? "draw"} round=${state.round} seq=${state.seq}`);
  return 0;
}

async function readReplay(path: string): Promise<ReplayFile> {
  const replay = (await Bun.file(path).json()) as ReplayFile;
  if (
    !replay ||
    typeof replay.seed !== "number" ||
    replay.rules === undefined ||
    replay.decks === undefined
  ) {
    throw new Error("回放文件必须包含 seed、完整 rules 快照与 decks");
  }
  return replay;
}

function eventMatches(event: GameEvent | undefined, expected: EventExpectation): boolean {
  if (event === undefined) {
    return false;
  }
  const actual = event as unknown as Record<string, unknown>;
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

async function replay(args: readonly string[]): Promise<number> {
  const path = args.find((arg) => !arg.startsWith("--"));
  if (path === undefined) {
    console.error(USAGE);
    return 2;
  }
  const replayFile = await readReplay(path);
  const createOptions = {
    shuffle: false,
    firstPlayer: 0,
    ...(replayFile.heroes === undefined ? {} : { heroes: replayFile.heroes }),
  } as const;
  let state = createGame(replayFile.rules, replayFile.decks, replayFile.seed, createOptions);
  hydrateCardFaces(state);
  const deps = depsForReplay(replayFile);
  const step = args.includes("--step");
  const writeMessages = args.includes("--write-messages");
  const messagesPerSeat: [unknown[], unknown[]] = [[], []];
  for (const seat of [0, 1] as const) {
    messagesPerSeat[seat].push(
      { t: "seat", version: 1, seq: state.seq, playerId: `replay-${seat}`, seat },
      {
        t: "snapshot",
        version: 1,
        seq: state.seq,
        playerId: `replay-${seat}`,
        view: project(state, seat),
        legal: legalActions(state, seat, deps),
      },
    );
  }
  const events: GameEvent[] = [];
  const eventNames: string[] = [];
  const rejected: string[] = [];
  let sawPending = false;
  for (let index = 0; index < replayFile.intents.length; index += 1) {
    const intent = replayFile.intents[index];
    if (intent === undefined) {
      continue;
    }
    const result = apply(state, intent, deps);
    if (!result.ok) {
      rejected.push(result.code);
      messagesPerSeat[intent.player].push({
        t: "rejected",
        version: 1,
        seq: state.seq,
        code: result.code,
      });
      console.log(`[${index}] rejected=${result.code}`);
      continue;
    }
    state = result.state;
    sawPending ||= state.pendingInput !== null;
    console.log(`[${index}] ${JSON.stringify(intent)}`);
    for (const event of result.events) {
      events.push(event);
      eventNames.push(event.name);
      console.log(`  ${JSON.stringify(event)}`);
    }
    for (const seat of [0, 1] as const) {
      messagesPerSeat[seat].push(
        {
          t: "events",
          version: 1,
          seq: state.seq,
          events: result.events
            .map((event) => projectEvent(state, event, seat))
            .filter((event): event is NonNullable<typeof event> => event !== null),
        },
        {
          t: "snapshot",
          version: 1,
          seq: state.seq,
          playerId: `replay-${seat}`,
          view: project(state, seat),
          legal: legalActions(state, seat, deps),
        },
      );
      const request = project(state, seat).pendingInput;
      if (request?.player === seat) {
        messagesPerSeat[seat].push({
          t: "prompt",
          version: 1,
          seq: state.seq,
          request,
        });
      }
    }
    if (step) {
      console.log(
        `  phase=${state.phase} round=${state.round} seq=${state.seq} pending=${
          state.pendingInput === null ? "none" : JSON.stringify(state.pendingInput)
        }`,
      );
    }
  }
  for (const expected of replayFile.expectedEvents ?? []) {
    if (!eventNames.includes(expected)) {
      throw new Error(`golden replay 缺少期望事件：${expected}`);
    }
  }
  for (const [name, expectedCount] of Object.entries(replayFile.expectedEventCounts ?? {})) {
    const actualCount = eventNames.filter((eventName) => eventName === name).length;
    if (actualCount !== expectedCount) {
      throw new Error(
        `golden replay 事件数不匹配：${name} 实际=${actualCount} 期望=${expectedCount}`,
      );
    }
  }
  let eventCursor = 0;
  for (const expected of replayFile.expectedEventSequence ?? []) {
    while (eventCursor < events.length && !eventMatches(events[eventCursor], expected)) {
      eventCursor += 1;
    }
    if (eventCursor >= events.length) {
      throw new Error(`golden replay 缺少有序事件：${JSON.stringify(expected)}`);
    }
    eventCursor += 1;
  }
  const expectedRejects = [...(replayFile.expectedRejects ?? [])].sort();
  if (JSON.stringify([...rejected].sort()) !== JSON.stringify(expectedRejects)) {
    throw new Error(
      `golden replay 拒绝不匹配：实际=${JSON.stringify(rejected)} 期望=${JSON.stringify(expectedRejects)}`,
    );
  }
  if (replayFile.expectedPending === true && !sawPending) {
    throw new Error("golden replay 未命中期望的挂起点");
  }
  if (writeMessages) {
    const persisted = { ...replayFile, messagesPerSeat };
    await Bun.write(path, `${JSON.stringify(persisted, null, 2)}\n`);
    console.log(
      `messages=${messagesPerSeat[0].length}/${messagesPerSeat[1].length} written=${path}`,
    );
  }
  console.log(`over=${state.winner ?? "draw"} round=${state.round} seq=${state.seq}`);
  return 0;
}

async function sim(args: readonly string[]): Promise<number> {
  const games = numberOf(args, "--games", Number(process.env.SIM_GAMES ?? 1_000));
  const maxSteps = numberOf(args, "--max-steps", 512);
  const initiative = argValue(args, "--initiative") ?? "alternate";
  if (!INITIATIVE_NAMES.includes(initiative as SimInitiative)) {
    throw new Error(`--initiative 取值必须是 ${INITIATIVE_NAMES.join(" | ")}`);
  }
  const preset = argValue(args, "--preset") ?? "concentrated";
  const presetAll = args.includes("--preset-all") || argValue(args, "--presets") === "all";
  if (preset !== "concentrated" && preset !== "spread" && preset !== "mixed") {
    throw new Error(`--preset 取值必须是 ${PRESET_NAMES.join(" | ")}`);
  }
  const bundle = buildBundle({
    cards: CARD_SOURCES,
    enchantments: ENCHANTMENT_SOURCES,
    createdAt: resolveCreatedAt("0"),
  });
  const presets = PRESET_NAMES.map((name) => [name, presetDeck(name)] as const);
  for (const [name, constructed] of presets) {
    try {
      validateConstructedDeck(bundle, DEFAULT_RULES, PRESET_HEROES[0], constructed);
    } catch (error) {
      if (error instanceof DeckValidationError)
        throw new Error(`预构筑 ${name} 校验失败：${error.message}`);
      throw error;
    }
  }

  const runMatchup = (p0: PresetName, p1: PresetName, matchupGames: number) => {
    const decks: readonly [readonly CardId[], readonly CardId[]] = [presetDeck(p0), presetDeck(p1)];
    const wins: Record<string, number> = { "0": 0, "1": 0, draw: 0 };
    const rounds: number[] = [];
    let incompleteGames = 0;
    const perCard = new Map<
      CardId,
      { played: number; drawn: number; added: number; games: number; wins: number }
    >();
    for (let index = 0; index < matchupGames; index += 1) {
      const seen = new Map<CardId, Set<0 | 1>>();
      let firstStep = true;
      let state: GameState;
      try {
        state = runBotGame({
          seed: index + 1,
          rules: { ...DEFAULT_RULES, initiative: initiative as SimInitiative },
          decks,
          heroes: PRESET_HEROES,
          deps: pf1Deps(),
          maxSteps,
          onStep: (nextState, events) => {
            if (firstStep) {
              firstStep = false;
              for (const player of [0, 1] as const) {
                for (const id of nextState.zones[`p${player}:hand`]) {
                  const entity = nextState.entities[id];
                  if (entity !== undefined) {
                    const players = seen.get(entity.cardId) ?? new Set<0 | 1>();
                    players.add(player);
                    seen.set(entity.cardId, players);
                  }
                }
              }
            }
            for (const event of events) {
              if (
                event.name !== "card_played" &&
                event.name !== "card_drawn" &&
                event.name !== "card_added_to_hand"
              ) {
                continue;
              }
              const entity = nextState.entities[event.target];
              if (entity === undefined || (entity.owner !== 0 && entity.owner !== 1)) {
                continue;
              }
              const stats = perCard.get(event.cardId) ?? {
                played: 0,
                drawn: 0,
                added: 0,
                games: 0,
                wins: 0,
              };
              if (event.name === "card_played") stats.played += 1;
              if (event.name === "card_drawn") stats.drawn += 1;
              if (event.name === "card_added_to_hand") stats.added += 1;
              perCard.set(event.cardId, stats);
              const players = seen.get(event.cardId) ?? new Set<0 | 1>();
              players.add(entity.owner);
              seen.set(event.cardId, players);
            }
          },
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("对局超过")) {
          incompleteGames += 1;
          continue;
        }
        throw error;
      }
      wins[String(state.winner ?? "draw")] = (wins[String(state.winner ?? "draw")] ?? 0) + 1;
      rounds.push(state.round);
      for (const [cardId, players] of seen) {
        const stats = perCard.get(cardId) ?? { played: 0, drawn: 0, added: 0, games: 0, wins: 0 };
        stats.games += players.size;
        stats.wins += [...players].filter((player) => state.winner === player).length;
        perCard.set(cardId, stats);
      }
    }
    rounds.sort((a, b) => a - b);
    const p90Round = rounds.length === 0 ? 0 : (rounds[Math.ceil(rounds.length * 0.9) - 1] ?? 0);
    const cardIds = new Set([...decks[0], ...decks[1]]);
    const cardReport = Object.fromEntries(
      [...cardIds].map((cardId) => {
        const stats = perCard.get(cardId) ?? { played: 0, drawn: 0, added: 0, games: 0, wins: 0 };
        const copies = [
          decks[0].filter((id) => id === cardId).length,
          decks[1].filter((id) => id === cardId).length,
        ] as const;
        return [
          cardId,
          {
            ...stats,
            copies,
            pickrate: rounds.length === 0 ? 0 : stats.games / (rounds.length * 2),
            winrate: stats.games === 0 ? 0 : stats.wins / stats.games,
          },
        ];
      }),
    );
    const result = {
      p0: p0,
      p1: p1,
      games: matchupGames,
      completedGames: rounds.length,
      incompleteGames,
      wins,
      avgRound:
        rounds.length === 0 ? 0 : rounds.reduce((sum, round) => sum + round, 0) / rounds.length,
      p50Round: rounds[Math.ceil(rounds.length * 0.5) - 1] ?? 0,
      p90Round,
      perCard: cardReport,
    };
    console.log(
      `${p0} vs ${p1}：胜率 0/1/平 ${wins["0"] ?? 0}/${wins["1"] ?? 0}/${wins.draw ?? 0}，平均局长 ${result.avgRound}，p50=${result.p50Round}，p90=${result.p90Round}`,
    );
    return result;
  };

  const matchupNames: readonly (readonly [PresetName, PresetName])[] = [
    ["concentrated", "concentrated"],
    ["spread", "spread"],
    ["mixed", "mixed"],
    ["concentrated", "spread"],
    ["concentrated", "mixed"],
    ["spread", "mixed"],
  ];
  const matchupGames = presetAll ? Math.max(1, Math.floor(games / 6)) : games;
  const matchupReports = (
    presetAll ? matchupNames : [[preset as PresetName, preset as PresetName] as const]
  ).map(([p0, p1]) => runMatchup(p0, p1, matchupGames));
  const first = matchupReports[0];
  const report = {
    games,
    completedGames: first?.completedGames ?? 0,
    maxSteps,
    incompleteGames: first?.incompleteGames ?? 0,
    incompleteReason:
      (first?.incompleteGames ?? 0) === 0
        ? null
        : `有 ${first?.incompleteGames ?? 0} 局在 ${maxSteps} 步内未结束，未静默提高上限`,
    initiative,
    wins: first?.wins ?? { "0": 0, "1": 0, draw: 0 },
    avgRound: first?.avgRound ?? 0,
    p50Round: first?.p50Round ?? 0,
    p90Round: first?.p90Round ?? 0,
    perCard: first?.perCard ?? {},
    ...(presetAll ? { matchups: matchupReports } : {}),
  };
  const reportDir = resolve(import.meta.dir, "../reports/sim");
  await mkdir(reportDir, { recursive: true });
  await Bun.write(resolve(reportDir, "latest.json"), JSON.stringify(report, null, 2));
  console.log(
    `模拟 ${games} 局（${preset}${presetAll ? "，全部预构筑组合" : ""}），平均局长 ${report.avgRound}，p50=${report.p50Round}，p90=${report.p90Round}`,
  );
  console.log(JSON.stringify(report));
  return 0;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case "play":
        return await play(rest);
      case "replay":
        return await replay(rest);
      case "sim":
        return await sim(rest);
      default:
        console.error(USAGE);
        return 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
