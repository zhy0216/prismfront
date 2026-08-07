// GameEvent —— 引擎的输出形态。
//
// 来源：《框架设计》§3.3（输出是事件流，不是状态 diff）、§5.2（命名约定）、§4.3（RNG）；
//       《DSL v2》§5（事件表 v2）、§11.3（英雄事件）；IR v1 §4.1（trigger 的 on/filter）。
//
// ── 为什么是事件流而不是状态 diff（框架 §3.3）────────────────────────────────
// 前端要的是「12 号打了 20 号 3 点 → 20 号死了 → 20 号的亡语召唤了 41 号到 2 号格」，
// 不是「棋盘从 A 变成了 B」。状态 diff 无法驱动动画——它丢掉了**因果与顺序**，
// 而卡牌游戏的表现层几乎全部信息量都在因果与顺序里（Hearthstone 的 PowerHistory 同形态）。
// 由此推出 GameEvent 的三条形状要求：
//   1. **一个事件 = 一件已经发生的事**，粒度对齐一次可播放的动画，不合并、不批处理。
//   2. **自带因果**：`source`（谁干的）/ `target`（对谁）/ `player`（哪个玩家），
//      名字与 IR 的 `EVENT_ENTITY_FIELDS` 逐字对齐（见下方「三个实体字段」）。
//   3. **顺序即数组顺序**，不另设时间戳（§6.1 引擎不读时间）。
//
// ── 事件名词汇表直接复用 IR 的 EventName ─────────────────────────────────────
// `EventName`（25 个）是 trigger 的 `on` 取值域，已由 packages/ir 权威定义。
// engine **不另抄一份**——抄一份就会出现「引擎发的名字触发器监听不到」这类
// 只能靠人肉对表发现的 bug。这里只做一件事：给每个名字配一份负载类型，
// 并用文件末尾的编译期断言把「负载表的键集 ≡ EventName」钉死。
// IR 加了新事件名而这里忘了配负载 → 编译不过。
//
// ── §5.2 命名约定：祈使式 = 动作，过去式 = 事件 ──────────────────────────────
// `act.hit` / `act.strike` / `act.draw` 是动作；`damaged` / `struck` / `card_drawn` 是事件。
// 引擎内部**只发过去式**。唯一的自造事件 `engine.random_picked` 也遵守这条
// （框架 §4.3 原文写作 `RANDOM_PICK`，此处按 §5.2 改为过去式并加 `engine.` 前缀）。
//
// ── 纯数据（框架 §3.1 + §13 坑 3）★ ─────────────────────────────────────────
// GameEvent 与 GameState 受同一条铁律约束，且因为事件日志就放在 state 里（见 log.ts），
// 状态的序列化往返测试（架构 §6.1 第二条）会**顺带**把这里也测掉。三条硬规矩：
//   1. **实体一律用 id 引用**，不许放 EntityData 对象。
//   2. **不许出现可选字段**：一律「必填 + `| null`」。
//      理由是 JSON 往返——`JSON.stringify({a: undefined})` 会**丢键**，
//      于是 `revive(ev)` 与 `ev` 不再逐字相等，往返测试就失去了探针作用。
//      `null` 能原样往返，`undefined` 不能，所以这里只用 `null` 表示「没有」。
//   3. 只用 string / 有限 number / boolean / null / 纯对象 / 数组。
//      不许函数、class 实例、Map、Set、Symbol、NaN、Infinity。
//
// ── 三个实体字段的语义（IR 的 EVENT_ENTITY_FIELDS = source | target | player）──
// `sel.event(field)` 与 `trigger.filter` 的键都只能取这三个名字，所以负载里的实体字段
// **必须**叫这三个名字之一，语义统一如下，不许各事件各自发明：
//   - `target` = 这件事的**主体/承受方**：被打的、被抽的、被打出的、被召唤的、死掉的
//   - `source` = **造成这件事的实体**（施动者），没有施动者时为 `null`
//   - `player` = **相关玩家实体**（`sel.controller` / `sel.opponent` 的取值域）
// 对照 IR v1 §4.1 的两个例子即可验证这套约定：
//   荆棘卫士 `filter:{target: sel.self}` = 「我被出手命中时」；
//   Cleave   `filter:{source: sel.self}` = 「我命中单位时」。
// ⚠ `card_played.target` 是**被打出的那张牌**，不是这张牌指定的目标——
//   牌自己的目标在结算上下文 `ctx.target` 里，不进事件负载。
//
// ── 本文件明确不做的 ────────────────────────────────────────────────────────
// - **不做投影**：`projectEvent(state, ev, viewer)` 是 M7。GameEvent 携带**完整真相**
//   （含隐藏牌的 `cardId`），按视角抹除是投影层的事（框架 §6）。
//   engine 内部传的一律是这份完整事件，发给客户端的是投影后的 `ClientEvent`。
// - **不带 seq**：`seq` 是**协议消息**的去重序号（框架 §3.1 的 `state.seq`、§7.3
//   「每条消息带 seq」），由服务端逐条消息递增，不是逐个事件递增。
//   事件之间的顺序已经由数组下标表达，再塞一个 seq 只会出现两个真相源。

