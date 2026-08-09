---
title: 格子战斗卡牌 DSL 规范 v2
date: 2026-08-05
tags: 卡牌游戏, DSL, IR, 格子战斗, 规范, Colyseus, 回合制
---

# 格子战斗卡牌 DSL 规范 v2.0

> 前置文档：《Colyseus 卡牌游戏技术框架设计》《卡牌 DSL 的 JSON IR 规范》(v1)。
> v1 的分层架构、IR 总体设计（前缀节点、编译产物、bundleId、校验三层、资源上限、
> 挂起/恢复机制）**全部保留**。本文档只写玩法带来的变化，并给出 v2 的完整节点表
> 与 TS 权威类型。`irVersion: "2.0.0"`（major：语义变更）。

---

## 0. 规则输入与机制映射

用户给出的 6 条规则 → 机制术语：

| # | 原文 | 机制化 |
|---|---|---|
| 1 | 双方各有横向 9 个格子 | 每方一行 `slots[9]`，双方**同索引对齐**：友方 i 的"对面"= 敌方 i |
| 2 | 战斗单位放到格子里 | 单位在场必占且仅占一格；`board` 区域从无序列表变为 9 格数组 |
| 3 | 用户的一个动作是 action | 行动权交替制：一次 intent = 一个 action，做完换对方 |
| 4 | 可以 pass | **连续双 pass → 进入战斗阶段**（用户选定 LoR 式；单方 pass 不锁定，对手行动后可再行动） |
| 5 | 开局 5 水晶 | **每回合回满且上限递增**（用户选定炉石式）：开局上限 5，每回合 +1，封顶可配 |
| 6 | 卡牌有战斗方向，默认对面 | `direction` 是**一个普通 Tag**（见 §2.3），默认 0 = 正对面；战斗阶段单位向 `自己的格 + direction` 的敌方格出手 |

用户拍板的另两条：**战斗全场同时结算**（快照攻击，统一扣血，可同归于尽）；
**方向指向空格 → 伤害直接进对方英雄**，英雄血量归零判负。

**本版假设**（可改，都进 RulesConfig，不影响 DSL 形状）：

- 英雄血量 30；双方英雄同回合归零 → 平局
- 有手牌/牌库：起手 4 张，每回合开始抽 1
- 先手：首回合随机（消耗 RNG），之后每回合轮换
- 回合 = round（行动阶段 + 战斗阶段）；"每回合"均指 round

**开放问题**（不阻塞 DSL——`act.*` 已覆盖，这只影响 intent 白名单）：
玩家能否把"移动单位 / 改方向"当作一个 action？还是位置与方向只能由卡牌效果改变？
**待定，默认后者**（更省经济设计，先跑起来）。

**参照系：Artifact / Artifact Foundry（单路版）。** 这套规则 ≈ 去掉三路、塔和英雄装备
经济的 Artifact：action 交替与双 pass 开打即其 initiative 系统；战斗方向即 attack arrow；
打空格进英雄血即打塔；水晶 5 + 递增对应塔法力 3 + 递增。两条经过市场验证的教训直接适用：
① 1.0 的随机箭头（面对空格时 50/25/25 随机直打/斜打）被玩家痛骂，Foundry 已移除改为
直打——本设计选的"直打玩家"正是修正后的形态；② "先 pass 的一方获得下回合先手"是
Artifact 公认的深度来源，已收录为 initiative 选项（§6），建议试玩对比。
Artifact 核心关键词（Cleave/Siege/Retaliate/改箭头）的 DSL 映射见 §8.7。

| 维度 | v1 | v2 |
|---|---|---|
| 战场 | `board` 无序列表 + playOrder | 每方 `slots[9]` 定位数组，playOrder 仅用于触发排序 |
| 回合 | 主动玩家回合制，end_turn | action 交替 + 连续双 pass → 战斗阶段 → 新回合 |
| 战斗 | 玩家指定攻击（attack intent） | **无攻击 intent**。战斗阶段引擎按方向自动结算全场 |
| 位置 | 只有 `sel.adjacent` 一个位置概念 | 新增 `slot.*` 节点族（SlotRef 一等公民）+ 一组位置选择器/动作 |
| 方向 | 无 | `direction` 成为 TagKey：附魔/光环/沉默天然作用于它 |
| 资源 | mana | crystal（改名），回满 + 上限递增 |
| 事件 | turn_began/ended 等 | round_*、combat_*、struck、passed、unit_moved 等（§5） |

