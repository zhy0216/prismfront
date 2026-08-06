---
title: 卡牌 DSL 的 JSON IR 规范
date: 2026-08-05
tags: 卡牌游戏, DSL, IR, JSON, TypeScript, 规范, Colyseus
---

# 卡牌 DSL 的 JSON IR 规范 v1.0

> 配套文档：《Colyseus 卡牌游戏技术框架设计》
>
> 定位：TS builder 是**编写层**，本 IR 是**运行时格式与传输格式**。
> engine 只认识 IR，不认识 TS；`cards/*.ts` 编译产出 `cards.ir.json`。

---

## 0. 为什么需要一份"规范"而不只是一个 schema

JSON Schema 只能约束**形状**，约束不了**语义**。而卡牌引擎 90% 的 bug 出在语义上：
选择器什么时候求值、空集合怎么处理、RNG 在哪一步推进、目标列表是快照还是实时查询。

所以这份文档的重点在 §5（求值语义）和 §6（挂起与恢复）。
§3 的 op 表只是词汇表，§5 才是语法和语义。

---

## 1. 六条设计原则

1. **IR 是规范形式（canonical），糖只存在于编写层。**
   TS 里 `play: Hit(TARGET, 6)` 和 `play: [Hit(TARGET, 6)]` 都合法，
   编译产出永远是数组。IR 里不存在"两种写法等价"这种事，
   否则 diff、缓存 key、哈希全部会出问题。

2. **每个节点是带 `op` 判别式的对象**，四类节点用前缀区分：
   `act.*` 动作 / `sel.*` 选择器 / `num.*` 数值 / `cond.*` 条件。
   前缀不是洁癖：它让**类型校验退化成字符串前缀检查**，
   删掉了整整一类"把选择器塞进数值位置"的攻击面（UGC 场景尤其重要），
   而且 dump 结算栈时一眼能看出在看什么。

3. **可读性由工具解决，不由格式牺牲。**
   IR 故意写得机器友好；配套提供 `ir:print` 反编译器，把 IR 渲染回 TS 风格文本。
   反编译器顺带解决了另外两个需求：admin 后台展示卡牌逻辑、两个版本间的行为 diff。

4. **常见字面量不包装。** 数字直接写 `6` 而不是 `{"op":"num.const","v":6}`；
   布尔直接写 `true`。只有需要惰性求值时才升级为节点。

5. **IR 节点不可变、可共享。** 一张卡的 `play` 节点在内存里只有一份，
   结算栈引用它而不是拷贝它（见 §6.2）。

6. **数据与逻辑在文档层面就分开。** `card.data`（数值/文案/美术）和 `card.script`（逻辑）
   是两个顶层字段。策划改 `data`，程序改 `script`，两边可以独立走审批和热更。

---

## 2. 文档结构

### 2.1 Bundle（一次构建的产物）

```json
{
  "irVersion": "1.0.0",
  "bundleId": "core@2026.08.05-1",
  "createdAt": "2026-08-05T10:00:00Z",
  "opsUsed": ["act.hit", "act.draw", "sel.target", "num.count"],
  "cards": { "CORE_001": { /* Card */ } },
  "enchantments": { "CORE_020e": { /* Enchantment */ } }
}
```

| 字段 | 说明 |
|---|---|
| `irVersion` | 本规范的 semver。engine 声明支持区间（如 `>=1.0.0 <2.0.0`） |
| `bundleId` | 不可变标识。**每场对局在开始时钉住一个 bundleId 并写进回放**，这样平衡性补丁不会让历史回放失真 |
| `opsUsed` | 用到的 op 全集。engine 启动时一次性比对自己支持的 op 集，快速拒绝，不用等到卡打出来才炸 |

### 2.2 Card

```json
{
  "id": "CORE_001",
  "set": "core",
  "data": {
    "name":   { "zh": "火球术", "en": "Fireball" },
    "text":   { "zh": "造成 6 点伤害。", "en": "Deal 6 damage." },
    "kind":   "spell",
    "cost":   4,
    "faction": "mage",
    "rarity": "common",
    "tribe":  null,
    "art":    "core/fireball",
    "collectible": true,
    "tags":   { "atk": 0, "health": 0 }
  },
  "script": {
    "target": { "op": "sel.zone", "side": "both", "zone": ["board", "hero"] },
    "requires": null,
    "play": [
      { "op": "act.hit", "target": { "op": "sel.target" }, "amount": 6 }
    ],
    "deathrattle": [],
    "triggers": [],
    "intercepts": [],
    "auras": [],
    "costMod": null,
    "chooseOne": []
  }
}
```

`script` 的所有字段可省略，省略等价于空数组 / `null`。构建器统一补齐成规范形式。

**`kind`**：`"minion" | "spell" | "weapon" | "hero" | "hero_power" | "token"`

### 2.3 Enchantment（附魔 / buff）

