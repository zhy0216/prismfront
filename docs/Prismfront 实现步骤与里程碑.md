---
title: Prismfront 实现步骤与里程碑
date: 2026-08-07
tags: prismfront, 实施计划, 里程碑, 路线图, 工程管理
---

# Prismfront 实现步骤与里程碑

> **执行清单见 [`todos/`](../todos/README.md)**——本文按里程碑拆成了可勾选的待办文件，
> 另有横向的《决策待办》与《风险登记册》。日常推进改那边，本文只在阶段划分本身变化时同步。
>
> 前置：《Prismfront 工程与技术架构》（包边界、Bun+Turborepo 形态）·
> 《Prismfront Phaser 客户端技术设计》·《格子战斗卡牌 DSL 规范 v2》(+v2.1) ·
> 《卡牌 DSL 的 JSON IR 规范》v1 ·《红蓝绿卡牌数值基准》v1.2。
>
> 本文替代《Colyseus 卡牌游戏技术框架设计》§12 的 M0–M8 路线图——那份路线图写于
> v2.1（英雄/色门/融合）与 Phaser 客户端定案之前，阶段划分已不适用。
> 其两条核心排期判断**原样保留**：先做纯引擎、用 CLI 跑通两个 bot 对打再接网络。

---

## 0. 三条排期原则

1. **贵的东西先做对，不是先做完。** 求值语义（IR §5）、战斗时序（v2 §4.2）、
   隐藏信息投影（框架 §6）这三样返工代价是十倍级，全部排在能跑之前。
   op 集可以增量长，语义不行。
2. **每个里程碑的完成标志是一条可执行命令**，不是"感觉做完了"。下文每个 M 都给了验收命令。
3. **关键路径是引擎，不是画面。** 客户端看起来是最大的一块（M10），
   但它靠 M8 的 golden replay 解耦，可以和服务端并行——这是全程唯一一次大的并行机会，
   要刻意为它准备（M8 的 replay 必须**刻意**覆盖战斗边界用例，不能随手存几局）。

---

## 1. 关键路径与并行机会

```
M0 ── M1 ── M2 ── M3 ── M4 ── M5 ── M6 ── M7 ── M8 ─┬─ M9  服务端 ──┐
骨架   IR   状态  回合  DSL   触发  英雄  投影  bot │              ├─ M11 ─ M12
      类型  结算  战斗  求值  光环  色门  合法  回放 └─ M10 客户端 ─┘  卡池   平衡
                   ★         ★                  ★
                                          ↑
                          卡池撰写（M11）从这里就能并行开工
```

- **★ 三个高风险节点**：M3（战斗同时结算）、M5（触发/拦截时序）、M8（fuzz 暴露深层 bug）。
  这三处各留出 50% 的缓冲。
- **M8 之后分叉**：服务端（M9）与客户端（M10）无依赖关系，`MockTransport` 让客户端
  完全不必等服务端。单人开发按 M9→M10 串行；两人开发在这里分头。
- **卡池（M11）从 M6 结束就能开工**：写卡只依赖 DSL 表达力，不依赖网络与画面。
  如果有第二个人（哪怕是策划），M6 之后就该把 33 张卡的撰写并行出去。

**粗略工作量**（单人、熟悉 TypeScript、不含美术产出）：**45–60 人日**到可联机对战。
其中客户端 M10 约占三分之一。这是估算不是承诺，M3/M5/M8 三处的实际耗时决定总量。

---

## 2. 里程碑总表

