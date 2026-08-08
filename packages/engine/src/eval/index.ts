// eval/ —— DSL 求值器（架构 §2.3 的 `eval/`，IR v1 §5 求值语义）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 四个求值函数，一条铁规矩：穷尽 switch
// ═══════════════════════════════════════════════════════════════════════════
//   evalSel     (env, Sel)      -> EntityId[]        选择器   sel.ts
//   evalNum     (env, Num)      -> number            数值     num.ts
//   evalCond    (env, Cond)     -> boolean           条件     cond.ts
//   evalSlot    (env, SlotRef)  -> SlotAddr | null   位置     slot.ts
//   evalCardRef (env, CardRef)  -> CardId | null     卡引用   card.ts（E4 补入）
//
// 五个都写成 `switch (node.op) { … default: return assertNever(node); }`。
// **IR 加了一个 op 而这里漏写 case ⇒ 编译不过**（`context.ts` 的 `assertNever`）。
// 这正是 `ir/src/types/index.ts` 文件头承诺的那件事：可辨识联合 + TS 穷尽检查
// 是求值器与 handler 表的兜底。漏一个 op 若变成运行时静默跳过，症状会是
// 「某张卡偶尔不生效」—— 在随机对局里未必显形，代价远高于一次编译错误。
//
// ═══════════════════════════════════════════════════════════════════════════
// 三份共用的语义，各自只有一处实现
// ═══════════════════════════════════════════════════════════════════════════
//   empty.ts    **空集合语义统一表**（IR v1 §5.2）+ 无效槽（v2 §3.1）+ `forAll`
//               —— 规范原文就叫"统一规则，不许各 op 各自发明"，所以取值只写在那里。
//               ★ 全 IR 唯一的例外 `num.slot_index → -1` 也在那张表上单列一行。
//   context.ts  求值环境（`GameState` + `CtxBindings` + 卡表）、侧别换算、
//               `assertNever`、以及**唯一的 RNG 入口** `rollInt`。
//   sel.ts      `single`（"恰好一个实体"的共同判据）与 `evalEntities`。
//
// ═══════════════════════════════════════════════════════════════════════════
// 求值顺序 = RNG 顺序（IR v1 §5.4，必须写死）
// ═══════════════════════════════════════════════════════════════════════════
// 推进 RNG 的节点：`sel.random`、`num.random`、`slot.random_empty`（v2 §3.1 补入），
// 外加 E4 的 `card.random`。它们全部经 `context.ts` 的 `rollInt` → `rng/nextInt`。
// 五条规则的落地位置：
//   1. 字段按**签名声明顺序**求值            → 各 op 的分支，注释逐条点名
//   2. `Act[]` 按数组下标升序               → E4（`resolve/push.ts` 已经是 LIFO 反转）
//   3. `cond.and` / `cond.or` **短路**       → cond.ts（短路会跳过右侧的 RNG 消耗）
//   4. `act.when` 只求值命中的分支           → E4；数值版 `num.if` 在 num.ts
//   5. 光环重算 / 死亡结算**不得消耗 RNG**   → `resolve/auras.ts`、`resolve/deaths.ts`
//                                             都不 import 本目录的随机路径
// ⚠ 规则 3 与 4 的实现要点是一样的：**只求值命中的那一支**。
//   写成"先把两个分支都算出来再选"会多消耗一整条分支的 RNG，单测全绿、回放失真。
//
// ═══════════════════════════════════════════════════════════════════════════
// 本目录**不**做的事
// ═══════════════════════════════════════════════════════════════════════════
// - 动作求值与 handler 表（`Record<Act["op"], Handler>`）→ E4 的 `handlers/`。
//   IR v1 §5.3 的规则 1（动作内快照：`target` 求值一次、全程冻结）与规则 2
//   （`act.repeat` 每轮重新求值）都落在那里，本目录只提供"求一次值"的能力。
// - 触发器 / 拦截器 / 光环的求值接线 → M5。其中 `num.field` 需要的"被拦动作"上下文
//   已由 M5/T2 扩到 `EvalEnv.field` 上（一个**读取器**而不是动作节点本身，
//   理由见 `context.ts` 的 `ActNumFieldReader`）；接线方是 `resolve/interceptors.ts`。
//
// E4 补入的一支：`card.ts`（`CardRef` 求值）。`card.pool` 仍求不出来 ——
// `filter` 里 `sel.it` 绑定的是**卡**而不是实体，与 `CtxBindings.it`（`EntityId`）
// 不是同一个取值域，且引擎手里没有「枚举全卡池」的能力（见该文件头）。

export { evalCardRef } from "./card.ts";
export { evalCond } from "./cond.ts";
export type { ActNumFieldReader, CardLookup, EnchantLookup, EvalEnv } from "./context.ts";
export {
  assertNever,
  cardDataOf,
  controllerOfSelf,
  createEvalEnv,
  NO_CARDS,
  NO_ENCHANTMENTS,
  playerEntityId,
  resolveSelSides,
  resolveSlotSide,
  rollInt,
  withIt,
} from "./context.ts";
export { EMPTY_SET, forAll, INVALID_SLOT } from "./empty.ts";
export { evalNum } from "./num.ts";
export { evalEntities, evalSel, single } from "./sel.ts";
export type { SlotAddr } from "./slot.ts";
export { evalSlot, isSlotAddrOccupied } from "./slot.ts";
