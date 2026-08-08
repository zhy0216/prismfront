// 属性修改：`act.set_tag` / `act.mod_tag` / `act.buff` / `act.set_flag`。
// 来源：IR v1 §3.4（四个动作的签名）、IR v1 §2.3（附魔实例：ench / source / duration）、
//       框架 §4.1 时序规则 4（光环是重算而非增量）、v2 §2.3（direction 是普通 Tag）、
//       v2 §5（`buffed` / `direction_changed` 的负载）。
//
// ⚠ `act.set_flag` 是 **M5/T2 才补上的**：它不是"顺手实现一个 op"，而是拦截器的
//   标准用例硬要求的一环 —— IR v1 §10.6 的圣盾把 `then` 写成
//   `[set_flag(SELF, "divine_shield", false)]`，没有这个 handler，"挡一次"就退化成
//   "永远挡"，而那种测试只能验证「拦截器响了」，验证不了「盾用掉了」。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ `set_tag` / `mod_tag` 写 `base`，不写 `tags` —— 并且这就是"扛得住沉默"的定义 ★
// ═══════════════════════════════════════════════════════════════════════════
// `resolve/auras.ts` 把这个取舍留给了 M4/M5：这类直改究竟写 `base`，
// 还是转成一条永久附魔挂上去（那样 `act.silence` 能把它剥掉）。
//
// **本里程碑拍板：写 `base`。** 三条理由：
// 1. `tags` 是派生值，每一步都被 `refreshAuras` 从 `base` 重算覆盖（时序规则 4）——
//    写 `tags` 等于写一个下一行就被抹掉的缓存，症状是"改了没生效"；
// 2. IR v1 §3.4 把 `act.buff{ench}` 与 `act.set_tag/mod_tag` 分成了两个动作，
//    前者显式带附魔 id、后者不带。既然不带 ench，就没有可供 `act.silence` 剥离的
//    附魔实例 —— 硬造一条匿名附魔等于替规范发明一个它没写的实体；
// 3. 于是语义清清楚楚：**要能被沉默剥掉就写 `act.buff`，不要被剥就写 `act.set_tag`。**
//    写卡人在两个动作之间选，而不是靠猜引擎的内部实现。
//
// ⚠ 代价（写给 M5）：`act.silence` 复位到 `base`，因此 `set_tag` 改过的值**沉默不掉**。
//   这与炉石的"设置属性类效果沉默后不还原"一致，但真要改，改的是本文件而不是 silence。

import type { EntityId, TagKey } from "@prismfront/ir";
import { evalNum } from "../eval/index.ts";
import { emitEvent } from "../events/index.ts";
import type { ActHandler } from "../resolve/index.ts";
import type { EntityData, GameState } from "../state/index.ts";
import { hasFlag, maskWith, tagOf } from "../state/index.ts";
import { frozenEntities, snapshot, sourceOf } from "./targets.ts";

/**
 * 写一个 tag 的**卡面值**并发对应事件。
 *
 * 事件二选一，不叠发：
 * - `direction` → `direction_changed{target, from, to}`（v2 §5）。
 *   direction 是普通 Tag 而非新机制（v2 §2.3），所以走这条路的不只是"转向"卡，
 *   附魔 / 光环 / 沉默改到它时同样该发这个事件（M5 补那几条路）。
 * - 其余 tag → `buffed{source, target, ench: null}`（`events/event.ts`：
 *   `act.set_tag` / `act.mod_tag` 这类不经附魔的直改发 `ench: null`）。
 *
 * **值没变就不发事件**：`set_tag(atk, 3)` 打在一个 atk 已经是 3 的单位上不是一件
 * 发生过的事，发出去只会让"每当属性被修改"的触发器（M5）凭空触发。
 *
 * `from` 取**生效值** `tags`（v2 §5 的 `direction_changed` 说的是"生效方向改变"），
 * `to` 取写完之后的 `base`。M4 里两者相等（`refreshAuras` 的两个 Σ 还是空和），
 * M5 加上附魔与光环之后 `to` 要改成"重算后的生效值"—— 那时这一行会需要跟着动。
 */
function writeTag(
  state: GameState,
  entity: EntityData,
  tag: TagKey,
  value: number,
  source: EntityId | null,
): void {
  const from = tagOf(entity, tag);
  if (from === value) {
    return;
  }
  entity.base[tag] = value;
  // 顺手把派生值对齐，免得同一步里后续动作读到旧值（第 ⑥ 步才会重算）。
  entity.tags[tag] = value;
  if (tag === "direction") {
    emitEvent(state, { name: "direction_changed", target: entity.id, from, to: value });
    return;
  }
  emitEvent(state, { name: "buffed", source, target: entity.id, ench: null });
}

/**
 * `act.set_tag{target, tag, value}` —— 直接设置属性。
 *
 * ★ 目标只求值一次、`value` 也只求一次（IR v1 §5.3 规则 1 / §5.4 规则 1：
 * 字段按声明顺序 target → tag → value）。
 */
export const setTagHandler: ActHandler<"act.set_tag"> = (env, act) => {
  const targets = snapshot(env, act.target);
  if (targets.length === 0) {
    return;
  }
  const value = evalNum(env, act.value);
  const source = sourceOf(env);
  for (const target of frozenEntities(env, targets)) {
    writeTag(env.state, target, act.tag, value, source);
  }
};