| M | 名称 | 产出 | 验收命令 | 估算 |
|---|---|---|---|---|
| M0 | 工程骨架与选型验证 | 8 包骨架、turbo、CI、**技术 spike** | `bunx turbo typecheck lint boundaries` | 1–1.5d |
| M1 | IR 权威类型与 builder | `packages/ir` | `bun test --filter @prismfront/ir` | 2–3d |
| M2 | 引擎内核 I：状态与结算骨架 | 状态/RNG/结算栈/事件流 | 确定性 + 序列化往返测试 | 3–4d |
| M3 | 引擎内核 II：回合与同时结算 ★ | v2/v2.1 状态机、战斗 | 战斗边界四测 | 4–6d |
| M4 | DSL 求值器与首批卡 | 求值器、handler 表、10 张卡 | `bunx turbo ir:build` + 单卡测试 | 4–5d |
| M5 | 触发 / 拦截 / 光环 ★ | 三分体系、附魔 | Artifact 四关键词可写 | 3–5d |
| M6 | 英雄 / 色门 / 融合 / 复燃泉 | v2.1 全套 | 色门与复活测试 | 3–4d |
| M7 | 视图投影与合法动作 | `project` / `legalActions` | 隐藏信息 grep 测试 | 2–3d |
| M8 | bot / CLI / fuzz / golden replay ★ | 可 headless 对打 | 10 万局 fuzz 无失败 | 3–5d |
| M9 | Colyseus 服务端 | 房间、计时、重连 | 两端打完一局 | 3–4d |
| M10 | Phaser 客户端 | 可玩界面 | 浏览器打完一局 | 8–12d |
| M11 | PF1 全卡池与 lint | 33 卡 + 3 英雄 | `bunx turbo ir:validate` | 4–5d |
| M12 | 平衡闭环 | winrate 表、调参流程 | 局长 6±1 回合 | 持续 |

---

## 3. 逐里程碑展开

### M0 · 工程骨架与选型验证

**做什么**

1. `bun init` → 根 `package.json` 的 `workspaces` + `catalog`（架构文档 §1.1 给了全文）。
2. 建 8 个空包，各自 `package.json` + `tsconfig.json` + 包级 `turbo.json`（打 tag）。
3. `turbo.json`、`tsconfig.base.json`、`biome.json`、`bunfig.toml`。
4. CI（GitHub Actions + `oven-sh/setup-bun@v2`），流水线按架构文档 §3.3。
5. **三个 spike，这是 M0 的真实价值所在**：
   - **Colyseus × Bun**：`colyseus@0.17.10` + `@colyseus/bun-websockets@0.17.13`
     起一个空房间；用 `colyseus.js@0.16.22` 连上，双向发一条消息，断线重连一次。
     → 结论回填架构文档 §1.2 风险 A / B，决定是否使用 Schema。
   - **Vite 8 × Bun × Phaser 4**：`bun run vite` 起 dev server，渲染一个空场景 + 一个 Sprite。
   - **boundaries 生效**：故意在 `packages/engine` 里 `import "phaser"`，
     确认 `bunx turbo boundaries` 变红，然后删掉。

**完成标志**

```bash
bunx turbo typecheck lint boundaries   # 全绿
bun run spike:colyseus                 # 打印「joined / echo / reconnected」
bun run spike:client                   # 浏览器出现一个方块
```

**为什么 spike 必须在第一天**：架构文档 §1.2 的风险 A 是唯一可能推翻联机层选型的问题。
它花半天验证，或者花两周后返工。

---

### M1 · IR 权威类型与 builder

**做什么**

1. 把 IR v1 §9 的类型 + v2 §7 的差异 + v2.1 §11 的增补，**合并成一份 `irVersion: "2.1.0"` 的完整类型**。
   顺手做掉架构文档 §10 的 6 项规范一致性清理（`baseHp`、`ZoneName` 补 `base`/`fountain`、
   `SlotSide`/`SelSide` 拆分、`stunned` 快照条件、`deploySchedule` 语义注释）。
2. TS builder 糖面：v2 §7 列的 `At / SlotOf / OPPOSITE / COMBAT_TARGET / AttackersOf /
   Adjacent / Push / Pull / Summon / Strike / defineCard / defineEnchantment`。
   builder 只是"构造 IR 节点的类型安全外壳"，实现量很小。
3. `COLOR_OWNERSHIP` 常量——《数值基准》§1.2 的色轮归属表做成 JSON，**人和 lint 读同一份**。
4. 校验器先做 L1（结构）+ L2（前缀种类），L3 语义等 op 集稳定后在 M11 补。

**完成标志**

```bash
bun test packages/ir            # 前缀校验、规范形式归一化
bun run ir:print GRID_001       # 反编译器能把 IR 打回 TS 风格文本
```
能用 builder 写出 v2 §8 的六张示例卡，产出与文档里手写 JSON 逐字节一致的规范形式。

**注意**：IR §1 原则 1「IR 是规范形式，糖只存在于编写层」要在这里立住——
`play: Hit(...)` 与 `play: [Hit(...)]` 必须产出同一份 JSON，否则后面 diff、缓存 key、
哈希全会出问题。

---

### M2 · 引擎内核 I：状态与结算骨架

**做什么**

