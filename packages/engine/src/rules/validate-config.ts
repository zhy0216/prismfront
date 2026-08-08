// RulesConfig 的**运行时校验**（DSL v2 §6 + §11.5）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 为什么 M3 才需要这个文件
// ═══════════════════════════════════════════════════════════════════════════
// M2 的引擎不读 `rules` 里的任何一项语义字段（只读 `board.slots` 与 `baseHp`），
// 配置写错了也看不出来。M3 的相位机开始**逐字段消费**它：水晶公式读 `crystals`、
// 双 pass 阈值读 `pass`、先手策略读 `initiative`、英雄部署读 `heroes.deploySchedule`。
// 一份坏配置从此不再是"参数不好看"，而是"整局对战跑成另一套规则"——
// 而 `rules` **进状态**（`state/game-state.ts`），坏配置会跟着存档与回放一起流传。
//
// 所以校验点定在 `createGame` 的**第一行**：坏配置在建局那一刻就撞墙，
// 而不是在第 7 回合某个除以 0 的地方才现形。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 决策 #3（M3 已拍板）：`playerActions` 恒关，遇到另两个值**直接抛错** ★
// ═══════════════════════════════════════════════════════════════════════════
// `RulesConfig.playerActions` 的取值域是 `play_card | move_unit | set_direction`
// （DSL v2 §6），默认只开 `["play_card"]`。M3 的决定是：**另外两个永不实现**，
// 且配置里出现它们时**抛错**，既不实现也不静默忽略。
//
// 理由（M3 任务书原文）：`direction` 在《数值基准》§1.2 是**红 primary / 绿 forbidden**。
// 玩家能免费改方向 = 红色主色身份蒸发 + 绿色禁令失效，**开了就得重写 §1.2**。
// 抛错而非静默无效，是为了让将来任何人打开这个开关时**当场撞墙**，
// 而不是跑出一局规则与设计文档不一致的对局 —— 后者要到试玩数据变形了才会被发现。
//
// 字段本身**保留在 `RulesConfig` 里不删**：删掉等于承认这个设计维度不存在，
// 而 v2 §0 把它记成了开放问题。留着字段 + 校验期拒绝 = 「记着这件事，且暂不允许」。
//
// ═══════════════════════════════════════════════════════════════════════════
// 常量为什么在这里重列一遍（架构 §2.2 禁令 1）
// ═══════════════════════════════════════════════════════════════════════════
// engine 的 `dependencies` 恒为空、`@prismfront/ir` 只在 devDependencies ⇒ engine 对 ir
// **只能是纯类型依赖**，`INITIATIVE_RULES` / `PLAYER_ACTION_KINDS` 这两个运行时数组
// 一个都不许 import。做法与 `state/entity.ts` 的 `FLAG_BITS` 完全一致：
// 在 engine 内部按 `satisfies Record<联合, ...>` 重列一份 —— **键漏一个就编译不过**，
// 于是 ir 往联合里加了新取值而这里忘了跟上时，是编译错误而不是运行时漏判。

import type { InitiativeRule, PlayerActionKind, RulesConfig } from "@prismfront/ir";

/**
 * 规则配置非法（{@link validateRulesConfig} 唯一会抛的错）。
 *
 * **不是 `IllegalReason`**：`apply()` 的 `ok:false` 说的是"玩家发了一条不该发的意图"，
 * 是对局内的常态；坏配置则是**建局方（服务端 / CLI / 测试夹具）自己的 bug**，
 * 没有任何"回一个原因码让对方重发"的语义。所以它走异常通道，且带足三样信息：
 * 哪个字段、什么非法值、为什么不允许 —— 撞上它的人不该再去翻规范才知道发生了什么。
 */
export class RulesConfigError extends Error {
  /** 出问题的字段路径，如 `"playerActions"` / `"crystals.capMax"`。 */
  readonly field: string;
  /** 该字段的非法取值，已 `JSON.stringify` 成文本（错误对象不承诺纯数据，但可读性要够）。 */
  readonly value: string;
  /** 为什么不允许。 */
  readonly why: string;

