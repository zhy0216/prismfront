---
title: Prismfront 工程与技术架构
date: 2026-08-07
tags: prismfront, 架构, monorepo, turborepo, bun, typescript, phaser, colyseus, 工程规范
---

# Prismfront 工程与技术架构

> 前置文档（本文全部承接，不改动其任何结论）：
> 《Colyseus 卡牌游戏技术框架设计》分层与不变量 ·
> 《卡牌 DSL 的 JSON IR 规范》v1 ·《格子战斗卡牌 DSL 规范 v2》（含 v2.1 英雄/色门/融合）·
> 《红蓝绿卡牌数值基准》v1.2 ·《Prismfront 命名与主题》包名规范 ·《世界观与背景故事》。
>
> 本文只解决既有文档的三处空白：**① Bun + Turborepo 的具体工程形态**、
> **② 客户端选型落到 Phaser 后的包边界**、**③ 把"分层铁律"从口头约定变成 CI 卡口**。
> 客户端内部设计见《Prismfront Phaser 客户端技术设计》，落地顺序见《Prismfront 实现步骤与里程碑》。

---

## 0. 一页结论

| 决策 | 结论 | 依据 |
|---|---|---|
| 包管理 + 运行时 | **Bun 1.3**（`workspaces` + `catalog:` 版本钉死） | 用户定案；顺带消掉 tsx / tsdown / vitest 三个依赖 |
| 仓库形态 | Bun workspaces + Turborepo 2.x，`packages/`（库）与 `apps/`（可运行物）二分 | 库与应用的缓存/部署策略不同 |
| 内部包构建 | **不构建**（源码包，`exports` 直指 `src/index.ts`） | Bun 原生执行 TS，这条在 Bun 下无条件成立（§4.1） |
| 语言 | TypeScript 7（仅用于 `tsc --noEmit` 类型检查，不参与运行） | 全仓 typecheck 秒级 |
| 测试 | `bun test`（Jest 兼容，内置） | 少一个依赖，且能直接跑 `.ts` |
| 客户端 | Phaser 4 + Vite 8（由 Bun 驱动） | Phaser 4 公开 API 与 3 基本一致、新渲染器 |
| 联机层 | Colyseus 0.17 + **`@colyseus/bun-websockets`**（官方 Bun 传输） | 官方支持 Bun，无需降级；但客户端 SDK 有裂口，见 §1.2 |
| 服务端部署 | `bun build --compile` 单可执行文件 | 无需 Node 基础镜像 |
| 分层强制 | `turbo boundaries` + 包 tag，违规即 CI 失败 | 把《框架设计》§2 的"铁律"变成机器可执行 |
| 校验闭环 | 确定性、隐藏信息、engine 零依赖，各一条 CI 断言 | 三者都属于"事后补代价极大" |

---

## 1. 技术选型与版本基线

### 1.1 版本基线（2026-08-07 核对 npm registry 快照）

| 用途 | 包 | 版本 | 备注 |
|---|---|---|---|
| 包管理 + 运行时 | `bun` | 1.3.14（本机已装） | `packageManager: "bun@1.3.14"` 钉死 |
| 任务编排 | `turbo` | 2.10.8 | 官方支持 bun 1.2+；配置根节点是 `tasks`，**不是 1.x 的 `pipeline`** |
| 类型检查 | `typescript` | 7.0.2（npm `latest`） | 只跑 `--noEmit`，不产出任何文件 |
| Bun 类型 | `@types/bun` | 1.3.14 | 只给 `apps/*`，**不给 `packages/*`** |
| 客户端框架 | `phaser` | 4.0.0 | ESM + 自带 `types/phaser.d.ts` |
| 客户端构建 | `vite` | 8.2.1 | 由 `bun run vite` 驱动 |
| 联机服务端 | `colyseus` | 0.17.10 | |
| Bun 传输层 | `@colyseus/bun-websockets` | 0.17.13 | 依赖 `bun-serve-express@2` + `@colyseus/core@^0.17.41` |
| 联机客户端 | `colyseus.js` | 0.16.22 | 依赖 `@colyseus/schema@^3` ← **裂口在这里，见 §1.2** |
| 校验 | `zod` | 4.4.3 | 只用于**服务端入口**校验外部输入，不进 engine |
| Lint/Format | `@biomejs/biome` | 2.5.7 | 单二进制，省掉 ESLint+Prettier 两套配置 |