```json
{
  "id": "CORE_020e",
  "attachesTo": "minion",
  "mods":  { "atk": 2, "health": 1 },
  "flags": ["taunt"],
  "duration": "permanent",
  "script": { "triggers": [], "auras": [] }
}
```

`duration`：`"permanent"` | `"end_of_turn"` | `"end_of_next_turn"` | `"while_source_alive"`

附魔本身可以带触发器（"这个随从死亡时……"），所以 `script` 是递归结构。

---

## 3. 节点词汇表

签名记法：`op(字段: 类型) -> 返回类型`。
`Sel` = 选择器节点，`Num` = 数字或数值节点，`Cond` = 布尔或条件节点，`Act[]` = 动作数组。

### 3.1 Selector（`sel.*` → `Entity[]`）

**上下文叶子**（求值时从绑定上下文取，见 §5.1）

| op | 签名 | 说明 |
|---|---|---|
| `sel.self` | `() -> Sel` | 持有本脚本的实体 |
| `sel.target` | `() -> Sel` | 本次打出/动作指定的目标 |
| `sel.controller` | `() -> Sel` | SELF 的控制者（玩家实体） |
| `sel.opponent` | `() -> Sel` | 对手玩家实体 |
| `sel.chosen` | `() -> Sel` | 最近一次 `act.discover` / `act.select_target` 的结果 |
| `sel.it` | `() -> Sel` | 迭代游标。仅在 `sel.where` / `act.for_each` 内部合法 |
| `sel.event` | `(field) -> Sel` | 事件负载中的实体。`field`: `"source"｜"target"｜"player"` |
| `sel.entity` | `(id: number) -> Sel` | 字面实体 id。**仅出现在运行时绑定，编写层不可用**（见 §5.6） |

**区域选择器**

```
sel.zone(side, zone) -> Sel
  side: "friendly" | "enemy" | "both"
  zone: ZoneName | ZoneName[]
  ZoneName: "board" | "hand" | "deck" | "graveyard" | "secret" | "hero" | "weapon"
```

TS 里的具名常量全部编译成这一个 op：

| TS 常量 | IR |
|---|---|
| `FRIENDLY_MINIONS` | `{op:"sel.zone", side:"friendly", zone:"board"}` |
| `ENEMY_HERO` | `{op:"sel.zone", side:"enemy", zone:"hero"}` |
| `ALL_CHARACTERS` | `{op:"sel.zone", side:"both", zone:["board","hero"]}` |
| `FRIENDLY_HAND` | `{op:"sel.zone", side:"friendly", zone:"hand"}` |

**组合与过滤**

| op | 签名 | 说明 |
|---|---|---|
| `sel.and` | `(of: Sel[]) -> Sel` | 交集，保持 `of[0]` 的顺序 |
| `sel.or` | `(of: Sel[]) -> Sel` | 并集，去重，按 playOrder 排序 |
| `sel.minus` | `(of: Sel, exclude: Sel) -> Sel` | 差集 |
| `sel.where` | `(of: Sel, cond: Cond) -> Sel` | 逐个求值 `cond`，其中 `sel.it` 绑定到候选 |
| `sel.random` | `(of: Sel, n?: Num, distinct?: bool) -> Sel` | 随机取 n 个，默认 `n=1, distinct=true`。**推进 RNG** |
| `sel.limit` | `(of: Sel, n: Num, from?: "start"｜"end") -> Sel` | 取前/后 n 个 |
| `sel.sort` | `(of: Sel, by: TagKey, dir?: "asc"｜"desc") -> Sel` | 排序，同值按 playOrder 稳定 |
| `sel.adjacent` | `(of: Sel) -> Sel` | 相邻（站位相关玩法用） |

**卡牌引用**（`card.*` → `CardId`，用于召唤/生成）

| op | 签名 |
|---|---|
| 字面量 | `"CORE_TOKEN_01"` |
| `card.of` | `(of: Sel) -> CardRef` — 取某实体的 cardId（复制用） |
| `card.random` | `(from: Sel｜Pool) -> CardRef` — 随机一张。**推进 RNG** |
| `card.pool` | `(filter: Cond) -> Pool` — 从全卡池筛（发现用） |

### 3.2 Num（`num.*` → `number`）

字面数字直接写。以下节点用于惰性求值。

| op | 签名 | 说明 |
|---|---|---|
| `num.count` | `(of: Sel) -> Num` | 集合大小 |
| `num.attr` | `(of: Sel, tag: TagKey) -> Num` | 单个实体的属性。集合非单元素时返回 0 |
| `num.sum` | `(of: Sel, tag: TagKey) -> Num` | 求和 |
| `num.max` / `num.min` | `(of: Num[]) -> Num` | 多值取极值 |
| `num.add` / `num.mul` | `(of: Num[]) -> Num` | 变参 |
| `num.sub` / `num.div` | `(l: Num, r: Num) -> Num` | `div` 向下取整，除零得 0 |
| `num.neg` | `(of: Num) -> Num` | 取负（`costMod` 常用） |
| `num.clamp` | `(of: Num, lo: Num, hi: Num) -> Num` | |
| `num.if` | `(cond: Cond, then: Num, else: Num) -> Num` | |
| `num.random` | `(lo: Num, hi: Num) -> Num` | 闭区间随机整数。**推进 RNG** |
| `num.tag` | `(tag: GlobalTag) -> Num` | 全局量：`turn`、`mana`、`fatigue` 等 |

