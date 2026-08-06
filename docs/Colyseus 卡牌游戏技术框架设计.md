---
title: Colyseus 卡牌游戏技术框架设计
date: 2026-08-05
tags: colyseus, 卡牌游戏, DSL, TypeScript, Fireplace, 游戏架构, 回合制
---

# Colyseus 卡牌游戏技术框架设计

> 目标：用 Colyseus 做联机层，用一套移植自 Fireplace（Python Hearthstone 模拟器）的
> TypeScript DSL 写卡牌脚本。玩法规则未定，框架必须把「规则」和「引擎」分开，
> 让后续加规则只是填空，而不是改架构。

---

## 1. 目标与约束

**必须满足的：**

| 约束 | 为什么 | 对架构的影响 |
|---|---|---|
| 服务端权威 | 卡牌游戏作弊收益极高 | 客户端只发「意图」，不发「结果」；合法性一律服务端算 |
| 隐藏信息 | 手牌、牌库、奥秘不能泄露给对手 | 必须有独立的**视图投影层**，不能直接同步全量状态 |
| 确定性 | 回放、复现 bug、AI 训练、断线重算 | RNG 入状态；引擎无 I/O、无 `Date.now()`、无全局可变量 |
| 状态可克隆 | MCTS / minimax bot、前端预演 | 状态必须是**纯数据**，实体之间用 id 引用而非对象指针 |
| 因果事件流 | 前端要按顺序播「攻击→掉血→死亡→亡语」动画 | 引擎输出的是**有序事件日志**，不只是状态 diff |
| 规则可换 | 玩法未定 | 资源系统、胜负条件、区域上限做成 `RulesConfig` |

**明确不做的（现阶段）：**具体卡池、平衡性、美术、排位分。

---

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│ client (Web / Unity / 任意)                                   │
│   本地镜像 PlayerView + 事件队列 → 动画                        │
└───────────────▲──────────────────────────┬───────────────────┘
                │ snapshot / events        │ intent
┌───────────────┴──────────────────────────▼───────────────────┐
│ @cardgame/server        Colyseus 0.16                        │
│   MatchRoom：连接、鉴权、回合计时、重连、认输、观战            │
│   ViewProjector：state ──按玩家过滤──▶ PlayerView / 事件      │
│   ★ 这一层只做传输与编排，不含任何卡牌规则                     │
└───────────────┬──────────────────────────────────────────────┘
                │ engine.apply(state, intent) → { state, events }
┌───────────────▼──────────────────────────────────────────────┐
│ @cardgame/engine        纯 TypeScript · 零依赖 · 零 I/O       │
│   GameState（纯数据）· 结算栈 · 触发系统 · 死亡结算 · 光环     │
│   DSL runtime：Selector / Action / LazyNum / Evaluator        │
└───────────────▲──────────────────────────────────────────────┘
                │ 注册
┌───────────────┴──────────────────────────────────────────────┐
│ @cardgame/cards         卡牌脚本（DSL 写法）                  │
│   defineCard({ id, cost, play: [Hit(TARGET, 6)] })           │
└──────────────────────────────────────────────────────────────┘
```

**分层铁律：**依赖只能自下而上。`engine` 不认识 Colyseus，不认识具体卡；
`cards` 不认识网络；`server` 不认识任何一张卡的规则。

违反这条的收益是「一开始快 20%」，代价是三个月后无法写单测、无法做 bot、
无法回放。这是整个设计里最重要的一条。

---

## 3. 三条核心不变量

### 3.1 状态是纯数据，实体用 id 互相引用

```ts
type EntityId = number;

interface GameState {
  seq: number;                              // 单调递增，用于协议去重
  rng: RngState;                            // 种子入状态 → 可回放
  phase: Phase;
  activePlayer: PlayerId;
  turn: number;
  entities: Record<EntityId, EntityData>;   // 扁平实体表
  players: [PlayerData, PlayerData];
  zones: Record<ZoneKey, EntityId[]>;       // "p0:hand" → [12, 15, 33]
  stack: PendingAction[];                   // ★ 结算栈也在状态里
  pendingInput: InputRequest | null;        // ★ 等待玩家选择时的挂起点
}