版本策略：**全部走 Bun 的 `catalog`，禁止在子包里写 `^`**：

```jsonc
// package.json（根）
{
  "name": "prismfront",
  "private": true,
  "packageManager": "bun@1.3.14",
  "workspaces": {
    "packages": ["packages/*", "apps/*"],
    "catalog": {
      "typescript": "7.0.2",
      "@biomejs/biome": "2.5.7",
      "turbo": "2.10.8"
    },
    "catalogs": {
      "client": { "phaser": "4.0.0", "vite": "8.2.1", "colyseus.js": "0.16.22" },
      "server": { "colyseus": "0.17.10", "@colyseus/bun-websockets": "0.17.13", "zod": "4.4.3" }
    }
  }
}
```

子包里写 `"phaser": "catalog:client"`。卡牌游戏的隐性成本是"某次升级后回放对不上了"——
`catalog` 让升级变成改一行、且必然全仓一致。

### 1.2 三个必须在 M0 拍板的选型风险

**风险 A（阻塞级）：Colyseus 服务端与官方浏览器 SDK 存在 schema 大版本裂口。**

实测：`colyseus@0.17.10` → `@colyseus/core@0.17.47` 把 `@colyseus/schema@^4.0.7` 列为
**必需 peer**；而官方浏览器 SDK `colyseus.js` 的 `latest` 仍停在 `0.16.22`，其依赖是
`@colyseus/schema@^3.0.0`。schema 3 与 4 是序列化器的大版本差异，握手能否互通**未经验证**。

**但我们的架构天生绕得开它。**《框架设计》§7.1 已论证棋盘不进 Schema，Schema 只承载
座位/阶段/计时器等元信息——而这部分完全可以改用普通消息下发。所以出路排序是：

1. **首选：不使用 Schema。** 房间元信息与棋盘一样走 `send`/`onMessage`。
   序列化器版本差异随即与我们无关，Colyseus 退化为"带房间、匹配与重连的 WebSocket"，
   连 `colyseus.js` 的 schema 依赖都不会被触发。
2. 次选：M0 花半天做握手 spike（`colyseus.js@0.16.22` 连 0.17 服务端，验证
   join / send / 重连），通过则可以用 Schema 承载元信息。
3. 兜底：服务端降到 0.16 线配对。**代价是放弃 `@colyseus/bun-websockets`**
   （该包只有 0.17 线），也就等于放弃 Bun 原生传输——所以这条实际上最不划算。

无论走哪条，`apps/server` 必须把 Colyseus API 包在 `src/transport/` 一层之内，
房间逻辑只依赖我们自己的 `Transport` 接口。这样风险 A 无论怎么演化，都只影响一个目录。

**风险 B（中）：Bun 侧的两个新路径尚未在本项目验证。**

- `@colyseus/bun-websockets@0.17.13` 是官方包，但依赖 `bun-serve-express` 这层 shim，
  比久经考验的 `ws` 传输年轻。
- Vite 8 声明 `engines.node ^20.19 || >=22.12`，在 Bun 下运行依赖 Bun 的 Node 兼容层。

两者都在 M0 的 spike 里一次性验证（起服务端 + 起客户端 dev server + 连通一条消息）。
兜底：传输层退回 `@colyseus/ws-transport`（Bun 的 Node 兼容足以跑 `ws`），
客户端 dev 退回 Node 跑 Vite。两条退路都不影响任何业务代码。

