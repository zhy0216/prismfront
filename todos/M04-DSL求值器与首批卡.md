---
title: M4 · DSL 求值器与首批卡
date: 2026-08-07
tags: prismfront, 里程碑, M4, DSL, 求值器, handler, 卡牌
milestone: M4
status: todo
estimate: 4–5d
depends_on: [M3]
blocks: [M5]
risk: normal
---

# M4 · DSL 求值器与首批卡

> 索引见 [README](./README.md)。原文见《[实现步骤与里程碑](../docs/Prismfront%20实现步骤与里程碑.md)》§3。

**产出**：求值器、handler 表、10 张卡 ｜ **估算** 4–5d ｜ **依赖** M3 ｜ **解锁** M5

---

## 任务

- [ ] `evalSel` / `evalNum` / `evalCond`，靠 TS 的穷尽检查兜底（漏一个 op 编译不过）。
- [ ] `slot.*` 族与**无效槽语义**：动作的 SlotRef 解析为无效槽 → 该动作静默跳过。
- [ ] handler 表 `Record<Act["op"], Handler>`。
- [ ] **求值语义三条铁规**（IR §5.3，整份规范最容易出错处）：
  - [ ] 动作内快照：`target` 求值一次，动作全程冻结
  - [ ] `act.repeat` 每轮重新求值
  - [ ] `sel.random(n)` 一次性求值
  - [ ] 后两条长得像、语义完全不同 → 写进 code review checklist，并**各配一条测试**
- [ ] 空集合语义统一表（IR §5.2）。
- [ ] RNG 求值顺序（IR §5.4）。
- [ ] 先支持 8–10 个最常用 op，跑通 G01–G05、R01/R07/R09、B01/B02。

---

## 完成标志

```bash
bunx turbo ir:build              # 产出第一个 cards.ir.json
bun test packages/cards          # 单卡测试，每张 3 行
```

- [ ] 两条命令全部通过

---

## 相关风险

`Repeat` vs `.random(n)` 求值时机混淆（M4 起长期风险）→ 卡牌行为静默错误。
应对：进 review checklist；两条对照测试。详见 [风险登记册](./风险登记册.md)。