  constructor(field: string, value: unknown, why: string) {
    const shown = safeStringify(value);
    super(`规则配置非法：${field} = ${shown} —— ${why}`);
    this.name = "RulesConfigError";
    this.field = field;
    this.value = shown;
    this.why = why;
  }
}

/** 把任意值变成一段可读文本。配置来自外部，不排除塞进来循环引用之类的东西。 */
function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/**
 * 先手策略全集（DSL v2 §6）。
 *
 * `satisfies Record<InitiativeRule, true>` 提供**穷尽性**：ir 的 `InitiativeRule`
 * 新增一项而这里没跟上，本行编译即报错（同 `state/entity.ts` 的 `FLAG_BITS` 写法）。
 * 四种策略的实现在 `initiative.ts`，那里的 `switch` 也靠联合本身拿穷尽性 ——
 * 两处一起保证"新增策略不可能被漏掉"。
 */
const INITIATIVE_RULE_SET = {
  alternate: true,
  first_passer: true,
  random_each_round: true,
  fixed_first: true,
} as const satisfies Record<InitiativeRule, true>;

/**
 * 玩家 action 白名单的**准入表**（DSL v2 §6）。
 *
 * `true` = 允许出现在 `rules.playerActions` 里；`false` = **恒关**，出现即抛错。
 * 写成表而不是 `if (kind === "move_unit" || kind === "set_direction")`，
 * 是为了让"哪些开、哪些关"是一份可以一眼扫完的数据，而且 `satisfies` 会逼着
 * 将来 ir 新增取值时在这里显式表态（新增一个 kind 而不填 → 编译不过）。
 */
const PLAYER_ACTION_ALLOWED = {
  /** 打出一张牌 —— PF1 唯一开放的玩家行动（v2 §6 默认值）。 */
  play_card: true,
  /** 玩家自由移动单位。**恒关**，见文件头决策 #3。 */
  move_unit: false,
  /** 玩家自由改方向。**恒关**，见文件头决策 #3。 */
  set_direction: false,
} as const satisfies Record<PlayerActionKind, boolean>;

/** `move_unit` / `set_direction` 被拒的完整说辞，两处取值共用一段文案。 */
const PLAYER_ACTION_REFUSAL =
  "PF1 恒关此开关（M3 决策 #3）。direction 在《数值基准》§1.2 是**红 primary / 绿 forbidden**：" +
  "玩家能免费移动/改方向 = 红色的主色身份蒸发、绿色的禁令失效，开了它就必须先重写 §1.2 的配色身份。" +
  "引擎选择在配置校验期直接拒绝而不是静默忽略，是为了让打开开关的人当场撞墙，" +
  "而不是跑出一局与设计文档不一致的对局。";

/** 非负整数（格数、水晶、血量这类计数字段的共同要求）。 */
function requireCountAtLeast(field: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RulesConfigError(field, value, `必须是不小于 ${min} 的整数`);
  }
}