**风险 C（低）：TypeScript 7 是原生实现的首个稳定大版本。**
本项目里 TS **不参与运行**（Bun 直接执行 `.ts`），只负责 `--noEmit` 类型检查，
所以爆炸半径极小。唯一用到 Compiler API 的是《IR 规范》§11 的 `ir:schema`
（`ts-json-schema-generator`）。若它未适配 TS 7，改用 `zod` 定义 IR 运行时 schema
并反向生成 JSON Schema——L1 结构校验本来就只需要一份可执行的 schema。

**风险 D（低）：Phaser 4 刚发布。** 官方明确"公开 API 与 Phaser 3 基本一致，内部渲染器重写，
提供迁移指南"。我们用的都是最稳定的部分（Scene、Container、Sprite、Text、Tween、
RenderTexture、Input）。回退 `phaser@3.90.x` 对客户端代码改动很小——
这也是《Phaser 客户端技术设计》坚持把编排逻辑与显示对象分离的理由之一。

---

## 2. 仓库结构与包图

### 2.1 目录

```
prismfront/
├── package.json                 # workspaces + catalog + packageManager
├── bun.lock                     # 文本锁文件，进版本库
├── bunfig.toml                  # [test] preload 等
├── turbo.json                   # 根任务定义 + boundaries 规则
├── tsconfig.base.json
├── biome.json
├── docs/                        # 既有 10 份设计文档 + 本文
├── packages/                    # 库：不产出可运行物，不构建
│   ├── ir/       @prismfront/ir      IR 权威类型 · TS builder · 三层校验器 · printer/differ
│   ├── engine/   @prismfront/engine  纯规则内核（零运行时依赖、零 Bun API）
│   ├── cards/    @prismfront/cards   卡牌脚本源 → cards.ir.json / cards.client.json
│   ├── shared/   @prismfront/shared  协议：Intent / ServerMsg / PlayerView
│   └── bot/      @prismfront/bot     随机 / 贪心 / MCTS
└── apps/                        # 应用：有部署形态
    ├── server/   @prismfront/server  Colyseus 房间与投影
    ├── client/   @prismfront/client  Phaser 4 + Vite
    └── cli/      @prismfront/cli     对局 / 回放 / ir 工具链 / 批量模拟
```

相对《框架设计》§8 的两处调整，都有明确理由：

- **拆出 `packages/ir`**：《IR 规范》§12 说"先写 §9 的 TS 类型，它是唯一权威定义，其他一切
  都从它派生"。既然是唯一权威，它就不该藏在 engine 里——`cards` 只需要类型和 builder，
  不需要 engine 运行时；`cli` 的校验器/反编译器是构建期工具，不该被打进 engine。
  拆开之后 engine 对 ir 是**纯类型依赖**（`import type`），运行时零耦合。
- **`packages/` 与 `apps/` 二分**：库要被 boundaries 约束、不构建、**不许碰 Bun API**；
  应用要部署、要有各自的 env、可以用 `Bun.serve`。混在一起这两套策略会互相打架。

### 2.2 依赖铁律

```
                    ┌─────────────┐
                    │     ir      │  ← 零依赖。IR 类型 / builder / 校验器
                    └──┬───┬───┬──┘
              type only │   │   │
                    ┌───▼─┐ │ ┌─▼──────┐
                    │engine│ │ │ cards  │  ← 依赖 ir(值)；engine 仅 devDep(测试用)
                    └──┬──┘ │ └─┬──────┘
                       │    │   │
                    ┌──▼────▼───▼──┐
                    │    shared    │  ← 协议类型
                    └──┬────────┬──┘
                       │        │
        ┌──────────────▼──┐  ┌──▼──────────────┐
        │ server / bot /  │  │     client      │
        │      cli        │  │  (Phaser)       │
        └─────────────────┘  └─────────────────┘
```

**五条禁令（由 `turbo boundaries` + Biome 强制，违反即 CI 红）：**