不变的：Selector/Num/Cond/Act 四族与前缀约定、动作内快照、`repeat` vs `random(n)`
求值时机、空集合语义、RNG 推进顺序规则、拦截器/触发器/光环三分、挂起与恢复、
结算栈存引用、校验三层、资源上限、bundle 版本化。

---

## 2. 状态模型修订

### 2.1 GameState 增改

```ts
interface GameState {
  // ...v1 字段（seq/rng/entities/stack/pendingInput 等）不变
  round: number;
  phase: "mulligan" | "actions" | "combat" | "over";
  priority: PlayerId;            // 当前该谁 action
  initiative: PlayerId;          // 本回合先手（战斗快照顺序用）
  firstPasser: PlayerId | null;  // 本回合先 pass 的一方（initiative:"first_passer" 用）
  consecutivePasses: 0 | 1 | 2;
  slots: [(EntityId | null)[], (EntityId | null)[]];   // 双方各 9，索引对齐
}

interface PlayerData {
  hp: number;
  crystals: number;              // 当前可用
  crystalCap: number;            // 开局 5，每回合 +growth，封顶 capMax
  // hand/deck/graveyard 仍是有序列表 zone
}
```

### 2.2 EntityData 增字段

```ts
interface EntityData {
  // ...v1 字段不变
  slot: number | null;           // 在场时 0-8，否则 null（英雄恒为 null）
}
```

英雄是不占格子的实体（`sel.zone(side,"hero")` 照旧可选中），承接打空格的伤害。

### 2.3 direction 是 Tag，不是新机制 ★

```
生效方向 = base.direction (默认 0) + Σ附魔 + Σ光环   —— 与 atk/health 同一套管线
```

由此免费获得：附魔可以改方向（"战吼：方向 -1"）、光环可以批量改方向、
**沉默自动重置方向**、`num.attr(of,"direction")` 直接可读、`act.set_tag/mod_tag`
直接可写。不新增任何 op。方向不限幅：指出界 = 指空格 = 打英雄（§4.3）。

---

## 3. 节点变更表

### 3.1 新节点族：`slot.*`（SlotRef，位置一等公民）

选择器返回实体，但"空格子"不是实体——召唤、移动、判空都需要**位置值**。

| op | 签名 | 说明 |
|---|---|---|
| `slot.at` | `(side, index: Num) -> SlotRef` | 字面位置。`side: "friendly"｜"enemy"` |
| `slot.of` | `(of: Sel) -> SlotRef` | 某实体所站的格。非单实体或不在场 → 无效槽 |
| `slot.opposite` | `(of: SlotRef) -> SlotRef` | 翻转 side，索引不变 |
| `slot.shift` | `(of: SlotRef, delta: Num) -> SlotRef` | 同排位移。出界 → 无效槽 |
| `slot.random_empty` | `(side) -> SlotRef` | 随机空格。**推进 RNG**。无空格 → 无效槽 |
| `slot.first_empty` | `(side, from?: "left"｜"right") -> SlotRef` | 最左/最右空格，默认 left |

**无效槽语义 = 空集合语义的位置版**：动作的 SlotRef 参数解析为无效槽 → 该动作静默跳过。
`cond.occupied(无效槽)` → `false`。

RNG 规则延伸：`slot.random_empty` 与 `sel.random` 同级，**禁止出现在
aura / intercept.cond 内**（校验期错误）。

### 3.2 Selector 增改

| op | 签名 | 说明 |
|---|---|---|
| `sel.at` NEW | `(slot: SlotRef｜SlotRef[]) -> Sel` | 格上的实体。空格贡献空集 |
| `sel.opposite` NEW | `(of: Sel) -> Sel` | `of` 中每个实体的**正对面**实体（不看方向） |
| `sel.combat_target` NEW | `(of: Sel) -> Sel` | 按当前 direction 解析的战斗目标。指空格 → **敌方英雄** |
| `sel.attackers_of` NEW | `(of: Sel) -> Sel` | 所有当前方向指向 `of` 中实体的敌方单位（"谁在瞄我"） |
| `sel.adjacent` CHANGED | `(of: Sel, dist?: Num) -> Sel` | 语义改为**位置相邻**：同侧 ±dist 格内的单位，默认 1 |
| `sel.zone` CHANGED | 不变，但 `zone:"board"` 现在**按格序 0→8 枚举**（顺序有定义了） |

