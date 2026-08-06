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
- [ ] 服务端收到意图**重新完整校验**（M7 的 `legal` 字段不是权威）。

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
