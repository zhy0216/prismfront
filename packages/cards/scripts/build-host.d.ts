// 构建脚本的宿主接口垫片（与 `src/bun-test.d.ts` 同一个理由，只是换了一组名字）。
//
// 为什么本包连 `console` / `URL` 都要自己声明：
//   架构 §2.2 禁令 5 要求 `packages/*` 运行时中立 —— 不装 `@types/bun`
//   （turbo boundaries 的 `pure` tag 明确 deny 了它），本包 tsconfig 又是 `types: []`，
//   而 `tsconfig.base.json` 的 `lib` 只有 `ES2023`（没有 DOM）。
//   于是宿主提供的一切（`console`、`process`、`URL`、`import.meta.url`）在类型层面都不存在。
//
// 为什么 I/O 走 `node:fs` 而不是 `Bun.write`：
//   `Bun.*` 被本包的 biome.json 直接拦下（禁令 5），而 `node:fs` 在 bun 与 node 下都能跑，
//   反而更符合"运行时中立"。biome 的 `noRestrictedImports` 只拦 `bun` / `bun:*`，不拦 `node:*`。
//
// 边界（改之前先读）：
//   1. 这里的签名是**手写的最小子集**，只覆盖 `scripts/` 真正用到的调用形式，
//      不是 `@types/node` 的等价物。用到新东西就往下加一条，别把它当完整类型用。
//   2. 只有 `scripts/` 可以用这些名字。`src/` 是纯函数（卡表 → bundle），
//      一旦在 src 里看到 `writeFileSync` 或 `process`，就是这条分界线破了。
//   3. 装了 `@types/node` 之后请删掉本文件（同一个 program 里重复声明会 TS2300）。

interface ImportMeta {
  /** 当前模块的 URL。用它定位产物路径，避免依赖 cwd（turbo 与手跑的 cwd 不一定相同）。 */
  readonly url: string;
}

declare class URL {
  constructor(input: string, base?: string | URL);
  readonly href: string;
  readonly pathname: string;
}

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 非零退出码 = 闸门不通过。CI 只看这个（架构 §3.3）。 */
  exit(code: number): never;
};

declare module "node:fs" {
  export function mkdirSync(path: URL | string, options?: { recursive?: boolean }): void;
  export function writeFileSync(path: URL | string, data: string): void;
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
}