1. 状态模型：扁平 `entities` 表、`zones`、`slots: [(EntityId|null)[], (EntityId|null)[]]`、
   `PlayerData`（`crystals`/`crystalCap`）、`stack`、`pendingInput`。
   **纯数据，实体用 id 互相引用**（框架 §3.1）——这条从第一行代码就要守死。
2. `RngState` + `nextInt`，种子入状态。
3. `resolve()` 六步流水线（框架 §4.1）：绑定上下文 → 拦截器 → handler → 触发入栈 →
   死亡结算 → 光环重算。触发/拦截/光环先留空实现，管线先立起来。
4. 事件日志与 `GameEvent`。
5. 不碰 DSL：手写几个临时 handler，跑通"抽牌 → 放单位到格 → 手动 strike → 死亡"。

**完成标志**

```bash
bun test packages/engine/src/__tests__/determinism.test.ts
```
两条确定性测试（架构文档 §6.1）通过。**第二条（序列化往返）是架构腐化的探针**，
它一红就说明状态里混进了函数或 class 实例。

**把框架 §4.1 的四条时序规则抄成 `resolve.ts` 顶部注释**，这是文档明确要求的。

---

### M3 · 引擎内核 II：回合状态机与同时结算 ★

本项目最独特、也最容易做错的一块。

**做什么**

1. **完整相位机**，一次做到 v2.1 形态，不分两步：
   ```
   round_start → deploy(若有) → actions → combat → round_end
   ```
   > 决策理由：deploy 相位只是多一个 intent 分支（v2.1 §11.3 明确说服务端聚合双方
   > 秘密选择后喂**单个** intent，引擎保持单输入模型），现在写便宜；
   > 等 M6 再往稳定的相位机里插一个新相位，则要重测全部时序。

2. 水晶：`crystalCap = min(5 + (round-1)*growth, capMax)`，每回合**回满**。
3. 行动交替：`priority` 切换、`consecutivePasses`、连续双 pass → combat。
   **pass 不锁定**（对手行动后清零）。
4. `initiative` 四种策略全部实现（`alternate` / `first_passer` / `random_each_round` /
   `fixed_first`），走 `RulesConfig` 切换——`first_passer` 是 Artifact 公认的深度来源，
   要留着在 M12 试玩对比（v2 §6）。
5. **战斗阶段严格按 v2 §4.2 五步**：
   ```
   ① combat_began → 结算栈完全清空（此时的 buff/召唤会影响快照）
   ② 快照 strikes：按 [initiative 方 0→8, 另一方 0→8] 遍历
        条件 atk > 0 && !stunned        ← 《数值基准》§7 的增补
        目标格 = 敌方行 (自己格 + 生效direction)
        越界或空 → 敌方基地
        记录 {attacker, target, amount}，此后全部冻结
   ③ 逐条应用：走 act.strike → act.hit 管线
        ★ 不做中途死亡结算   ★ 触发器只入栈不结算
   ④ 全部应用完 → 结算栈开闸 → 统一死亡 → 亡语 → 光环重算 → 循环至不动点
   ⑤ combat_ended → end_of_combat 附魔剥离 → round_end
   ```
6. `direction` 作为普通 Tag：生效值 = `base.direction + Σ附魔 + Σ光环`，
   与 atk/health 同一套管线。**不要为它写任何特殊代码**——沉默自动重置方向、
   光环批量改方向、`num.attr(of,"direction")` 可读，全部是免费获得的。

**完成标志** —— 四条测试，一条都不能少：

```ts
test("先被打死的单位本轮照样打出伤害（同归于尽成立）");
test("战斗中亡语召唤的单位不获得本轮出手（快照已冻结）");
test("方向指向空格/越界 → 伤害进敌方基地");
test("stunned 单位不进入快照");
```

**最容易写错的地方**：第 ③ 步那两个"不"。一旦在逐条应用中途做了死亡结算，
同归于尽就不成立，整个战斗手感全变——而这个 bug 在随机对局里未必立刻显形。
所以它必须有独立测试，不能靠 fuzz 兜。

---

### M4 · DSL 求值器与首批卡

**做什么**

1. `evalSel` / `evalNum` / `evalCond`，靠 TS 的穷尽检查兜底（漏一个 op 编译不过）。
2. `slot.*` 族与**无效槽语义**：动作的 SlotRef 解析为无效槽 → 该动作静默跳过。
3. handler 表 `Record<Act["op"], Handler>`。
4. **求值语义三条铁规**（IR §5.3，整份规范最容易出错处）：
   - 动作内快照：`target` 求值一次，动作全程冻结
   - `act.repeat` 每轮重新求值
   - `sel.random(n)` 一次性求值
   后两条长得像、语义完全不同 → 写进 code review checklist，并各配一条测试。