interface EntityData {
  id: EntityId;
  cardId: string;            // → 去注册表查行为，行为不进状态
  owner: PlayerId;
  zone: ZoneKey;
  playOrder: number;         // 触发排序用
  base: Tags;                // 卡面原始值
  tags: Tags;                // 计算后的当前值（光环/附魔叠加结果）
  enchantments: EntityId[];
  damage: number;
  flags: number;             // bitmask：已攻击 / 召唤失调 / 沉默 / 圣盾…
}
```

Fireplace 的状态里存的是 Python 对象引用，克隆一次很贵。我们改成 **id + 扁平表**：
`clone(state)` 可以做到几微秒，MCTS 每秒跑几万次模拟，回放/存档直接 `JSON.stringify`。
这是相对 Fireplace 的一个实质改进，务必从第一天就守住。

**推论：状态里不许出现函数、闭包、class 实例、Map/Set 之外的复杂对象。**
卡牌行为全部通过 `cardId → CardScript` 从注册表取。

### 3.2 引擎是纯函数

```ts
function apply(state: GameState, intent: Intent): ApplyResult;

type ApplyResult =
  | { ok: true;  state: GameState; events: GameEvent[] }
  | { ok: false; code: IllegalReason };            // 非法意图，状态不变
```

内部允许在一份 draft 上原地改（性能），但对外表现为「进去一个状态，出来一个新状态」。
没有 `console.log`、没有计时器、没有随机数源——`Math.random()` 在 engine 包里应该被
ESLint 直接禁掉。

### 3.3 输出是事件流，不是状态 diff

前端需要的是：

```
ATTACK    {source: 12, target: 20}
DAMAGE    {target: 20, amount: 3, source: 12}
DAMAGE    {target: 12, amount: 2, source: 20}
DEATH     {entity: 20}
TRIGGER   {source: 20, kind: "deathrattle"}
SUMMON    {entity: 41, zone: "p1:board", pos: 2}
```

而不是「棋盘从 A 变成了 B」。状态 diff 无法驱动动画，这是卡牌游戏和 MMO 最大的区别。
Hearthstone 自己的协议（PowerHistory）也是这个形态。

Colyseus 的 Schema 增量同步在这里**不是主力**，它只承担快照兜底（见 §7）。

---

## 4. 引擎层设计

### 4.1 结算模型

整个引擎的心脏。90% 的卡牌 bug 来自时序，所以时序必须是写死的、可打印的、可测的。

```ts
function resolve(state: GameState): GameEvent[] {
  let guard = 0;
  while (state.stack.length > 0) {
    if (++guard > MAX_RESOLUTION_DEPTH) throw new ResolutionLoopError();

    const pending = state.stack.pop()!;
    const ctx = bindContext(state, pending);        // 绑定 SELF / TARGET / EVENT

    // 1) 替换效果：圣盾、免疫、"改为..."
    const action = applyInterceptors(state, ctx, pending.action);
    if (action === CANCELLED) continue;

    // 2) 执行，产出事件
    const emitted = handlers[action.kind](state, ctx, action);

    // 3) 事后触发：按「当前回合玩家优先，再按 playOrder 升序」入栈
    queueTriggers(state, emitted);

    // 4) 状态基础动作：死亡结算
    processDeaths(state);

    // 5) 光环重算
    refreshAuras(state);

    // 6) 需要玩家输入 → 挂起，等 resume()
    if (state.pendingInput) break;
  }
  return drainEventLog(state);
}
```

**必须明文写进文档的四条时序规则**（否则每张卡都会有人来问）：

1. **触发顺序**：当前回合玩家的触发器先于对手；同一方按实体 `playOrder` 升序（先上场的先触发）。
2. **触发是入栈而非立即执行**：A 触发 B，B 要等 A 这一步的死亡结算做完才开始。
3. **死亡结算是独立阶段**：每个 action 结算完统一检查 `health <= 0`，批量移入墓地，
   亡语按 `playOrder` 排队。中途新死的要再跑一轮，直到不动点。
4. **光环是重算而非增量**：`tags = base + 所有附魔 + 所有生效光环`，每步重算。
   实体数量在 20 量级，重算成本可忽略，但省掉了「光环失效时忘了减回去」这一整类 bug。

### 4.2 结算栈进状态 → 免费拿到「中途等玩家选择」

发现、抉择、"选择一个敌方随从"这类效果需要**在结算中途暂停**等玩家输入。

因为 action 是**纯数据**、结算栈**在状态里**，暂停变成了天然能力：

```ts
state.pendingInput = { player: 0, kind: "DISCOVER", options: [c1, c2, c3] };
// → 序列化整个 state 存起来，玩家断线重连也不丢
// → 玩家回应后：
engine.resume(state, { chosen: c2 });   // 栈顶继续弹
```

如果 action 是带方法的 class 实例（Fireplace 的做法），这里就得额外做协程或者
把状态机拆成一堆特判。**action 即数据**这个决定，回报主要就在这里。

### 4.3 RNG

```ts
interface RngState { s0: number; s1: number; }         // xorshift128+ 或 mulberry32
function nextInt(state: GameState, max: number): number;  // 原地推进 state.rng
```

- 种子由服务端生成并存库，**永不下发客户端**（否则可预测随机 = 泄露隐藏信息）。
- 所有随机来源必须走 `nextInt`，禁用 `Math.random()`。
- 随机结果作为事件下发（`RANDOM_PICK {result: 33}`），客户端只是被告知。
- `{seed, deckLists, intents[]}` 三元组即可完整复现一局 → 回放/复现 bug/申诉。

---

## 5. DSL 设计：Fireplace → TypeScript

### 5.1 核心映射表

TS 没有运算符重载，硬套 Fireplace 的 `|` `+` `*` 只能得到丑陋的模拟。
做法是：**保留 Fireplace 的语义模型（惰性选择器 + 动作 + 惰性数值 + 求值器），
用链式方法和具名函数替换运算符，并把省下来的表达力用在类型安全上。**

| Fireplace (Python) | 本框架 (TypeScript) | 说明 |
|---|---|---|
| `FRIENDLY + MINIONS` | `FRIENDLY.and(MINIONS)` | 交集 |
| `SELF \| TARGET` | `SELF.or(TARGET)` | 并集 |
| `ALL_MINIONS - SELF` | `ALL_MINIONS.not(SELF)` | 排除 |
| `RANDOM(ENEMY_MINIONS)` | `ENEMY_MINIONS.random()` | 随机 1 个 |
| `ENEMY_MINIONS * 2` | `ENEMY_MINIONS.random(2)` | 随机 2 个（不重复） |
| `Hit(TARGET, 3) * 3` | `Repeat(3, Hit(TARGET, 3))` | 重复，**每次重新求值选择器** |
| `Count(FRIENDLY_MINIONS) * 2` | `Count(FRIENDLY_MINIONS).times(2)` | 惰性数值运算 |
| `Attr(SELF, ATK) >= 3` | `Attr(SELF, "atk").gte(3)` | 条件 |
| `Dead(SELF) & Draw(CONTROLLER)` | `when(Dead(SELF), Draw(CONTROLLER))` | 条件动作 |
| `Damage(FRIENDLY_MINIONS).on(X)` | `on(Damaged(FRIENDLY_MINIONS), X)` | 事件监听 |
| `play = A, B` | `play: [A, B]` | 顺序执行 |

### 5.2 命名约定：祈使式 = 动作，过去式 = 事件

Fireplace 把 `Damage(...)` 同时当动作和事件模式用，很省，但在 TS 里读起来会歧义。
我们区分开：

- **动作**（做某事）：`Hit`、`Heal`、`Draw`、`Summon`、`Destroy`、`Buff`、`Silence`
- **事件**（某事发生了）：`Damaged`、`Healed`、`Played`、`Died`、`Drawn`、`Summoned`、
  `TurnBegan`、`TurnEnded`、`Attacked`

```ts
on(Died(FRIENDLY_MINIONS), Draw(CONTROLLER))     // 一眼看出是监听
Hit(ENEMY_HERO, 3)                                // 一眼看出是执行
```

这是相对 Fireplace 的一处主动改动，代价是多记一套词，收益是 code review 时不用猜。

### 5.3 Selector（惰性、可组合、带类型）

```ts
interface Selector<T extends Entity = Entity> {
  eval(ctx: Ctx): T[];
  and<U extends T>(o: Selector<U>): Selector<U>;
  or(o: Selector<T>): Selector<T>;
  not(o: Selector<Entity>): Selector<T>;
  random(n?: number): Selector<T>;
  limit(n: number): Selector<T>;
  sortedBy(tag: TagKey, dir?: "asc" | "desc"): Selector<T>;
  where(cond: Evaluator): Selector<T>;
}
```

预置常量（覆盖 90% 卡，绝大多数卡不需要手写组合）：

```ts
SELF, TARGET, CONTROLLER, OPPONENT, CHOSEN, EVENT
FRIENDLY_HERO, ENEMY_HERO, ALL_HEROES
FRIENDLY_MINIONS, ENEMY_MINIONS, ALL_MINIONS, OTHER_MINIONS
FRIENDLY_CHARACTERS, ENEMY_CHARACTERS, ALL_CHARACTERS
FRIENDLY_HAND, FRIENDLY_DECK, FRIENDLY_GRAVEYARD
RANDOM_ENEMY_MINION = ENEMY_MINIONS.random()
```

**类型安全（Python 版拿不到的收益）：**

```ts
declare function Hit(target: Selector<Character>, amount: Num): Action;
declare function Buff(target: Selector<Minion>, ench: EnchantmentId): Action;

