// 流水线第 4 步：事后触发入栈（框架 §4.1 的 `queueTriggers(state, emitted)`）。
// 来源：框架 §4.1 时序规则 1 与规则 2、IR v1 §4.1（Trigger 的形状）、
//       DSL v2 §5（事件表）、`events/event.ts`（`engine.*` 不进触发器词汇表）。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 本文件同时承担两件事，务必分清 ★
// ═══════════════════════════════════════════════════════════════════════════
//   A. **排序与入栈**（框架 §4.1 时序规则 1 + 规则 2）—— 这是**流水线**的一部分，
//      M2 就做对了，并且有测试钉住：{@link compareTriggerOrder} / {@link sortTriggers}。
//      ⚠ 但规则 1 只覆盖**一次入栈之内**：栈是 LIFO，多次入栈之间是「后压的先跑」。
//      跨批次的顺序因此是**调用方**的责任，见 {@link queueTriggers} 的顺序约定
//      与为此拆出来的 {@link collectOrderedTriggers}。
//   B. **事件 → 触发器的匹配**（`trigger.on` / `filter` / `cond` / `zone` / `once`）
//      —— 这是**卡牌语义**，需要卡表与 M4 的求值器，M5 才填得上：
//      {@link collectTriggerSubscriptions}。
//
// M5（本条目）只动了 B，A 与六步流水线一行都没改。
//
// ═══════════════════════════════════════════════════════════════════════════
// M5 定下的三件事（改本文件前先读完）
// ═══════════════════════════════════════════════════════════════════════════
//
// ── 1. 订阅从哪来：`ResolveDeps.scripts`（新增的第三张 bundle 查询表）──────────
// M4 之前引擎**拿不到 `card.script`**：`eval/context.ts` 的 `CardLookup` 只返回
// `CardData`（卡面），`ScriptExpander` 又是按 ref 取**单个动作节点**的。
// M5 补的是一张并列的 `ScriptLookup`（`deps.ts`），而**不是**把 `CardLookup` 放宽成
// 整张 `Card` —— 完整取舍与架构 §5.2 隐藏信息边界的论证写在 `deps.ts` 的
// `ScriptLookup` 上，这里不重复。第二个订阅来源是**附魔自带的 `script.triggers`**
// （IR v1 §2.3），走已有的 `enchantments` 注入口，见 {@link subscriptionsOf}。
//
// ── 2. 入栈条目是 `via:"inline"` 而不是 IR v1 §6.2 的 ref ────────────────────
// ★ **规则本身**（哪种条目走哪条路、条目由谁构造）写在 `push.ts` 文件头「条目形态」
//   一节，那里是全仓唯一的一份；本条是那条规则里「触发器为什么也内联」的完整论证，
//   两处互不重复。
// §6.2 的规范形态是 `{ref:"<cardId>#<路径>", ctx}`，收益是条目极小。这里仍然内联，
// 三条理由（任何一条单独成立都够）：
//   a. 引擎手里**已经有**那一段 `do` —— `ScriptLookup` 就是为此注入的。
//      换成 ref 等于把同一份数据编码成字符串、再由展开器查回来，多一层可写错的映射；
//   b. **附魔的触发器没有 `<cardId>#…` 形式的 ref**（`state/stack.ts` 的 `ScriptRef`
//      形状是 `<cardId>#<script 路径>`）。走 ref 就得为附魔另发明一套 ref 命名空间，
//      而它要跟 bundle 的 `enchantments` 表对齐 —— 那是一整条新的可漂移契约；
//   c. 全仓**没有** `ScriptExpander` 的生产实现（`deps.expandScript` 至今缺省，
//      `handlers/index.ts` 的 `DEFAULT_DEPS` 明写了这一点）。此刻走 ref = 全部触发器
//      静默失效，而"静默失效"正是本仓最不能接受的失败形态。
// 代价是栈条目变大（一个 `Act` 节点而不是一个字符串）。M7 的投影 / M8 的回放若因为
// 快照体积回到 ref 形态，改动只落在 {@link collectTriggerSubscriptions} 造条目的那一行
//（把 `push.ts` 的 `inlinePending` 换成引用形态的构造）+ 补一个展开器；
// `PendingAction` 两种形态本来就并存（`state/stack.ts`），流水线不用改。
//
// ── 3. 同一个实体贡献多条动作时的顺序 ────────────────────────────────────────
// 一条触发器的 `do` 是 `Act[]`，一个实体也可能同时命中多条触发器。它们的 `owner`
// 相同 ⇒ {@link compareTriggerOrder} 的三级键**全部打平**（下面那句"两个实体不可能有
// 相同 id"只覆盖跨实体的情形）。打平那一段的顺序 = **输入顺序** =
// 「实体枚举顺序 × 触发器声明顺序 × `do` 的数组下标」，而这正是 IR v1 §5.4 规则 2
// 要的语义（`Act[]` 按数组下标升序）。
// 它由 `Array.prototype.sort` 的**稳定性**承载 —— 自 ES2019 起这是**规范保证**，
// 不是引擎实现细节，所以与文件下方"确定性不能靠稳定排序"那句不冲突：
// 那句针对的是**跨实体**顺序（输入顺序来自区域扫描，是任意的，必须由排序键定死），
// 而**同一实体内部**的顺序除了输入顺序之外没有别的载体可以表达。
// 前提是枚举本身确定：{@link collectTriggerSubscriptions} 按实体 id 升序扫
// （`Object.values` 对整数键有规范保证的顺序），与 `resolve/auras.ts` 同一条依据。
//
// ═══════════════════════════════════════════════════════════════════════════
// 时序规则 1（框架 §4.1 原文）
// ═══════════════════════════════════════════════════════════════════════════
// > **触发顺序**：当前回合玩家的触发器先于对手；同一方按实体 `playOrder` 升序
// > （先上场的先触发）。
//
// 落到代码里是 {@link compareTriggerOrder} 的三级键：
//   ① 是否属于「当前回合玩家」（是 → 排前）
//   ② `playOrder` 升序
//   ③ 实体 id 升序（兜底，保证是**全序** —— 两个实体不可能有相同 id，
//      于是排序结果与输入顺序、与引擎的排序算法实现都无关。确定性不能靠"稳定排序"
//      这种实现细节，架构 §6.1 的哈希比对会把任何抖动放大成假红。）
//
// ═══════════════════════════════════════════════════════════════════════════
// 时序规则 2（框架 §4.1 原文）
// ═══════════════════════════════════════════════════════════════════════════
// > **触发是入栈而非立即执行**：A 触发 B，B 要等 A 这一步的死亡结算做完才开始。
//
// 落到代码里就是本文件**只 push、不执行**：`queueTriggers` 返回后，流水线继续跑
// 第 5 步死亡结算与第 6 步光环重算，触发器要等下一次 `stack.pop()` 才轮到。
// 由于栈是 LIFO 而排序给的是**执行顺序**，入栈必须逆序 —— 那一次反转关在
// `push.ts` 的 `pushPendingInOrder` 里，本文件不自己写 `stack.push`。