/**
 * `act.mod_tag{target, tag, delta}` —— 增减属性。
 *
 * 基准是**每个目标各自的生效值**（`tags`），不是 `base`：
 * "全体 +1 攻" 打在一个吃了光环的单位上应当是 `生效值 + 1`。M4 里两者相等，
 * 但按生效值写才是规则 4 想要的读法（读派生、写卡面）。
 *
 * `delta === 0` 由 {@link writeTag} 的"值没变不发事件"自然吸收
 * （IR v1 §9 对字面量 0 的 `act.shift` 给的是编写期告警，不是运行期错误）。
 */
export const modTagHandler: ActHandler<"act.mod_tag"> = (env, act) => {
  const targets = snapshot(env, act.target);
  if (targets.length === 0) {
    return;
  }
  const delta = evalNum(env, act.delta);
  const source = sourceOf(env);
  for (const target of frozenEntities(env, targets)) {
    writeTag(env.state, target, act.tag, tagOf(target, act.tag) + delta, source);
  }
};

/**
 * `act.buff{target, ench}` —— 附加附魔（IR v1 §3.4）。
 *
 * 挂的是一条**附魔实例**（`state/entity.ts` 的 `AttachedEnchantment`）：
 * `{ench, source, duration}`，三个字段全是纯数据、`source` 是 id 引用。
 * 加成本身（`mods` / `flags`）**不写进实体** —— 由流水线第 ⑥ 步 `refreshAuras`
 * 每步从 `base` 重算加出来（时序规则 4：重算而非增量）。M4 的 `refreshAuras`
 * 还没有那个 Σ，所以本动作在 M4 里除了事件与 `enchantments` 数组之外没有可观测效果；
 * M5 补上 Σ 之后**本文件一行都不用改**。
 *
 * `duration` 必须从 bundle 的附魔定义里取（IR v1 §2.3 决定何时剥离），
 * 所以要 `EvalEnv.enchantments`（`resolve/deps.ts` 的注入口）。
 * **查不到定义 ⇒ 静默跳过**：挂一条不知道何时该剥的附魔，比不挂更糟 ——
 * 它会永久地留在实体上，而且沉默之外没有任何东西能清掉它。
 *
 * `source` 取 SELF，取不到实体时给 `0`（`state/create.ts`：实体 id 从 1 起，
 * 0 是"没有实体"的哨兵）—— `AttachedEnchantment.source` 的类型是 `EntityId`
 * 而不是 `EntityId | null`，`duration: "while_source_alive"` 用它判存续，
 * 一个查不到的 source 天然等价于"来源已不在"。
 */
export const buffHandler: ActHandler<"act.buff"> = (env, act) => {
  const targets = snapshot(env, act.target);
  if (targets.length === 0) {
    return;
  }
  const ench = env.enchantments(act.ench);
  if (ench === undefined) {
    return;
  }
  const source = sourceOf(env);
  for (const target of frozenEntities(env, targets)) {
    target.enchantments.push({ ench: act.ench, source: source ?? 0, duration: ench.duration });
    emitEvent(env.state, { name: "buffed", source, target: target.id, ench: act.ench });
  }
};

/**
 * `act.set_flag{target, flag, value}` —— 置/清一个标志位（IR v1 §3.4）。
 *
 * ⚠ `value` 是 **boolean**，不是 `Num`（`ir/src/types/act.ts` 点名说了），
 * 所以这里一次 `evalNum` 都没有 —— 顺带地，本动作**一次 RNG 都不推进**。
 *
 * ── 写 `baseFlags`，与 {@link writeTag} 写 `base` 是同一条规矩 ────────────────
 * `flags` 是派生值，每一步都会被 `refreshAuras` 从 `baseFlags` 重算覆盖
 * （框架 §4.1 时序规则 4，M5/T3 之后还会加上附魔与光环的 Σ）。写 `flags` 等于写一个
 * 下一行就被抹掉的缓存 —— 症状是"圣盾用掉了又回来了"。顺手把派生值对齐，
 * 免得同一步里后续动作读到旧值（第 ⑥ 步才会重算）。
 *
 * ⚠ 代价，与 `act.set_tag` 那条完全对称：T3 补上 Σ 之后，**附魔/光环授予的标志位
 *   清不掉** —— 本动作只动 `baseFlags`，下一次重算又会把 Σ 加回来。
 *   语义因此是清楚的：要能被清掉就写卡面标志位，要持续生效就挂附魔/光环。
 *
 * ── 不发事件 ────────────────────────────────────────────────────────────────
 * v2 §5 的 25 个事件名里**没有**"标志位变化"这一条（`buffed` 说的是属性/附魔）。
 * 借一个名字发出去，只会让监听 `buffed` 的触发器为一次不存在的加成而触发；
 * 自造一个新名字则要动 IR 的 `EventName`（`irVersion` minor + 触发器词汇表跟进）。
 * 所以这里**一个事件都不发**，可观测面是盘面本身 —— 与 `handlers/board.ts` 的
 * 那些位置原语同一个取舍。
 *
 * **值没变就不写**：与 {@link writeTag} 的"值没变不发事件"同一条理由，
 * 且让"这一步真的改了东西"在测试里可判别（读的是**生效值**，`state/queries.ts` 的 `hasFlag`）。
 */
export const setFlagHandler: ActHandler<"act.set_flag"> = (env, act) => {
  const targets = snapshot(env, act.target);
  if (targets.length === 0) {
    return;
  }
  for (const target of frozenEntities(env, targets)) {
    if (hasFlag(target, act.flag) === act.value) {
      continue;
    }
    target.baseFlags = maskWith(target.baseFlags, act.flag, act.value);
    target.flags = maskWith(target.flags, act.flag, act.value);
  }
};