import type {
  CardId,
  EnchantId,
  EntityId,
  EventEntityField,
  EventName,
  PlayerActionKind,
} from "@prismfront/ir";

// ═══════════════════════════════════════════════════════════════════════════
// 规则事件：25 个 EventName 各配一份负载
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 规则事件——触发器能监听到的那一类（`trigger.on` 的取值域 = IR 的 {@link EventName}）。
 *
 * 分组与 DSL v2 §5 的事件表逐行对应。
 * 每个成员都是 `{ name } & 负载`，按 `name` 判别的可辨识联合，
 * M5 的触发器匹配与 M4 的 `sel.event` 都从这里获得穷尽检查。
 */
export type RuleEvent =
  // ── 回合与资源（v2 §4.1 回合状态机）──────────────────────────────────────
  /** 回合开始。`round` 从 1 起（v2 §4.1 `round_start`）。 */
  | { name: "round_began"; round: number }
  /** 回合结束。`end_of_round` 附魔在此之后剥离（v2 §4.1 `round_end`）。 */
  | { name: "round_ended"; round: number }
  /**
   * 获得水晶。回合开始的回满与 `act.gain_crystal` 都发它。
   * v2 §5 没有为水晶上限单设事件，`act.gain_crystal_cap` 的表达留给 M3 定夺。
   */
  | { name: "crystal_gained"; player: EntityId; amount: number }

  // ── 行动阶段（v2 §4.1）─────────────────────────────────────────────────
  /**
   * 玩家做了一个行动。`kind` 取自 `RulesConfig.playerActions`（v2 §6），
   * 默认只开放 `"play_card"`。此事件发出即意味着 `consecutivePasses` 归零。
   */
  | { name: "action_taken"; player: EntityId; kind: PlayerActionKind }
  /**
   * 玩家过牌。连续两次（双方各一次）进入战斗阶段（v2 §4.1）。
   * pass **不锁定**：对手随后行动会把计数清零。
   */
  | { name: "player_passed"; player: EntityId }

  // ── 战斗阶段（v2 §4.2）─────────────────────────────────────────────────
  /** 战斗开始。此时结算栈会完全清空，之后才做出手快照（v2 §4.2 第 1 步）。 */
  | { name: "combat_began"; round: number }
  /**
   * 出手这件事本身。负载 `{source, target, amount}` 由 v2 §5 明文规定。
   *
   * 战斗阶段的每一次出手与 `act.strike` 都发它；`amount` 是**快照时刻**的 atk。
   * ⚠ 溅射 / 反伤走 `act.hit`，**不发** `struck` —— 这是「反伤不会互相触发成
   * 无限连锁」的全部机制（v2 §8.7），别顺手在 `act.hit` 里补发。
   */
  | { name: "struck"; source: EntityId; target: EntityId; amount: number }
  /** 战斗结束。`end_of_combat` 附魔在此之后剥离（v2 §4.2 第 5 步）。 */
  | { name: "combat_ended"; round: number }

  // ── 牌（IR v1 §4.1 + v2 §5）────────────────────────────────────────────
  /**
   * 打出一张牌。`target` 是**牌实体**本身，`cardId` 是它翻开后的身份。
   * 牌自己指定的目标不在这里（见文件头「三个实体字段」的 ⚠）。
   */
  | { name: "card_played"; player: EntityId; target: EntityId; cardId: CardId }
  /** 抽到一张牌。牌库抽空的疲劳（v2 §6 `deck.fatigue`）不发此事件。 */
  | { name: "card_drawn"; player: EntityId; target: EntityId; cardId: CardId }
  /** 弃掉一张牌。 */
  | { name: "card_discarded"; player: EntityId; target: EntityId; cardId: CardId }
  /** 效果生成到手牌（`act.give`）。与 `card_drawn` 分开，「抽到」与「获得」语义不同。 */
  | { name: "card_added_to_hand"; player: EntityId; target: EntityId; cardId: CardId }

  // ── 场面（v2 §5，v1 的 minion_* 已改名）──────────────────────────────────
  /**
   * 单位上场。`slot` 是 0..8 的格位（v2 §2.1）。
   * `source` 是召唤者（亡语召唤时是死掉的那个），没有则 `null`。
   * 英雄上场发 {@link RuleEvent} 的 `hero_deployed` 而非本事件（v2.1 §11.3）。
   */
  | {
      name: "unit_summoned";
      player: EntityId;
      source: EntityId | null;
      target: EntityId;
      cardId: CardId;
      slot: number;
    }
  /**
   * 单位阵亡。`slot` 是它死时所在的格位，供客户端定位动画。
   *
   * **没有 `source` 字段**：死亡是独立的批量结算阶段（框架 §4.1 时序规则 3），
   * 一个单位可能同时被多次伤害压死，「凶手」在那个阶段已不可靠归因。
   * 需要「谁杀的」请挂 `damaged` 的触发器。
   *
   * 英雄阵亡发 `hero_died` 而**不发**本事件（v2.1 §11.3，触发器需明确区分）。
   */
  | { name: "unit_died"; target: EntityId; slot: number }
  /** 位移。负载 `{target, fromSlot, toSlot}` 由 v2 §5 明文规定；move_to/shift/swap 都发。 */
  | { name: "unit_moved"; target: EntityId; fromSlot: number; toSlot: number }
  /**
   * 生效方向改变。direction 是 Tag 而非新机制（v2 §2.3），
   * 所以附魔/光环/沉默改到它时同样发这个事件。方向不限幅，可为负。
   */
  | { name: "direction_changed"; target: EntityId; from: number; to: number }

  // ── 效果（IR v1 §4.1 + v2 §5）──────────────────────────────────────────
  /**
   * 伤害结果。打基地不单设事件——`target` 是基地实体即是（v2 §5 / §4.3）。
   * `source` 为 `null` 表示无施动实体的伤害（疲劳、规则伤害）。
   */
  | { name: "damaged"; source: EntityId | null; target: EntityId; amount: number }
  /** 治疗结果。`amount` 是**实际**回复量（溢出部分不计）。 */
  | { name: "healed"; source: EntityId | null; target: EntityId; amount: number }
  /**
   * 属性被修改。`ench` 指向 bundle 的附魔 id；
   * `act.set_tag` / `act.mod_tag` 这类不经附魔的直改发 `ench: null`。
   */
  | { name: "buffed"; source: EntityId | null; target: EntityId; ench: EnchantId | null }
  /** 被沉默：剥离附魔并复位 tag——**包括 direction**（v2 §2.3 的免费收益）。 */
  | { name: "silenced"; source: EntityId | null; target: EntityId }
  /** 变形为另一张卡。实体 id **保持不变**，只换身份，否则客户端会当成两个东西。 */
  | { name: "transformed"; target: EntityId; fromCardId: CardId; toCardId: CardId }

  // ── 英雄（v2.1 §11.3）───────────────────────────────────────────────────
  /** 英雄部署到格位。r1 部署 2 名、r2 部署第 3 名，复活重部署走同一流程。 */
  | { name: "hero_deployed"; player: EntityId; target: EntityId; cardId: CardId; slot: number }
  /**
   * 英雄阵亡：移入 `"fountain"`（复燃泉），`respawnAt` 回合的 deploy 阶段重新上场。
   * 与 `unit_died` 一样不带 `source`，理由同上。
   */
  | { name: "hero_died"; target: EntityId; slot: number; respawnAt: number }

  // ── 保留（v2 §5 原文：玩法可能用不上，PF1 无奥秘卡、无英雄技能）────────────
  /** 奥秘揭示。PF1 不产出此事件，保留以对齐 v2 §5 词汇表。 */
  | { name: "secret_revealed"; player: EntityId; target: EntityId; cardId: CardId }
  /** 英雄技能使用。PF1 不产出此事件，保留以对齐 v2 §5 词汇表。 */
  | { name: "hero_power_used"; player: EntityId; source: EntityId; target: EntityId | null };