5. 空集合语义统一表（IR §5.2）、RNG 求值顺序（IR §5.4）。
6. 先支持 8–10 个最常用 op，跑通 G01–G05、R01/R07/R09、B01/B02。

**完成标志**

```bash
bunx turbo ir:build              # 产出第一个 cards.ir.json
bun test packages/cards          # 单卡测试，每张 3 行
```

---

### M5 · 触发 / 拦截 / 光环 ★

**做什么**

1. **Trigger**（事后触发）：`on` / `filter` / `cond` / `once` / `zone`。
   触发顺序：当前 priority 方优先，同方按 `playOrder` 升序。
   `deathrattle` 展开为 `{on:"unit_died", filter:{target:SELF}, zone:"graveyard"}`。
2. **Intercept**（替换效果）：`cancel` / `set_field` / `mod_field` / `retarget`，
   按 `priority` 降序，**最多 8 层**。圣盾是它的标准用例。
3. **Aura**：声明式，每步全量重算 `tags = base + Σ附魔 + Σ光环`。
   不写"加上/减掉"，"光环失效忘了减回去"这类 bug 在表达层面就不存在。
4. 附魔四种 `duration`，含 v2 新增的 `end_of_combat`。

**完成标志** —— 这是**表达力验收点**，v2 §8.7 的四条必须全部可写且测试通过：

| 关键词 | DSL 写法 |
|---|---|
| Retaliate X | `on(Struck({target: SELF}), Hit(EVENT.source, X))` |
| Cleave X | `on(Struck({source: SELF}), Hit(Adjacent(EVENT.target), X))` |
| Siege X | `on(Struck({source: SELF}), when(IsMinion(EVENT.target), Hit(ENEMY_BASE, X)))` |
| 改箭头 | `Buff(TARGET, ench)`，ench 带 `direction` mod |

三条自洽性也要一并测：溅射/反伤走 `act.hit` 不发 `struck`（不会连锁）；
Cleave 命中基地时 `Adjacent` 为空集静默跳过；Siege 打空格时 `IsMinion` 挡住双重计算。
**这三条都不需要特判**——是空集语义和事件/动作二分在兜底。如果你发现自己在写特判，
说明前面某处做错了。

**风险**：亡语递归（亡语召唤的随从又有亡语）必须有深度上限并有测试，
否则线上会无限循环把房间卡死（框架 §13 坑 5）。

---

### M6 · 英雄 / 色门 / 融合 / 复燃泉

**做什么**

1. `kind: "hero"` —— 英雄占格参战、有攻血、按方向出手、可被打，与单位同规则结算。
2. `base` 区（30 血，承接打空格的伤害，胜负判定）与 `fountain` 区。
3. 选择器词汇分化：`FRIENDLY_UNITS`（含英雄）/ `FRIENDLY_MINIONS`（排除英雄）。
   已有卡的"友方随从"语义因此自动正确（光环不吃英雄）。
4. **色门**：`card.data.colors: Color[]`（长度 1–2）。`play_card` 合法性要求
   每个颜色都有一名**己方存活在场**英雄。英雄阵亡缺席期间该色牌全部锁定。
5. **融合卡** = `colors` 长度 2，需两色英雄同时在场。
6. 部署与复活：r1 部署 2 名、r2 第 3 名；阵亡 → `fountain`，`respawnAt = 回合+2`，
   **缺席恰好一整回合**（不是两回合——这是 Artifact 调研里被反复强调的经典错误）。
7. 新事件 `hero_deployed` / `hero_died`（英雄阵亡**不发** `unit_died`，触发器需区分）。

**必守点（2026-08-08 构筑规则补订）**：v2.1 §11.1 给卡加了 `data.hero`（所属英雄，
决定组牌时能不能带这张卡）。**它是纯构筑层字段，M6 的 legality 一行都不许读它。**
`play_card` 只看 `colors` × 在场存活英雄的颜色——一张红英雄的专属卡，在该英雄阵亡、
但另一名红色光源在场时**必须可打**。PF1 每色只有一名英雄，两条判断结果永远相同，
所以写成同一条也能过测试；这正是危险所在，英雄扩池的第一天它就会炸。

