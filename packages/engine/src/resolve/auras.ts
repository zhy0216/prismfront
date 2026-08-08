// 流水线第 6 步：光环重算（框架 §4.1 的 `refreshAuras(state)`）。
// 来源：框架 §4.1 时序规则 4、IR v1 §4.3（Aura）、IR v1 §2.3（Enchantment 的 mods/flags/script.auras）、
//       IR v1 §5.4 规则 5（光环重算不得消耗 RNG）、DSL v2 §2.3（direction 走同一条管线）、
//       DSL v2 §8.2（位置条件光环）、`state/entity.ts`（`base`/`tags`、`baseFlags`/`flags` 的分工）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 时序规则 4（框架 §4.1 原文）
// ═══════════════════════════════════════════════════════════════════════════
// > **光环是重算而非增量**：`tags = base + 所有附魔 + 所有生效光环`，每步重算。
// > 实体数量在 20 量级，重算成本可忽略，但省掉了「光环失效时忘了减回去」这一整类 bug。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★★ 这条规则对 handler 的强制要求：**持久的属性变更写 `base`，不要写 `tags`** ★★
// ═══════════════════════════════════════════════════════════════════════════
// `tags` 是**派生值**，每一步都会被本函数从 `base` 重新算出来并整体覆盖。
// 往 `tags` 里写东西 = 写进一个下一行就会被抹掉的缓存。
// 症状极具迷惑性：单步测试全绿（因为断言发生在重算之前），一进真实结算就"buff 没了"、
// "召唤出来的单位立刻死了（血量被重算回 0）"。
//
// 各类写入的正确落点：
//   - 召唤/生成实体的初值        → 写 `base`（与 `baseFlags`），再由本函数派生出 `tags`
//   - 附魔（`act.buff`）         → 挂进 `entity.enchantments`，由本函数**加**出来
//   - 光环（`Aura`）             → 不落在实体上，每次由本函数从光环源现算
//   - 伤害与治疗                 → 写 `entity.damage`，**不动 `tags.health`**
//                                 （血量记账见 `state/entity.ts`：当前血量 = tags.health - damage）
//   - `act.set_tag` / `act.mod_tag` 写 `base`（`handlers/tags.ts` 的 M4 定夺：
//     要能被沉默剥掉就写 `act.buff`，不要被剥就写 `act.set_tag`）
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ M5/T3：两个 Σ 的算法 —— **两趟，光环不看光环** ★
// ═══════════════════════════════════════════════════════════════════════════
// 第 1 趟  逐实体：`tags = base + Σ附魔.mods`、`flags = baseFlags + Σ附魔.flags`。
//          附魔是**纯数据**（按 `ench` 去 bundle 查 `mods`/`flags`，IR v1 §2.3），
//          不求值、不看盘面，所以这一趟逐实体独立、顺序无关。
// 第 2 趟  枚举全部光环源，在**第 1 趟的盘面**上求值 `cond` 与 `affects`，
//          把加成先**收集**到一张临时表里，收齐之后再一次性加到实体上。
//
// ── 为什么第 2 趟要"先收集再统一加"，而不是求一条加一条 ────────────────────
// 求一条加一条 = **光环能看见别的光环的加成**，于是：
//   a. 结果依赖枚举顺序 —— 谁先算谁后算会改变 `sel.where(atk >= 3)` 这类 affects 的结果，
//      而枚举顺序是实体 id 升序这种**实现细节**，架构 §6.1 的哈希比对会把它放大成假红；
//   b. 会出现**环** —— A 的 cond 读 B 的 atk、B 的 affects 又筛 A 的 atk，
//      "算到不动点"要么不收敛、要么在两个解之间震荡，而规范没有给不动点的定义。
// 于是本文件把光环的输入面钉死为 **base + Σ附魔**：光环之间互不可见，重算是一次性的、
// 与顺序无关的纯函数。代价是写不出"光环 A 加成之后才满足光环 B 的条件"这类卡；
// 收益是重算永远收敛、永远与枚举顺序无关。要改成级联，必须先给规范补一条不动点定义。
// （规则 4 的原文是 `base + 所有附魔 + 所有生效光环` —— 一个**和式**，不是一条迭代。）
//
// ── `direction` 一行特判都没有（v2 §2.3）────────────────────────────────────
// `mods` 是 `Partial<Record<TagKey, number>>`，`direction` 只是其中一个键，
// 由 `state/entity.ts` 的 `addTagValues` 与别的 tag 一样逐键相加。
// 「光环批量改方向」「附魔改方向」「沉默自动回 0」因此是免费的：
// **本文件的代码里出现 `direction` 零次**（只有这段注释提到它）。
// 哪天有人在这里为它写一个特判，说明接错了层。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 确定性：光环重算**不得消耗 RNG**（IR v1 §5.4 规则 5 + v2 §3.1）★
// ═══════════════════════════════════════════════════════════════════════════
// > 光环重算、死亡结算**不得消耗 RNG**（它们每步都跑，一旦消耗就无法保证确定性）。
// > 规则上直接禁止：`aura.affects` 和 `cond` 中出现 `*.random` 是校验期错误。
// >                                                        —— IR v1 §5.4 规则 5 原文
//
// M2 时这条是**结构性**成立的（本文件不 import 求值器，一次 `nextInt` 都调不到）。
// M5/T3 之后不再是：`affects` 是 `Sel`、`cond` 是 `Cond`，求值器里就有 `sel.random` /
// `num.random` / `slot.random_empty`。于是防线分两层，与 `interceptors.ts` 完全同构：
//   L3（M11，编写期）  `aura` 内出现 `*.random` → 校验错误（IR v1 §7 资源上限表点名）；
//   引擎（运行期）     每条光环求值前后比一次 `state.rng`，推进过就抛 {@link AuraRandomError}。
// 引擎这一层不是冗余：架构 §5.1 的载入期比对至今没有实现，引擎不是只吃自家 bundle 的，
// 而"静默地让随机流分叉"是本仓最不能接受的失败形态 —— 重算每步都跑，一次漂移之后
// 整局回放全部对不上，且没有任何症状能指回这里。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ M5/T3 拍板：属性变化**不补发 `buffed` 事件** ★
// ═══════════════════════════════════════════════════════════════════════════
// M2 把这个问题留给了 M5（"规则 4 是重算，重算本身不是一件发生过的事"）。定夺：**不发**。
// 三条理由，任何一条单独成立都够：
// 1. **重算不是一件"发生过的事"**。本函数每步都跑（流水线第 ⑥ 步、战斗第 ③ 步逐击、
//    `processDeaths` 的每一波、`stripEnchantments` 之后），一个回合几十上百次；
//    给每次差分发事件会把事件流淹掉，而事件流是 M7 投影与 M8 回放的输入。
// 2. **同一件事会发两遍**。v2 §5 的 `buffed` 语义是"一次附魔/属性修改**动作**发生了"，
//    `act.buff` / `act.set_tag` 已经在动作层发过（`handlers/tags.ts`）；
//    重算再发一次，监听 `buffed` 的触发器会为同一次加成触发两回。
// 3. **光环生效/失效根本没有对应的动作**。为它造事件等于让"盘面重算"成为触发源：
//    触发器 → 改盘面 → 光环变 → 又触发，一条极易成环的反馈，而 IR v1 §7 的
//    结算栈深度上限只挡得住已经失控的链，挡不住"每步都多几条事件"的稳态噪声。
// 可观测面因此是**盘面本身**（`tags` / `flags`），与 `handlers/tags.ts` 的
// `act.set_flag` 不发事件是同一个取舍。要做"每当获得光环加成"这类卡，
// 得先给 v2 §5 补一个事件名（`irVersion` minor + 触发器词汇表跟进），不是本文件的事。

