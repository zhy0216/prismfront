// 流水线第 2 步：拦截器 / 替换效果（框架 §4.1 的 `applyInterceptors`）。
// 来源：框架 §4.1（`const action = applyInterceptors(...); if (action === CANCELLED) continue;`）、
//       IR v1 §4.2（Intercept 的形状与应用顺序）、IR v1 §10.6（圣盾的规范写法）、
//       IR v1 §7（拦截器链长度上限 8）、IR v1 §5.3 规则 1（动作内快照）、
//       IR v1 §5.4 规则 5（拦截器必须确定性）、
//       DSL v2 §3.4（`act.strike` 内部走 `act.hit` 管线，所以拦 `act.hit` 对战斗同样生效）。
//
// ⚠ 拦截器与触发器**必须分开**（IR v1 §4.2 原文）：圣盾、免疫、减伤、"改为受到 1 点伤害"
//   不是事后反应，而是**修改正在发生的动作**。混进 trigger 里时序永远对不上。
//
// ═══════════════════════════════════════════════════════════════════════════
// 一条动作在本文件里经历什么（M5/T2 的实现纲要）
// ═══════════════════════════════════════════════════════════════════════════
//   ① 收候选：**场上**每个实体的 `card.script.intercepts`，按 `intercept === act.op` 过滤
//   ② 排序  ：`priority` **降序**，打平按 playOrder（复用 `triggers.ts` 的唯一口径）
//   ③ 逐条  ：`filter` 命中判定 → `cond` 判定 → 命中则应用 `effect`、记下 `then`
//   ④ 收尾  ：`then` 一律**入栈**（时序规则 2），返回改写后的动作或 {@link CANCELLED}
// 链长（真正**应用**了几条）超过 {@link MAX_INTERCEPT_CHAIN} ⇒ 抛 {@link InterceptChainError}。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 时序：`then` 必须**入栈**，不是就地执行（框架 §4.1 时序规则 2）★
// ═══════════════════════════════════════════════════════════════════════════
// 拦截器命中后追加的 `then` 属于「连锁」。就地执行会让它插到**当前动作的死亡结算之前** ——
// 圣盾的"清掉自己的标志位"就可能早于它所挡下的那次伤害生效，于是一次出手能同时
// 「被挡下」又「把盾用掉两次」。入栈之后 `then` 落在下一次 `stack.pop()`，
// 而当前这一步的第 ④~⑥ 步（触发排队、死亡结算、光环重算）先跑完。
// 落点是 `push.ts` 的 {@link pushPendingInOrder}，本文件不自己写 `state.stack.push`。
//
// 多条拦截器都带 `then` 时，**执行顺序 = 应用顺序**（高优先级的 `then` 先跑）：
// 一次性按执行顺序交给 `pushPendingInOrder`，那一次 LIFO 反转由 `push.ts` 负责。
// 逐条各 push 一次是错的 —— 后 push 的会压在上面，顺序恰好倒过来。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 被拦动作的字段：惰性读 + 记忆化 + **回写冻结**（IR v1 §5.3 规则 1）★
// ═══════════════════════════════════════════════════════════════════════════
// `filter` 要读被拦动作的实体字段（`act.hit.target`），`num.field` 要读它的数值字段
// （`act.hit.amount`）。两者都是 IR 节点，**求值就可能推进 RNG**（`sel.random` /
// `num.random`）。若本层求一次、handler 再求一次，就会出现两件坏事：
//   1. IR v1 §5.3 规则 1「动作内快照」跨不过拦截器这道坎 ——
//      拦截器看见的目标与 handler 真正打的目标**不是同一批**；
//   2. 同一次随机被推进两轮，回放里凭空多出一条 `engine.random_picked`。
// 所以读一次就**把结果冻回动作里**（数值 → 字面量，实体 → `sel.entity` / `sel.or`），
// 之后 handler 拿到的是同一份快照。惰性 + 记忆化的形态与 `act-slots.ts` 给位置参数的
// 处理完全一致：**没有拦截器读过的字段一个都不求值，读过的也只求值一次**。
//
// ⚠ 这条机制保证的**只有**「同一个字段不会被求值两次」。它**不**保证
//   「盘面上有没有拦截器，一条动作消耗的随机数条数一样」—— 那句话是假的，
//   而且两个方向都假（相同盘面、相同种子，只差 `deps` 里认不认识那张拦截器卡，实测）：
//   - **变少**：一条**无 `filter` 无 `cond` 的纯 `cancel`** 撞上
//     `act.hit(sel.random(敌方战线), num.random(1,6))` ⇒ 有卡时事件流是 `[]`（0 次推进），
//     没那张卡是 `[random_picked ×2, damaged]`（2 次）—— 动作没执行，它的字段一个都没求。
//     `retarget` / `set_field` 同理但只少一条：它们**直接覆盖**那个字段
//     （{@link ActView} 的 `writeTarget` / `writeNum` 只看字段在不在，不求原节点），
//     被覆盖掉的那个 `sel.random` / `num.random` 于是一次都不推进。
//   - **变多**：`act.hit` 的 handler 在目标为空时**连 `amount` 都不求**
//     （`handlers/damage.ts` 明写的静默跳过），而拦截器 `cond` 里的 `num.field("amount")`
//     已经把它求过了 ⇒ 打空气时有卡推进 1 次、没卡 0 次。
//   回放仍然可复现（盘面与 bundle 都是回放输入的一部分），所以这不是确定性事故；
//   但**别**把上一段读成"拦截器不改变随机流"。★ 求值**顺序**同样会变，见下面第二条 ⚠。
//
// ⚠ 冻结的代价（有意接受，写在这里免得将来当成 bug 排）：IR 没有「有序的多实体字面量」
//   选择器 —— `sel.entity` 只能表达一个，`sel.or` 会**按 playOrder 重排**（IR v1 §3.1）。
//   于是一个被拦截器读过的、**多目标**的字段，其枚举顺序会从原来的顺序（例如 `sel.zone`
//   的格序 0→8）归一到 `sel.or` 的规范顺序，可观测面是 AoE 的 `damaged` 事件顺序。
//   两害相权：重复求值会直接打掉规则 1（而且带随机时结果都不一样），比枚举顺序归一严重得多。
//   真要两全，得给 IR 补一个有序的多实体运行时超集节点（`sel.entity` 收 id 列表），
//   那是一次 `irVersion` minor + M11 校验跟进的改动，不在本条目范围内。
//
// ⚠ 冻结的第二项代价（同样有意接受）：**同一条动作里多个随机字段的求值顺序会变**。
//   惰性读 = 「谁先被拦截器读到，谁先求值；**没被读到的留给 handler**」。
//   ⚠ 倒序**不是**因为拦截器自己的读取顺序反了 —— 它恰好是正的：`filter` 读的是
//   **实体**字段（{@link FILTER_FIELDS} 与 `ACT_ENTITY_FIELDS` 同序）、`cond` 里的
//   `num.field` 读的是**数值**字段，`filter → cond` 就是
//   `ACT_ENTITY_FIELDS → ACT_NUM_FIELDS`，与 IR v1 §5.4 规则 1 的签名序**同向**。
//   真正倒序的来源是**读了后面的、没读前面的**：一条只读 `amount`（`cond` 写
//   `num.field`）、不碰 `target`（无 `filter`，或 `filter` 不提 `target`）的拦截器，
//   让 `amount` 在第 ② 步就求了值，而 `target` 要等第 ③ 步的 handler ——
//   于是这一条动作上的两个随机字段按 `amount → target` 求值，与签名的
//   `target → amount` 相反。两个字段都读、或都不读，顺序都是正的。
//   实测（相同盘面、相同种子，只差 `deps` 里认不认识那张拦截器卡）：
//   `act.hit(sel.random(敌方战线), num.random(1,6))` 撞上一条只读 `amount` 的拦截器
//   （`cond` 写 `num.field`）⇒ 抽出 `[3, 2]`，4 点落在敌方第 3 格；
//   没有那张卡时按签名顺序 ⇒ 抽出 `[0, 2]`，3 点落在第 1 格。
//   这一项与前面那条「随机数条数」的 ⚠ 是两件独立的事：那里说**次数**，这里说**顺序**。
//   本例两边恰好都推进 2 次（那条拦截器只读、不覆盖任何字段），差别全在取值顺序上。
//   回放仍然可复现（盘面与 bundle 都是回放输入的一部分），不是确定性事故 ——
//   但读者极容易把它读成"没有随机分叉"，所以在这里点明，并由
//   `__tests__/interceptors.test.ts` 的「求值顺序」那条**钉住现状**。
//   要连顺序一起两全，得让 {@link createActView} 在首次被读时按
//   `ACT_ENTITY_FIELDS` → `ACT_NUM_FIELDS` 的签名顺序一次性冻结**全部**字段。
//   那样求值顺序会回到规范序，代价是同时放弃「没被读过的字段一个都不求值」——
//   任何一条拦截器只要读了一个字段，该动作**所有**多目标字段的枚举顺序都会无条件
//   归一到 `sel.or`（上一条 ⚠ 的代价从"被读过的字段"扩大到"全部字段"）。
//   那是一次语义变更，不在本条目范围内。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 确定性：`filter` / `cond` 里**不得**出现 `*.random`（IR v1 §5.4 规则 5）★
// ═══════════════════════════════════════════════════════════════════════════
// 规范把这条列为 **L3 校验**（IR v1 §7：「确定性：`aura` / `intercept.cond` 内出现
// `*.random` → 错误」），落地在 M11。引擎侧仍然留一道**运行时防线**
// {@link InterceptRandomError}：匹配阶段（`filter` + `cond`）跑完后数一次 RNG 推进
// （{@link randomAdvancesSince}），多出来就抛。两条理由：
//   a. L3 只点名了 `cond`，而 `filter` 的值是 `Sel`，`sel.random` 同样能写进去 ——
//      这道防线覆盖的范围比 L3 大；
//   b. 引擎不是只吃自家 bundle 的（架构 §5.1 的载入期比对至今没有实现），
//      "静默地让随机流分叉"是本仓最不能接受的失败形态。
// **例外**：读被拦动作的字段（`num.field` / `filter` 读 `act.target`）本身可能推进 RNG，
// 那是**动作自己**的随机，不是拦截器的 —— 读取器把这种推进单独记账，防线据此免判。
// ★ 记账按**次数差**而不是"变没变"：一条拦截器完全可以**既**读了被拦动作的随机字段、
//   **又**在自己的 `filter` 里写 `sel.random`（`filter{target: sel.random(…)}` 去拦
//   `hit(sel.random(…), 1)` 就是），那时"rng 变了"与"读取器也读过"同时成立 ——
//   按"变没变"记账会整道防线免判，违规**静默通过**（实测如此）。
//   按次数记则是「读了 k 次就只允许恰好 k 次推进」，多出来的那次必是拦截器自己的。
// **不覆盖**：`effect` 里的 `value` / `delta` / `to`。它们每个动作至多求值一次
// （匹配阶段则是每个候选都要跑），"转移给一个随机友军"是合法卡面，不该被拦下。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 边界：本条目**不实现挂起式拦截器**（`rules/combat.ts` 的原子性约束仍然成立）★
// ═══════════════════════════════════════════════════════════════════════════
// `rules/combat.ts` 文件头的 ⚠ 写着：战斗批次是**原子**的，第 ③ 步不检查 `pendingInput`，
// 因为"剩下的出手"是那个函数的局部变量，落盘之后就没了。
// M5/T2 之后这条约束**依然成立**，理由是结构性的：
//   - 四种 `effect`（`cancel` / `set_field` / `mod_field` / `retarget`）都只改写动作节点，
//     一个都不挂起；
//   - `then` 是**入栈**的，本函数返回时它还没执行 —— 在 `resolve()` 里它等下一次弹栈，
//     在战斗第 ③ 步里它被 `harvest` 收进本地链条。
// ⚠ 唯一能打破它的写法是**把会挂起的动作写进 `then`**（`act.select_target` /
//   `act.discover`）：那样战斗批次会带着一个已置位的 `pendingInput` 继续跑完。
//   在 L3 补上"`intercept.then` 不得含挂起点"之前，这是一条**写卡约束**。
//   谁要真正打破它（例如"受到伤害时，选择一个目标转移过去"），必须**先**把战斗的
//   剩余快照放进 `GameState`（于是它要被投影 / 回放 / 快照一路照顾到），
//   再让第 ③ 步检查 `pendingInput` —— 那是一次有成本的设计变更，不是补一个 `if` 的事。
//
// ═══════════════════════════════════════════════════════════════════════════
// 三个「为什么是这样」
// ═══════════════════════════════════════════════════════════════════════════
// ── 1. 为什么多一个 `deps` 参数 ──────────────────────────────────────────────
// 拦截器写在 `card.script.intercepts` 里，而**行为不进状态**（框架 §3.1）——
// 引擎只能经 `deps.scripts`（`deps.ts` 的 `ScriptLookup`）去 bundle 里查。
// `state` 与 `ctx` 都给不出脚本，所以签名必须收下它。这与 M5/T1 让 `queueTriggers`
// 的 `deps` 变成**必填**是同一件事、同一条理由：忘了传 = 这一步**静默地**一条拦截器都不收，
// 而"卡偶尔不生效"是最难排的症状。收 {@link TriggerDeps}（`ResolveDeps` 继承它），
// 于是两个调用点原样把手里的 `deps` 传下去即可。
//
// ── 2. 为什么只收**场上**实体的拦截器 ───────────────────────────────────────
// IR v1 §4.2 没有给 Intercept `zone` 字段（Trigger §4.1 有，默认 `"board"`），
// 于是引擎必须自己定一个，这里取与 Trigger 默认值相同的 `"board"`：
// 拦截器改的是**正在发生的动作**，一张还躺在牌库 / 手牌 / 墓地里的卡不该有这个能力
// （否则"牌库里的卡在给全场减伤"，而且它连自己在不在场都不知道）。
// 代价：base 实体在 `"base"` 区（`state/create.ts`）因而不参与 —— 它的 `cardId` 是保留值
// `__base`，本来也查不到脚本。将来要做"基地护甲减伤"，正确的做法是给 IR 的 Intercept
// 补 `zone` 字段，而不是在这里加一条 `|| zone === "base"` 的特判。
//
// ── 3. 为什么**没有**第二个来源（附魔不带拦截器）─────────────────────────────
// 触发器有两个来源（卡的 `script.triggers` + 附魔的 `script.triggers`，IR v1 §2.3），
// 拦截器**只有一个**：IR v1 §2.3 的 `EnchantmentScript` 只有 `triggers` / `auras`。
// 于是"用附魔授予圣盾"目前只能授予 `divine_shield` 这个**标志位**，
// 挡伤害的那条拦截器仍须写在卡上。要让附魔也能带拦截器，得先给 IR 补字段
// （`irVersion` minor + M11 校验跟进），不在本条目范围内。