### 3.3 Cond（`cond.*` → `boolean`）

| op | 签名 | 说明 |
|---|---|---|
| `cond.exists` | `(of: Sel, atLeast?: Num) -> Cond` | 集合非空 / 至少 n 个。默认 `atLeast=1` |
| `cond.eq` `ne` `gt` `gte` `lt` `lte` | `(l: Num, r: Num) -> Cond` | |
| `cond.and` / `cond.or` | `(of: Cond[]) -> Cond` | **短路求值**（影响 RNG 顺序，见 §5.4） |
| `cond.not` | `(of: Cond) -> Cond` | |
| `cond.has_tag` | `(of: Sel, tag: TagKey, value?: Num) -> Cond` | 全称量化：`of` 中**每个**实体都满足 |
| `cond.has_flag` | `(of: Sel, flag: FlagName) -> Cond` | |
| `cond.is_kind` | `(of: Sel, kind: CardKind｜CardKind[]) -> Cond` | |
| `cond.has_tribe` | `(of: Sel, tribe: TribeName) -> Cond` | |
| `cond.in_zone` | `(of: Sel, zone: ZoneName) -> Cond` | |
| `cond.dead` | `(of: Sel) -> Cond` | |

> **注意全称量化**：`cond.has_tribe(of, "beast")` 对空集返回 `true`（数学惯例）。
> 要表达"存在一个野兽"用 `cond.exists(sel.where(of, cond.has_tribe(sel.it, "beast")))`。
> 这是最容易写错的一处，TS builder 应该提供 `Any()` / `All()` 两个明确的糖。

### 3.4 Act（`act.*` → 状态变更 + 事件）

**伤害与治疗**

```
act.hit(target: Sel, amount: Num, spellDamage?: bool)
act.heal(target: Sel, amount: Num)
act.set_health(target: Sel, value: Num)
act.gain_armor(target: Sel, amount: Num)
```

**牌与区域**

```
act.draw(player: Sel, count?: Num)              // count 默认 1
act.give(player: Sel, card: CardRef, count?: Num)      // 生成到手牌
act.shuffle(player: Sel, card: CardRef, count?: Num)   // 洗入牌库
act.discard(target: Sel)
act.move(target: Sel, zone: ZoneName, side?: "owner"|"opposite", pos?: Num)
act.steal(target: Sel, to: Sel)
```

**场面**

```
act.summon(player: Sel, card: CardRef, count?: Num, pos?: Num)
act.destroy(target: Sel)
act.transform(target: Sel, card: CardRef)
act.attack(attacker: Sel, target: Sel)          // 强制攻击
```

**属性修改**

```
act.buff(target: Sel, ench: EnchantId)
act.silence(target: Sel)
act.set_tag(target: Sel, tag: TagKey, value: Num)
act.mod_tag(target: Sel, tag: TagKey, delta: Num)
act.set_flag(target: Sel, flag: FlagName, value: bool)
```

**资源**

```
act.gain_mana(player: Sel, amount: Num)         // 本回合水晶
act.gain_max_mana(player: Sel, amount: Num)     // 永久上限
```

**控制流**

```
act.when(cond: Cond, then: Act[], else?: Act[])
act.repeat(n: Num, do: Act[])                   // ★ 每轮重新求值，见 §5.3
act.for_each(of: Sel, do: Act[])                // 绑定 sel.it，列表在开始时快照
act.nothing()
```

> 没有 `act.seq`。**数组本身就是序列**，`play`、`then`、`do` 都是 `Act[]`。
> 少一个 op，少一层嵌套。

**需要玩家输入（挂起点，见 §6）**

```
act.discover(from: Sel|Pool, show?: Num, pick?: Num)   // show 默认 3，pick 默认 1
act.select_target(from: Sel, optional?: bool)
```

两者都把结果绑定到 `sel.chosen`，供后续动作使用。

---

## 4. 触发器、拦截器、光环

### 4.1 Trigger（事后触发）

```json
{
  "on": "healed",
  "filter": { "target": { "op": "sel.zone", "side": "both", "zone": ["board","hero"] } },
  "cond": null,
  "once": false,
  "zone": "board",
  "do": [ { "op": "act.buff", "target": {"op":"sel.self"}, "ench": "CORE_020e" } ]
}
```