Hit(FRIENDLY_HAND, 3)   // ✗ 编译错误：手牌不是 Character
Buff(ENEMY_HERO, "e1")  // ✗ 编译错误：英雄不能被随从附魔
```

Fireplace 这类错误只能在运行时炸。做成千张卡的时候，这个差别很大。

### 5.4 一个必须讲清楚的语义坑：选择器求值时机

```ts
Repeat(3, Hit(RANDOM_ENEMY_MINION, 1))   // 每次重新随机 → 可能全打同一个（奥术飞弹）
Hit(ENEMY_MINIONS.random(3), 1)          // 一次选 3 个不重复 → 分别各挨 1 点（多重射击）
```

这两个写法长得像，语义完全不同。规则：
**`Repeat` 内每轮重新求值；选择器内的 `.random(n)` 一次性求值。**
文档、注释、review checklist 都要写这一条。

### 5.5 LazyNum 与 Evaluator

```ts
type Num = number | LazyNum;

Count(FRIENDLY_MINIONS)                       // 场上友方随从数
Attr(SELF, "atk")                             // 自身攻击力
Count(FRIENDLY_HAND).times(2).plus(1)
Attr(TARGET, "cost").clamp(0, 10)

// 条件
Find(FRIENDLY_MINIONS.where(HasTribe("beast")))
Attr(SELF, "atk").gte(3)
Dead(TARGET)
and(Find(ENEMY_MINIONS), Attr(FRIENDLY_HERO, "hp").lte(10))