import type {
  Act,
  EntityId,
  EventEntityField,
  Trigger,
  TriggerFilter,
  ZoneName,
} from "@prismfront/ir";
import type { EvalEnv } from "../eval/index.ts";
import { createEvalEnv, evalCond, evalSel, NO_ENCHANTMENTS } from "../eval/index.ts";
import type { GameEvent, RuleEvent } from "../events/index.ts";
import { eventEntity, isRuleEvent } from "../events/index.ts";
import type { EntityData, GameState, PendingAction, PlayerId } from "../state/index.ts";
import { controllerOf, createCtx, getEntity, withCtx, zoneOf } from "../state/index.ts";
import type { TriggerDeps } from "./deps.ts";
import { NO_SCRIPTS } from "./deps.ts";
import { inlinePending, pushPendingInOrder } from "./push.ts";

/**
 * 一条待入栈的触发器：**宿主实体 + 已经造好的栈条目**。
 *
 * 拆成这两个字段而不是直接给 `PendingAction`，是因为排序（时序规则 1）要看宿主实体的
 * 控制者与 `playOrder`，而栈条目本身只带 `ctx`（其 `self` 恰好就是宿主，但那是
 * M5 的约定，排序不该依赖别人的约定）。
 *
 * 纯数据：`owner` 是 id 引用，`pending` 是纯 JSON（框架 §3.1）。
 */
export interface QueuedTrigger {
  /** 触发器所在的实体（谁的触发器）。 */
  readonly owner: EntityId;
  /** 要压入结算栈的条目。M5 造它时把 `ctx.event` 绑成触发它的那条事件。 */
  readonly pending: PendingAction;
}