| 字段 | 说明 |
|---|---|
| `on` | 事件名（下表） |
| `filter` | 按事件负载的实体字段过滤。key 为负载字段名，value 为 `Sel`；实体须落在该 `Sel` 结果内 |
| `cond` | 额外条件，可访问 `sel.event.*` |
| `once` | 触发一次后自动移除 |
| `zone` | 本触发器在哪个区域生效。默认 `"board"`。手牌触发写 `"hand"`，亡语相关写 `"graveyard"` |

**事件名**（v1.0）

```
turn_began  turn_ended  mana_spent
card_played  card_drawn  card_discarded  card_added_to_hand
minion_summoned  minion_died  weapon_equipped
damaged  healed  attacked  attack_declared
buffed  silenced  transformed
secret_revealed  hero_power_used
```

`deathrattle` 是 `{on:"minion_died", filter:{target:SELF}, zone:"graveyard"}` 的糖，
构建器会展开。IR 里保留 `script.deathrattle` 字段只是为了可读性和 lint，
engine 内部一律当 trigger 处理。

### 4.2 Intercept（替换效果）

圣盾、免疫、减伤、"改为受到 1 点伤害"这类效果不是"事后反应"，而是**修改正在发生的动作**。
必须和 trigger 分开，否则时序永远对不上。

```json
{
  "intercept": "act.hit",
  "filter": { "target": { "op": "sel.self" } },
  "cond":   { "op": "cond.gt", "l": { "op": "num.field", "field": "amount" }, "r": 0 },
  "effect": { "kind": "cancel" },
  "then":   [ { "op": "act.set_flag", "target": {"op":"sel.self"}, "flag": "divine_shield", "value": false } ],
  "priority": 100
}
```

`effect.kind`：

| kind | 说明 |
|---|---|
| `cancel` | 取消该动作，`then` 仍然执行 |
| `set_field` | `{ kind, field, value: Num }` 覆盖动作的某个数值字段 |
| `mod_field` | `{ kind, field, delta: Num }` 增减 |
| `retarget` | `{ kind, to: Sel }` 改目标（嘲讽/转移伤害） |

`num.field(field)` 是拦截器上下文专用节点，读取被拦截动作的字段值。

多个拦截器按 `priority` 降序依次应用，同优先级按 playOrder。**最多 8 层**，超出报错。

### 4.3 Aura（持续效果）

```json
{
  "affects": {
    "op": "sel.minus",
    "of": { "op": "sel.where",
            "of": { "op": "sel.zone", "side": "friendly", "zone": "board" },
            "cond": { "op": "cond.has_tribe", "of": {"op":"sel.it"}, "tribe": "beast" } },
    "exclude": { "op": "sel.self" }
  },
  "mods":  { "atk": 1 },
  "flags": [],
  "cond":  null,
  "zone":  "board"
}
```

光环是**声明式**的：不写"加上"和"减掉"，只声明"在什么条件下，谁获得什么"。
引擎每步重算 `tags = base + Σ附魔 + Σ生效光环`。这样"光环失效忘了减回去"这一整类 bug
在表达层面就不存在。

---

## 5. 求值语义（本规范的核心）

### 5.1 上下文绑定

每次求值都在一个上下文里进行：

```ts
interface Ctx {
  self:     EntityId;               // sel.self
  target?:  EntityId;               // sel.target
  chosen?:  EntityId | CardId;      // sel.chosen
  event?:   EventPayload;           // sel.event.*
  it?:      EntityId;               // sel.it（where / for_each 内部）
  action?:  ActNode;                // num.field（intercept 内部）
}
```

在错误的上下文里使用叶子节点是**校验期错误**，不是运行时错误：
`sel.it` 出现在 `where`/`for_each` 之外、`sel.event` 出现在 trigger 之外、
`num.field` 出现在 intercept 之外，构建时就应该拒绝。

### 5.2 空集合语义（统一规则，不许各 op 各自发明）

| 位置 | 空集合行为 |
|---|---|
| `act.*` 的 target/player | **静默跳过**，不报错，不产生事件 |
| `num.count` | `0` |
| `num.attr` / `num.sum` | `0` |
| `cond.exists` | `false` |
| `cond.has_*` / `cond.is_*` | `true`（全称量化，见 §3.3 注意） |
| `card.of` / `card.random` | 整个动作跳过 |

"造成 6 点伤害"打空气不该崩，也不该记事件。这条统一了，卡牌脚本里就不用到处写守卫。

### 5.3 选择器求值时机 ★

**三条规则，是整份规范最容易出错的地方：**

**规则 1｜动作内快照。** 一个动作开始执行时，其 `target` 选择器求值**一次**，
结果列表在该动作全程冻结。

```json
{ "op": "act.hit", "target": {"op":"sel.zone","side":"enemy","zone":"board"}, "amount": 3 }
```
打第一个随从致死后，列表不会缩短，剩下的照打。这符合直觉，也符合炉石规则。