// 条件动作
when(Attr(SELF, "atk").gte(5), Hit(ENEMY_HERO, 3), Draw(CONTROLLER))
//   ↑ 条件            ↑ then                       ↑ else（可省）
```

### 5.6 事件参数怎么拿

触发器里经常要引用「刚刚发生的那件事的当事人」。用 `EVENT` 命名空间：

```ts
on(Damaged(FRIENDLY_MINIONS), Hit(EVENT.source, 2))          // 反伤
on(Played(FRIENDLY, SPELL),   Buff(SELF, "e1"))
on(Healed(ANY_CHARACTER),     Draw(EVENT.target.controller()))
on(Died(FRIENDLY_MINIONS),    Summon(CONTROLLER, EVENT.target.cardId()))
```

`EVENT.*` 是绑定到当前事件负载的特殊选择器，在 `bindContext()` 里注入。

### 5.7 卡牌脚本形态

```ts
// cards/core/CORE_001.ts  —— 法术，需指定目标
import { defineCard, Hit, TARGET, ANY_CHARACTER } from "@cardgame/engine/dsl";

export default defineCard({
  id: "CORE_001",
  name: "火球术",
  kind: "spell",
  cost: 4,
  faction: "mage",
  text: "造成 6 点伤害。",
  target: ANY_CHARACTER,          // 有 target 字段 = 打出时必须选目标
  play: Hit(TARGET, 6),
});
```

```ts
// 随从 + 战吼
export default defineCard({
  id: "CORE_010",
  name: "工程师学徒",
  kind: "minion",
  cost: 2, atk: 1, health: 1,
  play: Draw(CONTROLLER),
});
```

```ts
// 触发器 + 附魔
export default defineCard({
  id: "CORE_020",
  name: "光明守护者",
  kind: "minion",
  cost: 1, atk: 1, health: 2,
  text: "每当一个角色获得治疗，获得 +1 攻击力。",
  triggers: [ on(Healed(ALL_CHARACTERS), Buff(SELF, "CORE_020e")) ],
});