import type { Aura, EnchantId, EntityId, FlagName, ZoneName } from "@prismfront/ir";
import type { EnchantLookup } from "../eval/index.ts";
import { createEvalEnv, evalCond, evalSel, NO_ENCHANTMENTS } from "../eval/index.ts";
import type { GameEvent } from "../events/index.ts";
import { drainEventLog } from "../events/index.ts";
import type { EntityData, FlagMask, GameState, TagValues } from "../state/index.ts";
import {
  addTagValues,
  createCtx,
  createTagValues,
  maskWith,
  NO_FLAGS,
  zoneOf,
} from "../state/index.ts";
import type { TriggerDeps } from "./deps.ts";
import { NO_SCRIPTS } from "./deps.ts";

/**
 * 一条光环的求值（`cond` / `affects`）推进了 RNG（IR v1 §5.4 规则 5 的运行时防线）。
 *
 * 见文件头「确定性」一节。形态与理念照抄 `interceptors.ts` 的 `InterceptRandomError`：
 * 它**不是「非法意图」**（那一类由 `apply()` 回 `ok:false` 的原因码），而是**卡牌数据错误**——
 * 吞掉它会让随机流的推进次数随盘面细节漂移，整局回放静默失真。
 *
 * 抛错前把事件日志排空并挂在 {@link events} 上：`events/log.ts` 定死了
 * 「`apply()` / `resume()` 返回时 `state.eventLog` 必为空」这条不变量，**抛错路径也不例外**。
 * 注意 `state` **不会**被回滚：引擎不做事务。
 */