/**
 * 时序规则 1 里的「当前回合玩家」。
 *
 * 本游戏是**共享回合 + 行动交替**（DSL v2 §4.1），没有炉石那样的「我的回合」，
 * 所以这个概念要显式定义一次，并且**只定义在这一处**：
 *
 * - `actions` 相位：`priority` —— 正在提交行动的那一方，就是把这一切引发出来的人，
 *   与炉石「当前回合玩家」语义最接近；
 * - 其余相位（`round_start` / `deploy` / `combat` / `round_end` / `mulligan` / `over`）：
 *   `initiative` —— 这些相位没有单个"正在行动"的玩家（deploy 由服务端聚合双方选择后
 *   喂**单个** intent，v2.1 §11.3；combat 是全场同时结算，v2 §4.2），
 *   本回合先手方是唯一稳定且已被规范用作遍历起点的排序基准（v2 §4.2 第 ② 步）。
 *
 * ⚠ 这是 M2 就必须拍板、但真正影响面在 M3（相位机）与 M5（触发器）的一个定义。
 *   若 M3/M5 认为该换成别的口径，**只改这一个函数**，全引擎的触发排序、拦截器排序
 *   会一起跟上。
 */
export function activePlayer(state: GameState): PlayerId {
  return state.phase === "actions" ? state.priority : state.initiative;
}

/** 排序键：① 是否当前回合玩家（0 优先）② playOrder ③ 实体 id。 */
interface TriggerRank {
  side: 0 | 1;
  playOrder: number;
  id: EntityId;
}

function rankOf(state: GameState, owner: EntityId): TriggerRank {
  const entity = getEntity(state, owner);
  if (entity === undefined) {
    // 宿主已经不在实体表里（例如触发器排队期间被 `act.transform` 换掉了 id）。
    // 排到最后而不是抛错 —— 悬空 id 是常态而不是错误（`state/queries.ts` 的 `getEntity`）。
    return { side: 1, playOrder: Number.MAX_SAFE_INTEGER, id: owner };
  }
  return {
    side: controllerOf(entity) === activePlayer(state) ? 0 : 1,
    playOrder: entity.playOrder,
    id: owner,
  };
}

/**
 * 时序规则 1 的比较函数，**按宿主实体**比：当前回合玩家优先，同方按 playOrder 升序。
 *
 * 负数 ⇒ `a` 排前。三级键见文件头；第三级用实体 id 兜底，保证全序。
 *
 * ★ 这是**全引擎唯一**的「谁排前面」口径。除了触发器（{@link compareTriggerOrder}），
 *   `interceptors.ts` 的拦截器链在 `priority` 打平之后也用它（IR v1 §4.2
 *   「同优先级按 playOrder」）—— 拦截器**不**另写一份排序，否则同一个盘面会出现
 *   两种"先后"，而这类分叉只会在某张卡的表现上偶尔显形。
 */
export function compareOwnerOrder(state: GameState, a: EntityId, b: EntityId): number {
  const ra = rankOf(state, a);
  const rb = rankOf(state, b);
  if (ra.side !== rb.side) {
    return ra.side - rb.side;
  }
  if (ra.playOrder !== rb.playOrder) {
    return ra.playOrder - rb.playOrder;
  }
  return ra.id - rb.id;
}

/**
 * 时序规则 1 的比较函数：**当前回合玩家优先，同方按 playOrder 升序**。
 *
 * 负数 ⇒ `a` 先触发。排序键全部来自宿主实体，所以它只是
 * {@link compareOwnerOrder} 在 {@link QueuedTrigger} 上的一层薄壳。
 */
export function compareTriggerOrder(state: GameState, a: QueuedTrigger, b: QueuedTrigger): number {
  return compareOwnerOrder(state, a.owner, b.owner);
}

/**
 * 按时序规则 1 排序，返回**执行顺序**的新数组（不改入参）。
 *
 * 排序的是「执行顺序」不是「入栈顺序」—— 反转交给 `push.ts`。
 */
export function sortTriggers(
  state: GameState,
  queued: readonly QueuedTrigger[],
): readonly QueuedTrigger[] {
  return [...queued].sort((a, b) => compareTriggerOrder(state, a, b));
}

// ═══════════════════════════════════════════════════════════════════════════
// B. 事件 → 触发器的匹配（IR v1 §4.1）
// ═══════════════════════════════════════════════════════════════════════════

/** `trigger.zone` 的默认值（IR v1 §4.1 原文：「默认 `"board"`」）。 */
const DEFAULT_TRIGGER_ZONE: ZoneName = "board";

