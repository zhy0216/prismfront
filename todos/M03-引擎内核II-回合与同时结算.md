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

- [ ] 实现 `round_start → deploy(若有) → actions → combat → round_end`

> 决策理由：deploy 相位只是多一个 intent 分支（v2.1 §11.3 明确说服务端聚合双方
> 秘密选择后喂**单个** intent，引擎保持单输入模型），现在写便宜；
> 等 M6 再往稳定的相位机里插一个新相位，则要重测全部时序。

### 2. 水晶

- [ ] `crystalCap = min(5 + (round-1)*growth, capMax)`，每回合**回满**。

### 3. 行动交替

- [ ] `priority` 切换、`consecutivePasses`、连续双 pass → combat。
- [ ] **pass 不锁定**（对手行动后清零）。

### 4. initiative 四种策略全部实现

- [ ] `alternate` / `first_passer` / `random_each_round` / `fixed_first`，走 `RulesConfig` 切换。
      `first_passer` 是 Artifact 公认的深度来源，要留着在 M12 试玩对比（v2 §6，[决策 #2](./决策待办.md)）。
- [ ] **默认 `alternate`**（[决策 #2](./决策待办.md) 已拍板）。首回合先手随机、消耗 RNG（v2 §36），
      与 `initiative` 策略正交，不要写成策略的一部分。

### 4b. `playerActions` 恒关 —— 配置校验期抛错

- [ ] `RulesConfig` 保留 `playerActions` 字段，但配置校验遇到 `move_unit` / `set_direction`
      **直接抛错**，不实现、也不静默忽略（[决策 #3](./决策待办.md) 已拍板）。

> 决策理由：`direction` 在《数值基准》§1.2 是**红 primary / 绿 forbidden**。
> 玩家能免费改方向 = 红色主色身份蒸发 + 绿色禁令失效，**开了就得重写 §1.2**。
> 抛错而非静默无效，是为了让将来任何人打开这个开关时当场撞墙，而不是跑出一局错的对局。

### 5. 战斗阶段严格按 v2 §4.2 五步

- [ ] ① `combat_began` → 结算栈完全清空（此时的 buff/召唤会影响快照）
- [ ] ② 快照 strikes：按 `[initiative 方 0→8, 另一方 0→8]` 遍历
  - 条件 `atk > 0 && !stunned` ← 《数值基准》§7 的增补
  - 目标格 = 敌方行（自己格 + 生效 direction）
  - 越界或空 → 敌方基地
  - 记录 `{attacker, target, amount}`，此后全部冻结
- [ ] ③ 逐条应用：走 `act.strike` → `act.hit` 管线
  - ★ **不做中途死亡结算**
  - ★ **触发器只入栈不结算**
- [ ] ④ 全部应用完 → 结算栈开闸 → 统一死亡 → 亡语 → 光环重算 → 循环至不动点
- [ ] ⑤ `combat_ended` → `end_of_combat` 附魔剥离 → `round_end`

### 6. direction 作为普通 Tag

- [ ] 生效值 = `base.direction + Σ附魔 + Σ光环`，与 atk/health 同一套管线。

**不要为它写任何特殊代码**——沉默自动重置方向、光环批量改方向、
`num.attr(of,"direction")` 可读，全部是免费获得的。

---

## 完成标志 —— 四条测试，一条都不能少

```ts
test("先被打死的单位本轮照样打出伤害（同归于尽成立）");
test("战斗中亡语召唤的单位不获得本轮出手（快照已冻结）");
test("方向指向空格/越界 → 伤害进敌方基地");
test("stunned 单位不进入快照");
```

- [ ] 四条测试全部通过

---

## 注意

**最容易写错的地方**：第 ③ 步那两个"不"。一旦在逐条应用中途做了死亡结算，
同归于尽就不成立，整个战斗手感全变——而这个 bug 在随机对局里未必立刻显形。
所以它必须有独立测试，**不能靠 fuzz 兜**。

## 已决策（2026-08-07）

- [决策 #2](./决策待办.md)：`initiative` **默认 `alternate`**，四种全实现。
  golden 的防线在 M8（配置快照 + 一局 `first_passer`），不在这里。
- [决策 #3](./决策待办.md)：`playerActions` **恒关**，配置校验期对另两个值抛错。
