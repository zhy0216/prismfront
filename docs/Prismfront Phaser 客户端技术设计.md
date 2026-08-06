---
title: Prismfront Phaser 客户端技术设计
date: 2026-08-07
tags: prismfront, phaser, 客户端, 前端架构, 动画编排, 事件流
---

# Prismfront Phaser 客户端技术设计

> 前置：《Prismfront 工程与技术架构》（包边界与协议）·《格子战斗卡牌 DSL 规范 v2》
> （回合状态机 §4.1、战斗结算 §4.2、事件表 §5）·《Prismfront 命名与主题》§3 色彩语言 ·
> 《世界观与背景故事》§10 机制↔叙事对照表。
>
> 既有文档从未定义过客户端（《框架设计》§8 只写了一句"client/ 可选，先做个调试用的"）。
> 本文补齐这一层，并把它约束成一个**不含任何规则的播放器**。

---

## 0. 一条铁律

**客户端是事件流播放器，不是状态镜像，更不是规则副本。**

它做三件事：把 `PlayerView` 画出来、把 `ClientEvent[]` 演出来、把点击变成 `Intent` 发出去。
它不知道火球术造成几点伤害，不知道方向怎么解析，不知道谁会死。

三条推论，每条都对应一类会被踩的坑：

1. **不做本地预演。** 玩家点了牌，UI 可以立刻给"已发出"的反馈，但**场面不动**，
   等服务端事件回来才动。客户端一旦能算出结果，它就能算出隐藏信息。
2. **不做状态 diff 驱动动画。** 服务端给的是因果事件流（《框架设计》§3.3），
   动画直接由事件驱动。"棋盘从 A 变成 B"无法还原"打了 3 点 → 死了 → 亡语召唤"。
3. **规则文本来自服务端。** 卡牌为什么不能打（色门锁定、水晶不够）由服务端的
   `LegalMoves` 给出理由码，客户端只负责把理由码翻成人话。

---

## 1. 分层架构

```
┌────────────────────────────────────────────────────────────┐
│ Phaser 层（显示对象、Tween、输入拾取）                       │
│   BootScene · MatchScene · HudScene · OverlayScene          │
└───────────▲────────────────────────────┬───────────────────┘
            │ 播放指令 / 显示状态          │ 原始输入
┌───────────┴────────────────────────────▼───────────────────┐
│ 编排层（纯 TS，零 Phaser 依赖，可单测）                      │
│   Director   事件流 → Beat 时间线（§5）                      │
│   Layout     slot/side → 世界坐标（§4）                      │
│   CardFace   卡牌数据 → 卡面绘制规格（§7）                   │
│   IntentBuilder  交互状态机 → Intent（§6）                   │
└───────────▲────────────────────────────┬───────────────────┘
            │ snapshot / events           │ intent
┌───────────┴────────────────────────────▼───────────────────┐
│ 传输层  Transport 接口                                       │
│   ColyseusTransport（真实）   MockTransport（回放，§10）      │
└────────────────────────────────────────────────────────────┘
```

**编排层零 Phaser 依赖**是本设计最重要的工程决定。它带来三件事：
Director 与 Layout 可以用 `bun test` 直接测（纯 TS，无需 DOM 环境）；
Phaser 4 若需回退 3.90 只动最上层；客户端开发可以在服务端存在之前就开始（§10）。

---

## 2. 双轨状态

客户端同时持有两份状态，**永远不要把它们合成一份**：

| | 内容 | 由谁改 | 用途 |
|---|---|---|---|
| `authoritative` | 最后一次 `snapshot` + 已应用的全部 `events` | 传输层 | 合法性提示、UI 数值、重连基准 |
| `presentation` | 屏幕上此刻的样子 | Director 逐 Beat 推进 | 显示 |

动画播放期间两者必然不一致：服务端已经知道随从死了，屏幕上它还在燃烧。
`presentation` 落后 `authoritative` 是**正常状态**，不是需要修复的 bug。

由此得到几条明确规则：