### 3.3 Num / Cond 增改

| op | 签名 | 说明 |
|---|---|---|
| `num.slot_index` NEW | `(of: Sel) -> Num` | 所站格索引。**唯一的例外返回值：不在场/非单实体 → -1**（因为 0 是真实格子，不能当空值用） |
| `cond.occupied` NEW | `(slot: SlotRef) -> Cond` | 格上有单位。判空用 `cond.not` 包一层 |

方向读数不需要新 op：`num.attr(of, "direction")`。

`num.tag` 的 GlobalTag 更新为：`round`、`crystals`、`crystal_cap`、`fatigue`。

### 3.4 Act 增改

**新增（位置四件套 + 出手）**

```
act.move_to (target: Sel, to: SlotRef)          // 瞬移。to 被占/无效 → 跳过
act.shift   (target: Sel, delta: Num)           // 位移：逐格推，被占/到边即停，不连推
act.swap    (a: Sel, b: Sel)                    // 换位。a、b 须各为单个在场单位，否则跳过
act.strike  (attacker: Sel, target: Sel)        // 立即出手一次：amount = attacker 当前 atk
                                                // 内部走 act.hit 管线（拦截器因此两处都能拦）
```

`delta` 用带符号整数而不用 "left/right"——双方索引轴共享，"左右"随视角翻转，
数轴不会。TS builder 提供 `Push/Pull` 语法糖处理符号。

**修改**

```
act.summon (player, card, at: SlotRef, count?)
```
`at` 在**规范形式中必填**。TS builder 里省略时，编译器补
`{op:"slot.random_empty", side:"friendly"}`（显式化，保证 RNG 顺序可审计）。
`at` 被占或无效 → 跳过。`count > 1` 时每个后续单位重新求值 `at`。

**删除**

- `act.attack`（玩家指定攻击已不存在，效果驱动的出手用 `act.strike`）

**改名**

- `act.gain_mana` → `act.gain_crystal`（本回合水晶）
- `act.gain_max_mana` → `act.gain_crystal_cap`（上限）

### 3.5 附魔修订

```json
{ "id": "X_e", "mods": { "atk": 1, "direction": -1 }, "duration": "end_of_combat" }
```

- `mods` 可含 `direction`（§2.3）
- `duration` 更新：`"permanent" | "end_of_round" | "end_of_combat" | "while_source_alive"`
  （v1 的 `end_of_turn` 改名 `end_of_round`；新增 `end_of_combat`——"战斗号角"类必需）

---

## 4. 回合状态机与战斗结算（本版核心语义）

### 4.1 回合状态机

```
round_start:
  crystalCap = min(5 + (round-1) * growth, capMax)
  crystals   = crystalCap                     ← 回满
  各抽 1 张；initiative 按 RulesConfig.initiative 更新；priority = initiative
  consecutivePasses = 0
  → actions

actions:                          ── 行动阶段 ──
  priority 方提交一个 intent：
    play_card / (未来可开放的其他 action) →
        consecutivePasses = 0；priority 切换
    pass →
        consecutivePasses += 1；priority 切换
        consecutivePasses == 2 → combat        ← 连续双 pass 才开打

combat:                           ── 战斗阶段，见 §4.2 ──
  → round_end

round_end:
  end_of_round 附魔到期剥离 → round_start（回合数 +1）

任意时刻某英雄 hp<=0 → over（在死亡结算中判定；双亡 → 平局）
```

注意 pass **不锁定**：一方 pass 后对手做了 action，pass 方下轮可继续行动
（`consecutivePasses` 被清零）。

计时提示（server 层）：行动交替制意味着**每 action 一个计时器**，
不是每回合一个。超时视同 pass。

### 4.2 战斗阶段算法（全场同时结算）