// ═══════════════════════════════════════════════════════════════════════════
// 引擎事件：不属于触发器词汇表的那一类
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 引擎事件名的前缀。
 *
 * 为什么要前缀：引擎需要下发一些**不属于 `EventName`** 的事件（目前只有随机结果）。
 * 它们不能进 `EventName`——那是 trigger `on` 的取值域，加进去等于允许卡牌
 * 「监听随机数」。用一个 IR 词汇表里不可能出现的前缀（`EventName` 全是无点的
 * snake_case）把两个命名空间物理隔开，于是：
 *   - `isRuleEvent` 可以只靠前缀判定，不需要在 engine 里复制一份 25 个名字的表；
 *   - `on: "engine.random_picked"` 在 IR 侧天然是校验错误，不需要额外规则。
 * 文件末尾有编译期断言保证这个前缀与 `EventName` 不相交。
 */
export const ENGINE_EVENT_PREFIX = "engine.";

/** {@link ENGINE_EVENT_PREFIX} 的字面量类型，供末尾的不相交断言使用。 */
export type EngineEventPrefix = typeof ENGINE_EVENT_PREFIX;

/**
 * 消耗 RNG 的来源（框架 §4.3「所有随机来源必须走 `nextInt`」）。
 *
 * 前四个是 IR v1 §5.4 点名的推进 RNG 的节点（`slot.random_empty` 由 v2 §3.1 补入），
 * 后两个是 DSL 之外的引擎自身消耗点。写进事件是为了让回放能一眼看出
 * 「这一步随机是谁要的」——排 RNG 错位 bug 时这是唯一有用的信息。
 *
 * ⚠ 光环重算与死亡结算**不得消耗 RNG**（IR v1 §5.4 规则 5），故不在此列。
 */