/**
 * `filter` 的键（= 事件负载的实体字段）**按这个固定顺序**求值。
 *
 * 不按 `Object.keys(filter)` 走：那是 JSON 的键序，同一条触发器在不同产物里可能不同，
 * 而 filter 的值是 `Sel` —— 里面允许出现 `sel.random`，求值顺序会直接变成 RNG 顺序
 * （IR v1 §5.4 规则 1 的同款理由）。写死一个顺序，回放就与键序无关。
 *
 * engine 对 ir 是**纯类型依赖**（架构 §2.2 禁令 1），不能 import `EVENT_ENTITY_FIELDS`
 * 这个值，所以本地重列。两个方向都由类型钉死，见下面那条 `satisfies` 与
 * {@link _FilterFieldsAreExhaustive}。
 */
const FILTER_FIELDS = ["source", "target", "player"] as const satisfies readonly EventEntityField[];

/** 编译期断言：`T` 必须为 `EventEntityField` 的**每个**取值都列了一项。 */
type CoversEveryEntityField<T extends Record<EventEntityField, true>> = T;

/**
 * {@link FILTER_FIELDS} 的**反方向**钉子：上面那个 `satisfies` 只保证「名字没写错」
 *（写错 / 多写 → 编译错），这一行保证「一个不少」。
 *
 * 少一个字段是**静默**的失败：`TriggerFilter = Partial<Record<EventEntityField, Sel>>`
 * （IR v1 §4.1），ir 哪天加了第四个实体字段而这里没跟上，{@link matchesFilter} 的 `for`
 * 根本不会看它 ⇒ 卡上写了的那条 filter 键**形同虚设**、触发器多触发一片，
 * 而且没有任何症状指向这里。钉成编译错误之后，报的是
 * 「Property 'xxx' is missing … Record<EventEntityField, true>」。
 *
 * 与 `types/ops.ts` 的 `satisfies Record<CondOp, true>`、`state/entity.ts` 的 `FLAG_BITS`
 * 同一条思路；差别是这里的表从 {@link FILTER_FIELDS} **摊**出来而不是另抄一份清单 ——
 * 抄一份就又多了一个会漂的真相源。
 */
type _FilterFieldsAreExhaustive = CoversEveryEntityField<{
  [K in (typeof FILTER_FIELDS)[number]]: true;
}>;

/**
 * 一条挂在实体上的触发器 + 它在 `entity.firedOnce` 里的键。
 *
 * 键与「这条触发器写在哪」一一对应，见 {@link subscriptionsOf}。
 */
interface TriggerBinding {
  readonly key: string;
  readonly trigger: Trigger;
}

/**
 * `entity.firedOnce` 的键：**来源前缀 + 声明下标**。
 *
 * 为什么不能只用「下标」：一个实体的订阅来自三处（卡的 `triggers`、卡的 `deathrattle`、
 * 每条附魔的 `script.triggers`），三处的下标会互相撞。加上来源前缀之后，
 * 「烧掉了卡上第 0 条」与「烧掉了 CORE_020e 的第 0 条」是两个不同的键。
 *
 * 附魔那一支用**附魔 id** 而不是 `entity.enchantments` 的数组下标：下标会随剥离
 * （`rules/phase.ts` 的 `stripEnchantments`）整体前移，一个已经记下的键会莫名其妙地
 * 指到另一条触发器上。代价是同一个实体挂**两份同 id 的附魔**时它们共享 `once` 记账 ——
 * 语义上"这条附魔的一次性效果已经用过了"，可接受，而且比一个会漂的键安全得多。
 */
function triggerKeyOf(source: string, index: number): string {
  return `${source}.${index}`;
}

/** 亡语那条糖触发器的键（它在 `CardScript` 里是独立字段，没有下标）。 */
const DEATHRATTLE_KEY = "deathrattle";

