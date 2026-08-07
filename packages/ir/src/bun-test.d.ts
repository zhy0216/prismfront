// bun:test 的最小类型垫片。
//
// 为什么需要它：packages/* 的 tsconfig 是 `types: []`，且 turbo boundaries 的 `pure` tag
// 明确 deny 了 `@types/bun`（架构 §2.2 禁令 5：packages/* 必须运行时中立）。
// 于是 packages/ir 里的 *.test.ts 写 `import { test } from "bun:test"` 会报 TS2307。
// 而 packages/ir/biome.json 的 overrides 又专门为测试文件放行了 `bun:test`
// —— 说明测试就该写在这里。缺的只是类型。
//
// 这份垫片只声明测试运行器的形状，**不引入任何 Bun.* 全局**，因此不破坏禁令 5。
// 只覆盖本包测试实际用到的匹配器，用到新的再往下加。
//
// ⚠️ 全仓应当只存在一份 `declare module "bun:test"`。若外层日后改用别的方案
// （根 tsconfig.base 配 typeRoots / 统一放 tools/types/），请把本文件删掉。

declare module "bun:test" {
  interface Matchers<T> {
    toBe(expected: T): void;
    toEqual(expected: unknown): void;
    toStrictEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toHaveLength(expected: number): void;
    toThrow(expected?: string | RegExp): void;
    readonly not: Matchers<T>;
  }

  type TestBody = () => void | Promise<void>;

  export function expect<T>(actual: T): Matchers<T>;
  export function test(name: string, body: TestBody): void;
  export function it(name: string, body: TestBody): void;
  export function describe(name: string, body: () => void): void;
  export function beforeAll(body: TestBody): void;
  export function afterAll(body: TestBody): void;
  export function beforeEach(body: TestBody): void;
  export function afterEach(body: TestBody): void;
}