- 手牌可交互性看 `authoritative`（玩家不必等动画播完才能思考），
  但**提交 Intent 时带上 `seq`**，服务端按 seq 校验，杜绝"看着旧画面点了已失效的目标"。
- `Director.fastForward()` 把 `presentation` 一次性推到 `authoritative`，
  无动画。跳过按钮、重连、切后台回来都走它。
- 收到 `snapshot` 一律先 `fastForward()` 再重建，不做增量对齐。

---

## 3. 场景划分

| Scene | 常驻 | 职责 |
|---|---|---|
| `BootScene` | 否 | 加载 `cards.client.json`、图集、字体；预烘卡面纹理（§7） |
| `LobbyScene` | 否 | 连接、匹配、选卡组 |
| `MatchScene` | 是 | 九曜位棋盘、双方单位、英雄、光束、基地 |
| `HudScene` | 是（叠加） | 手牌、水晶、基地血、光源条、回合/计时、pass 按钮 |
| `OverlayScene` | 按需（叠加） | 调度期：起手换牌、英雄部署、发现、选择目标、结算 |
| `DebugScene` | dev only | 事件日志、`seq`、状态 dump、Beat 时间线可视化 |

`MatchScene` 与 `HudScene` 分开是有原因的：棋盘相机可能缩放/位移（小屏适配、战斗特写），
HUD 绝不能跟着动。Phaser 的并行 Scene 天然解决，不要用一个 Scene 加 `setScrollFactor(0)` 硬凑。

场景间**只通过 `MatchBus`（单个 `Phaser.Events.EventEmitter`）通信**，
禁止 `this.scene.get("HudScene").someMethod()`。

---

## 4. 棋盘坐标系统

### 4.1 设计分辨率与布局常量

固定设计分辨率 **1920×1080**，`Scale.FIT` + `autoCenter`。

```ts
export const SLOT_W = 180, SLOT_H = 170, SLOT_GAP = 8, SLOT_COUNT = 9;
export const BOARD_X0 = (1920 - (SLOT_COUNT * SLOT_W + (SLOT_COUNT - 1) * SLOT_GAP)) / 2; // 118
export const ROW_Y = { enemy: 300, friendly: 640 };   // 行中心
export const BASE_Y = { enemy: 96,  friendly: 844 };  // 基地条

export function slotToWorld(side: "friendly" | "enemy", index: number) {
  return {
    x: BOARD_X0 + index * (SLOT_W + SLOT_GAP) + SLOT_W / 2,
    y: ROW_Y[side],
  };
}
```

两行之间留出 **170px 的对撞带**，光束在这里交汇——这是整个画面的视觉焦点，
不要拿它塞 UI。

### 4.2 ★ 只翻上下，不翻左右

两名玩家都看到"自己在下方"。但**格位索引轴对双方都是 0 在左、8 在右，永不翻转**。

理由不是美观，是正确性。《DSL v2》§3.4 明确写了：

> `delta` 用带符号整数而不用 "left/right"——双方索引轴共享，"左右"随视角翻转，数轴不会。

如果客户端为对手视角把索引左右镜像，那么同一张"方向 −1"的斜刺长枪兵，在两个玩家屏幕上
会指向相反的方向，两人对同一局面的口头交流会彻底错位，录像与直播也会自相矛盾。

**只翻 Y**：`side` 是相对观察者的（`viewerSeat` 决定哪一方是 `friendly`），
`index` 直接用引擎的绝对索引。实测这样两名玩家看到的光束在世界坐标里几何完全一致，
只是上下颠倒——这正是我们要的。

### 4.3 ★ 光束即射线：空格穿透

单位在 `friendly` 第 `i` 格、生效方向 `d`，出手目标是敌方第 `i+d` 格。渲染规则：

```
从 slotToWorld(friendly, i) 向 slotToWorld(enemy, i+d) 发射一条光束：
  · 该格有单位   → 光束止于该单位，播放命中
  · 该格为空     → 光束穿过曜位，继续延伸至敌方基地条，播放基地受击
  · i+d 越界     → 同上（沿外插方向出射，抵达基地条）
```