/**
 * 把 `script.deathrattle` 展开成一条**普通触发器**（IR v1 §4.1）。
 *
 * > `deathrattle` 是 `{on:"unit_died", filter:{target:SELF}, zone:"graveyard"}` 的糖，
 * > 构建器会展开。IR 里保留 `script.deathrattle` 字段只是为了可读性和 lint，
 * > engine 内部一律当 trigger 处理。                        —— IR v1 §4.1 原文
 *
 * ★ **展开只在这一处发生**。于是「亡语」在引擎里不是一个概念：
 *   - `deaths.ts` 不需要亡语排队逻辑（它只发死亡事件，本模块照常匹配）；
 *   - 框架 §4.1 时序规则 3 的「亡语按 `playOrder` 排队」自动由 {@link sortTriggers} 兑现；
 *   - `zone: "graveyard"` 正是"死后还能触发"的**全部**机制 —— 单位已经躺进墓地了
 *     （`deaths.ts` 的 `sendOffBoard` 先搬区、后发事件），所以区域判定通得过。
 *   若哪天有人在别处写 `if (亡语)`，那是重复实现，删掉它。
 *
 * ⚠ 这条糖对**英雄**永不成立（v2.1 §11.3）：英雄阵亡发的是 `hero_died` 而不是
 *   `unit_died`，且它躺进的是 `fountain` 而不是 `graveyard` —— 两把锁各自都足以挡住。
 *   要给英雄写"阵亡时…"，订阅 `hero_died`。
 */
function deathrattleTriggerOf(deathrattle: readonly Act[]): Trigger {
  return {
    on: "unit_died",
    filter: { target: { op: "sel.self" } },
    zone: "graveyard",
    do: deathrattle,
  };
}

/**
 * 一个实体身上的**全部**触发器，按**稳定的声明顺序**。
 *
 * 顺序 = 卡的 `deathrattle` → 卡的 `triggers` → 逐条附魔的 `script.triggers`：
 * 前两者按 `CardScript` 的**字段声明顺序**（IR v1 §9 / `ir/src/types/card.ts`），
 * 附魔按 `entity.enchantments` 的**施加顺序**（`state/entity.ts`）。
 * 这个顺序会一路变成同一实体内部的触发顺序（见文件头第 3 条），所以它必须由
 * 一份可指认的规范决定，而不是"碰巧这么写的"。
 *
 * 两个来源都可能查不到（`deps` 缺省 / bundle 里没有这张卡或这条附魔）——
 * 一律**静默得到空集**，与 `NO_CARDS` / `NO_ENCHANTMENTS` 的语义一致：
 * 「引擎不认识这张卡」不是错误，是退化。
 */
function subscriptionsOf(entity: EntityData, deps: TriggerDeps): TriggerBinding[] {
  const out: TriggerBinding[] = [];
  const script = (deps.scripts ?? NO_SCRIPTS)(entity.cardId);
  if (script !== undefined) {
    const deathrattle = script.deathrattle ?? [];
    if (deathrattle.length > 0) {
      out.push({ key: DEATHRATTLE_KEY, trigger: deathrattleTriggerOf(deathrattle) });
    }
    const triggers = script.triggers ?? [];
    for (let i = 0; i < triggers.length; i += 1) {
      const trigger = triggers[i];
      if (trigger !== undefined) {
        out.push({ key: triggerKeyOf("triggers", i), trigger });
      }
    }
  }
  const lookup = deps.enchantments ?? NO_ENCHANTMENTS;
  for (const attached of entity.enchantments) {
    // IR v1 §2.3「附魔本身可以带触发器」——**第二个订阅来源**，别漏。
    const triggers = lookup(attached.ench)?.script?.triggers ?? [];
    for (let i = 0; i < triggers.length; i += 1) {
      const trigger = triggers[i];
      if (trigger !== undefined) {
        out.push({ key: triggerKeyOf(`${attached.ench}.triggers`, i), trigger });
      }
    }
  }
  return out;
}

/**
 * `filter` 判定（IR v1 §4.1）：**键是事件负载的实体字段，该字段上的实体须落在该 `Sel` 内**。
 *
 * 三条容易写错的点：
 * 1. **SELF 绑的是订阅者，不是事件源**。荆棘卫士写 `{target: sel.self}` = 「我被打时」，
 *    Cleave 写 `{source: sel.self}` = 「我命中别人时」——两者只差在键上，
 *    而只有"SELF = 挂着这条触发器的那个实体"才让这对写法成立（`env` 由调用方绑好）。
 * 2. **事件没有这个字段 ⇒ 不匹配**。`unit_died` 没有 `source`（`events/event.ts` 讲了
 *    为什么不设），`damaged.source` 也可能是 `null`（疲劳等规则伤害）。
 *    「字段上没有实体」⇒ 它不可能落在任何集合内 ⇒ 判否。这不是特判，是"须落在集合内"
 *    的直接推论。
 * 3. **位置选择器是免费的**。`{target: sel.adjacent(sel.self)}` = 「相邻友军被打时」
 *    （v2 §5 点名的用法）在这里没有任何专门代码：`sel.adjacent` 只是又一个 `Sel`。
 *    如果有人为它写特判，说明这一层接错了。
 *
 * 求值顺序见 {@link FILTER_FIELDS}；命中失败即短路（同 `cond.and`，IR v1 §5.4 规则 3）。
 */