import type {
  Act,
  ActEntityField,
  ActNumField,
  ActOp,
  Cond,
  EntityId,
  Intercept,
  InterceptFilter,
  Num,
  Sel,
  ZoneName,
} from "@prismfront/ir";
import type { EvalEnv } from "../eval/index.ts";
import { assertNever, createEvalEnv, evalCond, evalNum, evalSel } from "../eval/index.ts";
import type { GameEvent } from "../events/index.ts";
import { drainEventLog } from "../events/index.ts";
import type { CtxBindings, GameState, PendingAction } from "../state/index.ts";
import { createCtx, zoneOf } from "../state/index.ts";
import type { TriggerDeps } from "./deps.ts";
import { NO_SCRIPTS } from "./deps.ts";
import { inlinePending, pushPendingInOrder } from "./push.ts";
import { compareOwnerOrder } from "./triggers.ts";

/**
 * 「该动作被取消」的哨兵（框架 §4.1 的 `CANCELLED`）。
 *
 * 用字符串常量而不是 `null`：`null` 会和「没有拦截器」「求值为空」混淆，
 * 而这三件事在流水线里的处理完全不同。`Act` 是对象联合，与字符串永不相撞，
 * 于是 `action === CANCELLED` 就是一次零成本、无歧义的判别。
 *
 * 被取消**不等于什么都没发生**：拦截器的 `then` 仍然执行（IR v1 §4.2），
 * 圣盾就是靠这一点在挡下伤害的同时清掉自己的标志位。
 */