```
1. emit combat_began → 结算栈完全清空
   （combat_began 触发器此时跑完——buff/移动/召唤都会影响下一步快照）

2. 快照 strikes：
   按 [initiative 方格 0→8, 另一方格 0→8] 遍历所有在场单位：
     atk <= 0 → 不出手
     目标格 = 敌方行的 (自己格索引 + 生效direction)
     目标   = 目标格上的单位；目标格越界或为空 → 敌方英雄
     记录 { attacker, target, amount = 此刻的 atk }
   ★ 快照后列表与数值全部冻结：中途加/掉 buff、死亡都不改变本轮出手

3. 按快照顺序逐条应用：
     每条走 act.strike → act.hit 管线，拦截器（圣盾/减伤/改目标）逐条生效
     产生的触发器只入栈不结算 ★ 不做中途死亡结算 ★
   —— 这两个"不"就是"同时"的全部含义：
      先被打死的单位本轮照样打出伤害（同归于尽成立）

4. 全部应用完毕：结算栈开闸（struck 等触发器按入栈序跑）
   → 统一死亡结算 → 亡语 → 光环重算 →（有新死亡则循环至不动点）
   ★ 战斗中（亡语等）召唤的单位不获得出手：快照已冻结

5. emit combat_ended → end_of_combat 附魔剥离 → round_end
```

顺序敏感点只有两处，都已钉死：**快照遍历序**（决定事件流顺序与拦截器消耗顺序，
如圣盾挡哪一下）与 **RNG**（战斗阶段本身不消耗 RNG；触发器里的随机照旧走 §v1-5.4）。

### 4.3 打英雄

对英雄的 strike 走同一条 `act.hit` 管线，产生 `damaged` 事件（target = 英雄实体），
护甲/拦截器对英雄同样生效。hp<=0 在死亡结算阶段统一判定。

### 4.4 挂起兼容性

战斗阶段的触发器/亡语若含 `act.discover` 等挂起点，机制照常工作
（栈可序列化，v1-§6）。超时兜底规则不变。

---

## 5. 事件表 v2

```
round_began  round_ended  crystal_gained
action_taken  player_passed
combat_began  struck  combat_ended
card_played  card_drawn  card_discarded  card_added_to_hand
unit_summoned  unit_died  unit_moved  direction_changed
damaged  healed  buffed  silenced  transformed
hero_damaged 不单设：damaged 的 target 是英雄实体即是
secret_revealed  hero_power_used            （保留，玩法可能用不上）
```

- `struck` 负载：`{source, target, amount}`——战斗出手与 `act.strike` 都发它
  （`damaged` 是伤害结果，`struck` 是出手这件事，两者都能挂触发器）
- `unit_moved` 负载：`{target, fromSlot, toSlot}`，move_to/shift/swap 都发
- v1 的 `turn_began/turn_ended` 删除，`attacked/attack_declared` 删除
- 触发器 `filter` 现在可用位置选择器：如 `filter: {target: sel.adjacent(sel.self)}`
  ——"相邻友军被打时"不需要任何新机制

---

## 6. RulesConfig v2

```ts
interface RulesConfig {
  board:    { slots: 9 };
  crystals: { initial: 5; growth: 1; capMax: 10 };
  pass:     { combatAfterConsecutivePasses: 2 };
  initiative: "alternate" | "first_passer" | "random_each_round" | "fixed_first";
  // "first_passer"（Artifact 式）：本回合先 pass 的一方获得下回合先手。
  // 与双 pass 规则天然咬合——"何时 pass"从纯节奏决策升级为资源决策：
  // 多打一张牌 = 让出下回合先手。建议试玩时与 "alternate" 对比。
  heroHp: 30;
  // size 是派生量 = heroes.perDeck × heroes.cardsPerHero（§11.1 配额制）；
  // maxCopies 2 → 3（2026-08-08，决策 #12）
  deck: { size: 30; maxCopies: 3; startingHand: 4; drawPerRound: 1; fatigue: true };
  playerActions: ("play_card" | "move_unit" | "set_direction")[];  // 开放问题的开关
  actionSeconds: 30;
  reconnectSeconds: 90;
}
```

`playerActions` 默认 `["play_card"]`——移动/改方向暂时只归卡牌效果管（§0 开放问题）。

---

## 7. TS 权威类型（v2 全量差异部分）