**规则 2｜`act.repeat` 每轮重新求值。**

```json
{ "op": "act.repeat", "n": 3,
  "do": [{ "op": "act.hit",
           "target": {"op":"sel.random","of":{"op":"sel.zone","side":"enemy","zone":"board"}},
           "amount": 1 }] }
```
→ 每轮独立随机，可能三发打同一个（奥术飞弹）。

**规则 3｜`sel.random(n)` 一次性求值。**

```json
{ "op": "act.hit",
  "target": {"op":"sel.random","of":{"op":"sel.zone","side":"enemy","zone":"board"},"n":3},
  "amount": 1 }
```
→ 一次选 3 个不重复，各挨 1 点（多重射击）。

这两个写法长得像，语义完全不同。**TS builder 应该在类型层面尽量把它们区分开，
code review checklist 必须有这一条。**

`act.for_each` 遵循规则 1：列表在循环开始时快照，循环中新增的实体不会被迭代到。

### 5.4 求值顺序（决定 RNG，必须写死）

推进 RNG 的节点有三个：`sel.random`、`num.random`、`card.random`。
它们的求值顺序直接决定对局结果，所以顺序不能靠 JSON key 顺序（不可靠），
必须由**本规范的签名字段顺序**唯一确定：

1. 一个动作的字段按 §3.4 签名中的**声明顺序**求值。
   `act.hit(target, amount)` → 先 target 后 amount。
2. `Act[]` 按数组下标升序。
3. `cond.and` / `cond.or` **短路**：`and` 遇 false 停，`or` 遇 true 停。
   ⚠ 这意味着短路会跳过后面分支里的 RNG 消耗。这是有意的，但写卡时要注意
   **不要把带随机的表达式放在短路条件的右侧**。lint 应该对此告警。
4. `act.when` 只求值命中的那个分支。
5. 光环重算、死亡结算**不得消耗 RNG**（它们每步都跑，一旦消耗就无法保证确定性）。
   规则上直接禁止：`aura.affects` 和 `cond` 中出现 `*.random` 是校验期错误。

### 5.5 结算流水线

每个动作出栈后走固定六步（与框架文档 §4.1 一致）：

```
1. 绑定上下文（self / target / event）
2. 应用拦截器链（可能 cancel / 改字段 / 改目标）
3. 执行 handler，产出 GameEvent[]
4. 匹配触发器入栈：当前回合玩家优先，同方按 playOrder 升序
5. 死亡结算：health<=0 批量入墓 → 亡语入栈 → 重复至不动点
6. 光环重算
```

### 5.6 编写子集 vs 运行时超集

IR 有两个子集，校验器要区别对待：

| | 编写期（bundle 里） | 运行时（结算栈里） |
|---|---|---|
| `sel.entity(id)` | ✗ 禁止 | ✓ 允许（绑定后的具体实体） |
| `sel.it` | 仅限 where/for_each 内 | 同左 |
| `num.field` | 仅限 intercept 内 | 同左 |

构建产物只允许编写子集。运行时超集只由引擎自己生成，永不来自外部输入——
这条是 UGC 场景的安全边界。

---

## 6. 挂起与恢复

### 6.1 挂起协议

`act.discover` / `act.select_target` 执行时，若需要玩家输入：

```ts
state.pendingInput = {
  player: PlayerId,
  kind: "discover" | "select_target" | "choose_one",
  options: EntityId[] | CardId[],
  optional: boolean,
  deadline: number,          // 回合计时快照，由 server 层填
};
// → 结算循环 break，整个 state 可序列化落盘
```

恢复：

```ts
engine.resume(state, { chosen: EntityId | CardId })
// → 写入 ctx.chosen，栈顶动作从中断处继续
```

**超时兜底必须定义**：`discover` 超时取第一项，`select_target` 超时且 `optional=true`
则跳过、否则取第一个合法目标。不能让一个挂起点把房间永久卡死。

### 6.2 结算栈的表示

栈条目**不内联节点**，用引用 + 上下文：

```json
{
  "ref": "CORE_050#play.1",
  "ctx": { "self": 42, "target": 17, "chosen": "CORE_099" }
}
```

`ref` 格式：`<cardId>#<script 路径>`，路径是从 `script` 起的点分下标。

这样做的收益：
- 栈条目极小 → `clone(state)` 快 → MCTS 可行
- 状态体积小 → 快照/存档/回放便宜
- 前提是 **bundleId 在对局开始时钉住**（§2.1），否则热更会让 ref 指向错的节点

---

## 7. 校验

三层，全部在 `ir:validate` 里跑，CI 必过。

**L1 结构**（JSON Schema 2020-12）：字段存在性、类型、枚举值。

**L2 种类（sort）**：靠前缀。`act.hit.target` 位置只接受 `sel.*`；
`amount` 位置只接受 `number` 或 `num.*`。一次遍历，无需推导。