export const CANCELLED = "__cancelled" as const;

/** {@link applyInterceptors} 的返回类型：改写后的动作，或 {@link CANCELLED}。 */
export type InterceptResult = Act | typeof CANCELLED;

/** 拦截器链长度上限（IR v1 §7 资源上限表）。计的是**真正应用了几条**，见 {@link applyInterceptors}。 */
export const MAX_INTERCEPT_CHAIN = 8;

/** 判别 {@link InterceptResult}。写成类型守卫，调用点不必重复字面量。 */
export function isCancelled(result: InterceptResult): result is typeof CANCELLED {
  return result === CANCELLED;
}

/**
 * 一条动作上被应用的拦截器超过了 {@link MAX_INTERCEPT_CHAIN}（IR v1 §7 资源上限）。
 *
 * 形态与理念照抄 `resolve.ts` 的 `ResolutionLoopError`：它**不是「非法意图」**
 * （那一类由 `apply()` 回 `ok:false` 的原因码），而是**卡牌数据 / 盘面失控**。
 * 吞掉它只会让一条动作被十几层替换效果改得面目全非，而那种局面既没人看得懂、
 * 也不可能在事后归因。
 *
 * 抛错前把事件日志排空并挂在 {@link events} 上：`events/log.ts` 定死了
 * 「`apply()` / `resume()` 返回时 `state.eventLog` 必为空」这条不变量，
 * **抛错路径也不例外**。注意 `state` **不会**被回滚：引擎不做事务。
 */
