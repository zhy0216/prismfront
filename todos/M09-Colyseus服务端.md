---
title: M9 · Colyseus 服务端
date: 2026-08-07
tags: prismfront, 里程碑, M9, colyseus, 服务端, 房间, 重连
milestone: M9
status: todo
estimate: 3–4d
depends_on: [M8]
blocks: [M12]
risk: normal
---

# M9 · Colyseus 服务端

> 索引见 [README](./README.md)。原文见《[实现步骤与里程碑](../docs/Prismfront%20实现步骤与里程碑.md)》§3。

**产出**：房间、计时、重连 ｜ **估算** 3–4d ｜ **依赖** M8 ｜ **与 [M10](./M10-Phaser客户端.md) 可并行**

---

## 任务

- [ ] `src/transport/` 隔离层：定义我们自己的 `Transport` 接口，Colyseus 的 API
      只出现在这一层之内（架构文档 §1.2 的风险隔离要求）。
- [ ] `MatchRoom`：座位分配、`intent` 收发、`seq`、快照/事件下发（**逐客户端投影后**广播）。
- [ ] 计时：用 `this.clock`（可暂停时钟），**每 action 一个计时器**（默认 30 秒），
      超时视同 pass——**不是每回合一个计时器**。
- [ ] 部署相位：服务端聚合双方的秘密选择，凑齐后以**单个** `deploy` intent 喂引擎。
- [ ] 重连：`allowReconnection`（**它返回 Promise，忘了 catch 会静默吞掉判负逻辑**，
      框架 §13 坑 7），重连后补发全量快照。
- [ ] 认输、超时判负、对局结果落库（走 `onDispose` 或独立队列，别阻塞房间销毁）。
- [ ] **`ResolutionLoopError` 撞上时那一局怎么办**（M5/T4 留下的残余风险，需要在这里拍板）。
      `apply()` 先 clone 再跑，抛错时**入参状态一字未改**，所以房间**不必**从快照恢复，
      丢掉这一次意图即可 —— 房间不会卡死（框架 §13 坑 5 那条已消除）。
      **但**：环发生在**自动相位**（双 pass → combat 那一段）里时，那一局会卡在
      "这条意图提交不下去"上 —— 房间活着，那局推不动，玩家再点多少次都是同一个错。
      要定的是：判负 / 作废 / 还是标记为引擎故障并人工介入。
      判据参考：这不是玩家的错（是卡牌数据或引擎的 bug），判负对被卡的一方不公平。
      详见 `packages/engine/src/resolve/resolve.ts` 的 `ResolutionLoopError`
      与 `resolve/__tests__/deathrattle-loop.test.ts`。
- [ ] 服务端收到意图**重新完整校验**（M7 的 `legal` 字段不是权威）。
- [ ] 玩家身份用**不透明 `playerId` 字符串**，不要假设「匿名 = 无 id」，
      也**不要把 Colyseus 的 `sessionId` 当玩家身份外泄到引擎层**——
      `sessionId` 每次重连都会变，而重连正是本里程碑要支持的。
      ([决策 #8](./决策待办.md)：账号系统推迟到 M12 之后，这是那时不必改 transport 层的零成本前提。)

---

## 完成标志

```bash
bun run play:online --p0 bot --p1 bot     # 两个 CLI 客户端经服务端打完一局
```

- [ ] 命令通过
- [ ] 隐藏信息 CI 测试在**服务端出口**再跑一遍

---

## 相关风险

- Colyseus 服务端与浏览器 SDK schema 裂口 → `transport/` 隔离层让影响限于一个目录。
- `@colyseus/bun-websockets` 较新 → 退回 `@colyseus/ws-transport`（Bun 的 Node 兼容足以跑 `ws`），业务代码不动。

详见 [风险登记册](./风险登记册.md)。