function matchesFilter(env: EvalEnv, event: RuleEvent, filter: TriggerFilter | undefined): boolean {
  if (filter === undefined) {
    return true;
  }
  for (const field of FILTER_FIELDS) {
    const sel = filter[field];
    if (sel === undefined) {
      continue;
    }
    const id = eventEntity(event, field);
    if (id === null || !evalSel(env, sel).includes(id)) {
      return false;
    }
  }
  return true;
}

/**
 * 找出订阅了某条规则事件的全部触发器（IR v1 §4.1 的 `on` / `filter` / `cond` / `once` / `zone`）。
 *
 * 判定顺序是**由便宜到贵**的：`on` 比事件名 → `zone` 比区域 → `once` 查记账 →
 * `filter` 求值 → `cond` 求值。前三条是纯比较，后两条要跑求值器（可能消耗 RNG），
 * 所以顺序不是风格问题：把 `cond` 提前会让"根本不该触发的触发器"也推进随机流。
 *
 * ── 上下文绑定（IR v1 §5.1）─────────────────────────────────────────────────
 * `ctx = { self: 宿主, event: 本事件, target/chosen/it: null }`：
 * - `self` = **订阅者**（不是事件源）—— 卡里写 `sel.self` 指的就是自己；
 * - `event` = 触发它的那条事件，于是 `cond` 与 `do` 里的 `sel.event.*` 都能读到
 *   （`state/stack.ts` 的 `CtxBindings.event` 就是为此存在的）；
 * - `target` **不绑** —— 触发器没有"打出时指定的目标"这回事，要事件里的对象请写
 *   `EVENT.target`（`sel.event`）。绑一个假的 `target` 只会让写卡的人分不清两者。
 * 同一份 ctx 同时用于 `filter` / `cond` 求值和入栈条目，于是"匹配时看到的世界"
 * 与"执行时绑定的世界"必然一致。
 *
 * ── ⚠ 一处**有意的副作用**：`once` 的记账 ────────────────────────────────
 * 命中的 `once` 触发器当场记进 `entity.firedOnce`（`state/entity.ts`）。
 * 记在**匹配这一刻**而不是执行那一刻，是因为 IR v1 §4.1 说的是「触发一次后自动移除」——
 * "触发"就是这里；而入栈到执行之间隔着整个死亡结算与光环重算（时序规则 2），
 * 那期间同名事件可能再来一条，记晚了它就会被排第二次。
 * 反过来说，`once` 的消耗**不因为动作最终没做成而退回**（目标是空集、无效槽…）——
 * 与炉石一致，也与"空集合静默跳过不是错误"（IR v1 §5.2）自洽。
 *
 * 关于**亡语**：见 {@link deathrattleTriggerOf} —— 它在这里被展开成普通触发器，
 * 别处一行特判都没有。
 */
export function collectTriggerSubscriptions(
  state: GameState,
  event: RuleEvent,
  deps: TriggerDeps,
): readonly QueuedTrigger[] {
  const out: QueuedTrigger[] = [];
  // 枚举顺序 = 实体 id 升序（`Object.values` 对整数键有规范保证的顺序，同 `auras.ts`）。
  // 跨实体的最终顺序由 `sortTriggers` 定死，这里只需要**确定**，不需要"对"。
  for (const entity of Object.values(state.entities)) {
    for (const { key, trigger } of subscriptionsOf(entity, deps)) {
      if (trigger.on !== event.name) {
        continue;
      }
      // `zone`：订阅者不在这个区就不订阅。亡语的 `"graveyard"` 正是它能在死后触发的原因。
      if (zoneOf(entity) !== (trigger.zone ?? DEFAULT_TRIGGER_ZONE)) {
        continue;
      }
      const once = trigger.once === true;
      if (once && entity.firedOnce.includes(key)) {
        continue;
      }
      const ctx = withCtx(createCtx(entity.id), { event });
      const env = createEvalEnv(state, ctx, deps.cards, deps.enchantments);
      if (!matchesFilter(env, event, trigger.filter) || !matchesCond(env, trigger)) {
        continue;
      }
      if (once) {
        entity.firedOnce.push(key);
      }
      // 一条触发器的 `do` 是 `Act[]`，按数组下标升序执行（IR v1 §5.4 规则 2）——
      // 逐条造栈条目，顺序由文件头第 3 条兜住。条目形态见文件头第 2 条，构造走
      // `push.ts` 的 `inlinePending`（本文件不手写 `{ via: … }` 字面量，同 `combat.ts`）。
      for (const act of trigger.do) {
        out.push({ owner: entity.id, pending: inlinePending(act, ctx) });
      }
    }
  }
  return out;
}