export const RANDOM_SOURCES = [
  "sel.random",
  "num.random",
  "card.random",
  "slot.random_empty",
  "shuffle",
  "initiative",
] as const;

export type RandomSource = (typeof RANDOM_SOURCES)[number];

/**
 * 引擎事件——**触发器监听不到**的那一类。
 *
 * 目前只有一个成员。框架 §4.3 要求「随机结果作为事件下发
 * （`RANDOM_PICK {result: 33}`），客户端只是被告知」，理由是种子永不下发客户端，
 * 客户端无法自行复现随机，只能被告知结果。
 *
 * `result` 是 `nextInt(state, max)` 的**原始产出**，落在 `[0, max)`。
 * 「这个数最后选中了哪个实体/哪张卡」由紧随其后的规则事件表达
 * （`unit_summoned` / `card_added_to_hand` …）——M4 的求值器负责配对，
 * M2 只把形状留好。
 */
export type EngineEvent = {
  name: "engine.random_picked";
  origin: RandomSource;
  /** `nextInt` 的排他上界。`max <= 0` 不应产生事件（没得可选）。 */
  max: number;
  /** 落在 `[0, max)` 的整数。 */
  result: number;
};

// ═══════════════════════════════════════════════════════════════════════════
// 对外的 GameEvent 与取值辅助
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 引擎的输出单元（框架 §3.2 `ApplyResult.events`）。
 *
 * `GameEvent = RuleEvent | EngineEvent`：前者是触发器词汇表（IR 的 `EventName`），
 * 后者是引擎自己的旁白。两者都是纯数据、可 JSON 往返、实体一律用 id 引用。
 */
