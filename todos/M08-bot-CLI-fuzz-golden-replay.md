---
title: M8 · bot / CLI / fuzz / golden replay ★
date: 2026-08-07
tags: prismfront, 里程碑, M8, bot, fuzz, replay, CLI, 高风险
milestone: M8
status: todo
estimate: 3–5d
depends_on: [M7]
blocks: [M9, M10]
risk: high
---

# M8 · bot / CLI / fuzz / golden replay ★

> 索引见 [README](./README.md)。原文见《[实现步骤与里程碑](../docs/Prismfront%20实现步骤与里程碑.md)》§3。

**产出**：可 headless 对打 ｜ **估算** 3–5d（★ 留 50% 缓冲）｜ **依赖** M7 ｜ **解锁** M9 与 M10（可并行）

---

## 任务

- [ ] `RandomBot`（第一天就该有的 fuzzer）与 `GreedyBot`，都只从 `legalActions` 取动作。
- [ ] `bun run play --seed 1 --p0 greedy --p1 random` —— 终端跑完整一局，逐步打印状态与事件。
- [ ] `bun run replay <file> --step` —— 回放器，排 bug 的主力工具。
- [ ] `sim`：批量对打 + 每步不变量断言
  - [ ] 血量非负
  - [ ] 单实体不跨区
  - [ ] **槽位无重复占用**
  - [ ] `clone(state)` 结算一致

### ★ golden replay 套件

不是随手存几局，而是**刻意构造**并存下这批局面——
它们同时是客户端的视觉回归夹具（客户端设计 §10）：

| replay | 覆盖什么 | |
|---|---|---|
| `combat-tradeoff` | 同归于尽（双方互相打死） | ☐ |
| `beam-through-empty` | 空格穿透 → 光束直击基地 | ☐ |
| `diagonal-strike` | direction ±1 斜打 | ☐ |
| `thorns-dies-but-retaliates` | 荆棘卫士本轮阵亡仍反伤 | ☐ |
| `color-gate-blackout` | 英雄阵亡 → 该色全锁 → 一回合后解锁 | ☐ |
| `deploy-r1-r2` | 部署两批 | ☐ |
| `discover-suspend` | 挂起点与恢复 | ☐ |
| `initiative-first-passer` | `initiative: "first_passer"` 全程（[决策 #2](./决策待办.md)） | ☐ |

### replay 格式的两条硬约束（[决策 #2](./决策待办.md) 已拍板）

- [ ] 每个 replay 文件**内嵌完整 `RulesConfig` 快照**，回放时用文件里的配置，
      **不读默认值**。否则改一次默认值，历史 golden 集体变红，而它们本该是不变量。
- [ ] golden 集**至少一局跑 `first_passer`**（上表最后一行）。
      默认是 `alternate`，`first_passer` 那条码路径若无夹具，会在 M9–M11 期间静默烂掉——
      而 M12 做试玩对比时正是最不该撞见意外的时刻。

---

## 完成标志

```bash
bunx turbo sim -- --games=100000     # 无断言失败
ls replays/golden/                   # 八个夹具齐备
```

- [ ] 两条命令全部通过

---

## 分叉点

**此处分叉：[M9](./M09-Colyseus服务端.md) 与 [M10](./M10-Phaser客户端.md) 可以并行。**
`MockTransport` 让客户端完全不必等服务端。单人开发按 M9→M10 串行；两人开发在这里分头。

## 相关风险

fuzz 暴露深层时序 bug → 可能回头改 M3/M5。
M8 预留 50% 缓冲；**这正是 fuzz 的价值，不是意外**。详见 [风险登记册](./风险登记册.md)。
