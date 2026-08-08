// bun:test 的最小类型垫片（与 packages/ir/src/bun-test.d.ts 同源）。
//
// 为什么 cards 需要自己的一份：本包 tsconfig 是 `types: []`，且 turbo boundaries 的
// `pure` tag 明确 deny 了 `@types/bun`（架构 §2.2 禁令 5：packages/* 必须运行时中立）。
// 每个包的 `tsc --noEmit` 是**独立的 program**（架构 §4.3 不用 project references），
// 别的包那两份垫片没有被本包的 `import` 图触达，所以本包的 *.test.ts 写
// `import { test } from "bun:test"` 会报 TS2307。
// 而 packages/cards/biome.json 的 overrides 又专门为测试文件放行了 `bun:test`
// —— 说明测试就该写在这里。缺的只是类型。
//
// 这份垫片只声明测试运行器的形状，**不引入任何 Bun.* 全局**，因此不破坏禁令 5。
// 只覆盖本包测试实际用到的匹配器，用到新的再往下加。
//
// ⚠️ 同一个 TS program 里只能有一份 `declare module "bun:test"`，否则 TS2300 重复标识符。
// 本包如需再加，请改这个文件，不要在子目录另起一份。
// 若外层日后改用统一方案（根 tsconfig.base 配 typeRoots / 统一放 tools/types/），
// 请把本文件与 ir / engine 的那两份一起删掉。

declare module "bun:test" {
  interface Matchers<T> {
    toBe(expected: T): void;
    toEqual(expected: unknown): void;
    toStrictEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeGreaterThan(expected: number): void;
    toHaveLength(expected: number): void;
    toMatch(expected: string | RegExp): void;
    toThrow(expected?: string | RegExp): void;
    readonly not: Matchers<T>;
  }

  type TestBody = () => void | Promise<void>;

  export function expect<T>(actual: T): Matchers<T>;
  export function test(name: string, body: TestBody): void;
  export function it(name: string, body: TestBody): void;
  export function describe(name: string, body: () => void): void;
}