```ts
export type Side = "friendly" | "enemy";

export type SlotRef =
  | { op: "slot.at";           side: Side; index: Num }
  | { op: "slot.of";           of: Sel }
  | { op: "slot.opposite";     of: SlotRef }
  | { op: "slot.shift";        of: SlotRef; delta: Num }
  | { op: "slot.random_empty"; side: Side }                       // RNG
  | { op: "slot.first_empty";  side: Side; from?: "left" | "right" };

export type Sel =
  | /* v1 全部保留（sel.zone/self/target/controller/opponent/chosen/it/event/entity、
       and/or/minus/where/random/limit/sort） */
  | { op: "sel.at";            slot: SlotRef | SlotRef[] }
  | { op: "sel.opposite";      of: Sel }
  | { op: "sel.combat_target"; of: Sel }
  | { op: "sel.attackers_of";  of: Sel }
  | { op: "sel.adjacent";      of: Sel; dist?: Num };             // 语义改为位置相邻

export type Num =
  | /* v1 全部保留 */
  | { op: "num.slot_index"; of: Sel };                            // 空值例外：-1

export type Cond =
  | /* v1 全部保留 */
  | { op: "cond.occupied"; slot: SlotRef };

export type Act =
  | /* v1 保留：hit/heal/set_health/gain_armor/draw/give/shuffle/discard/destroy/
       transform/buff/silence/set_tag/mod_tag/set_flag/move/steal/
       when/repeat/for_each/discover/select_target/nothing */
  | { op: "act.summon";   player: Sel; card: CardRef; at: SlotRef; count?: Num } // at 必填
  | { op: "act.move_to";  target: Sel; to: SlotRef }
  | { op: "act.shift";    target: Sel; delta: Num }
  | { op: "act.swap";     a: Sel; b: Sel }
  | { op: "act.strike";   attacker: Sel; target: Sel }
  | { op: "act.gain_crystal";     player: Sel; amount: Num }
  | { op: "act.gain_crystal_cap"; player: Sel; amount: Num };
  // 删除：act.attack、act.gain_mana、act.gain_max_mana

export type TagKey = "atk" | "health" | "cost" | "direction" | /* ... */;
export type GlobalTag = "round" | "crystals" | "crystal_cap" | "fatigue";
export type Duration = "permanent" | "end_of_round" | "end_of_combat" | "while_source_alive";
export type EventName = /* §5 表 */;
```

TS builder 糖面（编译目标都是上面的 IR）：

```ts
At(FRIENDLY, 4)              // slot.at
SlotOf(SELF)                 // slot.of
OPPOSITE(SELF)               // sel.opposite
COMBAT_TARGET(SELF)          // sel.combat_target
AttackersOf(SELF)            // sel.attackers_of
Adjacent(SELF)               // sel.adjacent
Push(X, 1) / Pull(X, 1)      // act.shift(delta=+1 / -1)
Summon(CONTROLLER, "id")               // at 自动补 slot.random_empty(friendly)
Summon(CONTROLLER, "id", At(FRIENDLY, Num))
Strike(SELF, COMBAT_TARGET(SELF))
defineEnchantment({ id, direction: -1, duration: "end_of_combat" })
```

---

## 8. 示例卡（v2 玩法特色向）

### 8.1 斜刺长枪兵 —— direction 即 Tag

```ts
defineCard({
  id: "GRID_001", name: "斜刺长枪兵", kind: "minion", cost: 3, atk: 3, health: 2,
  text: "战吼：战斗方向变为斜左。",
  play: Buff(SELF, "GRID_001e"),
});
defineEnchantment({ id: "GRID_001e", direction: -1 });
```

```json
{ "script": { "play": [
    { "op": "act.buff", "target": {"op":"sel.self"}, "ench": "GRID_001e" } ] } }
```
沉默它 → 附魔剥离 → 方向自动回 0。零额外代码。

### 8.2 空袭猎手 —— 位置条件光环

```ts
defineCard({
  id: "GRID_002", name: "空袭猎手", kind: "minion", cost: 2, atk: 2, health = 3,
  text: "对面格子没有单位时，攻击力 +2。",
  aura: Aura(SELF, { atk: +2 },
             Not(Occupied(SlotOf(SELF).opposite()))),
});
```

```json
{ "auras": [ {
  "affects": { "op": "sel.self" },
  "mods": { "atk": 2 },
  "cond": { "op": "cond.not", "of":
            { "op": "cond.occupied", "slot":
              { "op": "slot.opposite", "of":
                { "op": "slot.of", "of": {"op":"sel.self"} } } } },
  "zone": "board" } ] }
```
光环每步重算 → 对面上/空单位时自动生效/失效，无需触发器。