**完成标志**

```ts
test("红英雄阵亡后，该回合起红色牌不可打出");
test("红英雄 r3 阵亡 → r5 部署阶段回归（只缺席一回合）");
test("融合卡需要两色英雄同时存活在场");
test("色门只看颜色不看归属：所属英雄不在场但同色光源在场 → 可打");
```

此时**卡池撰写（M11）可以并行开工**。

---

### M7 · 视图投影与合法动作

**做什么**

1. `project(state, viewer)` / `projectEvent(state, ev, viewer)`，按框架 §6 的可见性表。
   **隐藏牌必须保留稳定 `entityId`**，只把 `cardId` 置 `null`——否则
   "抽牌→飞入手牌→打出翻开"的动画在客户端接不上。
2. `legalActions(state, player)` + `IllegalReason`，**带上色门缺色信息**
   （客户端要显示"没有红色光源"，不是错误码）。
3. `legal` 只是给 UI 置灰用的方便字段，**不是权威**——服务端收到意图必须重新完整校验。

**完成标志**

```bash
bun test packages/engine/src/__tests__/hidden-info.test.ts
```
把发给玩家 B 的所有字节 grep 一遍，断言不含玩家 A 手牌的任何 cardId。

**这一步不要往后挪**（框架 §13 坑 4）。隐藏信息不能事后补。

---

### M8 · bot / CLI / fuzz / golden replay ★

**做什么**

1. `RandomBot`（第一天就该有的 fuzzer）与 `GreedyBot`，都只从 `legalActions` 取动作。
2. `bun run play --seed 1 --p0 greedy --p1 random` —— 终端跑完整一局，逐步打印状态与事件。
3. `bun run replay <file> --step` —— 回放器，排 bug 的主力工具。
4. `sim`：批量对打 + 每步不变量断言（血量非负、单实体不跨区、**槽位无重复占用**、
   `clone(state)` 结算一致）。
5. **★ golden replay 套件**：不是随手存几局，而是**刻意构造**并存下这批局面——
   它们同时是客户端的视觉回归夹具（客户端设计 §10）：

   | replay | 覆盖什么 |
   |---|---|
   | `combat-tradeoff` | 同归于尽（双方互相打死） |
   | `beam-through-empty` | 空格穿透 → 光束直击基地 |
   | `diagonal-strike` | direction ±1 斜打 |
   | `thorns-dies-but-retaliates` | 荆棘卫士本轮阵亡仍反伤 |
   | `color-gate-blackout` | 英雄阵亡 → 该色全锁 → 一回合后解锁 |
   | `deploy-r1-r2` | 部署两批 |
   | `discover-suspend` | 挂起点与恢复 |

**完成标志**

```bash
bunx turbo sim -- --games=100000     # 无断言失败
ls replays/golden/                   # 七个夹具齐备
```

**此处分叉：M9 与 M10 可以并行。**

---

### M9 · Colyseus 服务端

**做什么**

1. `src/transport/` 隔离层：定义我们自己的 `Transport` 接口，Colyseus 的 API
   只出现在这一层之内（架构文档 §1.2 的风险隔离要求）。
2. `MatchRoom`：座位分配、`intent` 收发、`seq`、快照/事件下发（**逐客户端投影后**广播）。
3. 计时：用 `this.clock`（可暂停时钟），**每 action 一个计时器**（默认 30 秒），
   超时视同 pass——不是每回合一个计时器。
4. 部署相位：服务端聚合双方的秘密选择，凑齐后以**单个** `deploy` intent 喂引擎。
5. 重连：`allowReconnection`（**它返回 Promise，忘了 catch 会静默吞掉判负逻辑**，
   框架 §13 坑 7），重连后补发全量快照。
6. 认输、超时判负、对局结果落库（走 `onDispose` 或独立队列，别阻塞房间销毁）。

**完成标志**

```bash
bun run play:online --p0 bot --p1 bot     # 两个 CLI 客户端经服务端打完一局
```
外加隐藏信息 CI 测试在服务端出口再跑一遍。

---

### M10 · Phaser 客户端

详细设计见《Prismfront Phaser 客户端技术设计》。分五个可独立验收的子步：