**L3 语义**：
- 引用完整性：`ench` 指向的附魔存在；`CardRef` 字面量指向的卡存在
- 上下文合法性：`sel.it` / `sel.event` / `num.field` 是否在允许的作用域内（§5.1）
- `script.target` 与 `sel.target` 配套：用了 `sel.target` 却没声明 `target` → 错误；
  声明了 `target` 却没用 → 告警
- 确定性：`aura` / `intercept.cond` 内出现 `*.random` → 错误（§5.4 规则 5）
- 编写子集：出现 `sel.entity` → 错误（§5.6）

**资源上限**（防 UGC 与手滑）：

| 限制 | 值 |
|---|---|
| 单卡节点数 | 512 |
| 表达式深度 | 32 |
| `act.repeat.n`（字面量时） | 64 |
| 拦截器链长度 | 8 |
| 单次结算栈深度 | 256 |
| 单卡 IR 字节数 | 64 KB |

---

## 8. 版本与迁移

- `irVersion` 走 semver。**新增 op = minor；改变既有 op 语义或字段 = major。**
- engine 声明支持区间。major 不匹配直接拒绝加载，不做"尽力而为"。
- 每个 bundle 归档保存（对象存储即可）。回放存 `bundleId`，
  回放时**加载当时的 bundle**，不是当前 bundle。
- 削弱一张卡 = 发新 bundle，不是原地改。历史回放因此永远可复现。

---

## 9. TS 类型定义（engine 侧的权威定义）

```ts
export type IRVersion = `${number}.${number}.${number}`;

export type Sel =
  | { op: "sel.self" } | { op: "sel.target" } | { op: "sel.controller" }
  | { op: "sel.opponent" } | { op: "sel.chosen" } | { op: "sel.it" }
  | { op: "sel.event"; field: "source" | "target" | "player" }
  | { op: "sel.entity"; id: number }                                   // runtime only
  | { op: "sel.zone"; side: Side; zone: ZoneName | ZoneName[] }
  | { op: "sel.and"; of: Sel[] }
  | { op: "sel.or"; of: Sel[] }
  | { op: "sel.minus"; of: Sel; exclude: Sel }
  | { op: "sel.where"; of: Sel; cond: Cond }
  | { op: "sel.random"; of: Sel; n?: Num; distinct?: boolean }
  | { op: "sel.limit"; of: Sel; n: Num; from?: "start" | "end" }
  | { op: "sel.sort"; of: Sel; by: TagKey; dir?: "asc" | "desc" }
  | { op: "sel.adjacent"; of: Sel };

export type Num =
  | number
  | { op: "num.count"; of: Sel }
  | { op: "num.attr"; of: Sel; tag: TagKey }
  | { op: "num.sum"; of: Sel; tag: TagKey }
  | { op: "num.add" | "num.mul" | "num.max" | "num.min"; of: Num[] }
  | { op: "num.sub" | "num.div"; l: Num; r: Num }
  | { op: "num.neg"; of: Num }
  | { op: "num.clamp"; of: Num; lo: Num; hi: Num }
  | { op: "num.if"; cond: Cond; then: Num; else: Num }
  | { op: "num.random"; lo: Num; hi: Num }
  | { op: "num.tag"; tag: GlobalTag }
  | { op: "num.field"; field: string };                                // intercept only

export type Cond =
  | boolean
  | { op: "cond.exists"; of: Sel; atLeast?: Num }
  | { op: "cond.eq"|"cond.ne"|"cond.gt"|"cond.gte"|"cond.lt"|"cond.lte"; l: Num; r: Num }
  | { op: "cond.and" | "cond.or"; of: Cond[] }
  | { op: "cond.not"; of: Cond }
  | { op: "cond.has_tag"; of: Sel; tag: TagKey; value?: Num }
  | { op: "cond.has_flag"; of: Sel; flag: FlagName }
  | { op: "cond.is_kind"; of: Sel; kind: CardKind | CardKind[] }
  | { op: "cond.has_tribe"; of: Sel; tribe: TribeName }
  | { op: "cond.in_zone"; of: Sel; zone: ZoneName }
  | { op: "cond.dead"; of: Sel };

export type CardRef =
  | string
  | { op: "card.of"; of: Sel }
  | { op: "card.random"; from: Sel | Pool };

export type Act =
  | { op: "act.hit";        target: Sel; amount: Num; spellDamage?: boolean }
  | { op: "act.heal";       target: Sel; amount: Num }
  | { op: "act.draw";       player: Sel; count?: Num }
  | { op: "act.give";       player: Sel; card: CardRef; count?: Num }
  | { op: "act.shuffle";    player: Sel; card: CardRef; count?: Num }
  | { op: "act.discard";    target: Sel }
  | { op: "act.summon";     player: Sel; card: CardRef; count?: Num; pos?: Num }
  | { op: "act.destroy";    target: Sel }
  | { op: "act.transform";  target: Sel; card: CardRef }
  | { op: "act.attack";     attacker: Sel; target: Sel }
  | { op: "act.buff";       target: Sel; ench: string }
  | { op: "act.silence";    target: Sel }
  | { op: "act.set_tag";    target: Sel; tag: TagKey; value: Num }
  | { op: "act.mod_tag";    target: Sel; tag: TagKey; delta: Num }
  | { op: "act.set_flag";   target: Sel; flag: FlagName; value: boolean }
  | { op: "act.move";       target: Sel; zone: ZoneName; side?: "owner"|"opposite"; pos?: Num }
  | { op: "act.steal";      target: Sel; to: Sel }
  | { op: "act.gain_armor"; target: Sel; amount: Num }
  | { op: "act.gain_mana";  player: Sel; amount: Num }
  | { op: "act.gain_max_mana"; player: Sel; amount: Num }
  | { op: "act.when";       cond: Cond; then: Act[]; else?: Act[] }
  | { op: "act.repeat";     n: Num; do: Act[] }
  | { op: "act.for_each";   of: Sel; do: Act[] }
  | { op: "act.discover";   from: Sel | Pool; show?: Num; pick?: Num }
  | { op: "act.select_target"; from: Sel; optional?: boolean }
  | { op: "act.nothing" };

export interface Trigger {
  on: EventName;
  filter?: Record<string, Sel>;
  cond?: Cond;
  once?: boolean;
  zone?: ZoneName;
  do: Act[];
}

export interface Intercept {
  intercept: Act["op"];
  filter?: Record<string, Sel>;
  cond?: Cond;
  effect:
    | { kind: "cancel" }
    | { kind: "set_field"; field: string; value: Num }
    | { kind: "mod_field"; field: string; delta: Num }
    | { kind: "retarget";  to: Sel };
  then?: Act[];
  priority?: number;
}

export interface Aura {
  affects: Sel;
  mods?: Partial<Record<TagKey, number>>;
  flags?: FlagName[];
  cond?: Cond;
  zone?: ZoneName;
}

export interface CardScript {
  target?: Sel | null;
  requires?: Cond | null;
  play?: Act[];
  deathrattle?: Act[];
  triggers?: Trigger[];
  intercepts?: Intercept[];
  auras?: Aura[];
  costMod?: Num | null;
  chooseOne?: { id: string; text: LocalizedText; target?: Sel; play: Act[] }[];
}
```