### 8.3 裂地冲锋 —— 位移 + 伤害

```ts
defineCard({
  id: "GRID_003", name: "裂地冲锋", kind: "spell", cost: 2,
  text: "对一个敌方单位造成 2 点伤害，并将其推移一格。",
  target: ENEMY_MINIONS,
  play: [Hit(TARGET, 2), Push(TARGET, 1)],
});
```

```json
{ "play": [
  { "op": "act.hit",   "target": {"op":"sel.target"}, "amount": 2 },
  { "op": "act.shift", "target": {"op":"sel.target"}, "delta": 1 } ] }
```
`shift` 语义：目标格被占或到边即停（不连推）。推开后它的战斗方向照旧，
但正对的敌人变了——位移即战术。

### 8.4 换位术 —— 双目标 = target + 挂起点

```ts
defineCard({
  id: "GRID_004", name: "换位术", kind: "spell", cost = 1,
  text: "选择两个友方单位，交换它们的位置。",
  target: FRIENDLY_MINIONS,
  play: [
    SelectTarget(FRIENDLY_MINIONS.not(TARGET)),   // 第二目标 → 挂起等输入 → CHOSEN
    Swap(TARGET, CHOSEN),
  ],
});
```
v1 的挂起机制原样复用，无新机制。

### 8.5 战地号手 —— 战斗阶段触发 + end_of_combat

```ts
defineCard({
  id: "GRID_005", name: "战地号手", kind: "minion", cost: 4, atk: 3, health: 4,
  text: "战斗开始时，所有友方单位本次战斗攻击力 +1。",
  triggers: [ on(CombatBegan(), Buff(FRIENDLY_MINIONS, "GRID_005e")) ],
});
defineEnchantment({ id: "GRID_005e", atk: +1, duration: "end_of_combat" });
```
时序保证（§4.2 第 1 步）：combat_began 触发器**先于快照**结算完毕，
所以这个 +1 一定算进本轮出手。

### 8.6 荆棘卫士 —— struck 触发反伤

```ts
defineCard({
  id: "GRID_006", name: "荆棘卫士", kind: "minion", cost: 3, atk: 1, health: 6,
  text: "每当受到单位的出手伤害，对出手者造成 1 点伤害。",
  triggers: [ on(Struck(SELF), Hit(EVENT.source, 1)) ],   // filter: target=SELF
});
```
同时结算下的行为（§4.2 第 3-4 步）：反伤触发器在**全部出手应用完之后**才结算——
即使荆棘卫士本轮被打死，反伤仍然发出（它是被快照期间的事件触发的）。

### 8.7 Artifact 关键词映射 —— 表达力验证

既然规则 ≈ 单路 Artifact，其核心关键词就应当全部可写。逐一验证（**均无需新 op**，
全部是 `struck` 触发器 + 现有选择器的组合，按 §4.2 时序在出手应用完毕后结算）：

| Artifact 关键词 | 语义 | DSL 写法 |
|---|---|---|
| Retaliate X | 被出手命中时反打 X | `on(Struck({target: SELF}), Hit(EVENT.source, X))` —— 即 §8.6 |
| Cleave X | 命中单位时溅射其相邻 X | `on(Struck({source: SELF}), Hit(Adjacent(EVENT.target), X))` |
| Siege X | 命中单位时额外打英雄 X | `on(Struck({source: SELF}), when(IsMinion(EVENT.target), Hit(ENEMY_HERO, X)))` |
| 改箭头（Compel 类） | 强制改变战斗方向 | `Buff(TARGET, ench)`，ench 带 `direction` mod —— §2.3 |

三个顺手的自洽性：溅射/反伤走 `act.hit` 而非 `act.strike`，不再发 `struck`，
**天然不会互相触发成连锁**；Cleave 命中英雄时 `Adjacent(英雄)` 为空集 → 静默跳过
（英雄不在场上，§v1-5.2 空集语义）；Siege 打空格时本来就直伤英雄，`IsMinion` 条件
恰好挡住双重计算。三条都不需要特判——是空集语义和事件/动作二分在兜底。

---

## 9. 校验新增（并入 v1 三层中的 L3）

