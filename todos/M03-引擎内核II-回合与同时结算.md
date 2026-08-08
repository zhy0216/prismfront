---
title: M3 · 引擎内核 II：回合状态机与同时结算 ★
date: 2026-08-07
tags: prismfront, 里程碑, M3, 引擎, 相位机, 同时结算, 战斗, 高风险
milestone: M3
status: todo
estimate: 4–6d
depends_on: [M2]
blocks: [M4]
risk: high
---

# M3 · 引擎内核 II：回合状态机与同时结算 ★

> 索引见 [README](./README.md)。原文见《[实现步骤与里程碑](../docs/Prismfront%20实现步骤与里程碑.md)》§3。

**产出**：v2 / v2.1 状态机、战斗 ｜ **估算** 4–6d（★ 留 50% 缓冲）｜ **依赖** M2 ｜ **解锁** M4

本项目最独特、也最容易做错的一块。

---

## 任务

### 1. 完整相位机，一次做到 v2.1 形态，不分两步

- [x] 实现 `round_start → deploy(若有) → actions → combat → round_end`
      （`packages/engine/src/rules/phase.ts`。combat 相位的进出与 `combat_began` /
      `combat_ended` / `end_of_combat` 剥离已就位，中间的快照三步见下方第 5 项。）

> 决策理由：deploy 相位只是多一个 intent 分支（v2.1 §11.3 明确说服务端聚合双方
> 秘密选择后喂**单个** intent，引擎保持单输入模型），现在写便宜；
> 等 M6 再往稳定的相位机里插一个新相位，则要重测全部时序。

### 2. 水晶

- [x] `crystalCap = min(5 + (round-1)*growth, capMax)`，每回合**回满**。
      （`crystalCapFor` / `refillCrystals`；字面量全部取自 `rules.crystals`。）

### 3. 行动交替

- [x] `priority` 切换、`consecutivePasses`、连续双 pass → combat。
      （阈值读 `rules.pass.combatAfterConsecutivePasses`，不写死 2。）
- [x] **pass 不锁定**（对手行动后清零）。

### 4. initiative 四种策略全部实现