/**
 * 校验一份规则配置，非法即抛 {@link RulesConfigError}。
 *
 * 由 `createGame` 在建局的第一行调用，**校验通过之后 `rules` 才被写进状态**。
 *
 * ── 校验什么、不校验什么 ──────────────────────────────────────────────────
 * 校验的是**配置对象自身的自洽性**：取值在不在域内、计数是不是非负整数、
 * 互相约束的两项对不对得上（`capMax >= initial`、`Σ deploySchedule === perDeck`）。
 *
 * **不校验**「传进来的牌库是否符合 `deck.size` / `deck.maxCopies`」——
 * 那是**构筑校验**，属于 M9 的服务端（也只有那里才有完整卡表能判同名张数）。
 * 引擎必须能用一副 3 张的夹具牌库跑测试，把构筑规则塞进建局会让所有夹具都报废。
 *
 * ── ⚠ 校验的是**取值域**，不是**形状** ⚠ ─────────────────────────────────
 * TS 类型在运行时不存在，配置又可能来自数据库/配置文件/网络，所以每一项取值都在这里
 * 做**运行时**判断，且判断对**原型键**免疫（`Object.hasOwn`，见
 * {@link validatePlayerActions}）。
 *
 * 但**字段的存在性与类型不在本函数的职责内**：`rules.playerActions` 若整个缺失，
 * 这里抛的是一条裸 `TypeError`（读 `.length`）而不是 {@link RulesConfigError}，
 * `board` / `crystals` / `deck` / `heroes` 缺字段同理。形状假定由 `RulesConfig` 这个类型
 * 与**上游的 schema 校验**（M9 的服务端在把外部 JSON 变成 `RulesConfig` 那一步）保证 ——
 * 在引擎里再补一层形状守卫，等于把 schema 校验实现两遍，而两遍迟早会分叉。
 * 这里把边界写清楚，是为了让撞上裸 `TypeError` 的人知道那不是漏判，是分工。
 */
export function validateRulesConfig(rules: RulesConfig): void {
  // ── 战线 ────────────────────────────────────────────────────────────────
  // 0 格的战线会让"目标格 = 自己格 + direction"永远越界、单位无处可站。
  requireCountAtLeast("board.slots", rules.board.slots, 1);

  // ── 水晶（v2 §4.1：cap = min(initial + (round-1) * growth, capMax)）───────
  requireCountAtLeast("crystals.initial", rules.crystals.initial, 0);
  requireCountAtLeast("crystals.growth", rules.crystals.growth, 0);
  requireCountAtLeast("crystals.capMax", rules.crystals.capMax, 0);
  if (rules.crystals.capMax < rules.crystals.initial) {
    throw new RulesConfigError(
      "crystals.capMax",
      rules.crystals.capMax,
      `不能小于 crystals.initial（${rules.crystals.initial}）—— 否则第 1 回合的上限公式 ` +
        "min(initial, capMax) 会立刻把开局水晶砍到 capMax，initial 这个字段就没有意义了",
    );
  }

  // ── 双 pass 阈值（v2 §4.1）────────────────────────────────────────────────
  // 阈值 0 会让 actions 相位在第一次检查时就直接进战斗，玩家一个行动都做不了。
  requireCountAtLeast(
    "pass.combatAfterConsecutivePasses",
    rules.pass.combatAfterConsecutivePasses,
    1,
  );

  // ── 先手策略（v2 §6）─────────────────────────────────────────────────────
  // `Object.hasOwn` 而不是 `in`：见 {@link validatePlayerActions} 里那段原型键的论证。
  // 漏掉这一处的症状是 `initiative: "toString"` 通过校验，随后 `initiative.ts` 的
  // `switch` 落到没人认领的分支上 —— 一局先手规则不明的对战。
  if (!Object.hasOwn(INITIATIVE_RULE_SET, rules.initiative)) {
    throw new RulesConfigError(
      "initiative",
      rules.initiative,
      `不是已知的先手策略。取值域：${Object.keys(INITIATIVE_RULE_SET).join(" | ")}`,
    );
  }

  // ── 基地（v2.1 §11.2）────────────────────────────────────────────────────
  // 0 血基地在第一次死亡结算就归零，对局在第 1 回合还没开始就结束。
  requireCountAtLeast("baseHp", rules.baseHp, 1);

  // ── 牌库与抽牌（v2 §6）───────────────────────────────────────────────────
  requireCountAtLeast("deck.size", rules.deck.size, 0);
  requireCountAtLeast("deck.maxCopies", rules.deck.maxCopies, 1);
  requireCountAtLeast("deck.startingHand", rules.deck.startingHand, 0);
  requireCountAtLeast("deck.drawPerRound", rules.deck.drawPerRound, 0);

  // ── ★ playerActions：恒关的那两项在这里撞墙 ★ ────────────────────────────
  validatePlayerActions(rules.playerActions);

  // ── 计时（v2 §4.1：行动交替制 = 每 action 一个计时器）────────────────────
  // 引擎自己不读时间（架构 §6.1），这两项由 M9 的服务端消费；这里只保证它们不是负数，
  // 免得一份坏配置一路传到服务端才在 setTimeout 上炸。
  requireCountAtLeast("actionSeconds", rules.actionSeconds, 0);
  requireCountAtLeast("reconnectSeconds", rules.reconnectSeconds, 0);

  // ── 英雄（v2.1 §11.5）────────────────────────────────────────────────────
  validateHeroes(rules.heroes);
}