/** `cond` 判定（IR v1 §4.1「额外条件，可访问 `sel.event.*`」）。没写就是恒真。 */
function matchesCond(env: EvalEnv, trigger: Trigger): boolean {
  return trigger.cond === undefined || evalCond(env, trigger.cond);
}

/**
 * 把**已经排好序**的一批触发器压入结算栈（规则 2），返回入栈条目数。
 *
 * 与 {@link queueTriggers} 分开导出，是为了让「排序 + 入栈」这段**流水线逻辑**
 * 能被独立测到 —— M2 的 {@link collectTriggerSubscriptions} 恒返回空，
 * 若不拆开，规则 1/2 的落地代码在整个 M2 期间都是跑不到的死代码，
 * 等 M5 接上真匹配时才第一次执行，那时出问题就分不清是匹配错了还是排序错了。
 *
 * **只 push、不执行**（规则 2）：压完就返回，触发器要等下一次 `stack.pop()` 才轮到。
 * LIFO 的那一次反转由 `push.ts` 负责，本文件不碰 `state.stack.push`。
 */
export function enqueueTriggers(state: GameState, ordered: readonly QueuedTrigger[]): number {
  if (ordered.length === 0) {
    return 0;
  }
  const items: PendingAction[] = [];
  for (const trigger of ordered) {
    items.push(trigger.pending);
  }
  pushPendingInOrder(state, items);
  return items.length;
}

/**
 * 把一批事件匹配出的触发器**按时序规则 1 排好序**并返回 —— ★ **不入栈**。
 *
 * 与 {@link queueTriggers} 的唯一差别就是末尾那一次 `pushPendingInOrder`。拆出来是为了
 * 让「在一个循环里逐条匹配、循环跑完之后**一次性**入栈」这种写法成为可能 ——
 * 那是跨批次顺序唯一正确的做法（见 {@link queueTriggers} 的顺序约定）。
 * 两个使用者：`rules/combat.ts` 的第 ③ 步（逐**击**）与 `resolve/deaths.ts` 的
 * `processDeaths`（逐**波**），两处都在开闸之前会经历多批。
 *
 * ── ★ 为什么不干脆把**匹配**也推迟到最后一次性做 ──────────────────────────
 * {@link collectTriggerSubscriptions} 读的是**当前状态**：`zone` 比的是订阅者此刻在哪个区、
 * `once` 查的是此刻的记账、`filter` / `cond` 都要在此刻求值。推迟匹配 = 拿"整批做完
 * 之后"的盘面去匹配，语义会变。逐条匹配保住的正是那条「匹配时看到的世界 = 执行时
 * 绑定的世界」（见 {@link collectTriggerSubscriptions} 的上下文绑定一节）。**排序**同理：
 * {@link sortTriggers} 的键读的也是当前状态（控制者与 `playOrder`）。
 *
 * 这不是一句只能靠自觉遵守的话，两个调用点各有一条测试钉着**匹配时机**：
 * - 战斗：`rules/__tests__/combat.test.ts` 的「★ 匹配不能推迟到批次末尾」——
 *   `cond: cond.dead(靶子)` 的一对互斥触发器，靶子的血量在批次里一击一击掉；
 * - 死亡结算：`__tests__/auras.test.ts` 的「★ 亡语的 cond 看到的是…中间盘面」——
 *   本波亡语的 `cond` 求值发生在"死者已进墓地、光环还没算掉"的那一刻。
 * ⚠ 两处能观测到的**变量不同**：战斗第 ③ 步跳过死亡结算，**死亡不改变 `zone`**，
 *   判别力只能来自血量。死亡结算那边 `zone` 确实会变（死者已进墓地），
 *   但上面引的那条测试**钉的不是 zone** —— 它的判别力来自光环值
 *   （光环源已死、`refreshAuras` 还没跑，`ally.atk` 仍是加成后的 5），
 *   即"死者已进墓地、光环还没算掉"这一刻的**中间态**。基于 `zone` 的测试也立得起来，
 *   只是现在没有。
 *
 * `engine.*` 事件在这里被 `isRuleEvent` 挡掉，理由见 {@link queueTriggers}。
 */