| 子步 | 内容 | 验收 |
|---|---|---|
| M10a | `Transport` 抽象 + `MockTransport`、Boot/Match 场景、`Layout`、棋盘与单位渲染、卡面程序化合成 | 加载 `?replay=deploy-r1-r2` 能看到正确棋盘 |
| M10b | `Director` + Beat 编排（齐射 / 死亡 / 空格穿透光束） | 七个 golden replay 逐个播放正确 |
| M10c | `HudScene`：**光源条**、水晶、基地血、复燃泉、每 action 计时环 | `color-gate-blackout` 播放时灯会灭并重亮 |
| M10d | 输入状态机 + `OverlayScene`（换牌 / 部署 / 发现 / 选目标） | 热座模式能出牌 |
| M10e | 接 `ColyseusTransport`、`seq` 校验、`resync`、`fastForward` | 浏览器对战打完一局，中途断网能恢复 |

**先做 M10a–M10c 全靠 replay，不需要服务端**——这就是 M8 那套夹具的兑现。

三个必须守住的点：
- 编排层零 Phaser 依赖（可 `bun test`，且 Phaser 4 出问题能回退 3.90）
- 每个 Beat 都实现 `complete()`（跳过 / 重连 / 切后台都靠它）
- **只翻上下，不翻左右**（客户端设计 §4.2）——索引轴对双方一致，否则斜打方向在两人
  屏幕上相反

---

### M11 · PF1 全卡池与 lint

**做什么**

1. 按《数值基准》§6 的 33 张基准卡表建卡，ID 用 `PF1_R01` 式（《命名与主题》§4）。
   注意 §6.1 已经用 v1.1 公式回查过示例卡并给出修正值：
   斜刺长枪兵改 **4/3+斜打**、荆棘卫士改 **Retaliate 2**、战地号手欠 3 点待补。
2. 三名首发英雄：红 5/4、绿 4/6、蓝 3/6（蓝留 3 点技能预留，需先拍板，见 §4）。
2b. **专属卡归属 + 配额制**（v2.1 §11.1/§11.4b，2026-08-08 补订）：
   `CardData` 加 `hero: CardId`，33 张按色 1:1 挂到同色英雄。
   `RulesConfig.heroes` 加 `allowDuplicates: false` 与 `cardsPerHero: 10`，
   `deck.maxCopies` 由 2 改 **3**（决策 #12 取代决策 #4）。
   卡组校验 = 3 名英雄互不相同 + 每张卡的 `hero` ∈ 所选英雄 +
   **每名英雄名下恰好 10 张** + 同名 ≤3；
   配置自洽 `deck.size === perDeck × cardsPerHero`（配置校验期抛错）；
   卡池下限 = 每名英雄专属卡种类数 ≥ ⌈10/3⌉ = 4。
3. **L3 语义校验**上线：引用完整性（**含 `hero` 指向确为 `kind:"hero"` 的卡**）、
   上下文合法性、确定性（aura/intercept.cond 内禁 `*.random`
   与 `slot.random_empty`）、编写子集（禁 `sel.entity`）、v2 §9 的六条新增校验。
4. **色轮越权 lint**：数据来源就是 M1 建的 `COLOR_OWNERSHIP` 常量。
   红卡出现 `act.swap` → 报错。
5. 资源上限表（单卡 512 节点、深度 32、拦截链 8、单卡 64KB…）。
6. `ir:print` / `ir:diff` 完成。

**完成标志**

```bash
bunx turbo ir:validate     # 三层校验 + 色轮 lint + 资源上限，全绿
bun test packages/cards    # 33 张卡各有测试
```

---

### M12 · 平衡闭环

《数值基准》§8.6 已经把闭环定义好了，这里只是把它接起来：

```
bot 万局对打 → 每卡 winrate/pick 表 → 调 §3/§4 价格表 → ir:build 重生成
  → ir:diff 出平衡性变更日志 → 回归 fuzz
```

**平衡补丁 = 数据变更，全程不碰引擎代码。** 这是整套架构最终要兑现的承诺。

调参纪律（《数值基准》§8）：标尺卡（G01–05 / R01–03）永不改；
改公式不改单卡；胜率偏离 ±5% 观察 / ±10% 动价格表 / ±15% 动机制；
局长偏离先动 HP 旋钮。

**完成标志**：随机与贪心 bot 对打的平均局长落在 **6±1 回合**（《数值基准》§5 的目标）。
注意 §6.2 已预警：英雄身板让 r1 双方白得约 47 点，局长可能 +1 到 7±1，先观察不要急着动 HP。