export class AuraRandomError extends Error {
  /** 违规光环的宿主实体。 */
  readonly owner: EntityId;
  /** 抛错前排空的事件（见类说明）。 */
  readonly events: readonly GameEvent[];

  constructor(owner: EntityId, events: readonly GameEvent[]) {
    super(
      `实体 ${owner} 的光环在重算时推进了 RNG：` +
        `aura 的 affects / cond 里不得出现 *.random（IR v1 §5.4 规则 5）`,
    );
    this.name = "AuraRandomError";
    this.owner = owner;
    this.events = events;
  }
}

/** `aura.zone` 的默认值（IR v1 §4.3 原文：「光环在哪个区域生效，默认 `"board"`」）。 */
const DEFAULT_AURA_ZONE: ZoneName = "board";

// ═══════════════════════════════════════════════════════════════════════════
// 第 1 趟：Σ附魔（纯数据，不求值）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 把一条附魔定义的 `mods` / `flags` 加进累加器（IR v1 §2.3）。
 *
 * 查不到定义（bundle 没接 / 热更换之后的旧存档）⇒ **静默贡献 0**，
 * 与 `eval/context.ts` 的 `NO_ENCHANTMENTS` 同一条退化语义：
 * 「引擎不认识这条附魔」不是错误。（`act.buff` 在挂上去的那一刻就查过一次定义，
 * 查不到根本挂不上 —— 所以这里查不到只可能是换过 bundle。）
 */
function addEnchantment(
  lookup: EnchantLookup,
  ench: EnchantId,
  tags: TagValues,
  flags: FlagMask,
): { tags: TagValues; flags: FlagMask } {
  const def = lookup(ench);
  if (def === undefined) {
    return { tags, flags };
  }
  return {
    tags: def.mods === undefined ? tags : addTagValues(tags, def.mods),
    flags: addFlags(flags, def.flags),
  };
}

/** 把一组标志位并进掩码（`maskWith` 是唯一的置位实现，见 `state/entity.ts`）。 */
function addFlags(mask: FlagMask, flags: readonly FlagName[] | undefined): FlagMask {
  let out = mask;
  for (const flag of flags ?? []) {
    out = maskWith(out, flag, true);
  }
  return out;
}

/**
 * 第 1 趟：把一个实体复位到 `base` / `baseFlags`，再加上 Σ附魔。
 *
 * **整体覆盖**而不是"把上一次加的减回去"—— 没有增量，就没有"忘了减回去"（规则 4）。
 *
 * ⚠ `createTagValues(entity.base)` 造的是**新表**，`entity.tags = entity.base` 不行：
 * 那会让卡面值与派生值变成**同一个对象**。本文件自己不会因此出错（`addTagValues`
 * 是纯函数，每次返回新表），坏的是别人 —— 全仓有好几处「写完 `base` 顺手把 `tags`
 * 对齐」的写法（`handlers/tags.ts` / `handlers/board.ts` / `testkit` 的 `setFace`），
 * 一旦两者同一，任何一次**原地**写 `tags` 都会静默改掉卡面值，而 `act.silence`
 * 正是靠"复位到 `base`"工作的 —— 症状要到沉默时才显形，且看起来像"沉默没生效"。
 * 有一条测试钉住这个对象身份（`__tests__/auras.test.ts` 的退化形态那条）。
 */