export const CORE_020e = defineEnchantment({ id: "CORE_020e", atk: +1 });
```

```ts
// 光环（持续效果，自动重算，自动失效）
export default defineCard({
  id: "CORE_030",
  name: "野猪王",
  kind: "minion", cost: 3, atk: 2, health: 3,
  text: "你的其他野兽获得 +1 攻击力。",
  aura: Aura(OTHER_MINIONS.and(FRIENDLY).where(HasTribe("beast")), { atk: +1 }),
});
```

```ts
// 亡语 + 费用修正 + 抉择
export default defineCard({
  id: "CORE_040",
  name: "谜之勇士",
  kind: "minion", cost: 5, atk: 4, health: 4,
  costMod: Count(FRIENDLY_MINIONS).negate(),        // 每有一个友方随从便宜 1 点
  deathrattle: Summon(CONTROLLER, "CORE_TOKEN_01"),
  chooseOne: [
    { id: "a", text: "造成 2 点伤害", target: ANY_CHARACTER, play: Hit(TARGET, 2) },
    { id: "b", text: "获得 2 点护甲", play: GainArmor(FRIENDLY_HERO, 2) },
  ],
});
```

```ts
// 中途需要玩家输入（发现）——注意 CHOSEN
export default defineCard({
  id: "CORE_050",
  name: "奥术智慧",
  kind: "spell", cost: 2,
  play: [
    Discover(CARDPOOL.where(IsSpell()).where(HasFaction("mage"))),
    AddToHand(CONTROLLER, CHOSEN),          // CHOSEN = 玩家刚选的那张
  ],
});
```

### 5.8 注册与打包

- `defineCard` 返回一个纯数据 `CardScript`，同时在模块副作用里写进 `CardRegistry`。
- `cards/index.ts` 由脚本生成（glob 全部卡文件 → 生成 barrel），避免手写漏注册。
- 构建期额外产出 `cards.client.json`：**只含展示字段**（name/cost/atk/health/text/art），
  **不含脚本**。客户端拿不到规则实现，也就无从预判隐藏信息。
- 卡牌 id 用 `SET_NNN` 形式，附魔 id 用 `SET_NNNe`，衍生物用 `SET_TOKEN_NN`。

---

## 6. 视图投影与隐藏信息

**这是最容易被跳过、也最容易返工的一层。** 不要等到"以后再加"。

```ts
function project(state: GameState, viewer: PlayerId): PlayerView;
function projectEvent(state: GameState, ev: GameEvent, viewer: PlayerId): ClientEvent | null;
```

规则：

| 数据 | 自己 | 对手 |
|---|---|---|
| 手牌 | 完整 | 只有 `entityId` + 数量，`cardId: null` |
| 牌库 | 只有数量（自己也不能看顺序！） | 只有数量 |
| 场面 | 完整 | 完整 |
| 奥秘/伏笔 | 完整 | 只有 `entityId` + "有一个奥秘" |
| RNG 种子 | 无 | 无 |
| 未来抽到什么 | 无 | 无 |

关键细节：**隐藏牌也要有稳定的 `entityId`**。否则「抽牌→飞入手牌→打出翻开」这套动画
就接不上，客户端会以为是两张不同的牌。牌的身份一直在，只是 `cardId` 从 `null` 变成实值。

自测方法：写一个测试，把发给玩家 B 的所有字节 grep 一遍，
断言其中不含玩家 A 手牌的任何 cardId。这个测试要放进 CI。

---

## 7. Colyseus 层设计

### 7.1 为什么棋盘不放进 Schema

Colyseus 的 `@colyseus/schema` 很适合「所有人可见、连续变化」的状态。卡牌游戏两条都不满足：

- **可见性**：房间状态默认全员同步。0.16 的 `StateView` 能做每客户端可见性，
  但要给每个实体挂 `@view()` 并手工维护 view 成员，隐藏信息一旦漏一处就是安全事故。
- **变化形态**：卡牌是离散跳变 + 需要因果顺序。Schema 给你的是"最终状态差异"，
  它会把「打了 3 点 → 死了 → 亡语召唤」压成一个 patch，动画层无法还原过程。

另外，把 Schema 类当作游戏状态会直接摧毁 §3.1：Schema 实例带装饰器、带脏标记、
不可 `structuredClone`，bot 和回放全部做不了。

**结论：**

- **Schema 承载**：房间/对局元信息 —— 座位、昵称、头像、当前回合、回合剩余秒数、
  比分、房间阶段。这些本来就是公开的，且天然适合增量同步。
- **消息承载**：棋盘本身 —— `snapshot`（全量视图）+ `events`（因果流）。
  回合制频率极低（每步几 KB），完全不需要二进制增量。

```ts
class MatchState extends Schema {
  @type("string") phase = "waiting";
  @type("uint8")  activeSeat = 0;
  @type("uint16") turn = 0;
  @type("uint16") turnSecondsLeft = 0;
  @type([SeatState]) seats = new ArraySchema<SeatState>();
}
```

### 7.2 MatchRoom 骨架

```ts
export class MatchRoom extends Room<MatchState> {
  maxClients = 2;
  private game!: GameState;                  // 引擎状态，不是 Schema
  private seatOf = new Map<string, PlayerId>();