这不是美术选择，是规则的直译：《DSL v2》§4.3「目标格越界或为空 → 敌方基地」，
《世界观》§10「曜位无人遮挡，光束长驱直灼残片」。
玩家看一眼光束是被挡住还是穿过去了，就知道这一击算不算打脸——
**用渲染把规则说清楚，比在卡面上写一行小字有效得多。**

空格穿透还顺带解决了一个 UI 难题：9 格棋盘稀疏是常态
（《数值基准》§5：r3 每侧 4–6 个单位），空列博弈是核心决策。
一眼看见"哪几条光束是直通基地的"，就是这个决策的全部信息。

---

## 5. ★ Director：事件流 → 动画时间线

### 5.1 为什么需要它

战斗阶段一次会吐出几十条事件。串行播放要十几秒，全并行则看不清。
Director 的职责是把 `ClientEvent[]` 切成 **Beat**（拍），一拍内并行、拍与拍串行。

关键洞察：**分组依据不需要客户端猜，引擎已经在事件流里给了相位标记。**
《DSL v2》§4.2 的战斗算法本身就是三段式，对应三个显式事件边界：

```
combat_began ──┐
               │  ① 快照 & 逐条应用 → 这一段只有 struck / damaged
struck × N ────┤     （引擎此时"不做中途死亡结算、触发器只入栈"）
damaged × N ───┘
               ② 结算栈开闸 → unit_died / 亡语 / buff 重算
unit_died × M
combat_ended
```

于是 Director 只需要一个跟着事件名走的小状态机，不需要任何规则知识。

### 5.2 Beat 编排表

| 事件段 | Beat 类型 | 编排 | 时长 |
|---|---|---|---|
| `combat_began` | `VolleyPrep` | 全场待出手单位微微前倾、蓄光 | 200ms |
| 连续的 `struck` / `damaged` | **`Volley`（齐射）** | 全部光束**同时**射出；伤害数字按快照顺序错开 40ms 依次弹出（>8 条时压到 20ms） | 480–900ms |
| 连续的 `unit_died` | `Deaths` | 全部死亡**并行**播放（同时结算，本就无先后） | 250ms |
| 亡语引发的 `unit_summoned` / `damaged` 等 | 每条一个 Beat | 串行，节奏加快 | 各 200ms |
| `combat_ended` | `CombatEnd` | 残光收束、附魔剥离提示 | 200ms |
| `card_played` | `PlayCard` | 手牌飞出→翻开→落格 | 400ms |
| `unit_moved` | `Move` | 折跃位移 | 250ms |
| `round_began` | `RoundStart` | 光潮扫过、水晶回满、抽牌 | 500ms |
| `hero_deployed` | `Deploy` | 承光者点亮入场 | 450ms |

**齐射同时、伤害数字错开**是这里唯一有分寸的地方：
同时出手是规则事实（必须让玩家看到"同归于尽"确实成立），
但十几个数字同时炸出来读不了，所以只错开**数字**，不错开**光束**。

一次完整战斗约 1.5–2.0 秒。

### 5.3 接口

```ts
interface Beat {
  readonly kind: BeatKind;
  play(ctx: RenderCtx): Promise<void>;   // 正常播放
  complete(ctx: RenderCtx): void;        // 立即落到终态，无动画
}

class Director {
  enqueue(events: ClientEvent[]): void;
  fastForward(): void;    // 依次 complete() 所有排队 Beat
  get isPlaying(): boolean;
}
```

**每个 Beat 必须实现 `complete()`**，这是硬性要求。跳过动画、重连补发、
浏览器切后台回来（`requestAnimationFrame` 停摆导致积压）三种情况都靠它。
少实现一个，就会出现"某次跳过后有个单位永远停在半空"。

Beat 的**规划**（事件流 → Beat 列表）是纯函数，直接单测：

```ts
import { test, expect } from "bun:test";

test("一次战斗编排成 齐射→死亡→收束 三拍", () => {
  const beats = planBeats(combatEventFixture);
  expect(beats.map(b => b.kind)).toEqual(["VolleyPrep", "Volley", "Deaths", "CombatEnd"]);
});
```