/**
 * 玩家 action 白名单校验（决策 #3 的落点）。
 *
 * 三件事：域外取值拒、恒关取值拒、空白名单拒。
 * **空白名单**同样是错：`playerActions: []` 意味着玩家在 actions 相位除了 pass 什么都做不了，
 * 双方只能一路 pass 到牌库耗尽 —— 这不是一种"更保守的配置"，而是一局跑不动的对战。
 */
function validatePlayerActions(kinds: readonly PlayerActionKind[]): void {
  if (kinds.length === 0) {
    throw new RulesConfigError(
      "playerActions",
      kinds,
      "白名单不能为空：玩家在 actions 相位将只剩 pass 可做，对局无法推进",
    );
  }
  for (const kind of kinds) {
    // ★ `Object.hasOwn` 而不是 `kind in PLAYER_ACTION_ALLOWED` ★
    // `in` 走**原型链**，于是 `"constructor"` / `"toString"` / `"valueOf"` /
    // `"hasOwnProperty"` / `"__proto__"` 这些 `Object.prototype` 上的名字全都"在表里"，
    // 一份写着 `playerActions: ["constructor"]` 的配置会静默通过、真的建出一局。
    // 本文件文件头把威胁模型写成"配置可能来自数据库/配置文件/网络"，那正是这类键的来源
    // （JSON 里 `"__proto__"` 是一个普通字符串键，谁都写得出来）。
    // `Object.hasOwn` 只认自有键，表里有几项就只放行几项。
    if (!Object.hasOwn(PLAYER_ACTION_ALLOWED, kind)) {
      throw new RulesConfigError(
        "playerActions",
        kind,
        `不是已知的玩家 action 类型。取值域：${Object.keys(PLAYER_ACTION_ALLOWED).join(" | ")}`,
      );
    }
    if (!PLAYER_ACTION_ALLOWED[kind]) {
      throw new RulesConfigError("playerActions", kind, PLAYER_ACTION_REFUSAL);
    }
  }
}

/**
 * 英雄配置校验（v2.1 §11.5）。
 *
 * `deploySchedule` 的语义按架构 §10 第 6 项定案：**索引 = 第几个回合（0-based），
 * 值 = 该回合部署几名**，各项之和须等于 `perDeck`。和对不上就意味着有英雄永远上不了场
 * （或者要部署的比卡组外带的还多）——两种都是配置错误，不是一种可用的变体。
 */
function validateHeroes(heroes: RulesConfig["heroes"]): void {
  requireCountAtLeast("heroes.perDeck", heroes.perDeck, 0);
  requireCountAtLeast("heroes.respawnDelay", heroes.respawnDelay, 0);

  let total = 0;
  for (let i = 0; i < heroes.deploySchedule.length; i += 1) {
    const count = heroes.deploySchedule[i];
    // `noUncheckedIndexedAccess`：下标恒在界内，但不用 `!` 绕过去。
    if (count === undefined) {
      continue;
    }
    requireCountAtLeast(`heroes.deploySchedule[${i}]`, count, 0);
    total += count;
  }
  if (total !== heroes.perDeck) {
    throw new RulesConfigError(
      "heroes.deploySchedule",
      heroes.deploySchedule,
      `各项之和（${total}）必须等于 heroes.perDeck（${heroes.perDeck}）：` +
        "和偏小会让一部分英雄永远上不了场，和偏大则会要求部署卡组外没有的英雄",
    );
  }
}
