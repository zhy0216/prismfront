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
- [ ] 三名首发英雄：红 5/4、绿 4/6、蓝 **3/6（纯身板，无技能）**。
      蓝的 3 点是**平衡储备**不是待设计（[决策 #5](./决策待办.md) 已拍板）——
      24 点档上蓝没有不与绿 4/6 撞车的整数身板，这 3 点是取整残差；
      且 3 点买不起任何现成效果（抽 1 = 8 点、眩晕 = 5 点）。
      将来若给英雄技能，**只能是 trigger / intercept，不能是主动技**
      （主动技要新增 player action，直接推翻[决策 #3](./决策待办.md)），
      且蓝的 `aura` 是 forbidden（§1.2），所以蓝英雄被动走不了光环。
- [ ] `RulesConfig.deck.maxCopies = **2**`（[决策 #4](./决策待办.md) 已拍板），
      lint 按此校验预构筑卡组。
- [ ] **L3 语义校验**上线：
  - [ ] 引用完整性
  - [ ] 上下文合法性
  - [ ] 确定性（aura / intercept.cond 内禁 `*.random` 与 `slot.random_empty`）
  - [ ] 编写子集（禁 `sel.entity`）
  - [ ] v2 §9 的六条新增校验
- [ ] **色轮越权 lint**：数据来源就是 M1 建的 `COLOR_OWNERSHIP` 常量。
      红卡出现 `act.swap` → 报错。

  **落 lint 前必须先改 `packages/ir/src/color-ownership.ts`**（[决策 #10](./决策待办.md) 已拍板）——
  15 行里有 5 行没有独占 op，光按 op 匹配会漏掉三分之一：

  - [ ] **查询 API 改成「露头」判别联合**，不要写四个平行的 `ownsTagKey/ownsFlag/ownsKeyword`：

        ```ts
        type Occurrence =
          | { kind: "op"; op: string }       | { kind: "tagKey"; tagKey: string }
          | { kind: "flag"; flag: string }   | { kind: "keyword"; keyword: string };

        ownershipOfOccurrence(color, occ) / ownsOccurrence(color, occ)
        ownershipForColorsOfOccurrence(colors, occ)   // 融合卡
        ```

        lint 是「遍历 IR 树吐露头 → 判归属 → 拼报错」，要的是**一次折叠、一条报错路径**。
        现有 `ownsOp` / `ownershipOf` / `ownershipForColors` / `colorsOwnOp` 退化成薄包装，签名不动。

  - [ ] **`act.buff` 从 `buff` 行的 `ops` 里摘掉**，该行改按 `tagKeys: ["atk","health"]` 匹配，
        与 `direction` 行同构。于是 `act.buff` / `act.set_tag` / `act.mod_tag`
        三个通用 op 统一按 tag 键路由。两个收益：
        - GRID_001 的方向附魔落到 `direction` 行 = 红 **primary**（原价），
          不再被误判成 buff 行 secondary + 「仅加攻」注记；
        - 补上现存漏洞：今天 `act.set_tag(友军,"atk",10)` 绕过色轮，**蓝色这么写 lint 会放行**。

        `buff` 行的 `keywords: ["aura"]` 不动（光环是 Card 的 `auras` 段，本来就不是 op）。

  - [ ] **匹配条件带符号判据**：`tagKey ∈ {atk,health}` 且**值 > 0** 才算「属性增益」。
        负值 = 减益 = 未登记 = 放行（[决策 #10c](./决策待办.md)：减敌方攻击力是很蓝的控制效果）。
        已知残留：绿因此可自由减攻，见[风险登记册](./风险登记册.md)。

  - [ ] **lint 的输入是整个 `Bundle`（含 `enchantments` 表），不能只看单卡 IR 树**——
        `act.buff` 只带 `ench: EnchantId`，附魔的 `mods` 键在另一个文档里。

  - [ ] `buff` 行红色的 `colorNotes.red = "仅加攻"` 超出「颜色 × 露头」二元判据，
        lint 要额外读 `colorNotes`（该细则在 M1 的注释里已标注）。
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

## 已决策（2026-08-07）

- [决策 #4](./决策待办.md)：`maxCopies` = **2**
- [决策 #5](./决策待办.md)：蓝英雄出**纯 3/6**，3 点登记为平衡储备（M12 的第一个杠杆）
- [决策 #6](./决策待办.md)：立绘美术**推迟到 M12 之后**，程序化占位到底，不阻塞本里程碑
- [决策 #9](./决策待办.md)：`cond.has_color` 在 M4 加，本里程碑的色轮 lint 可以直接用
- [决策 #10](./决策待办.md)：`color-ownership.ts` 的改造清单见上方色轮 lint 任务