export class InterceptChainError extends Error {
  /** 被突破的上限值。 */
  readonly limit: number;
  /** 被拦的那个 op。 */
  readonly op: ActOp;
  /** 抛错前排空的事件（见类说明）。 */
  readonly events: readonly GameEvent[];

  constructor(limit: number, op: ActOp, events: readonly GameEvent[]) {
    super(`动作 ${op} 上的拦截器链超过 ${limit} 层（IR v1 §7 资源上限）`);
    this.name = "InterceptChainError";
    this.limit = limit;
    this.op = op;
    this.events = events;
  }
}

/**
 * 拦截器的**匹配阶段**推进了 RNG（IR v1 §5.4 规则 5 的运行时防线）。
 *
 * 见文件头「确定性」一节：这条本该由 L3（M11）在编写期挡住，引擎侧留一道防线是因为
 * L3 只点名了 `cond`（`filter` 的 `Sel` 里同样能写 `sel.random`），
 * 而且架构 §5.1 的载入期比对至今没有实现。
 *
 * **读被拦动作的字段所推进的 RNG 不算**（那是动作自己的随机）——
 * 读取器单独记账，本错误据此免判，所以 `hit(target, num.random(1,3))` 撞上圣盾
 * （`cond` 里读 `num.field("amount")`）不会误伤。免判按**次数差**算
 * （读了 k 次就只允许恰好 k 次推进），于是「既读了随机字段、又自带 `sel.random`」
 * 的拦截器照样会被抓住 —— 那正是"变没变"式记账的盲区，见文件头「确定性」一节的 ★。
 */
export class InterceptRandomError extends Error {
  /** 违规拦截器的宿主实体。 */
  readonly owner: EntityId;
  /** 被拦的那个 op。 */
  readonly op: ActOp;
  /** 抛错前排空的事件（同 {@link InterceptChainError}）。 */
  readonly events: readonly GameEvent[];