1. `engine` 不得有任何运行时依赖。它的 `dependencies` 必须是空对象。
2. `engine` / `ir` / `cards` 不得依赖 `colyseus`、`phaser` 或任何 I/O 库。
3. **`client` 不得依赖 `engine` 或 `cards` 的脚本产物。** 客户端只能拿到
   `cards.client.json`（展示字段）与 `shared` 的协议类型。
   这不是洁癖——客户端一旦持有卡牌逻辑，就能预判隐藏信息（《框架设计》§5.8）。
4. `cards` 对 `engine` 只能是 `devDependencies`；运行时只依赖 `ir`。
5. **`packages/*` 不得使用 `Bun.*` 全局或 `bun:` 内置模块**，也不装 `@types/bun`。
   理由：引擎必须保持运行时中立——`bun test`、未来的浏览器内模拟、AI 训练环境
   都要能跑同一份代码，且确定性不能依赖某个运行时的实现细节。
   Bun 只在 `apps/*` 出现。

### 2.3 各包职责与对外 API

| 包 | 对外导出 | 内部结构 | 不负责 |
|---|---|---|---|
| `ir` | `type Sel/Num/Cond/Act/SlotRef/Card/...`、`defineCard/defineEnchantment` 与 builder 糖、`validate(bundle)`、`printCard`、`diffBundles`、`COLOR_OWNERSHIP`（《数值基准》§1.2 色轮归属表 JSON 常量） | `types/ builder/ validate/{l1,l2,l3} tools/` | 不解释 IR（那是 engine）、不知道任何具体卡 |
| `engine` | `apply(state, intent)`、`resume(state, input)`、`legalActions(state, player)`、`project(state, viewer)`、`projectEvent`、`createGame(rules, decks, seed)`、`testkit` | `state/ rng/ resolve/ triggers/ deaths/ auras/ combat/ eval/ handlers/ view/ rules/` | 不认识网络、不认识具体卡（按 cardId 查注册表）、不读时间 |
| `cards` | `CARD_SOURCES`（TS 源）、产物 `dist/cards.ir.json`、`dist/cards.client.json` | `src/pf1/{R,G,B,heroes,tokens}/` + 同目录 `*.test.ts` | 不含引擎逻辑 |
| `shared` | `Intent`、`ServerMsg`、`PlayerView`、`ClientEvent`、`LegalMoves`、`seq` 语义常量 | 单文件为主 | 不含实现 |
| `bot` | `RandomBot`、`GreedyBot`、`Bot` 接口 | | 不认识网络 |
| `server` | 可执行 | `transport/`（Colyseus 隔离层）`rooms/ projector.ts persistence/` | 不含任何卡牌规则 |
| `client` | 可执行 | 见《Phaser 客户端技术设计》 | 不含任何卡牌规则 |
| `cli` | 可执行 | `play/ replay/ ir/ sim/` | |

---

## 3. Turborepo 任务编排

### 3.1 根 `turbo.json`

