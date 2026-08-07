---
title: M10 · Phaser 客户端
date: 2026-08-07
tags: prismfront, 里程碑, M10, phaser, 客户端, 动画编排, HUD
milestone: M10
status: todo
estimate: 8–12d
depends_on: [M8]
blocks: [M12]
risk: normal
---

# M10 · Phaser 客户端

> 索引见 [README](./README.md)。原文见《[实现步骤与里程碑](../docs/Prismfront%20实现步骤与里程碑.md)》§3。
> 详细设计见《[Prismfront Phaser 客户端技术设计](../docs/Prismfront%20Phaser%20客户端技术设计.md)》。

**产出**：可玩界面 ｜ **估算** 8–12d（约占总工期三分之一）｜ **依赖** M8 ｜
**与 [M9](./M09-Colyseus服务端.md) 可并行**

---

## 五个可独立验收的子步

- [ ] **M10a** `Transport` 抽象 + `MockTransport`、Boot/Match 场景、`Layout`、
      棋盘与单位渲染、卡面程序化合成
  - 验收：加载 `?replay=deploy-r1-r2` 能看到正确棋盘
- [ ] **M10b** `Director` + Beat 编排（齐射 / 死亡 / 空格穿透光束）
  - 验收：七个 golden replay 逐个播放正确
- [ ] **M10c** `HudScene`：**光源条**、水晶、基地血、复燃泉、每 action 计时环
  - 验收：`color-gate-blackout` 播放时灯会灭并重亮
- [ ] **M10d** 输入状态机 + `OverlayScene`（换牌 / 部署 / 发现 / 选目标）
  - 验收：热座模式能出牌
- [ ] **M10e** 接 `ColyseusTransport`、`seq` 校验、`resync`、`fastForward`
  - 验收：浏览器对战打完一局，中途断网能恢复

**先做 M10a–M10c 全靠 replay，不需要服务端**——这就是 [M8](./M08-bot-CLI-fuzz-golden-replay.md)
那套夹具的兑现。

---

## 三个必须守住的点

- [ ] 编排层零 Phaser 依赖（可 `bun test`，且 Phaser 4 出问题能回退 3.90）
- [ ] 每个 Beat 都实现 `complete()`（跳过 / 重连 / 切后台都靠它）
- [ ] **只翻上下，不翻左右**（客户端设计 §4.2）——索引轴对双方一致，
      否则斜打方向在两人屏幕上相反
- [ ] **卡面立绘从第一天就走同一条渲染路径**（[决策 #6](./决策待办.md) 已拍板美术推迟）：
      `card.data.art` 有值 → 加载图；为空 → 程序化占位（色块 + 文字）。
      **不允许**出现「占位专用渲染分支」或写死的占位贴图——
      一旦占位走了另一条码路径，换图那天就是一次真返工。
      接美术必须是**纯数据替换、零渲染代码改动**。
      （`art` 已在架构 §5.2 的 `cards.client.json` 投影里，不需要新增字段。）

---

## 完成标志

- [ ] 浏览器打完一局

---

## 相关风险

- 客户端动画期间的输入（M10d）→ 本地排队 + 服务端按 `seq` 校验，别让动画阻塞输入（框架 §13 坑 6）。
- Phaser 4 新版本踩坑 → 编排层与显示层分离，回退 3.90 只动最上层。
- 单人开发 M10 拖长 → M10a–c 靠 replay 与引擎解耦，可随时暂停去推 M11 卡池。

详见 [风险登记册](./风险登记册.md)。