  onCreate(opts: MatchOptions) {
    this.state = new MatchState();
    this.setPrivate(false);

    this.onMessage("intent", (client, msg: Intent) => {
      const seat = this.seatOf.get(client.sessionId);
      if (seat === undefined) return;
      if (seat !== this.game.activePlayer && !isInstantIntent(msg)) {
        return this.reject(client, "NOT_YOUR_TURN");
      }

      const r = engine.apply(this.game, { ...msg, player: seat });
      if (!r.ok) return this.reject(client, r.code);

      this.game = r.state;
      this.pushEvents(r.events);             // 逐客户端过滤后广播
      this.syncMeta();                       // 同步 Schema 里的元信息
      this.armTurnTimer();
      this.checkGameOver();
    });

    this.onMessage("resync", (client) => this.sendSnapshot(client));
  }

  onJoin(client: Client, opts: JoinOptions) { /* 分座位；两人到齐 → startMatch() */ }

  async onLeave(client: Client, consented: boolean) {
    if (consented) return this.forfeit(client);
    this.broadcast("opponent_disconnected");
    try {
      await this.allowReconnection(client, RECONNECT_WINDOW_SEC);
      this.sendSnapshot(client);             // 重连后补全量视图
      this.broadcast("opponent_reconnected");
    } catch {
      this.forfeit(client);
    }
  }

  private pushEvents(events: GameEvent[]) {
    for (const c of this.clients) {
      const seat = this.seatOf.get(c.sessionId)!;
      const filtered = events
        .map(e => projectEvent(this.game, e, seat))
        .filter(Boolean);
      c.send("events", { seq: this.game.seq, events: filtered });
    }
  }

  private armTurnTimer() {
    this.turnTimer?.clear();
    this.turnTimer = this.clock.setTimeout(
      () => this.forceEndTurn(),
      this.rules.turnSeconds * 1000,
    );
  }
}
```

要点：

- 用 `this.clock`（Colyseus 的可暂停时钟），不要用裸 `setTimeout`。回合制**不需要**
  `setSimulationInterval`。
- 回合计时由服务端裁决，超时服务端自己发 `end_turn` 意图给引擎——引擎不认识时间。
- 断线期间计时策略要定：推荐「暂停最多 90 秒，超时判负」，写进 `RulesConfig`。

### 7.3 协议

```ts
// client → server
type Intent =
  | { t: "mulligan";   keep: EntityId[] }
  | { t: "play_card";  card: EntityId; target?: EntityId; pos?: number; option?: string }
  | { t: "attack";     attacker: EntityId; target: EntityId }
  | { t: "hero_power"; target?: EntityId }
  | { t: "respond";    // 回应 pendingInput（发现/抉择）
                       chosen: EntityId | string }
  | { t: "end_turn" }
  | { t: "concede" };

// server → client
type ServerMsg =
  | { t: "snapshot"; seq: number; view: PlayerView; legal: LegalMoves }
  | { t: "events";   seq: number; events: ClientEvent[] }
  | { t: "prompt";   request: InputRequest }        // 该你选了
  | { t: "rejected"; code: IllegalReason }
  | { t: "over";     winner: PlayerId | null; reason: EndReason };
