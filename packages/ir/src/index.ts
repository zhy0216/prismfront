// @prismfront/ir —— IR 权威类型 · TS builder · 校验器 · printer（架构 §2.3）
//
// 内部结构：types/ builder/ validate/ tools/ + color-ownership.ts
// 不解释 IR（那是 engine），不知道任何具体卡。**零运行时依赖。**
//
// 架构 §2.3 的对外契约：
//   type Sel/Num/Cond/Act/SlotRef/Card/...   ← types/
//   defineCard / defineEnchantment + builder 糖  ← builder/
//   validate(bundle)                          ← validate/
//   printCard                                 ← tools/
//   COLOR_OWNERSHIP                           ← color-ownership.ts
//   diffBundles                               ← bundle structural diff

export * from "./builder/index.ts";
export * from "./color-ownership.ts";
export * from "./tools/index.ts";
export * from "./types/index.ts";
export * from "./validate/index.ts";

// —— 命名消歧 ——
// `Aura` 在两处出现且**分属不同命名空间**，所以可以共存，但必须显式 re-export：
//   types/aura.ts   : `interface Aura`  —— IR §4.3 的光环节点类型（类型空间）
//   builder/aura.ts : `function Aura()` —— 构造该节点的糖（值空间）
// 只靠上面两条 `export *` 会报 TS2308（星号导出之间的同名歧义）；
// 而两条显式 re-export 并排写会报 TS2300（导出名重复）——因为 `export {}` 形式
// 会同时占据类型与值两个空间。可行的写法是**本地各声明一次**：
// 同一作用域里一个类型别名 + 一个 const 同名是合法的（interface + const 的经典模式），
// 且本地声明会遮蔽星号导出。两者由此各归其位：
//   `import type { Aura }` 拿到 IR 节点类型，`Aura(...)` 拿到构造函数。
import { Aura as AuraBuilder } from "./builder/index.ts";
import type { Aura as AuraNode } from "./types/index.ts";

export type Aura = AuraNode;
export const Aura = AuraBuilder;