---

## 4. 需要你拍板的决策

| # | 决策 | 何时需要 | 建议 |
|---|---|---|---|
| 1 | Colyseus 是否使用 Schema 承载房间元信息 | **M0（阻塞）** | 不用。绕开 schema 3/4 裂口，联机层也变得可替换 |
| 2 | `initiative` 默认策略 | M3 实现，M12 定 | 四种全实现走配置；默认先 `alternate`，M12 与 `first_passer` 试玩对比 |
| 3 | `playerActions` 是否开放「移动单位 / 改方向」 | M3 | 保持默认关（只 `play_card` + `pass`）。开关留着，先跑起来 |
| 4 | 卡组同名卡上限 `maxCopies` | M11 前 | 2（《数值基准》§9 标注待定，纯 RulesConfig 随时改） |
| 5 | 蓝英雄塞理安的 3 点预留技能 | M11 | 需要设计定案；不定则先做成纯 3/6 身板 |
| 6 | 立绘美术何时介入 | M11 之后 | 客户端有程序化占位（客户端设计 §7.3），不阻塞任何里程碑 |
| 7 | 是否做卡组构筑器 | M12 之后 | 先用两套预构筑卡组；构筑器是产品功能不是玩法验证前提 |
| 8 | 账号 / 排行 / 匹配分段 | 推迟 | M12 之后再议；《市场调研》建议这类外围能力优先接现成方案而非自研 |

> **本表是 2026-08-07 的快照，权威版本是 [todos/决策待办.md](../todos/决策待办.md)**（现有 12 条，全部已拍板）。
> 快照与现状已有出入：**#4 的 `maxCopies` 结论由 2 改为 3**（被 #12 取代），
> #7 的「按色偏分三套预构筑」分法作废（配额制下色比恒为 10/10/10）。
> 表里没有的 #9–#12 也只在 todos 侧维护。

---

## 5. 风险登记册

| 风险 | 触发点 | 影响 | 应对 |
|---|---|---|---|
| Colyseus 服务端与浏览器 SDK schema 裂口 | M0 | 联机层选型推翻 | 首选不用 Schema；`transport/` 隔离层让影响限于一个目录 |
| `@colyseus/bun-websockets` 较新、未经大规模验证 | M0 / M9 | 传输不稳 | 退回 `@colyseus/ws-transport`（Bun 的 Node 兼容足以跑 `ws`），业务代码不动 |
| 同时结算的两个"不"被实现错 | M3 | 战斗手感全变，且随机对局未必显形 | 四条独立测试，不靠 fuzz 兜 |
| 亡语递归无限循环 | M5 | 线上房间卡死 | 深度上限 + 专门测试（框架 §13 坑 5） |
| `Repeat` vs `.random(n)` 求值时机混淆 | M4 起长期 | 卡牌行为静默错误 | 进 review checklist；两条对照测试 |
| fuzz 暴露深层时序 bug | M8 | 可能回头改 M3/M5 | M8 预留 50% 缓冲；这正是 fuzz 的价值，不是意外 |
| 客户端动画期间的输入 | M10d | 操作丢失或错位 | 本地排队 + 服务端按 `seq` 校验，别让动画阻塞输入（框架 §13 坑 6） |
| 9 格棋盘上 AoE 过强 | M12 | 数值失衡 | 《数值基准》§9 已标记为"最先观察的一行"，改 §4 价格表一行即可 |
| Phaser 4 新版本踩坑 | M10 | 客户端进度 | 编排层与显示层分离，回退 3.90 只动最上层 |
| 单人开发 M10 拖长 | M10 | 总工期 | M10a–c 靠 replay 与引擎解耦，可随时暂停去推 M11 卡池 |

---

## 6. 第一周具体做什么

如果明天开工，前五天的顺序是：

1. **D1**：M0 全部（骨架 + CI + 三个 spike）。**当天必须拿到 Colyseus×Bun 的结论。**
2. **D2–D3**：M1（IR 类型合并 + 规范一致性清理 + builder + L1/L2 校验）。
3. **D4–D5**：M2 开头（状态模型 + RNG + 结算栈骨架），先把两条确定性测试立起来。

不要在第一周碰 Colyseus 房间逻辑，也不要碰 Phaser——
框架文档 §12 的判断依然成立：先接网络的话，你会同时在调试规则 bug 和网络 bug，
定位成本翻好几倍。