```

- **每条消息带 `seq`**。客户端发现 seq 跳号 → 自动发 `resync` 拉快照。
  这一条能挡掉后期一大半"客户端状态和服务端对不上"的玄学问题。
- **`legal` 是给 UI 置灰用的方便字段，不是权威**。服务端收到意图必须重新完整校验。
  绝不能因为"客户端已经过滤过了"就省掉服务端检查。

### 7.4 匹配与扩容

- 起步：单进程 `matchMaker.joinOrCreate("match", { mode })`，`filterBy: ["mode"]`。
- 扩容：`RedisPresence` + `RedisDriver`，多进程无状态水平扩。
- 对局结果落库走 Room 的 `onDispose`，或独立写 `MatchResult` 到队列，别阻塞房间销毁。
- 观战：单独的只读座位，视图投影传 `viewer: "spectator"`（延迟 N 秒下发以防串通）。

---

## 8. 工程结构

pnpm workspace monorepo：

```
cardgame/
├── package.json                     # pnpm workspaces
├── tsconfig.base.json
└── packages/
    ├── engine/                      # 零依赖，纯 TS
    │   src/
    │     state.ts  entity.ts  zones.ts  tags.ts  enums.ts
    │     rng.ts    resolve.ts  triggers.ts  deaths.ts  auras.ts
    │     events.ts view.ts    rules.ts
    │     dsl/
    │       selector.ts  action.ts  handlers.ts
    │       lazy.ts      evaluator.ts  define.ts  index.ts
    │     testkit/ setup.ts  assert.ts        # 测试夹具（对外导出）
    ├── cards/                       # 只依赖 engine
    │   src/core/CORE_001.ts …
    │   src/index.ts                 # 生成物
    │   scripts/gen-barrel.ts
    ├── shared/                      # 协议类型，client + server 共用
    │   src/protocol.ts  view.ts
    ├── server/                      # Colyseus
    │   src/index.ts  rooms/MatchRoom.ts  rooms/LobbyRoom.ts
    │   src/schema/MatchState.ts  src/projector.ts  src/persistence/
    ├── bot/                         # 依赖 engine + cards，不依赖 server
    │   src/random.ts  src/greedy.ts  src/mcts.ts
    └── client/                      # 可选，先做个调试用的
```

`engine/package.json` 里不允许出现任何 runtime dependency。这条用 CI 卡住。

---

## 9. 测试策略

纯引擎最大的红利就在这里。目标是**每张卡一个测试，写起来 3 行**。

```ts
test("火球术打脸 6 点", () => {
  const g = setup({
    p0: { hand: ["CORE_001"], mana: 10 },
    p1: { heroHp: 30 },
  });
  play(g, "CORE_001", { target: g.p1.hero });
  expect(g.p1.hero.hp).toBe(24);
});