export type GameEvent = RuleEvent | EngineEvent;

/** 全部事件名。等于 IR 的 `EventName` 加上 `engine.` 前缀的那些。 */
export type GameEventName = GameEvent["name"];

/** 按名字取出单个事件类型，例：`GameEventOf<"damaged">`。 */
export type GameEventOf<N extends GameEventName = GameEventName> = Extract<GameEvent, { name: N }>;

/** 按名字取出单个事件的负载（去掉 `name`），例：`EventPayloadOf<"struck">`。 */
export type EventPayloadOf<N extends GameEventName = GameEventName> = Omit<GameEventOf<N>, "name">;

/**
 * 是不是触发器能监听的规则事件。
 *
 * 判定只看 {@link ENGINE_EVENT_PREFIX}——见那里的说明：
 * 这样就不必在 engine 里复制一份 `EventName` 的 25 个字符串。
 */
export function isRuleEvent(event: GameEvent): event is RuleEvent {
  return !event.name.startsWith(ENGINE_EVENT_PREFIX);
}

/** {@link isRuleEvent} 的反面。 */
export function isEngineEvent(event: GameEvent): event is EngineEvent {
  return event.name.startsWith(ENGINE_EVENT_PREFIX);
}

/**
 * 读取事件负载里的实体字段，字段不存在时返回 `null`。
 *
 * 只读取，不求值——`sel.event(field)`（M4）与 `trigger.filter`（M5）都要先拿到
 * 这个 id 才能往下走，而「某事件没有这个字段」是**常态**而非错误
 * （IR v1 §5.2：空集合静默跳过，不报错）。所以这里返回 `null` 而不是抛。
 *
 * `field` 的取值域直接用 IR 的 `EventEntityField`（= `source | target | player`），
 * 与 `sel.event.field` / `trigger.filter` 的键**同一个类型**，不在 engine 里另抄。
 *
 * 类型上无法穷尽收窄（`filter` 允许对任意事件写任意实体字段），
 * 所以实现走一次运行时取值：只有 `number` 才是实体 id，
 * 于是 `engine.random_picked.origin`（string）这类同名非实体字段天然被排除。
 */
export function eventEntity(event: GameEvent, field: EventEntityField): EntityId | null {
  const value: unknown = (event as { readonly [key: string]: unknown })[field];
  return typeof value === "number" ? value : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 编译期断言：负载表与 IR 词汇表必须逐字对齐
// ═══════════════════════════════════════════════════════════════════════════

/** `T` 必须是 `never`，否则**使用它的类型别名声明处**直接报错。纯类型，无运行时痕迹。 */
type MustBeNever<T extends never> = T;

/**
 * IR 新增了事件名而这里忘了配负载 → 此行报错，列出缺的那些名字。
 * （engine 对 ir 是纯类型依赖，跑不了运行时的 `EVENT_NAMES` 对比，只能这么钉。）
 */
export type EventNameCoverage = MustBeNever<Exclude<EventName, RuleEvent["name"]>>;

/** 这里写了 IR 里不存在的事件名（多半是拼写错误）→ 此行报错。 */
export type EventNameNoStrays = MustBeNever<Exclude<RuleEvent["name"], EventName>>;

/** `EventName` 里出现了 `engine.` 前缀的名字 → {@link isRuleEvent} 的判定失效 → 此行报错。 */
export type EnginePrefixDisjoint = MustBeNever<Extract<EventName, `${EngineEventPrefix}${string}`>>;