  constructor(owner: EntityId, op: ActOp, events: readonly GameEvent[]) {
    super(
      `实体 ${owner} 在拦截 ${op} 的匹配阶段推进了 RNG：` +
        `intercept 的 filter / cond 里不得出现 *.random（IR v1 §5.4 规则 5）`,
    );
    this.name = "InterceptRandomError";
    this.owner = owner;
    this.op = op;
    this.events = events;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 被拦动作的字段视图（惰性读 + 记忆化 + 回写冻结）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `filter` 的键**按这个固定顺序**求值。
 *
 * 不按 `Object.keys(filter)` 走，理由与 `triggers.ts` 的 `FILTER_FIELDS` 逐字相同：
 * 那是 JSON 的键序，同一条拦截器在不同产物里可能不同，而键的求值顺序会变成
 * 「被拦动作的哪个字段先被冻结」的顺序。
 *
 * engine 对 ir 是**纯类型依赖**（架构 §2.2 禁令 1），不能 import `ACT_ENTITY_FIELDS`
 * 这个值，所以本地重列。两个方向都由类型钉死，见下面那条 `satisfies` 与
 * {@link _FilterFieldsAreExhaustive}。顺序与 `ir/src/types/act.ts` 的
 * `ACT_ENTITY_FIELDS` 逐字一致。
 */
const FILTER_FIELDS = [
  "target",
  "player",
  "attacker",
  "a",
  "b",
  "to",
] as const satisfies readonly ActEntityField[];

/** 编译期断言：`T` 必须为 `ActEntityField` 的**每个**取值都列了一项。 */
type CoversEveryActEntityField<T extends Record<ActEntityField, true>> = T;

/**
 * {@link FILTER_FIELDS} 的**反方向**钉子：上面那个 `satisfies` 只保证「名字没写错」
 *（写错 / 多写 → 编译错），这一行保证「一个不少」。
 *
 * 少一个字段是**静默**的失败：`InterceptFilter = Partial<Record<ActEntityField, Sel>>`
 * （IR v1 §4.2），ir 哪天加了第七个实体字段而这里没跟上，{@link matchesFilter} 的 `for`
 * 会把那个键整条跳过 ⇒ 卡上写了的那条 filter 键**形同虚设**、拦截器多命中一片
 * （圣盾写 `{新字段: …}` 就退化成**无条件** `cancel`），而且没有任何症状指向这里。
 * 钉成编译错误之后，报的是
 * 「Property 'xxx' is missing … Record<ActEntityField, true>」。
 *
 * 与 `triggers.ts` 的同名 `_FilterFieldsAreExhaustive` 是同一个钉子的两份实例
 * （那边钉的是 `EventEntityField`）；表从 {@link FILTER_FIELDS} **摊**出来而不是
 * 另抄一份清单 —— 抄一份就又多了一个会漂的真相源。
 */
type _FilterFieldsAreExhaustive = CoversEveryActEntityField<{
  [K in (typeof FILTER_FIELDS)[number]]: true;
}>;

/** `Act` 上按字段名读写的**擦除后**视图。全模块只有下面两个函数用它做断言。 */
type ErasedAct = Record<string, unknown>;

/**
 * 取动作上一个字段的原始值。
 *
 * `Act` 是可辨识联合，TS 表达不了「任意成员上名为 f 的那个字段」（correlated union
 * 索引，TS 至今没有对应的类型运算），所以这里必须有一次断言 ——
 * 把它关在本函数与 {@link withField} 两处，与 `deps.ts` 的 `ErasedActHandler` 同款处理。
 * 断言之后的**种类**由 {@link selFieldOf} / {@link numFieldOf} 在运行期判，不靠类型。
 */
function rawField(act: Act, field: string): unknown {
  return (act as unknown as ErasedAct)[field];
}

/** 改写动作的一个字段，返回**新**节点（不改入参：栈条目里可能还引用着原节点）。 */
function withField(act: Act, field: string, value: unknown): Act {
  return { ...(act as unknown as ErasedAct), [field]: value } as unknown as Act;
}

/** 一个值是不是 `op` 以给定前缀开头的 IR 节点。 */
function isNodeOf(value: unknown, prefix: string): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const op = (value as { op?: unknown }).op;
  return typeof op === "string" && op.startsWith(prefix);
}

/**
 * 动作上某个实体字段的 `Sel`；没有这个字段、或它不是 `Sel` ⇒ `null`。
 *
 * ⚠ 种类判断不能省：`"to"` 在 `act.steal` 里是 `Sel`、在 `act.move_to` 里是 **SlotRef**
 * （`ir/src/types/act.ts` 的 `ACT_ENTITY_FIELDS` 点名说了只有前者可作过滤对象）。
 * 靠 `op` 前缀区分是唯一不需要在引擎里重抄一份"哪个 op 有哪些字段"的办法 ——
 * 重抄一份就必然与 IR 漂移。
 */
function selFieldOf(act: Act, field: ActEntityField): Sel | null {
  const raw = rawField(act, field);
  return isNodeOf(raw, "sel.") ? (raw as Sel) : null;
}

/**
 * 动作上某个数值字段的 `Num`；没有这个字段、或它不是 `Num` ⇒ `null`。
 *
 * ⚠ 同样不能省种类判断：`act.set_flag.value` 是 **boolean**（`ir/src/types/act.ts`
 * 的 `ACT_NUM_FIELDS` 点名说了对它用 `num.field` 无意义）。
 * 字面量数字是 `Num` 的合法成员（IR v1 原则 4），所以 `typeof === "number"` 单列一支。
 */
function numFieldOf(act: Act, field: ActNumField): Num | null {
  const raw = rawField(act, field);
  if (typeof raw === "number") {
    return raw;
  }
  return isNodeOf(raw, "num.") ? (raw as Num) : null;
}

/**
 * 把一批实体 id 冻结成一个 `Sel`（IR v1 §5.6 的运行时超集）。
 *
 * 恰好一个 ⇒ `sel.entity`，与 `rules/combat.ts` 冻结战斗快照的写法一致。
 * 其余（含空集）⇒ `sel.or`，代价是**枚举顺序被归一到 playOrder 升序**，见文件头的 ⚠。
 */
function frozenSel(ids: readonly EntityId[]): Sel {
  const only = ids[0];
  if (ids.length === 1 && only !== undefined) {
    return { op: "sel.entity", id: only };
  }
  const of: Sel[] = ids.map((id) => ({ op: "sel.entity", id }));
  return { op: "sel.or", of };
}

/**
 * 从 `mark` 这个日志位置起，RNG 被推进了**几次**。
 *
 * 数的是 `engine.random_picked`：`eval/context.ts` 的 `rollInt` 是求值器推进 RNG 的
 * 唯一入口，而它每推进一次就发恰好一条这个事件（`events/event.ts` 要求的一一配对），
 * 于是"数事件"就等于"数次数"。
 *
 * ★ 为什么不比 `state.rng`：它只有 `s0` / `s1` 两个字、没有计数器，比它只能回答
 *   「变没变」，回答不了「变了几次」—— 而 {@link InterceptRandomError} 的防线要的
 *   正是次数（见文件头「确定性」一节的 ★）。
 *
 * 只扫 `mark` 之后的那一小段（匹配阶段只追加、不排空日志），所以成本与整局长度无关。
 */
function randomAdvancesSince(state: GameState, mark: number): number {
  let count = 0;
  for (let i = mark; i < state.eventLog.length; i += 1) {
    if (state.eventLog[i]?.name === "engine.random_picked") {
      count += 1;
    }
  }
  return count;
}

/** 被拦动作的可读可写视图（见文件头「惰性读 + 记忆化 + 回写冻结」）。 */
interface ActView {
  /** 当前（可能已被改写的）动作节点。 */
  current(): Act;
  /** 某个实体字段上的实体 id；动作没有这个字段 ⇒ `null`。首次读时冻结。 */
  entitiesOf(field: ActEntityField): EntityId[] | null;
  /** 某个数值字段的值；动作没有这个字段 ⇒ `null`。首次读时冻结。 */
  numOf(field: ActNumField): number | null;
  /** 写一个数值字段（`set_field` / `mod_field`）。动作没有这个字段 ⇒ **静默不写**。 */
  writeNum(field: ActNumField, value: number): void;
  /** 改写 `target`（`retarget`）。动作没有 `target` 字段 ⇒ **静默不写**。 */
  writeTarget(ids: readonly EntityId[]): void;
  /** 「读被拦动作的字段」累计推进过几次 RNG（{@link InterceptRandomError} 的免判依据）。 */
  randomReads(): number;
}

/**
 * 造一个 {@link ActView}。
 *
 * `env` 是**被拦动作自己的**求值环境（`ctx` 来自栈条目）—— 动作里的 `sel.self`
 * 指的是压栈那一方，不是拦截器的宿主。两个环境不能混，见 {@link applyInterceptors}。
 */
function createActView(env: EvalEnv, act: Act): ActView {
  let working = act;
  const entityMemo = new Map<ActEntityField, EntityId[] | null>();
  const numMemo = new Map<ActNumField, number | null>();
  let randoms = 0;

  /**
   * 求值一段节点，并记下它推进了**几次** RNG。
   *
   * 记次数而不是"有没有"：一次字段求值可以推进不止一次（`sel.random(of, n)` 抽 n 个
   * 就是 n 次，IR v1 §5.3 规则 3），而 {@link InterceptRandomError} 的免判是拿这个数
   * 去与实际推进次数对账的 —— 少记一次就等于给拦截器留了一次免费的随机。
   */
  const tracked = <T>(evaluate: () => T): T => {
    const mark = env.state.eventLog.length;
    const value = evaluate();
    randoms += randomAdvancesSince(env.state, mark);
    return value;
  };

  return {
    current: () => working,
    entitiesOf: (field) => {
      if (entityMemo.has(field)) {
        return entityMemo.get(field) ?? null;
      }
      const sel = selFieldOf(working, field);
      if (sel === null) {
        entityMemo.set(field, null);
        return null;
      }
      const ids = tracked(() => evalSel(env, sel));
      working = withField(working, field, frozenSel(ids));
      entityMemo.set(field, ids);
      return ids;
    },
    numOf: (field) => {
      if (numMemo.has(field)) {
        return numMemo.get(field) ?? null;
      }
      const node = numFieldOf(working, field);
      if (node === null) {
        numMemo.set(field, null);
        return null;
      }
      const value = tracked(() => evalNum(env, node));
      working = withField(working, field, value);
      numMemo.set(field, value);
      return value;
    },
    writeNum: (field, value) => {
      if (numFieldOf(working, field) === null) {
        return;
      }
      working = withField(working, field, value);
      numMemo.set(field, value);
    },
    writeTarget: (ids) => {
      if (selFieldOf(working, "target") === null) {
        return;
      }
      working = withField(working, "target", frozenSel(ids));
      entityMemo.set("target", [...ids]);
    },
    randomReads: () => randoms,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 候选收集与排序
// ═══════════════════════════════════════════════════════════════════════════

/** 一条候选拦截器 + 它的宿主（排序要看宿主的控制者与 playOrder）。 */
interface Candidate {
  readonly owner: EntityId;
  readonly intercept: Intercept;
}

/** `intercept.priority` 的默认值（IR v1 §4.2 原文：「默认 0。降序应用。」）。 */
const DEFAULT_PRIORITY = 0;

/** 拦截器宿主必须待着的区域，见文件头「为什么只收场上实体的拦截器」。 */
const INTERCEPT_ZONE: ZoneName = "board";

/**
 * 收集能拦下这条动作的全部拦截器，**按应用顺序**返回（IR v1 §4.2）。
 *
 * 枚举顺序 = 实体 id 升序（`Object.values` 对整数键有规范保证的顺序，同 `auras.ts` /
 * `triggers.ts`）；最终顺序由下面那次排序定死，枚举只需要**确定**，不需要"对"。
 *
 * 排序键两级：
 *   ① `priority` **降序**（IR v1 §4.2 原文）
 *   ② 打平时按 playOrder —— 直接用 `triggers.ts` 的 {@link compareOwnerOrder}，
 *      那是全引擎唯一的「谁排前面」口径（它还带着"当前回合玩家优先"与实体 id 兜底，
 *      于是结果是**全序**，不依赖排序算法的稳定性）。
 * 同一个实体的多条拦截器三级键全部打平，此时顺序 = **声明顺序**，
 * 由 `Array.prototype.sort` 的稳定性承载（ES2019 起是规范保证）——
 * 与 `triggers.ts` 文件头第 3 条是同一条论证。
 */
function collectInterceptors(state: GameState, op: ActOp, deps: TriggerDeps): Candidate[] {
  const lookup = deps.scripts ?? NO_SCRIPTS;
  const out: Candidate[] = [];
  for (const entity of Object.values(state.entities)) {
    if (zoneOf(entity) !== INTERCEPT_ZONE) {
      continue;
    }
    for (const intercept of lookup(entity.cardId)?.intercepts ?? []) {
      if (intercept.intercept === op) {
        out.push({ owner: entity.id, intercept });
      }
    }
  }
  return out.sort((a, b) => {
    const byPriority =
      (b.intercept.priority ?? DEFAULT_PRIORITY) - (a.intercept.priority ?? DEFAULT_PRIORITY);
    return byPriority !== 0 ? byPriority : compareOwnerOrder(state, a.owner, b.owner);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 匹配
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `filter` 判定（IR v1 §4.2）：**键是被拦动作的实体字段，该字段上的实体须落在该 `Sel` 内**。
 *
 * 三条容易写错的点：
 * 1. **SELF 绑的是宿主，不是动作的施动者**。圣盾写 `{target: sel.self}` = 「打到我头上时」，
 *    而 `env` 由调用方绑成宿主 —— 这正是那句写法成立的前提。
 * 2. **动作没有这个字段 ⇒ 不匹配**（不是「当作通过」）。`{attacker: …}` 拦 `act.hit`
 *    永远匹配不上：`act.hit` 没有 `attacker`。与 `triggers.ts` 的「事件负载没有这个字段
 *    ⇒ 判否」同一条推论 —— 字段上没有实体，它就不可能落在任何集合内。
 * 3. **字段求值为空 ⇒ 不匹配**。"打空气"没有被拦的对象；空集恒真会让圣盾把一条
 *    本来就什么都不做的动作也算成"挡下了一次"，白白清掉标志位。
 *
 * 多元素时是**全称量化**：动作那个字段上的实体**全部**落在 `Sel` 内才算命中。
 * 与 `cond.has_flag` 一族的读法（`eval/empty.ts` 的 `forAll`）保持一致，
 * 也是两害相权的结果 —— 拦截是**整条动作**级别的（`cancel` 取消的是整个动作），
 * 若改成存在量化，一个带圣盾的单位会让整片 AoE 对**所有人**都失效。
 * 代价是圣盾挡不住多目标 AoE 里落到自己头上的那一份；要挡住，得先把 `act.hit`
 * 拆成逐目标的动作，那是动作层的改动，不在本条目范围内。
 *
 * 求值顺序见 {@link FILTER_FIELDS}；命中失败即短路（同 `cond.and`，IR v1 §5.4 规则 3）。
 */
function matchesFilter(env: EvalEnv, view: ActView, filter: InterceptFilter | undefined): boolean {
  if (filter === undefined) {
    return true;
  }
  for (const field of FILTER_FIELDS) {
    const sel = filter[field];
    if (sel === undefined) {
      continue;
    }
    const actual = view.entitiesOf(field);
    if (actual === null || actual.length === 0) {
      return false;
    }
    const allowed = evalSel(env, sel);
    if (!actual.every((id) => allowed.includes(id))) {
      return false;
    }
  }
  return true;
}

/** `cond` 判定（IR v1 §4.2「可用 `num.field(field)` 读被拦截动作的字段值」）。没写就是恒真。 */
function matchesCond(env: EvalEnv, cond: Cond | undefined): boolean {
  return cond === undefined || evalCond(env, cond);
}

// ═══════════════════════════════════════════════════════════════════════════
// 应用
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 应用一条命中的拦截器的 `effect`（IR v1 §4.2 的四种 `kind`）。
 *
 * 返回「这个动作是否被取消」。三种非 `cancel` 的效果在**动作没有对应字段**时
 * 静默跳过（IR v1 §5.2 的基调：做不成的事静默退化，不抛）——
 * 例如 `set_field{field:"amount"}` 拦 `act.draw`（它只有 `count`）。
 * 那是写卡错误，该由 L3 在编写期挡住，运行时不值得为它掀掉房间。
 *
 * `value` / `delta` / `to` 都在**宿主**的环境里求值（`env`），并且**当场冻成字面量 /
 * `sel.entity`** 写回动作 —— 这一步不能省：handler 之后是用**动作自己的** ctx 求值的，
 * 把 `{to: sel.self}` 原样塞进去，`sel.self` 会解成出手方而不是拦截器的宿主。
 */
function applyEffect(env: EvalEnv, view: ActView, intercept: Intercept): boolean {
  const effect = intercept.effect;
  switch (effect.kind) {
    case "cancel":
      return true;
    case "set_field":
      view.writeNum(effect.field, evalNum(env, effect.value));
      return false;
    case "mod_field": {
      const current = view.numOf(effect.field);
      if (current !== null) {
        view.writeNum(effect.field, current + evalNum(env, effect.delta));
      }
      return false;
    }
    case "retarget":
      // `to` 求值成一批 id 再冻结（见函数说明）。
      view.writeTarget(evalSel(env, effect.to));
      return false;
    default:
      // ★ 穷尽检查：IR 新增一种 `effect.kind` 而这里漏写 case → 编译不过。
      return assertNever(effect);
  }
}

/**
 * 对一个即将执行的动作应用拦截器链（框架 §4.1 第 2 步 / IR v1 §4.2）。
 *
 * 参数与框架 §4.1 逐字对齐（`state, ctx, action`），外加一个 `deps` ——
 * 拦截器的唯一来源是 bundle，理由见文件头「为什么多一个 `deps` 参数」。
 *
 * ── 两个环境，不能混 ────────────────────────────────────────────────────────
 * - **动作的环境**（`ctx` 来自栈条目）：用来求值**被拦动作自己的字段**。
 *   `act.hit{target: sel.self}` 里的 `sel.self` 指压栈那一方，与拦截器无关。
 * - **宿主的环境**（`createCtx(owner)`）：用来求值拦截器的 `filter` / `cond` / `effect`
 *   与压栈 `then` 的上下文。`sel.self` = 挂着这条拦截器的实体 —— 圣盾的
 *   `{target: sel.self}` / `then: [set_flag(sel.self, …)]` 全押在这一条上。
 *   `target` / `chosen` / `it` / `event` 一律**不绑**：拦截器没有"打出时指定的目标"，
 *   要读被拦动作请写 `filter` 或 `num.field`（同 `triggers.ts` 对 `target` 的处理）。
 *
 * ── 链的推进与终止 ──────────────────────────────────────────────────────────
 * 按 {@link collectInterceptors} 给的顺序逐条判定；命中就应用 `effect`、把 `then` 记下。
 * **`cancel` 一旦命中就停止整条链**：动作已经不存在了，再让低优先级的拦截器改它没有意义，
 * 更要紧的是那样会让第二条同形的圣盾也跟着把 `then` 跑一遍 —— 一次伤害清掉两层盾。
 * 真正**应用**了几条才计入 {@link MAX_INTERCEPT_CHAIN}（IR v1 §4.2 的原文是
 * 「依次应用」）：场上摆十个圣盾但只有一个命中，那是一层链，不是十层。
 *
 * ── 返回什么 ────────────────────────────────────────────────────────────────
 * 没有任何候选 ⇒ **原样返回入参**（引用相等），一次求值都不做 ——
 * 这正是 M2~M4「没有拦截器源」那个退化形态，行为逐字不变。
 */
export function applyInterceptors(
  state: GameState,
  ctx: CtxBindings,
  act: Act,
  deps: TriggerDeps,
): InterceptResult {
  const candidates = collectInterceptors(state, act.op, deps);
  if (candidates.length === 0) {
    return act;
  }

  const actEnv = createEvalEnv(state, ctx, deps.cards, deps.enchantments);
  const view = createActView(actEnv, act);
  const queued: PendingAction[] = [];
  let applied = 0;
  let cancelled = false;

  for (const { owner, intercept } of candidates) {
    const hostCtx = createCtx(owner);
    // 宿主环境带上 `num.field` 的读取器（`eval/context.ts` 的 `ActNumFieldReader`）：
    // 动作上没有那个数值字段时读到 0，与空集合语义的数值位同调（IR v1 §5.2）。
    const hostEnv = createEvalEnv(state, hostCtx, deps.cards, deps.enchantments, (field) => {
      return view.numOf(field) ?? 0;
    });

    // ★ 匹配阶段的确定性防线（见文件头）：`filter` / `cond` 自己推进 RNG 就抛；
    //   读被拦动作字段造成的推进由 `view.randomReads()` 单独记账，不计在内。
    //   ★ 两边都按**次数**对账：读了 k 次就只允许恰好 k 次推进。写成
    //   「rng 变了 && 读取器没读过」的实现有一个盲区 —— 同一条拦截器**既**读了随机
    //   字段**又**自带 `sel.random` 时两个条件同时成立，整道防线免判（见文件头的 ★）。
    const mark = state.eventLog.length;
    const reads = view.randomReads();
    const hit =
      matchesFilter(hostEnv, view, intercept.filter) && matchesCond(hostEnv, intercept.cond);
    if (randomAdvancesSince(state, mark) !== view.randomReads() - reads) {
      throw new InterceptRandomError(owner, act.op, drainEventLog(state));
    }
    if (!hit) {
      continue;
    }

    if (applied >= MAX_INTERCEPT_CHAIN) {
      throw new InterceptChainError(MAX_INTERCEPT_CHAIN, act.op, drainEventLog(state));
    }
    applied += 1;

    cancelled = applyEffect(hostEnv, view, intercept);
    // `then` 无论取消与否都要执行（IR v1 §4.2）—— 圣盾正是靠这一点清掉自己的标志位。
    for (const one of intercept.then ?? []) {
      // 条目形态见 `push.ts` 文件头「条目形态」一节；构造走 `inlinePending`，
      // 本文件不手写 `{ via: … }` 字面量（同 `triggers.ts` / `combat.ts`）。
      queued.push(inlinePending(one, hostCtx));
    }
    if (cancelled) {
      break;
    }
  }

  // ★ 时序规则 2：`then` **入栈**，不就地执行。一次性按执行顺序交出去，
  //   那一次 LIFO 反转关在 `push.ts` 里（逐条各 push 一次会把顺序倒过来）。
  if (queued.length > 0) {
    pushPendingInOrder(state, queued);
  }
  return cancelled ? CANCELLED : view.current();
}