- `slot.at.index` 为字面量时须在 `[0, 8]`
- `slot.random_empty` 出现在 aura / intercept.cond → 错误（确定性规则延伸）
- `act.summon.at` 缺失 → 错误（规范形式必填；builder 负责补默认）
- `act.shift.delta` 为字面量 0 → 告警（无操作，多半是笔误）
- trigger.on 使用已删除事件（turn_*、attacked）→ 错误，提示改名映射
- `direction` 出现在非 minion 的附魔 mods 中 → 告警

资源上限表不变。

---

## 10. 迁移清单（v1 bundle → v2）

1. `irVersion` 2.0.0，major——v1 引擎直接拒载
2. `act.attack` → `act.strike`；`act.gain_mana(_cap)` → `act.gain_crystal(_cap)`
3. `act.summon` 补 `at`（无位置语义的旧卡补 `slot.random_empty`）
4. 附魔 `duration: "end_of_turn"` → `"end_of_round"`
5. trigger `on: "turn_began/ended"` → `"round_began/ended"`
6. `sel.adjacent` 语义变更复查：v1 是"召唤顺序相邻"，v2 是"格子相邻"
7. 状态层：`zones["px:board"]` 列表 → `slots` 数组；实体补 `slot` 字段；
   `direction` 进 TagKey

---

## 11. v2.1 增补：英雄、色门与融合卡（构筑规则定案，2026-08-05；构筑层补订 2026-08-08）

规范尚未实现，破坏性改名直接并入，无兼容负担。IR 版本记 2.1.0。

### 11.1 构筑规则（2026-08-08 补订：混色自由 → 英雄专属卡 + 配额制）

**卡组外 3 张英雄卡**（互不相同，**不可重复**）+ **30 张卡组**。

每张非英雄卡**恰好归属一名英雄**（`data.hero`，**无中立卡**）。30 张只能从
**所选 3 名英雄的专属卡池并集**里挑 —— 选英雄即选可用卡池。

**配额制**：每名英雄**恰好带 10 张**自己的专属卡，同名卡**至多 3 份**。
`3 名 × 10 张 = 30`，所以 `deck.size` 不再是自由旋钮，而是
**派生量 `perDeck × cardsPerHero`**（校验须断言二者一致，§11.4b）。

于是构筑决策是**每名英雄的 10 个槽位怎么分配份数**：
把 10 张压在 3-4 种卡上（每种 3 份，抽稳但打法单一），还是摊到 8-10 种（曲线全但抽不稳）。
**推论**：每名英雄的专属卡种类数必须 `≥ ⌈cardsPerHero / maxCopies⌉ = 4`，
否则凑不满配额——这是英雄扩池时的硬下限，卡池校验要挡住。

**这条限制只作用于组牌，不作用于打出。** 卡进了手牌之后能不能打，只看色门（§11.4）：
`colors` 里每个颜色都有己方存活在场英雄即可，**与这张卡归属谁无关**。
所属英雄阵亡不会锁死它的专属卡——只要同色还有别的光源在场，照打不误。
（PF1 每色恰好一名英雄，两条判断的结果永远重合，但**引擎不许把它们实现成同一条判断**：
这是英雄扩池后第一个会炸的地方。）

双色（融合）卡不是特例：它同样只归属一名英雄，只是这名英雄拥有一张跨色的专属卡。
带它只需选中该英雄；打出仍要两色光源同时在场。

### 11.2 英雄是占格参战的单位，"基地"接管承伤

- 英雄 `kind: "hero"`：在 9 格内占一格、有攻/血、按方向出手、可被打——与单位同规则结算
- 原先承接空格伤害的"英雄"实体更名**基地**（base，30 血，胜负判定）：
  `ZoneName` 中 `"hero"` → `"base"`，TS 常量 `ENEMY_HERO` → `ENEMY_BASE`。
  战斗方向指空格 → 打基地，语义完全不变，只改名
- **选择器词汇分化**（builder 糖，IR 不变）：
  `FRIENDLY_UNITS` = 场上全部（含英雄）；
  `FRIENDLY_MINIONS` = 排除英雄，编译为 `zone(board).where(is_kind(it,"minion"))`。
  已有卡的"友方随从"语义自动正确（光环不吃英雄）；伤害法术的默认目标域建议用 `*_UNITS`

### 11.3 部署与复活

- **r1 开始**：双方**同时秘密**各选 2 名英雄及格位 → 同时揭示；**r2 开始**：部署第 3 名
- 复活重部署走同一流程
- 工程技巧：同时秘密选择由**服务端聚合**双方选择后以单个
  `{t:"deploy", placements:[...]}` intent 喂引擎——引擎保持单输入模型，不需要双方并发输入机制
