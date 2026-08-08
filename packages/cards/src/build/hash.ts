// 内容指纹 —— `bundleId` 的来源（IR §1 原则 1：**确定性构建**）。
//
// 为什么要自己写一个散列，而不是 `Bun.hash` / `node:crypto`：
// 架构 §2.2 禁令 5 要求 `packages/*` 运行时中立（`Bun.*` 被包级 biome 直接拦下），
// 而 `node:crypto` 又把一个平台模块拖进纯包。散列在这里只做**构建指纹**，
// 不做签名、不做安全用途，十几行纯 TS 足够，还顺带保证任何 JS 运行时上结果一致。
//
// 算法：FNV-1a 64 位（Fowler-Noll-Vo, 1991）。选它的理由是简单 + 可验证 ——
// 它有公开的测试向量，下面的测试直接钉住 `""` / `"a"` / `"foobar"` 三条。
//
// ⚠ 一处**有意的偏离**：标准 FNV 吃的是**字节流**，这里吃的是 **UTF-16 code unit**。
//    取字节需要 `TextEncoder`，而它属于 DOM/Web lib，本包的 `lib: ES2023` 里没有
//    （tsconfig.base 不带 DOM，正是禁令 5 那条运行时中立的一部分）。
//    影响：纯 ASCII 输入下两者的输入序列完全相同，所以经典测试向量仍然成立；
//    含中文的输入（卡面文案）走的是本仓自己的变体。作为"同一份源 → 同一个 id"的
//    指纹这完全够用；它**不是**可跨工具复现的标准 FNV，别拿去和别处的 FNV 值比对。
//
// 用 BigInt 而不是拆 lane 的 `Math.imul`：这里不在引擎热路径上（一次构建跑一次），
// BigInt 的算术由规范定义为精确整数运算，比手工拆 32 位更难写错。
// 注意 engine 侧的 RNG 有相反的取舍（见 `packages/engine/src/rng/rng.ts`）：
// 那边的状态要进 JSON，`JSON.stringify(1n)` 直接抛，所以那边只能用 `Math.imul`。

/** FNV-1a 64 位的偏移基数与素数（FNV 官方参数）。 */
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
/** 每一步都要截回 64 位 —— BigInt 本身是任意精度的。 */
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a 64：逐个 UTF-16 code unit 吃进去（偏离说明见文件头）。 */
export function fnv1a64(text: string): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash ^ BigInt(text.charCodeAt(i))) * FNV_PRIME) & MASK_64;
  }
  return hash;
}

/** 定长 16 位十六进制的指纹文本。定长是为了让 bundleId 的形状永远一致。 */
export function fingerprint(text: string): string {
  return fnv1a64(text).toString(16).padStart(16, "0");
}