`planBeats` 不碰 Phaser，也不碰 DOM，所以它跑在 `bun test` 里和引擎测试是同一套设施。

---

## 6. 输入与意图

### 6.1 交互状态机

```
Idle
 ├─ 拖起手牌 ─→ Targeting（随从：高亮己方空格 / 法术：高亮合法目标）
 │                ├─ 落在合法处 → 发 play_card → Committed
 │                └─ 松手在别处 → 回弹 → Idle
 ├─ 点 Pass ─────→ 发 pass → Committed
 └─ 收到 prompt ─→ Prompt（OverlayScene 模态：发现 / 选择目标）→ 发 respond

Committed：短暂锁输入，等 events 或 rejected；rejected 则回弹并提示理由
```

部署阶段（v2.1 §11.3）是独立子状态：一次性把 2 名（r1）或 1 名（r2）英雄拖到格位，
**双方同时秘密选择**，全部放好后一次提交 `{ t: "deploy", placements: [...] }`。
提交前可以反复调整——秘密选择意味着没有信息可抢，不要做成逐个确认。

### 6.2 计时器是"每 action"，不是"每回合"

《DSL v2》§4.1 的提示要落到 UI：行动交替制下**每个 action 一个计时器**（默认 30 秒），
超时视同 pass。HUD 的计时环挂在当前 priority 方的头像上，行动权切换就重置。
把它做成"每回合一个大计时器"是会误导玩家的。

### 6.3 ★ 光源条：把色门画出来

HUD 顶部固定一条**光源条**，三盏灯对应红/绿/蓝：

```
● 红（亮）   ○ 绿（暗·复燃 1 潮）   ● 蓝（亮）
```

- 亮 = 该色有己方英雄存活在场 → 该色牌可打
- 暗 = 英雄在复燃泉，附带剩余回合数
- 融合卡（黄/品红/青）需要两盏同时亮，卡面上的两枚色点直接与灯对应

这是全 UI 最重要的一个控件。《命名与主题》§2 的整个设计意图——
"为什么没有红英雄就不能出红牌？因为没有红光源"——只有在这盏灯真的会灭的时候才成立。
不可打出的牌灰掉时，tooltip 直接说**「没有红色光源」**，而不是 `COLOR_GATE_LOCKED`。

同理，复燃泉（fountain）需要一块常驻显示区：躺着的英雄 + 回归倒计时。
英雄阵亡的真实代价是"一整回合的色门关闭"（《数值基准》§6.2），这个代价必须可见。

---

## 7. ★ 卡面程序化合成与色彩语言

### 7.1 不逐张画卡面

33 张基准卡 + 3 英雄 + 衍生物，且数值会随平衡补丁反复变动。逐张出图不可维护。
做法：**卡面 = 模板合成 → 烘焙成纹理 → 缓存**。

```
卡框（白模，按颜色 tint） + 立绘 + 费用/攻/血数字 + 名称/规则文本
        │
        └─→ Phaser RenderTexture 烘一次 → 缓存 key = `${cardId}` → 之后都是普通 Sprite
```

手牌里同名卡共用一张纹理，重绘只发生在数值被附魔改变时（另烘一张带角标的变体）。

### 7.2 卡框色直接编码色门要求

承《命名与主题》§3，**加色混合是信息设计，不是装饰**：

| 卡 `colors` | 卡框 | 含义 |
|---|---|---|
| `["R"]` / `["G"]` / `["B"]` | 红 / 绿 / 蓝 | 需 1 盏灯 |
| `["R","G"]` | **黄** | 需红+绿两盏灯 |
| `["R","B"]` | **品红** | 需红+蓝 |
| `["G","B"]` | **青** | 需蓝+绿 |
| 未来三色 | 白 | 三盏齐亮 |

融合卡框上再放**两枚小色点**标出构成色。理由：黄框告诉你"这是融合卡"，
色点告诉你"要哪两盏灯"——后者才是玩家出牌时真正要判断的。
玩家因此**不需要读文字就知道这张牌能不能打**，这是 9 格棋盘上节省决策时间的关键。

### 7.3 美术缺位时的占位管线