test("光明守护者受治疗后 +1 攻击", () => {
  const g = setup({ p0: { board: ["CORE_020"], hand: ["HEAL_2"] } });
  play(g, "HEAL_2", { target: g.p0.board[0] });
  expect(g.p0.board[0].atk).toBe(2);
});
```

四层：

1. **单卡测试**：`packages/cards/**/*.test.ts`，和卡文件放一起。新增卡必须带测试。
2. **时序测试**：专门测触发顺序、连锁死亡、光环失效、亡语递归。这些是重灾区。
3. **不变量测试（property-based）**：随机 bot 对打 10 万局，每步断言
   ——生命值不为负、区域上限不超、实体不同时存在于两个区域、
   `clone(state)` 结算结果与原状态一致（确定性检查）。这一条能自动逮出大量深层 bug。
4. **隐藏信息测试**：见 §6，序列化输出 grep 断言。CI 必跑。

回放测试：把线上崩溃的 `{seed, decks, intents}` 直接变成一条回归用例。

---

## 10. 工具链

- **回放器**：喂 `{seed, decks, intents}`，逐步打印状态和事件。排 bug 的主力工具。
- **随机 bot**：从第一天就有。它是最好的 fuzzer，也是联调服务端的免费陪练。
- **贪心 bot / MCTS**：靠 §3.1 的可克隆状态。MCTS 需要"确定化"处理隐藏信息
  （对未知手牌随机采样若干种可能各跑一遍）。
- **卡牌 lint**：扫描所有 `defineCard`，检查 id 唯一、附魔 id 存在、
  `target` 与 `TARGET` 使用是否配套、文本与实现字段是否矛盾。
- **CLI 对局**：`pnpm play` 在终端跑一局，不用起服务端也不用前端。

---

## 11. 规则可配置化（因为玩法还没定）

把所有「以后可能会改」的数字和开关收进一个对象，引擎读它而不是读常量：

```ts
interface RulesConfig {
  deckSize: number;
  maxCopiesPerCard: number;
  startingHand: [first: number, second: number];
  handLimit: number;
  boardLimit: number;
  mulligan: "none" | "replace-once" | "london";
  resource: { kind: "ramping"; max: number } | { kind: "fixed"; perTurn: number };
  fatigue: boolean;
  turnSeconds: number;
  reconnectSeconds: number;
  winCondition: WinConditionId[];        // 可插拔
}
```

玩法定下来之前，写死一份 `DEFAULT_RULES` 就能开工；定下来之后改的是数据不是代码。
**关键是别让这些数字散落在 30 个文件里**——这是"规则未定"阶段唯一需要付出的额外纪律。

---

## 12. 实施路线图

| 里程碑 | 内容 | 完成标志 |
|---|---|---|
| **M0** 骨架 | monorepo、tsconfig、CI、空 engine 包 | `pnpm build` 通过 |
| **M1** 状态与结算 | 实体/区域/标签、结算栈、事件日志、RNG | 能跑「抽牌→打随从→攻击→死亡」，全程零 DSL |
| **M2** DSL 最小集 | Selector + Action + `defineCard`，5 个动作（Hit/Heal/Draw/Summon/Buff） | 火球术、工程师学徒能跑通并有测试 |
| **M3** 触发与光环 | `on()`、亡语、`Aura`、附魔、死亡连锁 | 光明守护者 / 野猪王 通过时序测试 |
| **M4** 视图投影 | `project()`、`projectEvent()`、隐藏信息 CI 测试 | grep 测试通过 |
| **M5** Colyseus 接入 | MatchRoom、协议、计时、重连、快照 | 两个浏览器能打完一局 |
| **M6** 工具 | 随机 bot、回放器、fuzz 不变量测试 | 10 万局 fuzz 无断言失败 |
| **M7** 补 DSL | LazyNum、Evaluator、Discover/ChooseOne、费用修正 | 能写出 §5.7 里全部示例卡 |
| **M8** 规则填空 | 你定的玩法灌进 `RulesConfig` + 首批卡池 | 可玩 |

**建议的第一步**：M1 + M2 一起做，先不碰 Colyseus。
用 CLI 跑通「两个随机 bot 对打一局」再接网络。
先接网络的话，你会同时在调试规则 bug 和网络 bug，定位成本翻好几倍。

---

## 13. 已知取舍与坑

**已知取舍**

1. **不用 Schema 同步棋盘** — 放弃了二进制增量的带宽优势。回合制下每步几 KB，
   换来隐藏信息安全和动画可还原，划算。
2. **光环全量重算** — O(实体 × 光环)。实体在 20 量级，完全够用；
   真到瓶颈再加脏标记，别提前优化。
3. **祈使/过去式区分动作与事件** — 比 Fireplace 多记一套词，换来可读性。
4. **DSL 用链式方法** — 比 Python 运算符啰嗦，换来类型安全和 IDE 补全。

**已知的坑，提前记下来**

1. **触发顺序不写清楚就会天天返工**。§4.1 那四条要贴在 `resolve.ts` 顶部注释里。
2. **`Repeat` vs `.random(n)` 的求值时机**（§5.4）会被反复踩，写进 review checklist。
3. **状态里混进函数/class 实例**是最隐蔽的架构腐化。用一个测试断言
   `JSON.parse(JSON.stringify(state))` 与原状态结算结果一致，把这条守死。
4. **隐藏信息不能事后补**。M4 不要往后挪。
5. **亡语递归**（亡语召唤的随从又有亡语）必须有深度上限并且有测试，
   否则线上会出无限循环把房间卡死。
6. **客户端动画期间的输入**：事件流播放需要时间，玩家在动画播完前点击怎么办？
   推荐客户端本地排队 + 服务端按 seq 校验，别让动画阻塞输入。
7. **`onLeave` 里的 `allowReconnection` 是 Promise**，忘了 catch 会静默吞掉判负逻辑。

---

## 附：与 Fireplace 的主要差异汇总

| 维度 | Fireplace | 本框架 | 原因 |
|---|---|---|---|
| 状态表示 | 对象图（互相持引用） | 扁平 id 表，纯数据 | 克隆/序列化/回放/MCTS |
| Action | 带方法的 class 实例 | 纯数据 + handler 注册表 | 可序列化 → 结算中途可暂停/存档 |
| DSL 组合 | 运算符重载 | 链式方法 | TS 无运算符重载 |
| 事件命名 | 与动作同名 | 过去式区分 | 可读性 |
| 类型检查 | 运行时 | 编译期（Selector 泛型） | 千张卡规模下的可维护性 |
| 输出 | 状态 + 日志 | 状态 + 因果事件流（协议一等公民） | 前端动画 |
| 隐藏信息 | 模拟器无此需求 | 独立投影层 | 联机对战必需 |