function refreshOne(entity: EntityData, lookup: EnchantLookup): void {
  let tags = createTagValues(entity.base);
  let flags = entity.baseFlags;
  for (const attached of entity.enchantments) {
    const next = addEnchantment(lookup, attached.ench, tags, flags);
    tags = next.tags;
    flags = next.flags;
  }
  entity.tags = tags;
  entity.flags = flags;
}

// ═══════════════════════════════════════════════════════════════════════════
// 第 2 趟：Σ光环（求值，先收集再统一加）
// ═══════════════════════════════════════════════════════════════════════════

/** 一个实体收到的全部光环加成（第 2 趟的中间结果，**不进状态**）。 */
interface AuraGrant {
  tags: TagValues;
  flags: FlagMask;
}

/**
 * 一个实体身上的**全部**光环，按**稳定的声明顺序**。
 *
 * 两个来源，与 `triggers.ts` 的 `subscriptionsOf` 逐条对称：
 *   1. 卡的 `script.auras`（IR v1 §2.2），经 `deps.scripts` 查；
 *   2. **每条附魔的 `script.auras`**（IR v1 §2.3 的 `EnchantmentScript` 同时有
 *      `triggers` 与 `auras`），经 `deps.enchantments` 查，按附魔的施加顺序。
 * 漏掉第 2 个来源的症状是"用附魔授予的光环静默不生效"——与"光环写错了"长得一模一样。
 *
 * 顺序在本文件里其实**不可观测**（第 2 趟先收集再统一加，加法与按位或都可交换），
 * 但仍按声明顺序返回：将来若要为光环补事件或诊断输出，顺序得是可指认的而不是碰巧的。
 *
 * 两个来源都可能查不到 ⇒ 一律**静默得到空集**，与 `NO_SCRIPTS` / `NO_ENCHANTMENTS`
 * 的语义一致（`resolve/deps.ts`）：「引擎不认识这张卡」不是错误，是退化。
 */
function aurasOf(entity: EntityData, deps: TriggerDeps): Aura[] {
  const out: Aura[] = [];
  for (const aura of (deps.scripts ?? NO_SCRIPTS)(entity.cardId)?.auras ?? []) {
    out.push(aura);
  }
  const lookup = deps.enchantments ?? NO_ENCHANTMENTS;
  for (const attached of entity.enchantments) {
    for (const aura of lookup(attached.ench)?.script?.auras ?? []) {
      out.push(aura);
    }
  }
  return out;
}

/**
 * 求值一条光环，把它的加成记进 {@link AuraGrant} 表。
 *
 * 判定顺序 **zone → cond → affects**：
 * - `zone` 是纯比较（宿主不在那个区，这条光环就不生效 —— 与 `trigger.zone`
 *   「订阅者不在这个区就不订阅」同一个读法，IR v1 §4.1/§4.3 的字段说明是一对）；
 * - `cond` 不成立就不必再求 `affects`（v2 §8.2 空袭猎手的 `cond` 是位置判断，
 *   比枚举一整个区域便宜得多）。
 * 三者都**不得**推进 RNG，所以这个顺序在随机流上是不可观测的 ——
 * 它是效率取舍，不是像 IR v1 §5.4 规则 1 那样的语义约定。
 *
 * ── 上下文绑定（IR v1 §5.1）─────────────────────────────────────────────────
 * `ctx = { self: 宿主, 其余全 null }`：`affects` / `cond` 里的 `sel.self` 指的是
 * **挂着这条光环的实体**（v2 §8.2 空袭猎手的 `SlotOf(SELF).opposite()`、
 * IR v1 §10.3 野猪王的 `FRIENDLY_MINIONS.not(SELF)` 全押在这一条上）。
 * `target` / `chosen` / `it` / `event` 一律不绑：光环是**声明**，不是一次动作，
 * 它没有"打出时指定的目标"，也没有"触发它的那条事件"。
 */