立绘尚未产出。M10 起客户端就要能跑，所以**占位图必须是程序生成的**，
而不是等美术：卡框按色 tint + 色相化的剪影 + 卡名。
接口按 `art: "pf1/xxx"` 约定，美术到位后替换图集，代码不动。

---

## 8. 重连、resync 与快进

```
每条 ServerMsg 带 seq
  ├─ seq 连续      → 正常入 Director 队列
  ├─ seq 跳号      → 立即发 resync → 收 snapshot → fastForward() → 重建
  └─ 断线重连      → 收 snapshot → fastForward() → 重建 → 恢复输入
```

《框架设计》§7.3 的判断在这里兑现：seq 跳号自动 resync 能挡掉后期一大半
"客户端和服务端对不上"的玄学问题。这条**不要等出问题了再加**。

浏览器切后台会让 `requestAnimationFrame` 停摆，回来时 Director 队列可能积压十几拍。
策略：积压超过 3 拍即自动 `fastForward()` 到只剩最后 1 拍再正常播——
玩家看到的是"刚刚发生了什么"，而不是被迫看完二十秒的补播。

---

## 9. 资源管线与性能预算

| 项 | 预算 | 手段 |
|---|---|---|
| 首屏加载 | < 3s（4G） | 卡面纹理**运行时烘焙**而非预置大图；图集只放卡框白模 + 立绘 |
| 稳定帧率 | 60fps | 回合制无持续动画；战斗峰值也只有约 20 条光束 |
| Draw call | < 60 | 单张卡面 = 1 Sprite；光束用同一材质批处理 |
| GC | update 内零分配 | 伤害数字、光束、粒子全部对象池 |
| 包体 | < 2MB（不含立绘） | Phaser 4 ESM + Vite 8 tree-shaking（由 Bun 驱动） |

Phaser 4 的新渲染器对这个量级绰绰有余；**不要提前做优化**，
先把 §5 的编排做对——客户端的体验瓶颈会是动画节奏，不是帧率。

---

## 10. ★ 回放驱动开发：客户端不等服务端

`Transport` 是接口，有两个实现：

```ts
interface Transport {
  send(intent: Intent): void;
  onMessage(cb: (m: ServerMsg) => void): void;
}

class ColyseusTransport implements Transport { /* 真实 */ }
class MockTransport   implements Transport { /* 读 JSON 回放，按 intent 推进 */ }
```

`apps/cli` 的 `sim` 在 M8 就会产出 **golden replay**：
`{ seed, decks, intents, messagesPerSeat }`。把它喂给 `MockTransport`：

```
bunx turbo dev --filter=@prismfront/client
# 浏览器打开 http://localhost:5173/?replay=golden/combat-tradeoff.json
```

收益有三层：

1. **调度上**：客户端（M10）不必等服务端（M9），两者可并行——这是整条关键路径上
   最大的一次并行机会（见《实现步骤与里程碑》§1）。
2. **调试上**：想复现"同归于尽时死亡动画错乱"，不需要打一局，加载对应 replay 即可。
3. **回归上**：每个战斗边界用例（快照冻结、荆棘反伤、空格穿透打基地）各存一份 replay，
   变成客户端的视觉回归夹具。

M8 产出 replay 时就应当刻意覆盖这批用例，而不是随机存几局了事。

---

## 11. 明确不做的

- **不做本地规则/预演/离线 AI 对战**（§0）。想要单机练习模式，走服务端跑 bot。
- **不做实体 3D / spine 骨骼动画**。九曜位是信息密集的战术界面，2D + tween 足够。
- **不做响应式重排**。固定 1920×1080 + FIT 缩放；移动端横屏。
  9 格棋盘在竖屏下无法阅读，这是玩法决定的，别硬做。
- **不做 React/Vue 混合 UI**。HUD 用 Phaser 自己画，省掉 DOM 与 Canvas 的坐标同步地狱。
  唯一例外是文本密集的卡组构筑页面，可以另起一个纯 DOM 页面，不与对局同屏。
- **不做客户端埋点自动上报**（M12 之后再议）。