- [x] `alternate` / `first_passer` / `random_each_round` / `fixed_first`，走 `RulesConfig` 切换。
      `first_passer` 是 Artifact 公认的深度来源，要留着在 M12 试玩对比（v2 §6，[决策 #2](./决策待办.md)）。
      （`packages/engine/src/rules/initiative.ts`。）
- [x] **默认 `alternate`**（[决策 #2](./决策待办.md) 已拍板）。首回合先手随机、消耗 RNG（v2 §36），
      与 `initiative` 策略正交，不要写成策略的一部分。
      （那一掷在 `createGame` 里，`CreateGameOptions.firstPlayer` 可钉住以免测试/回放受随机影响。）

### 4b. `playerActions` 恒关 —— 配置校验期抛错

- [x] `RulesConfig` 保留 `playerActions` 字段，但配置校验遇到 `move_unit` / `set_direction`
      **直接抛错**，不实现、也不静默忽略（[决策 #3](./决策待办.md) 已拍板）。
      （`packages/engine/src/rules/validate-config.ts` 的 `RulesConfigError`，
      由 `createGame` 第一行调用。）

> 决策理由：`direction` 在《数值基准》§1.2 是**红 primary / 绿 forbidden**。
> 玩家能免费改方向 = 红色主色身份蒸发 + 绿色禁令失效，**开了就得重写 §1.2**。
> 抛错而非静默无效，是为了让将来任何人打开这个开关时当场撞墙，而不是跑出一局错的对局。

### 5. 战斗阶段严格按 v2 §4.2 五步

> 落点：① 与 ⑤（相位进出）在 `packages/engine/src/rules/phase.ts` 的 `runCombat()`；
> ②③④ 在 `packages/engine/src/rules/combat.ts`（`planStrikes` / `applyStrikes` /
> `settleCombat`，入口 `resolveStrikes`）。测试在 `rules/__tests__/combat.test.ts`。

- [x] ① `combat_began` → 结算栈完全清空（此时的 buff/召唤会影响快照）
      （发完事件立刻 `queueTriggers` + `resolve()`，于是"战斗开始时"的 buff/召唤
      在第 ② 步取数**之前**就已经生效 —— 交给 `runStep` 末尾那次排队会晚一步。）
- [x] ② 快照 strikes：按 `[initiative 方 0→8, 另一方 0→8]` 遍历
  - 条件 `atk > 0 && !stunned` ← 《数值基准》§7 的增补
  - 目标格 = 敌方行（自己格 + 生效 direction）
  - 越界或空 → 敌方基地
  - 记录 `{attacker, target, amount}`，此后全部冻结
  - ⚠ 「冻结」在 M3 **没有被送进管线**：IR v1 的 `act.strike` 没有 `amount` 字段，
    真打出去的数由 `strikeHandler` 在应用那一刻重读 `tags.atk`。两者在 M3 必然相等，
    但守着这条等式的原本只有一段结构性论证。现在由一道**运行时哨兵**守着
    （`combat.ts` 的 `assertFrozenAmount` → 抛 `StrikeAmountDriftError`）：
    M3 恒真，M5 引入"能在批次中途改 atk 的拦截器/触发器"时**第一次跑就当场抛**。
    哨兵是临时防线，M5 按 `PlannedStrike.amount` 的 TODO 二选一落地后连同错误类删掉。
- [x] ③ 逐条应用：走 `act.strike` → `act.hit` 管线
  - ★ **不做中途死亡结算**
  - ★ **触发器只入栈不结算**
  - 走的是一条**旁路管线**而不是给 `resolve()` 加模式开关（那要三个旋钮，且两个
    只有战斗一个调用方）。六步全部调 `resolve/` 导出的同名函数，只有"步骤顺序"
    这一件事有第二处实现，`resolve.ts` 文件头留了一行指回来。取舍见 `combat.ts` 头部。
  - 第二个「不」在 M3 是**不可观测**的（`collectTriggerSubscriptions` 恒返回空 ⇒
    排队恒 0 条 ⇒ 把 `harvest` 挪到排队之后不改变任何结果），所以
    `combat.ts` 留了一个接线口 `TriggerQueue`（生产恒为 `queueTriggers`），
    测试从那里塞一个**会真排队**的源进来把顺序钉死。M5 有真触发器源后该参数退役。
- [x] ④ 全部应用完 → 结算栈开闸 → 统一死亡 → 亡语 → 光环重算 → 循环至不动点
      （base 在战斗里归零 ⇒ 直接返回，不发 `combat_ended`、不进 round_end。）
  - 「开闸」那一次 `resolve()` 单独钉了一条测试：往主栈上摆一条站位触发器
    （与 `enterCombatWithTrigger` 同一条论证：已经在栈上的动作与刚排队压上去的
    触发器对那次 `resolve()` 完全同形），断言它**到第 ④ 步才**跑。
- [x] ⑤ `combat_ended` → `end_of_combat` 附魔剥离 → `round_end`
      （`stripEnchantments(state, "end_of_combat")`；`end_of_round` 那一半在 `endRound`。
      两处都在剥完之后 `refreshAuras` —— 属性是重算而非增量，M5 把两个 Σ 填上即生效。）

> ⚠ 遗留给 M5 的一条约束：战斗批次是**原子**的（第 ③ 步不检查 `pendingInput`）。
> M3 里结构性不可能挂起（strike/hit 都不挂起，拦截器与触发器还没有源）。
> M5 若要让拦截器挂起，必须先把"剩余快照"放进 `GameState` 才能续跑。

### 6. direction 作为普通 Tag

- [x] 生效值 = `base.direction + Σ附魔 + Σ光环`，与 atk/health 同一套管线。
      （`planStrikes` 读 `attacker.tags.direction`；两个 Σ 由 `resolve/auras.ts` 在 M5 填。
      不 clamp、不取模、可为负 —— 越界的结果是打进敌方基地，不是绕回来。）

**不要为它写任何特殊代码**——沉默自动重置方向、光环批量改方向、
`num.attr(of,"direction")` 可读，全部是免费获得的。
（落地时一行 direction 的 `if` / `switch` 都没有。）

---

## 完成标志 —— 四条测试，一条都不能少

```ts
test("先被打死的单位本轮照样打出伤害（同归于尽成立）");
test("战斗中亡语召唤的单位不获得本轮出手（快照已冻结）");
test("方向指向空格/越界 → 伤害进敌方基地");
test("stunned 单位不进入快照");
```

- [x] 四条测试全部通过（`packages/engine/src/rules/__tests__/combat.test.ts`，共 18 条）
      —— 全套 `bun test packages/engine` **201 pass / 0 fail**，没有 skip / todo / 留红。
- [x] 四条测试全部走 `src/testkit` 的夹具，文件里**一行状态字面量都没有**
      （建局 `openGame` / 摆盘 `putUnit` / 推进 `fightOnce`，见下）

> 「中途结算死亡」这个 bug 在 M3 只有两处可观测，两处都钉了测试：
> **事件顺序**（`unit_died` 必须全部排在两次出手之后）与
> **双方 base 同回合归零 → 平局**（提前判负会让平局永远打不出来）。
> `sel.entity` 按 id 取实体、不管它在哪个区，所以光看伤害数值是抓不到这个 bug 的。
>
> 第 2 条测试里的"亡语召唤"由一张桩 handler 站位 —— M3 还没有触发器源（M5），
> 但被测性质（快照冻结之后上场的单位不获得本轮出手）与召唤是谁发起的无关。
> 桩比真亡语**更强**：它把上场时刻放在第 ③ 步中途，比亡语（第 ④ 步之后）更早。
> **M5 落地后应当把它换成真亡语版本**（`on: "unit_died"` + `act.summon` 的卡），
> 断言不用改；换完桩整段删掉。等价性论证写在 `summonOnFirstHit` 的文档注释里。

### 这四条**不是空壳**：逐条做过变异验证

在 `rules/combat.ts`（最后一行是 `rules/phase.ts`）上人工注入 bug，
确认每条测试都会因为**它声称的那件事**而红：

| 注入的 bug | 红的测试 |
| --- | --- |
| 第 ③ 步逐条应用中途补一次 `processDeaths` | 同归于尽 + 双亡平局（2 条） |
| `hasFlag` → `hasBaseFlag`（读卡面标志位） | 滞光读生效 flags |
| 去掉 `hasFlag(attacker,"stunned")` 判定 | stunned 不进快照 + 滞光读生效 flags |
| `tags.direction` → `base.direction`（读卡面方向） | 战斗读生效 direction |
| 目标格 clamp 到 `[0,8]` / 对 9 取模 | 方向越界 → 敌方基地 |
| 把 `harvest` 挪到排队之后（= 批次中途就跑触发器） | ★ 触发器只入栈不结算（1 条） |
| 删掉第 ④ 步那次 `resolve()`（不开闸） | ★ 第 ④ 步开闸 + ★ 触发器只入栈不结算（2 条） |
| 拿掉 `assertFrozenAmount` 那道哨兵 | ★ 批次中途改 atk ⇒ 哨兵当场抛（1 条） |
| `concludeMatch` 改成空实现（`phase.ts`） | 终局清栈 + ★ 认输时栈上还剩着东西（2 条） |

第 3 条为此加了三个"陷阱位"守卫（p1 的 0 / 6 / 8 号格站人）：
越界格空着的话，`clamp` / 取模 / 直接进 base 三种实现**都**落到 base，断言全绿却什么都没验。

后四行是第二轮补修加的（前三行落在 `rules/combat.ts`，最后一行落在 `rules/phase.ts`）：

- 第 ③ 步那两个「不」原本只有第一个有运行时防线，第二个只有结构论证与注释 ——
  而任务书要求这两条**必须各有独立测试、不能靠 fuzz 兜**。
- 第 ④ 步原本只有 `processDeaths` 那一环被钉住（删它会红 5 条），
  后半段「开闸」谁都拦不住被误删。
- 「记录后全部冻结」原本由一条**有意留红**的测试站位。那条测试抓不到它要抓的事
  （实现今天就不冻结 ⇒ M5 破坏前后都是红，唯一可能的跃迁是 red→green），
  代价却是 `bun test packages/engine` / `bunx turbo test` 恒 exit 1 ——
  而 `.github/workflows/ci.yml` 里 `turbo test` 是必过步骤，恒红等于把整套测试的
  信号毁掉：从那个提交起没人能再拿"测试绿"当闸门。现在改成哨兵 + 断言哨兵会抛。
- 认输那条原本对「清栈」不承重（走公共 API 时认输那一刻栈本来就是空的），
  补了一条「人为脏栈 + 认输」把它钉住，并在原测试上写明它只钉相位/胜负那一半。

变异实验一律在仓库副本里做（`rsync` 一份到临时目录），工作树从头到尾没有被注入过 bug。

### 夹具落在 `src/testkit`（它的文件头本来就自述要提供这三类）

- **建局** `openGame({rules?, decks?, seed?, firstPlayer?, face?})` + `makeTestDeck`
  —— 一步停在 r1 的 `actions`；恒 `shuffle:false` 且默认钉先手 ⇒ **一次 RNG 都不消耗**，
  于是"牌库顶是哪张"可预测（`putUnit` 依赖它）。
- **摆盘** `putUnit(state, player, slot, face)`（牌库顶取牌 → 写卡面 → 直接摆格）、
  `baseIdOf` / `damageOf`（读盘）。
- **推进** `fightOnce(state, deps?)` —— 打完一次战斗，只取 `combat_began … combat_ended`
  那一段事件流（尾巴上的 `round_ended` / 水晶 / 抽牌与战斗无关，留着每条断言都会跟着相位机改）。
  对局在战斗中结束时没有 `combat_ended`，取到末尾；连 `combat_began` 都没有则抛夹具错。
- 顺带：`eventNames(events)`。

> 遗留（不属于 M3 完成判据）：`phase.test.ts` / `apply.test.ts` / `walkthrough.test.ts` /
> `determinism.test.ts` 各自还留着一份自己的 `RulesConfig` 字面量与建局函数。
> 它们**能**换成 `openGame`（`phase.test.ts` 的那个几乎逐字相同），但那是动别的单元的
> 测试文件，与本里程碑的完成判据无关，留给下一次碰到那些文件时顺手收。

---

## 注意

**最容易写错的地方**：第 ③ 步那两个"不"。一旦在逐条应用中途做了死亡结算，
同归于尽就不成立，整个战斗手感全变——而这个 bug 在随机对局里未必立刻显形。
所以它必须有独立测试，**不能靠 fuzz 兜**。

## 已决策（2026-08-07）

- [决策 #2](./决策待办.md)：`initiative` **默认 `alternate`**，四种全实现。
  golden 的防线在 M8（配置快照 + 一局 `first_passer`），不在这里。
- [决策 #3](./决策待办.md)：`playerActions` **恒关**，配置校验期对另两个值抛错。
