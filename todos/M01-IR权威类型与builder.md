---
title: M1 · IR 权威类型与 builder
date: 2026-08-07
tags: prismfront, 里程碑, M1, IR, 类型, builder, 校验器
milestone: M1
status: todo
estimate: 2–3d
depends_on: [M0]
blocks: [M2]
risk: normal
---

# M1 · IR 权威类型与 builder

> 索引见 [README](./README.md)。原文见《[实现步骤与里程碑](../docs/Prismfront%20实现步骤与里程碑.md)》§3。

**产出**：`packages/ir` ｜ **估算** 2–3d ｜ **依赖** M0 ｜ **解锁** M2

---

## 任务

- [ ] 把 IR v1 §9 的类型 + v2 §7 的差异 + v2.1 §11 的增补，
      **合并成一份 `irVersion: "2.1.0"` 的完整类型**。
- [ ] 顺手做掉架构文档 §10 的 6 项规范一致性清理：
  - [ ] `baseHp`
  - [ ] `ZoneName` 补 `base` / `fountain`
  - [ ] `SlotSide` / `SelSide` 拆分
  - [ ] `stunned` 快照条件
  - [ ] `deploySchedule` 语义注释
- [ ] TS builder 糖面（v2 §7 列表）：`At / SlotOf / OPPOSITE / COMBAT_TARGET / AttackersOf /
      Adjacent / Push / Pull / Summon / Strike / defineCard / defineEnchantment`。
      builder 只是"构造 IR 节点的类型安全外壳"，实现量很小。
- [ ] `COLOR_OWNERSHIP` 常量——《数值基准》§1.2 的色轮归属表做成 JSON，
      **人和 lint 读同一份**（M11 的色轮越权 lint 直接消费它）。
- [ ] 校验器 L1（结构）+ L2（前缀种类）。L3 语义等 op 集稳定后在 M11 补。

---

## 完成标志

```bash
bun test packages/ir            # 前缀校验、规范形式归一化
bun run ir:print GRID_001       # 反编译器能把 IR 打回 TS 风格文本
```

- [ ] 能用 builder 写出 v2 §8 的六张示例卡，产出与文档里手写 JSON **逐字节一致**的规范形式。

---

## 注意

IR §1 原则 1「IR 是规范形式，糖只存在于编写层」要在这里立住——
`play: Hit(...)` 与 `play: [Hit(...)]` 必须产出同一份 JSON，否则后面 diff、缓存 key、
哈希全会出问题。