```jsonc
{
  "$schema": "https://turborepo.dev/schema.json",
  "ui": "tui",
  "globalDependencies": ["tsconfig.base.json", "biome.json", "bun.lock"],

  "tasks": {
    // 传输节点：本身不执行脚本，只把「依赖包的源文件」纳入下游任务的哈希。
    // 源码包没有 build 产物，没有它就会出现「改了 ir，cards 的缓存却命中」。
    "transit": { "dependsOn": ["^transit"] },

    "typecheck": {
      "dependsOn": ["transit"],
      "inputs": ["src/**", "tsconfig.json", "$TURBO_DEFAULT$"],
      "outputs": []
    },

    "lint": { "dependsOn": ["transit"], "outputs": [] },

    // 卡牌编译：cards/src/**.ts → IR bundle + 客户端展示数据
    "ir:build": {
      "dependsOn": ["transit"],
      "outputs": ["dist/cards.ir.json", "dist/cards.client.json"]
    },

    // 三层校验 + 资源上限 + 色轮归属 lint。CI 必过。
    "ir:validate": { "dependsOn": ["ir:build"], "outputs": [] },

    "test": {
      "dependsOn": ["transit", "^ir:build"],
      "outputs": ["coverage/**"]
    },

    // 只有 apps 实现 build
    "build": {
      "dependsOn": ["transit", "^ir:build"],
      "outputs": ["dist/**", "!dist/**/*.map"]
    },

    // 批量模拟：确定性 ⇒ 输入不变则结果不变 ⇒ 可缓存。
    // 这是本仓最贵的任务（万局对打），缓存收益也最大。
    "sim": {
      "dependsOn": ["^ir:build"],
      "env": ["SIM_GAMES", "SIM_SEED"],
      "outputs": ["reports/**"]
    },

    "dev": { "cache": false, "persistent": true }
  },

  // §2.2 禁令的机器可执行形式
  "boundaries": {
    "tags": {
      "pure": {
        "dependencies": {
          "deny": ["colyseus", "colyseus.js", "phaser", "vite", "zod", "@types/bun"]
        }
      },
      "no-rules": {
        "dependencies": { "deny": ["@prismfront/engine", "@prismfront/cards"] }
      }
    }
  }
}
```

包级 `turbo.json`（例：`packages/engine/turbo.json`）：

```jsonc
{ "extends": ["//"], "tags": ["pure"] }
```

`apps/client/turbo.json`：

```jsonc
{ "extends": ["//"], "tags": ["no-rules"] }
```

> `client` 需要卡牌的**展示数据**，但不能依赖 `@prismfront/cards` 包本身。
> 做法：`cards#ir:build` 把 `cards.client.json` 同时写入 `apps/client/src/generated/`
> （由 `outputs` 声明覆盖），客户端 `import` 一个纯 JSON。
> boundaries 的 deny 因此成立，数据依然自动同步。

`Bun.*` 禁令 boundaries 管不到（它看依赖图，不看代码），由 Biome 补上：
`packages/*/biome.json` 里对 `Bun` 全局与 `bun:*` 导入设 `noRestrictedGlobals` / `noRestrictedImports`。

### 3.2 常用命令

```bash
bun install                                    # 装依赖
bunx turbo typecheck lint test                 # 全仓，秒级
bunx turbo ir:validate                         # 卡牌 IR 三层校验 + 色轮 lint
bunx turbo dev --filter=@prismfront/client...  # 客户端及其上游一起起
bunx turbo build --filter=@prismfront/server   # 打服务端部署包
bunx turbo boundaries                          # 检查分层是否被破坏
bunx turbo sim -- --games=100000               # 批量对打，产出 winrate 表
```

根 `package.json` 里配几个转发脚本（`bun run play` / `bun run replay`），
让日常操作不必记 `--filter`。

### 3.3 CI 流水线

```
oven-sh/setup-bun@v2
bun install --frozen-lockfile
  → bunx turbo boundaries      # 分层铁律
  → bunx turbo lint typecheck  # 并行
  → bunx turbo ir:validate     # 卡牌数据闸门
  → bunx turbo test            # 含确定性 / 隐藏信息 / 时序 / 战斗四类专项
  → bunx turbo build
  → bunx turbo sim -- --games=2000   # smoke 级 fuzz；夜间任务跑 10 万局
```

远程缓存（Vercel Remote Cache 或自建 S3 兼容后端）在 `sim` 上收益最大，
建议在有第二个开发者或接入 CI 的当天就开。

---

## 4. TypeScript 与运行策略

### 4.1 内部包不构建

```jsonc
// packages/engine/package.json
{
  "name": "@prismfront/engine",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./testkit": "./src/testkit/index.ts" },
  "dependencies": {},                         // ← 铁律：永远为空
  "devDependencies": { "@prismfront/ir": "workspace:*" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  }
}
```