---

## 10. 完整示例：TS 源码 → IR

### 10.1 火球术

```ts
defineCard({
  id: "CORE_001", name: "火球术", kind: "spell", cost: 4,
  target: ANY_CHARACTER,
  play: Hit(TARGET, 6),
});
```

```json
{ "id": "CORE_001",
  "data": { "kind": "spell", "cost": 4, "name": {"zh":"火球术"} },
  "script": {
    "target": { "op": "sel.zone", "side": "both", "zone": ["board","hero"] },
    "play": [ { "op": "act.hit", "target": { "op": "sel.target" }, "amount": 6 } ] } }
```

### 10.2 光明守护者（触发 + 附魔）

```ts
defineCard({
  id: "CORE_020", name: "光明守护者", kind: "minion", cost: 1, atk: 1, health: 2,
  triggers: [ on(Healed(ALL_CHARACTERS), Buff(SELF, "CORE_020e")) ],
});
defineEnchantment({ id: "CORE_020e", atk: +1 });
```

```json
{ "id": "CORE_020",
  "data": { "kind": "minion", "cost": 1, "tags": { "atk": 1, "health": 2 } },
  "script": {
    "triggers": [ {
      "on": "healed",
      "filter": { "target": { "op": "sel.zone", "side": "both", "zone": ["board","hero"] } },
      "zone": "board",
      "do": [ { "op": "act.buff", "target": {"op":"sel.self"}, "ench": "CORE_020e" } ]
    } ] } }
```

### 10.3 野猪王（光环）

```ts
aura: Aura(FRIENDLY_MINIONS.not(SELF).where(HasTribe(IT, "beast")), { atk: +1 })
```

```json
{ "auras": [ {
  "affects": {
    "op": "sel.minus",
    "of": { "op": "sel.where",
            "of": { "op": "sel.zone", "side": "friendly", "zone": "board" },
            "cond": { "op": "cond.has_tribe", "of": {"op":"sel.it"}, "tribe": "beast" } },
    "exclude": { "op": "sel.self" } },
  "mods": { "atk": 1 },
  "zone": "board" } ] }
```

### 10.4 谜之勇士（费用修正 + 亡语 + 条件）

