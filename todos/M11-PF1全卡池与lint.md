---
title: M11 · PF1 全卡池与 lint
date: 2026-08-07
tags: prismfront, 里程碑, M11, 卡池, 校验, lint, 色轮
milestone: M11
status: todo
estimate: 4–5d
depends_on: [M6]
blocks: [M12]
risk: normal
---

# M11 · PF1 全卡池与 lint

> 索引见 [README](./README.md)。原文见《[实现步骤与里程碑](../docs/Prismfront%20实现步骤与里程碑.md)》§3。

**产出**：33 卡 + 3 英雄 ｜ **估算** 4–5d ｜ **依赖** M6（**M6 结束即可并行开工**）｜ **解锁** M12

---

## 任务

- [ ] 按《数值基准》§6 的 33 张基准卡表建卡，ID 用 `PF1_R01` 式（《命名与主题》§4）。
      §6.1 已经用 v1.1 公式回查过示例卡并给出修正值：
  - [ ] 斜刺长枪兵改 **4/3 + 斜打**
  - [ ] 荆棘卫士改 **Retaliate 2**
  - [ ] 战地号手欠 3 点待补
- [ ] 三名首发英雄：红 5/4、绿 4/6、蓝 3/6
      （蓝留 3 点技能预留，需先拍板，见 [决策 #5](./决策待办.md)）。
- [ ] **L3 语义校验**上线：
  - [ ] 引用完整性
  - [ ] 上下文合法性
  - [ ] 确定性（aura / intercept.cond 内禁 `*.random` 与 `slot.random_empty`）
  - [ ] 编写子集（禁 `sel.entity`）
  - [ ] v2 §9 的六条新增校验
- [ ] **色轮越权 lint**：数据来源就是 M1 建的 `COLOR_OWNERSHIP` 常量。
      红卡出现 `act.swap` → 报错。
- [ ] 资源上限表（单卡 512 节点、深度 32、拦截链 8、单卡 64KB…）。
- [ ] `ir:print` / `ir:diff` 完成。

---

## 完成标志

```bash
bunx turbo ir:validate     # 三层校验 + 色轮 lint + 资源上限，全绿
bun test packages/cards    # 33 张卡各有测试
```

- [ ] 两条命令全部通过

---

## 待决策

- [决策 #4](./决策待办.md)：卡组同名卡上限 `maxCopies`（**M11 前**需要）
- [决策 #5](./决策待办.md)：蓝英雄塞理安的 3 点预留技能
- [决策 #6](./决策待办.md)：立绘美术何时介入（M11 之后，不阻塞）
