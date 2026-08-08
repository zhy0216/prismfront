---
title: M1 · IR 权威类型与 builder
date: 2026-08-07
tags: prismfront, 里程碑, M1, IR, 类型, builder, 校验器
milestone: M1
status: done
estimate: 2–3d
depends_on: [M0]
blocks: [M2]
risk: normal
---

# M1 · IR 权威类型与 builder

> 索引见 [README](../README.md)。原文见《[实现步骤与里程碑](../../docs/Prismfront%20实现步骤与里程碑.md)》§3。

**产出**：`packages/ir` ｜ **估算** 2–3d ｜ **依赖** M0 ｜ **解锁** M2

---

## 任务

- [x] 把 IR v1 §9 的类型 + v2 §7 的差异 + v2.1 §11 的增补，
      **合并成一份 `irVersion: "2.1.0"` 的完整类型**。
      → 93 个 op（sel 21 / slot 6 / num 16 / cond 17 / card 3 / act 30）+ 25 个事件，
      全部逐个展开成可辨识联合，无 `/* v1 全部保留 */` 占位、无 string 兜底。
      （[决策 #9](../决策待办.md) 的 `cond.has_color` 落地后 = **94 个 op**，
      cond 变 18；那是 `irVersion` 2.2.0，不是 M1 交付的 2.1.0。）
- [x] 顺手做掉架构文档 §10 的 6 项规范一致性清理：
  - [x] `irVersion` 定为 `2.1.0`
  - [x] `baseHp`（原 `heroHp`）
  - [x] `ZoneName` 补 `base` / `fountain`，删 `hero` 旧义
  - [x] `SlotSide` / `SelSide` 拆分（另发现第三个同名不同集的 `MoveSide`，一并单列）
  - [x] `stunned` 快照条件 `atk > 0 && !stunned`
  - [x] `deploySchedule` 语义注释
- [x] TS builder 糖面（v2 §7 列表）。
- [x] `COLOR_OWNERSHIP` 常量——《数值基准》§1.2 的 15 行色轮归属表。
      （**未按 JSON 落地**：JSON module 的类型会被 widen 成 `string`，`as const` 直接失效，
      且 `verbatimModuleSyntax` 下还要 import attributes。TS const 对象本身就是纯数据，
      同样满足「人和 lint 读同一份」。）
- [x] 校验器 L1（结构）+ L2（前缀种类）。L3 语义等 op 集稳定后在 M11 补。

---

## 完成标志

```bash
bunx turbo typecheck lint       # 16/16
bunx turbo boundaries           # 8 包 78 文件无违规
bun test packages/ir            # 371 pass / 0 fail，9 个测试文件
bun run ir:print GRID_001       # 反编译器把 IR 打回 v2 §8.1 的 TS 源码形式
```

- [x] 四条命令全部通过（2026-08-07）
- [x] 能用 builder 写出 v2 §8 的六张示例卡 —— **但「逐字节一致」字面上只对三张成立**，
      见下方「验收强度的诚实口径」。

---

## 注意

IR §1 原则 1「IR 是规范形式，糖只存在于编写层」要在这里立住——
`play: Hit(...)` 与 `play: [Hit(...)]` 必须产出同一份 JSON，否则后面 diff、缓存 key、
哈希全会出问题。

→ **已立住并有专门测试。**

---

## 验收强度的诚实口径（2026-08-07）

「六张示例卡与文档手写 JSON 逐字节一致」这条**字面上只对三张成立**：

- v2 **§8.1 / §8.2 / §8.3** 文档给了 JSON → 真·逐字节比对。
- v2 **§8.4 换位术 / §8.5 战地号手 / §8.6 荆棘卫士** —— **文档根本没有 JSON 代码块**，
  只有 TS 源码 + 散文说明。这三张的期望值是按规范推导出来的字面量，
  测试标题已如实标注「★ 文档未给 JSON，按规范推导」，没有冒充文档原文。

准确表述是：**三张真·逐字节 + 三张按规范推导的回归基线。**
要真正闭环，需要回写 v2 §8.4/§8.5/§8.6 补上这三段 JSON 再反向校验。

## 实测发现的规范缺陷（需回写文档）

M1 在把三份规范合并成一份类型时撞出这些，都不影响已定案的设计结论：

| # | 位置 | 问题 | M1 的处理 |
|---|---|---|---|
| 1 | IR v1 §9 | `Act` 联合**漏了 `act.set_health`**，但 §3.4 签名表与 v2 §7 的「v1 保留」清单都有 | 按保留处理并注释 |
| 2 | IR v1 §10.3 野猪王 | TS 源码按链式是 `where` 包 `minus`，文档 JSON 却是 `minus` 包 `where` —— 语义等价、结构不同，**不可能同时逐字节一致** | 按链式从左往右（唯一自洽读法），留了一条测试如实断言两者结构不同 |
| 3 | IR v1 §10.4 | 规范 JSON 里 `act.summon` 没有 `at`，而 v2 §3.4 规定 `at` 必填 | builder 补 `slot.random_empty(friendly)`，夹具注明这是唯一补写 |
| 4 | v2 §8.2 / §8.4 | `health = 3` / `cost = 1` 用了**赋值号**，在对象字面量里是语法错误 | 按显然意图写成 `health: 3` / `cost: 1`，未改代码迁就 |
| 5 | IR v1 §2.2 vs §10/§8 | 规范形式是否补齐 `script` 全部字段，两处矛盾 | 按 §9 保持字段可选，规范化策略交给 builder；只要同源同产出即满足原则 1 |

## 遗留项

- **`diffBundles` / `ir:diff` 未实现** —— 架构 §2.3 的 `ir` 对外导出清单里有它，
  但 M1 的四条任务与完成标志都没要求。§2.3 契约至今不完整，需在后续里程碑补，
  或从 §2.3 移除。
- **`@prismfront/ir` 的 `./tools/examples` 子路径导出指向测试夹具**
  （`src/__tests__/fixtures/grid-cards.ts`），`apps/cli` 的 `ir:print` 靠它取卡。
  标注为「M1 脚手架，M4 删」—— M4 有真正的 cards bundle 后必须清掉这条子路径导出。
- **词汇表取舍**：`FlagName` 删掉了 v1 的 `taunt`（v2 无攻击 intent、目标由 direction
  唯一决定，嘲讽无语义）；`ZoneName` / `CardKind` 保留了 `weapon` / `hero_power` / `secret`
  等 v1 遗留（照 v2 §5 保留 `secret_revealed` / `hero_power_used` 的先例），
  注明 PF1 无对应内容。
- **`Trigger.filter` / `Intercept.filter` / `num.field.field` 相对 IR §9 有意收紧**
  （从 `Record<string, Sel>` / `string` 收成枚举）。这是「无 string 兜底」的正确取舍，
  但意味着以后事件负载或动作签名新增字段时必须同步改 `types/event.ts` 与 `types/act.ts`，
  否则合法 IR 会被 L1 报成 unknown-field。

## 本轮新增的两条待拍板

- [决策 #9](../决策待办.md)：卡池按颜色筛选 —— 加 `cond.has_color` 还是给 TagKey 加颜色位。
  当前 93 个 op 里没有任何一个能按颜色筛卡池（IR §10.5 的发现示例因此只能表达一半）。
- [决策 #10](../决策待办.md)：`COLOR_OWNERSHIP` 的非 op 维度如何供 M11 lint 消费。
  15 行里有 5 行没有独占 op；另有 `act.buff` 双行冲突会让 GRID_001 被判到错误的行。

## 工程约定（M1 定）

**只有真正有 `*.test.ts` 的包才声明 `"test": "bun test"`。**
`bun test` 在零测试文件时 exit 1，空的 test 脚本会让 `bunx turbo test` 永远红。
各包在自己的里程碑落下第一条测试时再把这行加回去。
当前有 test 脚本的包：`packages/ir`。CI 的 `turbo test` 步骤已随本里程碑启用。