- phase 序列变为：`round_start → deploy(若有) → actions → combat → round_end`
- 英雄死亡 → 移入新区域 `"fountain"`，标记 `respawnAt = 回合+2`；缺席一整回合；
  到期后在 deploy 阶段重新选格上场
- 新事件：`hero_deployed`、`hero_died`（英雄阵亡不发 `unit_died`，触发器需明确区分）

### 11.4 色门与融合卡（legality 层，非 DSL）

- `card.data.faction` 废弃 → `card.data.colors: Color[]`（长度 1-2）
- **色门**：`play_card` 合法性要求 `colors` 中每个颜色都有一名**己方存活在场**英雄。
  英雄阵亡缺席期间该色牌全部锁定
- **融合卡** = `colors` 长度 2 → 需两色英雄同时在场。r1 只部署两色 → 第三色及其融合 r2 起才可用
- 校验新增：`colors` 长度 1-2；`kind:"hero"` → `colors` 恰 1、无 `cost`、不入 30 张卡组

### 11.4b 专属卡归属（构筑层，2026-08-08 新增）

- `card.data.hero: CardId` **新增**：所属英雄，指向一张 `kind:"hero"` 的卡。
  **纯构筑层字段** —— `play_card` 合法性、结算、投影、DSL 求值**一律不读它**。
  消费者只有两个，且都在引擎之外：`ir:validate` 的 lint，与**喂给 `createGame` 之前**的
  卡组校验。`packages/engine` 里对 `data.hero` 的引用数应当恒为 **0**
  （engine 只收已经合法的 id 列表）
- 归属 vs 色门是两条独立判断，不要合并（§11.1）
- 校验新增：
  - **可收藏的非英雄卡 → `hero` 必填**，且引用的 id 存在、`kind` 确为 `"hero"`
    （token / `collectible:false` 的卡不进卡组，免除此项）
  - `kind:"hero"` 的卡**不写** `hero`
  - **专属卡的 `colors` 必须包含其所属英雄的颜色**（红英雄可以有红蓝融合专属卡，
    不能有纯蓝专属卡——否则色门叙事与归属叙事脱钩）
  - **卡池下限**：每名英雄的专属卡**种类数 ≥ `⌈cardsPerHero / maxCopies⌉`**
    （当前 = ⌈10/3⌉ = 4），否则该英雄凑不满配额，是**卡池数据错误不是玩家错误**，
    必须在 `ir:validate` 挡住，不能等到组牌时才报
- 组牌校验（喂给 `createGame` 之前）：
  - 3 名英雄**互不相同**
  - 卡组内每张卡的 `hero` ∈ 所选 3 名英雄
  - **每名英雄名下恰好 `cardsPerHero` 张**（配额制，不是上限也不是下限）
  - 同名卡至多 `deck.maxCopies` 份
  - `deck.size === heroes.perDeck × heroes.cardsPerHero`（配置自洽性，
    在**配置校验期**就抛错，与 `playerActions` 那条同一处理方式，决策 #3）

### 11.5 RulesConfig 增补

```ts
heroes: {
  perDeck: 3, deploySchedule: [2, 1], respawnDelay: 1,
  allowDuplicates: false,
  cardsPerHero: 10,        // 每名英雄的配额，deck.size = perDeck × cardsPerHero
};
deck: { size: 30, maxCopies: 3, ... };   // maxCopies 2 → 3（决策 #12 取代决策 #4）
```

---

## 12. v2 明确不做的

- **不做同格叠放 / 多格单位**（占两格的巨型单位）。状态模型支持得了，但战斗快照、
  位移碰撞、光环判定全部要双倍规则，等玩法验证后再说。
- **不做纵深（多排/多路）**。单路 9 格**已定案**（2026-08-05 确认）：`slot.*` 坐标
  维度固定为一维 `(side, index)`，永不加 lane/row。格子数量本身仍走 `board.slots`
  配置（哪天想试 7 格或 11 格只是改数字），但**维度不再是自由度**。
- **不做玩家手动改方向/移动的 intent**（`playerActions` 开关留着，默认关）。
- v1 的四条不做（自定义 op、表达式字符串、let、通用循环）继续有效。