```ts
defineCard({
  id: "CORE_040", kind: "minion", cost: 5, atk: 4, health: 4,
  costMod: Count(FRIENDLY_MINIONS).negate(),
  deathrattle: Summon(CONTROLLER, "CORE_TOKEN_01"),
  play: when(
    Attr(SELF, "atk").gte(3),
    Hit(ENEMY_MINIONS.random(2), Count(FRIENDLY_MINIONS).times(2)),
    Draw(CONTROLLER),
  ),
});
```

```json
{ "script": {
  "costMod": { "op": "num.neg",
               "of": { "op": "num.count",
                       "of": { "op":"sel.zone","side":"friendly","zone":"board" } } },
  "deathrattle": [ { "op": "act.summon",
                     "player": {"op":"sel.controller"}, "card": "CORE_TOKEN_01" } ],
  "play": [ {
    "op": "act.when",
    "cond": { "op": "cond.gte",
              "l": { "op":"num.attr","of":{"op":"sel.self"},"tag":"atk" }, "r": 3 },
    "then": [ { "op": "act.hit",
                "target": { "op":"sel.random",
                            "of": {"op":"sel.zone","side":"enemy","zone":"board"},
                            "n": 2 },
                "amount": { "op":"num.mul",
                            "of": [ {"op":"num.count",
                                     "of":{"op":"sel.zone","side":"friendly","zone":"board"}},
                                    2 ] } } ],
    "else": [ { "op": "act.draw", "player": {"op":"sel.controller"} } ] } ] } }
```

### 10.5 发现（挂起点）

```ts
play: [
  Discover(CardPool(IsSpell().and(HasFaction("mage")))),
  AddToHand(CONTROLLER, CHOSEN),
]
```

```json
{ "play": [
  { "op": "act.discover",
    "from": { "op": "card.pool",
              "filter": { "op": "cond.and", "of": [
                { "op":"cond.is_kind", "of":{"op":"sel.it"}, "kind":"spell" },
                { "op":"cond.has_tag", "of":{"op":"sel.it"}, "tag":"faction_mage" } ] } },
    "show": 3, "pick": 1 },
  { "op": "act.give", "player": {"op":"sel.controller"}, "card": {"op":"card.of","of":{"op":"sel.chosen"}} }
] }
```

### 10.6 圣盾（拦截器）

```json
{ "intercepts": [ {
  "intercept": "act.hit",
  "filter": { "target": { "op": "sel.self" } },
  "cond":   { "op":"cond.and", "of": [
              { "op":"cond.has_flag", "of":{"op":"sel.self"}, "flag":"divine_shield" },
              { "op":"cond.gt", "l":{"op":"num.field","field":"amount"}, "r":0 } ] },
  "effect": { "kind": "cancel" },
  "then":   [ { "op":"act.set_flag", "target":{"op":"sel.self"},
                "flag":"divine_shield", "value": false } ],
  "priority": 100 } ] }
```

---

## 11. 工具链

| 命令 | 作用 |
|---|---|
| `pnpm ir:build` | `cards/**/*.ts` → `dist/cards.ir.json`，规范化 + 补默认值 |
| `pnpm ir:validate` | L1/L2/L3 三层校验 + 资源上限。CI 必过 |
| `pnpm ir:print <cardId>` | IR → TS 风格文本（反编译器）。调试和 admin 展示用 |
| `pnpm ir:diff <a> <b>` | 两个 bundle 的行为 diff，自动生成平衡性变更日志 |
| `pnpm ir:schema` | 从 §9 的 TS 类型生成 JSON Schema（`ts-json-schema-generator`） |

**关键：JSON Schema 是从 TS 类型生成的，不是手写的。** 手写两份必然漂移。

---

## 12. 落地顺序

1. **先写 §9 的 TS 类型**，它是唯一权威定义，其他一切（schema、校验器、builder、handler）都从它派生。
2. **实现 handler 表** `Record<Act["op"], Handler>`，TS 的 discriminated union 会强制你穷尽所有 op —— 漏一个编译不过。
3. **实现求值器** `evalSel` / `evalNum` / `evalCond`，同样靠穷尽检查兜底。
4. **写 TS builder**，它只是"构造 IR 节点的类型安全外壳"，实现量很小。
5. **最后写校验器**，因为要等 op 集稳定。

先做 1-3，只支持 §3 里 8-10 个最常用 op，跑通火球术和工程师学徒。
op 集是可以增量长的，**求值语义（§5）不行——那个必须一次定对**。

---

## 13. v1.0 明确不做的

- **不做用户自定义 op**。要新效果就发新 engine 版本。开了这个口子等于允许上传代码。
- **不做数学表达式字符串**（`"amount": "count(friendly.minions) * 2"`）。
  省下来的字符要用一个 parser 来换，而且 lint、diff、类型检查全部失效。
- **不做变量绑定 / let**。真需要复用中间值时，说明这张卡该拆了。
- **不做通用循环**。只有 `repeat(n)` 和 `for_each(sel)`，两者都有静态上界。
  没有 while，就没有停机问题，UGC 才敢开。