function grantAura(
  state: GameState,
  host: EntityData,
  aura: Aura,
  deps: TriggerDeps,
  grants: Map<EntityId, AuraGrant>,
): void {
  if (zoneOf(host) !== (aura.zone ?? DEFAULT_AURA_ZONE)) {
    return;
  }
  const env = createEvalEnv(state, createCtx(host.id), deps.cards, deps.enchantments);

  // ★ 确定性防线（见文件头）：求值前后比一次 `state.rng`，推进过就抛。
  //   `rng` 是原地改的两个 32 位字，比两个字段即可 —— 与 `interceptors.ts` 同款。
  const { s0, s1 } = state.rng;
  const affected =
    aura.cond === undefined || evalCond(env, aura.cond) ? evalSel(env, aura.affects) : null;
  if (state.rng.s0 !== s0 || state.rng.s1 !== s1) {
    throw new AuraRandomError(host.id, drainEventLog(state));
  }
  if (affected === null) {
    return;
  }

  for (const id of affected) {
    const current = grants.get(id) ?? { tags: createTagValues(), flags: NO_FLAGS };
    grants.set(id, {
      tags: aura.mods === undefined ? current.tags : addTagValues(current.tags, aura.mods),
      flags: addFlags(current.flags, aura.flags),
    });
  }
}

/**
 * 第 2 趟：枚举全部光环源，收集每个受影响实体拿到的加成。
 *
 * 枚举顺序 = 实体 id 升序（`Object.values` 对整数键有规范保证的顺序，
 * 同 `triggers.ts` / `interceptors.ts`）。这里只需要**确定**，不需要"对"——
 * 结果与顺序无关，因为加法与按位或都可交换，且光环之间互不可见（见文件头）。
 *
 * `Map` 是**求值期的局部变量**，不进状态（框架 §3.1 不变量 1：状态里不许有 Map）。
 */
function collectAuraGrants(
  state: GameState,
  entities: readonly EntityData[],
  deps: TriggerDeps,
): Map<EntityId, AuraGrant> {
  const grants = new Map<EntityId, AuraGrant>();
  for (const host of entities) {
    for (const aura of aurasOf(host, deps)) {
      grantAura(state, host, aura, deps, grants);
    }
  }
  return grants;
}

// ═══════════════════════════════════════════════════════════════════════════
// 对外入口
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 重算全部实体的派生属性与派生标志位（框架 §4.1 第 6 步）。
 *
 * **重算而非增量**：直接用 `base` / `baseFlags` 覆盖，而不是"把上一次加的减回去"。
 * 这正是规则 4 想消灭的那类 bug 的根源 —— 没有增量，就没有"忘了减回去"。
 * 于是「光环源死了」「附魔到期被剥了」这两件事在本文件里**一行代码都没有**：
 * 剥离方（`rules/phase.ts` 的 `stripEnchantments`、`resolve/deaths.ts`）只要把来源
 * 拿掉再调本函数，数值自己就回去了。
 *
 * 遍历**全部**实体而不只是场上的：手牌里的牌也会被光环改（费用修正是最常见的一种，
 * IR v1 §10.4 的谜之勇士就是），漏掉手牌等于漏掉一整类卡。
 * 实体量级在几十，成本可忽略（框架 §4.1 原话）。
 *
 * 两趟的算法与"光环不看光环"的论证见文件头。**不消耗 RNG**，违者抛
 * {@link AuraRandomError}。**不发任何事件**（文件头的定夺）。
 *
 * `deps` 是**必填**的（M5/T3 起），与 `queueTriggers` / `applyInterceptors` 同一条理由：
 * 光环与附魔的定义都在 bundle 里，忘了传 = 全场加成**静默**归零，而"卡偶尔不生效"
 * 是最难排的症状。不需要 bundle 的调用点（测试、只想跑流水线的桩）传
 * `handlers/index.ts` 的 `NO_DEPS`，那正是 M2~M4 的退化形态：两个 Σ 都是空和 ⇒ `tags = base`。
 */
export function refreshAuras(state: GameState, deps: TriggerDeps): void {
  const entities = Object.values(state.entities);
  const lookup = deps.enchantments ?? NO_ENCHANTMENTS;
  // 第 1 趟：tags = base + Σ附魔，flags = baseFlags + Σ附魔（逐实体独立，顺序无关）
  for (const entity of entities) {
    refreshOne(entity, lookup);
  }
  // 第 2 趟：在第 1 趟的盘面上求值全部光环，收齐之后再统一加（见文件头）
  const grants = collectAuraGrants(state, entities, deps);
  for (const entity of entities) {
    const grant = grants.get(entity.id);
    if (grant === undefined) {
      continue;
    }
    entity.tags = addTagValues(entity.tags, grant.tags);
    entity.flags = entity.flags | grant.flags;
  }
}
