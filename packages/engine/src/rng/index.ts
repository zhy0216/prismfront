// packages/engine/src/rng —— 引擎唯一的随机源（框架 §4.3、架构 §2.3 的 `rng/`）。
//
// 对外三样东西，都在 rng.ts 里：
//   RngState          纯数据的两字段状态，直接放进 GameState.rng（框架 §3.1 的 GameState）
//   createRngState    种子 → 状态。`createGame(rules, decks, seed)` 应当用它建局，
//                     别在别处手搓 `{ s0: seed, s1: 0 }` —— 那会绕开播种混合，
//                     相邻种子的开局会高度相关。
//   nextInt           唯一的随机出口，原地推进 state.rng，`[0, max)` 上均匀无偏
//
// 引擎里**不允许**存在第二个随机源：`Math.random` 已被 engine 的 biome.json 封死
// （架构 §6.1 的配套 lint），凡是需要随机的地方一律注入 `HasRng` 并调 `nextInt`。
//
// 算法选型（xoroshiro64**）、跨平台逐位一致性的论证、取模偏置的处理方式，
// 全写在 rng.ts 的文件头注释里 —— 改动本模块前先读那段，它直接决定回放能不能复现。
//
// 本模块零依赖：不 import 任何东西，也不 import `@prismfront/ir`（架构 §2.2 禁令 1
// 要求 engine 的 dependencies 恒为空，对 ir 只能是纯类型依赖）。

export type { HasRng, RngState } from "./rng.ts";
export { createRngState, NEXT_INT_MAX_BOUND, nextInt } from "./rng.ts";