`exports` 直指 `.ts` 源码。**Bun 原生执行 TypeScript，包括 workspace 链接进来的包**，
所以内部包没有构建步骤，也就没有构建顺序问题——`turbo` 的图只剩下
`transit`（哈希传播）和真正产出文件的 `ir:build` / `build`。

> 这一条在 Node 下是有代价的（Node 的类型剥离不覆盖 `node_modules`，得靠
> tsx/tsdown 兜底）。**换到 Bun 之后代价消失**：开发、测试、生产、CLI 全都直接跑
> `.ts`，工具链净减少 `tsx`、`tsdown`、`vitest` 三个依赖。这是本次选型最实在的收益。

TypeScript 因此**只承担类型检查**（`tsc --noEmit`），一个字节的 JS 都不产出。

### 4.2 `tsconfig.base.json`

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "preserve",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,     // slots[i] 返回 T|undefined，9 格数组必需
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "erasableSyntaxOnly": true,           // 禁 enum/namespace/参数属性，保证可被纯剥离
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "noEmit": true,
    "skipLibCheck": true
  }
}
```

`noUncheckedIndexedAccess` 对本项目不是可选项：`slots: (EntityId|null)[]` 的越界访问
正是《DSL v2》§3.1"无效槽"语义的来源，类型系统必须逼着每处都处理。

`erasableSyntaxOnly` 与 Bun 的类型剥离执行模型天然配套——写不出 Bun 跑不掉的语法。

**`lib` 里没有 `DOM`，`types` 里没有 `bun`**。
`apps/client` 自己加 `"lib": ["ES2023", "DOM"]`；`apps/server`、`apps/cli` 自己加
`"types": ["bun"]`。§2.2 第 5 条禁令因此在类型层面就成立：
`packages/*` 里写 `Bun.file(...)` 直接编译不过。

### 4.3 不用 project references

TS 7 的全量检查已经足够快，`references` 的增量收益不抵配置复杂度与
"改了上游忘了重建"的坑。若将来 typecheck 超过 10 秒再引入。

---

## 5. 跨包契约

全仓只有三份契约需要版本化管理，其余都是普通类型。

### 5.1 `cards.ir.json` —— 引擎的输入

《IR 规范》§2.1 的 bundle。要点原样保留：`irVersion`（本项目为 `2.1.0`）、
`bundleId`、`opsUsed`。**每场对局开始时钉住 bundleId 并写进回放**，
平衡性补丁不会让历史回放失真。

engine 启动时用 `opsUsed` 与自己支持的 op 集做一次全集比对，
不匹配立即拒载——不要等某张卡被打出来才炸。

### 5.2 `cards.client.json` —— 客户端的输入

只含展示字段：`id / name / text / kind / cost / colors / atk / health / rarity / art`。
**绝不含 `script`。** 由 `ir:build` 从同一份源产出，所以不会漂移。
产物同时写到 `packages/cards/dist/` 与 `apps/client/src/generated/`（后者进 `.gitignore`）。

### 5.3 `shared` 协议

在《框架设计》§7.3 基础上，按 v2 / v2.1 玩法更新：

```ts
// client → server
export type Intent =
  | { t: "mulligan";  keep: EntityId[] }
  | { t: "deploy";    placements: { hero: EntityId; slot: number }[] }  // v2.1 §11.3
  | { t: "play_card"; card: EntityId; target?: EntityId; at?: number; option?: string }
  | { t: "pass" }                                                       // v2 §4.1
  | { t: "respond";   chosen: EntityId | string }
  | { t: "concede" };

// server → client
export type ServerMsg =
  | { t: "snapshot"; seq: number; view: PlayerView; legal: LegalMoves }
  | { t: "events";   seq: number; events: ClientEvent[] }
  | { t: "prompt";   request: InputRequest }
  | { t: "rejected"; code: IllegalReason }
  | { t: "over";     winner: PlayerId | null; reason: EndReason };
```

相对 v1 协议的三处变化，全部来自玩法定案：**删 `attack`**（v2 无攻击 intent，战斗由引擎
自动结算）、**删 `end_turn` 改 `pass`**（v2 §4.1 连续双 pass 进战斗）、
**加 `deploy`**（v2.1 英雄部署；服务端聚合双方秘密选择后喂单个 intent，引擎保持单输入模型）。

`LegalMoves` 必须携带**不可打出的理由**，而不只是一个布尔——
色门锁定要在 UI 上说"没有红色光源"（《命名与主题》§2：主题替玩家记忆规则）：

```ts
export type IllegalReason =
  | "NOT_YOUR_PRIORITY" | "NOT_ENOUGH_CRYSTALS"
  | "COLOR_GATE_LOCKED"      // 附带缺哪个颜色
  | "NO_EMPTY_SLOT" | "INVALID_TARGET" | "WRONG_PHASE";
```

---

## 6. 三条必须由 CI 守住的不变量

《框架设计》把这三条列为"最容易被跳过、也最容易返工"。本节给出可执行形式。

### 6.1 确定性

```ts
// packages/engine/src/__tests__/determinism.test.ts
import { test, expect } from "bun:test";

test("同 seed 同意图序列 → 终局状态哈希一致", () => {
  const a = runMatch({ seed: 0x9F1, decks, intents });
  const b = runMatch({ seed: 0x9F1, decks, intents });
  expect(hash(a.state)).toBe(hash(b.state));
});

test("序列化往返不改变结算结果", () => {
  const s = midGameState();
  const revived = JSON.parse(JSON.stringify(s));
  expect(hash(apply(s, intent).state)).toBe(hash(apply(revived, intent).state));
});
```

第二条是《框架设计》§13"已知的坑 3"的守卫：
状态里一旦混进函数 / class 实例 / Map，它立刻会红。

配套 lint：`engine` 内禁用 `Math.random`、`Date`、`console`、`process`、`Bun`
（Biome 的 `noRestrictedGlobals`）。

### 6.2 隐藏信息

```ts
test("发给 P1 的字节里不含 P0 任何手牌 cardId", () => {
  const wire = JSON.stringify(collectAllMessagesFor(1, matchLog));
  for (const id of p0HandCardIds) expect(wire).not.toContain(id);
});
```

要点（《框架设计》§6）：隐藏牌仍要有**稳定的 `entityId`**，只是 `cardId` 为 `null`，
否则"抽牌→飞入手牌→打出翻开"的动画接不上。

### 6.3 引擎零依赖 / 运行时中立

```ts
test("engine 无运行时依赖", () => {
  expect(pkg.dependencies ?? {}).toEqual({});
});
```
加上 `turbo boundaries` 的 `pure` tag 与 §4.2 的 `types` 隔离，三重保险。

---

## 7. 测试策略

沿用《框架设计》§9 的四层，按本项目玩法补第五层。全部用 `bun test`。

| 层 | 位置 | 内容 |
|---|---|---|
| 1 单卡 | `packages/cards/src/**/*.test.ts` | 每张卡 3 行。新增卡必须带测试 |
| 2 时序 | `packages/engine/src/__tests__/timing/` | 触发顺序、连锁死亡、光环失效、亡语递归 |
| 3 **战斗结算** | `packages/engine/src/__tests__/combat/` | **本项目特有**：快照冻结、同归于尽、拦截器消耗顺序、`direction` 出界打基地、stunned 不出手 |
| 4 不变量 fuzz | `apps/cli` 的 `sim` | 随机 bot 万局，每步断言：血量非负、单实体不跨区、槽位无重复占用、`clone` 一致 |
| 5 隐藏信息 | `apps/server` | §6.2 |

第 3 层是新增的重点。《DSL v2》§4.2 把"同时结算"定义成两个"不"——
**不中途死亡结算、触发器只入栈不结算**——各需要一个专门的回归测试：

```ts
test("先被打死的单位本轮照样打出伤害（同归于尽）", ...);
test("战斗中亡语召唤的单位不获得本轮出手（快照已冻结）", ...);
test("荆棘卫士本轮被打死，反伤仍然发出", ...);   // v2 §8.6
```

回放测试：线上崩溃的 `{seed, decks, intents}` 直接落成一条回归用例。

`bunfig.toml`：

```toml
[test]
preload = ["./test-setup.ts"]
coverage = true
coverageThreshold = { line = 0.8 }
```

---

## 8. 运行与部署

| 目标 | 命令 | 产物 |
|---|---|---|
| 本地全栈 | `bunx turbo dev --filter=@prismfront/client... --filter=@prismfront/server...` | Vite dev server + `bun --hot` |
| 无 UI 跑一局 | `bun run play --seed 1 --p0 greedy --p1 random` | 终端逐步打印状态与事件 |
| 回放 | `bun run replay ./replays/xxx.json --step` | |
| 服务端部署 | `bun build src/index.ts --compile --outfile dist/prismfront-server` | **单个自包含可执行文件**，无需运行时镜像 |
| 客户端部署 | `bunx turbo build --filter=@prismfront/client` | 静态站点 |

服务端是有状态长连接进程，起步单进程；扩容按《框架设计》§7.4 上 Redis
`Presence` + `Driver`。`bun build --compile` 让容器镜像可以是 `scratch`/`distroless`，
这是 Bun 相对 Node 部署链路的另一处实在收益。

**不要在 M9 之前碰部署。**

---

## 9. 本文明确不做的

- **不做 `project references`**（§4.3）。
- **不做内部包发布到 npm**。全部 `"private": true`。想复用引擎是以后的事。
- **不做 Colyseus Schema 承载棋盘**（承接《框架设计》§7.1，不重新论证）；
  按 §1.2 首选方案，元信息也不用 Schema。
- **不做客户端预演/本地规则**。客户端零规则是隐藏信息安全的前提，不是性能取舍。
- **不在 `packages/*` 里用任何 Bun 专有 API**（§2.2 第 5 条）。Bun 是运行时，不是依赖。
- **不做 Docker 化开发环境**。`bun install` 足够；容器只用于部署，且因 `--compile` 极薄。

## 10. 待办：规范文档的一致性清理

通读既有文档时发现若干处需要在 M1 写 `packages/ir` 类型时统一，
**一律以最新定案为准**，改完回写规范：

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| 1 | DSL v2 §0 vs §11 | `irVersion` 一处写 `2.0.0`、一处写 `2.1.0` | 定为 `2.1.0` |
| 2 | DSL v2 §6 `RulesConfig` | 仍写 `heroHp: 30`，但 v2.1 已把承伤实体改名 base | 改 `baseHp: 30` |
| 3 | IR v1 §3.1 `ZoneName` | 缺 v2.1 的 `"base"` 与 `"fountain"`，且 `"hero"` 语义已变 | 补齐并删 `"hero"` 旧义 |
| 4 | DSL v2 §7 | `Side = "friendly"\|"enemy"`（slot 用）与 `sel.zone` 的 `side` 含 `"both"` 同名不同集 | 拆成 `SlotSide` / `SelSide` |
| 5 | 数值基准 §7 | `stunned` flag 要求写进 v2 §4.2 战斗快照条件，v2 正文尚未回写 | 快照条件定为 `atk > 0 && !stunned` |
| 6 | DSL v2 §11.5 | `deploySchedule: [2, 1]` 与 §11.3 的文字描述需对齐字段语义 | 注释为「r1 部署 2 名、r2 部署 1 名」 |

这些都是文档级笔误或未回写，不影响任何已定案的设计结论；列出来是为了让 M1 一次性做干净。