export function collectOrderedTriggers(
  state: GameState,
  events: readonly GameEvent[],
  deps: TriggerDeps,
): readonly QueuedTrigger[] {
  const ordered: QueuedTrigger[] = [];
  for (const event of events) {
    if (!isRuleEvent(event)) {
      continue;
    }
    const matched = collectTriggerSubscriptions(state, event, deps);
    for (const trigger of sortTriggers(state, matched)) {
      ordered.push(trigger);
    }
  }
  return ordered;
}

/**
 * 把一批事件匹配出的触发器**按时序规则 1 排序后入栈**（框架 §4.1 第 4 步）。
 *
 * 返回入栈条目数，方便调用方与测试断言「这一步排了几个触发」。
 *
 * ── 一次调用之内的顺序：字典序「事件发出序 × 规则 1」──────────────────────
 * - 外层键 = `events` 的**数组顺序**（`events/event.ts`：顺序即数组顺序）；
 * - 内层键 = 同一条事件匹配出的那一批按时序规则 1 排（{@link sortTriggers}）。
 * 两个键各有一条测试钉着（`__tests__/triggers.test.ts`）：外层键是「★ 一次调用喂多条
 * 事件」（一次喂两条事件、正反各喂一遍），内层键是「规则 1 端到端」。
 * 只钉内层键是不够的 —— 只喂一条事件的测试对事件遍历顺序**零判别力**。
 *
 * ── ★ 跨调用的顺序是**调用方**的责任，本函数管不着 ★ ───────────────────────
 * 栈是 LIFO，而本函数每次调用都当场压一次 ⇒ **后压的那一批先跑**。所以
 * 「先发的事件的触发器先跑」只在**一次调用之内**成立；调用方若在开闸（下一次
 * `stack.pop()`）之前调了多次，拿到的是逐批倒序。现有调用点分两类：
 *
 * 1. **调一次就开闸** —— `resolve.ts` 的第 ④ 步（每弹一条栈条目调一次）、
 *    `rules/phase.ts` 的 `runStep` 与战斗的进出口。两次调用之间隔着真正的执行，
 *    不存在"攒着一堆批次"的情形。
 *    ⚠ `resolve.ts` 那条路有一个**反直觉却真实**的后果：handler 在第 ③ 步压的**连锁**
 *    在栈上更靠下，第 ④ 步压的触发器盖在它之上 ⇒ 触发器先跑。`act.strike` 因此是
 *    `struck` →（`struck` 的触发器）→ `act.hit` → `damaged` →（`damaged` 的触发器）：
 *    出手的触发器跑在这一击自己的伤害**之前**（`handlers/damage.ts` 的 `strikeHandler`
 *    把那条 `act.hit` 压栈，`damaged` 要等它被弹出来才发）。
 * 2. **开闸之前会经历多批** —— `rules/combat.ts` 的第 ③ 步（一整批出手）与
 *    `resolve/deaths.ts` 的 `processDeaths`（不动点循环的多波死亡）。两处都**不能**
 *    逐批调本函数：那正是「后排队的先跑」把整场战斗 / 整次死亡结算的触发器倒过来的地方
 *    （M5 的两处实测缺陷，同一个 bug 的两个实例）。它们改用 {@link collectOrderedTriggers}
 *    逐批匹配、把有序条目累积起来，循环结束后调一次 {@link enqueueTriggers} ——
 *    整批的顺序这才是那条字典序。
 * 新调用方落在第 2 类时，照这两处那么写。
 *
 * `engine.*` 事件（目前只有 `engine.random_picked`）**不进触发器词汇表**，
 * 在这里被 `isRuleEvent` 挡掉 —— 否则等于允许卡牌"监听随机数"（见 `events/event.ts`）。
 *
 * `deps` 是**必填**的（M5 起）：它是订阅的唯一来源，忘了传 = 这一批事件**静默地**
 * 一条触发器都不排。那种失败没有任何症状可循（卡"偶尔不生效"），所以宁可让每个调用点
 * 都被编译器逼着显式回答"我这里的 bundle 查询从哪来"。不需要订阅源的调用点
 * （测试、只想跑流水线的桩）传 `handlers/index.ts` 的 `NO_DEPS` 即可。
 */
export function queueTriggers(
  state: GameState,
  events: readonly GameEvent[],
  deps: TriggerDeps,
): number {
  return enqueueTriggers(state, collectOrderedTriggers(state, events, deps));
}
