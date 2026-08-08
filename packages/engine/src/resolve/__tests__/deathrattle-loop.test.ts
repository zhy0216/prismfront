// 亡语递归的深度上限与失败形态（M5/T4）。
// 来源：框架 §13 坑 5 原文 ——
//
// > **亡语递归**（亡语召唤的随从又有亡语）必须有深度上限并且有测试，
// > 否则线上会出无限循环把房间卡死。
//
// 风险登记册那一行要的是**两样**：「深度上限 + 专门测试」。上限是 M2 就有的
// `resolve.ts` 的 {@link MAX_RESOLUTION_DEPTH}（IR v1 §7 资源上限表「单次结算栈深度 256」），
// 本文件补的是「专门测试」——**并且先证明那道上限真的兜得住亡语这条路径**。
//
// ═══════════════════════════════════════════════════════════════════════════
// 为什么已有的三条环测试不够，非要再写一个文件
// ═══════════════════════════════════════════════════════════════════════════
// 撞 `ResolutionLoopError` 的测试在 M2/M3 就有三条，但它们**全部注入一张自我复制的
// handler 表**（`resolve.test.ts` 的 `act.nothing` 自压、`apply.test.ts` 的 `act.move`
// 自压、`combat.test.ts` 的 `act.hit` 自压）：测的是「弹栈计数器本身会不会数」。
// 坑 5 说的是另一件事 —— **成环的是卡牌数据，不是 handler**：
// 亡语展开（`triggers.ts` 的 `deathrattleTriggerOf`）→ `zone:"graveyard"` 匹配 →
// `act.summon` 造新实体 → 光环重算把它判死（`deaths.ts`）→ 又一条亡语。
// 这条链上任何一环换个写法，"会不会挂死"的答案都可能变，而三条注入式测试对它零判别力。
// 本文件全程用**真卡 + 真 deps**（`cardDeps` 接 `scripts` / `enchantments`），一行 handler 桩都没有。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 实测结论（先验证，再写测试）★
// ═══════════════════════════════════════════════════════════════════════════
// 1. `MAX_RESOLUTION_DEPTH` **确实兜住了**亡语递归，三条路径都试过：直驱结算
//    （`runActs`）、相位机自动相位（`apply` 的 pass → combat）、战斗第 ④ 步开闸。
//    三处都在有界步数内抛 `ResolutionLoopError`，**没有一处挂死**。
//    原因：亡语最终都要经过 `resolve()` 的 `while` 才执行（时序规则 2「触发是入栈而非
//    立即执行」），而那个 `while` 每弹一次栈 `guard += 1`。全仓另外三个循环都不会因为
//    亡语变成无界：`deaths.ts` 的不动点循环每波至少从 `slots` 移走一个实体（亡语在那里
//    只入栈不执行）、`combat.ts` 的旁路链条自带同一道护栏、`phase.ts` 的 `advancePhases`
//    走的是一条无环相位链。所以**本条目不新增亡语专用的上限**。
// 2. 反向实验（在仓库副本里做的）：把 `resolve()` 那道 guard 拿掉、或把判据从弹栈次数
//    换成栈的**瞬时高度**（`state.stack.length > 256`），本文件立刻把测试进程跑挂 ——
//    `timeout` 杀掉、exit 124，连 `bun test --timeout` 都救不回来。同步死循环压根不把
//    事件循环还给运行时，这正是坑 5 说的"房间卡死"。换成高度判会挂，说明亡语环在这条
//    链上**始终没让栈长起来**（一条亡语弹出去、压回一两条），所以判据必须是弹栈次数。
//    顺带证实了上面那句"三条旧环测试对亡语这条路径零判别力"：把亡语的 `zone` 从
//    `"graveyard"` 改成 `"board"`（亡语从此不响），本文件 7 条全红，而那三条旧的
//    ResolutionLoopError 测试**一条都没红**。
// 3. 于是「合法的深链」与「无限循环」的分界线**不在亡语上**：一条亡语召唤一个带亡语的
//    随从完全合法（下面第 1 条测试），几十层的亡语接力也照跑（第 2 条）。
//    上限落在**同一次结算的弹栈次数**上，与是不是亡语无关。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 拍板：撞上限 = 抛错，不截断 ★
// ═══════════════════════════════════════════════════════════════════════════
// 这是 M2 就写在 `rules/apply.ts` 的 `@throws` 上的取舍，M5/T4 复核后维持，理由补全：
//
// - **不能截断**：静默丢掉栈上剩余的亡语 = 一半亡语跑了一半没跑，盘面在规则上说不通，
//   而这份状态会照常进快照 / 投影 / 回放（M7/M8），之后所有分歧都追不回源头。
//   "截断并记一条事件"同样不行：事件流是**因果**记录（框架 §3.3），"引擎放弃了"不是因果。
// - **抛错不会把房间卡死**，坑 5 担心的正是"卡死"：一次 `resolve()` 至多弹 256 次栈，
//   而一次 `apply()` 里 `resolve()` 的调用次数又被那条无环相位链钉死 ⇒ 整体有界，
//   进程照常响应，其它房间不受影响；而且 `apply()` 是**先 clone 再跑**的，
//   所以调用方手里那份状态**一字未改**（本文件最后一条测试钉住了这条），
//   房间连快照都不用回滚，丢掉这一次意图即可。
// - **诚实写清代价**：撞环发生在自动相位（双 pass 之后的战斗）时，那一局会卡在
//   "这条意图提交不下去"上 —— 房间活着，但那局推不动，要 M9 决定是判负还是作废。
//   这比"整个进程挂死"小几个数量级，且是**数据 bug 的正确表现**：卡池是自家写的，
//   真正的防线是 M11 的 lint 与 M8 的 fuzz，引擎在这里只负责「不挂死 + 可诊断」。
//
// 注：本文件**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1）。

import { expect, test } from "bun:test";
import type { Act, Aura, Card, CardId, Sel } from "@prismfront/ir";
import type { GameEvent } from "../../events/index.ts";
import { apply } from "../../rules/index.ts";
import type { GameState } from "../../state/index.ts";
import { createCtx, getZone } from "../../state/index.ts";
import { cardDeps, openGame, passOnce, putCard, runActs, scriptCard } from "../../testkit/index.ts";
import type { ResolveDeps } from "../index.ts";
import { MAX_RESOLUTION_DEPTH, pushActs, ResolutionLoopError, resolve } from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 卡与夹具
// ═══════════════════════════════════════════════════════════════════════════

/** 友方战线（`sel.zone` 的 side 相对 SELF，IR v1 §3.1）。base 在 `"base"` 区，不在里面。 */
const FRIENDLY_BOARD: Sel = { op: "sel.zone", side: "friendly", zone: "board" };
const SELF: Sel = { op: "sel.self" };
/** 友军（不含自己）—— 野猪王式光环的受影响集合（IR v1 §10.3）。 */
const OTHER_FRIENDLIES: Sel = { op: "sel.minus", of: FRIENDLY_BOARD, exclude: SELF };

/** 亡语里的召唤：落到自家最左空格（死者刚腾出来的那一格，v2 §3.1）。 */
function summon(card: CardId): Act {
  return {
    op: "act.summon",
    player: { op: "sel.controller" },
    card,
    at: { op: "slot.first_empty", side: "friendly" },
  };
}

/** 1/1 的卡面 —— 只召唤得起、只挨得住 1 点，链条的长短才由卡的写法决定。 */
const ONE_ONE = { tags: { atk: 1, health: 1 } } as const;

/**
 * 「亡语：召唤一个自己的复制」。**这张卡本身不成环** —— 复制品活着，链条到此为止。
 *
 * 它是坑 5 那句话的字面形态（"亡语召唤的随从又有亡语"），也是本文件的**反例基准**：
 * 引擎若为了防环把这种写法一刀切掉，第一条测试就红。
 */
const REBORN: Card = scriptCard("T_REBORN", { deathrattle: [summon("T_REBORN")] }, ONE_ONE);

/**
 * 「亡语：召唤一个自己的复制，并对所有友军造成 1 点伤害」——**单卡自闭环**。
 *
 * 两条动作各自都是常见写法（自爆兵 + 复活），组合起来才成环：复制品是 1 血，
 * 当场被同一条亡语的溅射打死 ⇒ 又一条亡语。这正是坑 5 说的那种卡。
 */
const SELF_LOOP: Card = scriptCard(
  "T_SELF_LOOP",
  { deathrattle: [summon("T_SELF_LOOP"), { op: "act.hit", target: FRIENDLY_BOARD, amount: 1 }] },
  ONE_ONE,
);

/** 「友军血量上限 −1」的光环 —— 单独看是一张普通的削弱牌（IR v1 §4.3）。 */
const BLIGHT_AURA: Aura = { affects: OTHER_FRIENDLIES, mods: { health: -1 } };
const BLIGHT: Card = scriptCard(
  "T_BLIGHT",
  { auras: [BLIGHT_AURA] },
  {
    tags: { atk: 0, health: 9 },
  },
);

/**
 * 一条 `n` 层的**合法**亡语接力：`T_CHAIN_1` 的亡语召唤 `T_CHAIN_2`，依此类推，
 * 第 `n` 张**没有**亡语，链条自然收口。
 *
 * 配 {@link BLIGHT} 使用：血量上限 −1 让每个 1/1 一上场就被判死（`deaths.ts` 在判死
 * 之前先重算光环），于是整条链在**一次结算**里跑完 —— 这才是"深链"，不是"环"。
 */
function chainCards(n: number): Card[] {
  const out: Card[] = [];
  for (let i = 1; i <= n; i += 1) {
    const script = i < n ? { deathrattle: [summon(`T_CHAIN_${i + 1}`)] } : {};
    out.push(scriptCard(`T_CHAIN_${i}`, script, ONE_ONE));
  }
  return out;
}

/**
 * 摆好「{@link BLIGHT} 在 8 格 + 链头在 0 格」的盘面，跑**一步空动作**把六步流水线推一次。
 *
 * 用 `act.nothing` 而不是直接打死链头：链头是被光环判死的（第 ⑤ 步），
 * 于是"起点"与"链条中间每一环"走的是**同一条**路径，测的不是某种特殊的开场。
 */
function runChain(n: number): { events: readonly GameEvent[] } {
  const cards = chainCards(n);
  const head = cards[0];
  if (head === undefined) {
    throw new Error("夹具错误：链长必须 ≥ 1");
  }
  const deps = cardDeps([...cards, BLIGHT]);
  const state = openGame();
  const blight = putCard(state, 0, 8, BLIGHT);
  putCard(state, 0, 0, head);
  return runActs(state, [{ op: "act.nothing" }], blight, deps);
}

/** 一批事件里某个名字出现了几次。 */
function countOf(events: readonly GameEvent[], name: GameEvent["name"]): number {
  return events.filter((event) => event.name === name).length;
}

/** 跑一段必定成环的结算，取回那个 {@link ResolutionLoopError}（没抛就当场失败）。 */
function expectLoopError(run: () => unknown): ResolutionLoopError {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  // 没抛 = 要么环被别的机制吃掉了（那要问为什么），要么这段根本没成环（夹具坏了）。
  // 先比 `name` 再比类型：`expect(x instanceof Y).toBe(true)` 红的时候只会说
  // "期望 true 得到 false"，而这一行会直接把"实际抛的是什么"印在失败信息里。
  expect(caught instanceof Error ? caught.name : "没有抛错（这段跑完了）").toBe(
    "ResolutionLoopError",
  );
  expect(caught instanceof ResolutionLoopError).toBe(true);
  return caught as ResolutionLoopError;
}

/** 摆好「光环 + 自召唤亡语」的两卡成环盘面，返回 `[state, deps, 链头 id]`。 */
function twoCardLoop(): [GameState, ResolveDeps, number] {
  const deps = cardDeps([REBORN, BLIGHT]);
  const state = openGame();
  const blight = putCard(state, 0, 8, BLIGHT);
  putCard(state, 0, 0, REBORN);
  return [state, deps, blight];
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 合法的那一侧：亡语递归本身不是环，不许一刀切
// ═══════════════════════════════════════════════════════════════════════════

test("亡语召唤带亡语的随从：复制品活着 ⇒ 结算正常收口，不当成环", () => {
  const deps = cardDeps([REBORN]);
  const state = openGame();
  const unit = putCard(state, 0, 0, REBORN);

  // 打死链头 ⇒ 亡语召唤一个同卡复制品。复制品满血站着，没有第二条死亡。
  const step = runActs(
    state,
    [{ op: "act.hit", target: { op: "sel.entity", id: unit }, amount: 9 }],
    unit,
    deps,
  );

  // 写错（给"亡语召唤带亡语的随从"设一道一刀切禁令）会在这里读到 0 次召唤；
  // 上限小到连一层都容不下（实测把 MAX_RESOLUTION_DEPTH 改成 1）则直接抛
  // ResolutionLoopError —— 两种"防环防过头"都被这一条挡住。
  expect(countOf(step.events, "unit_summoned")).toBe(1);
  expect(countOf(step.events, "unit_died")).toBe(1);
  expect(getZone(step.state, 0, "board")).toHaveLength(1);
  expect(getZone(step.state, 0, "graveyard")).toHaveLength(1);
});

test("合法深链：几十层亡语接力在一次结算里全部跑完，一层都不截断", () => {
  // 64 层远深于任何"亡语专用小上限"能容忍的深度，又远在 256 步预算之内。
  const depth = 64;
  const step = runChain(depth);

  // 每一层都死了一次；除了收口那张，每一层都召唤了下一层。
  // 写错（另设一道亡语专用的小上限；实测把 MAX_RESOLUTION_DEPTH 改成 8 就是这个形态）
  // 会在这里读到一个 ResolutionLoopError，或者一条被截短的链（死亡数 < 64）。
  expect(countOf(step.events, "unit_died")).toBe(depth);
  expect(countOf(step.events, "unit_summoned")).toBe(depth - 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 成环的那一侧：撞上限抛错，而不是把房间挂死
// ═══════════════════════════════════════════════════════════════════════════

test("单卡自闭环（亡语召唤自己 + 顺手打死复制品）⇒ ResolutionLoopError", () => {
  const deps = cardDeps([SELF_LOOP]);
  const state = openGame();
  const unit = putCard(state, 0, 0, SELF_LOOP);

  const loop = expectLoopError(() =>
    runActs(
      state,
      [{ op: "act.hit", target: { op: "sel.entity", id: unit }, amount: 9 }],
      unit,
      deps,
    ),
  );

  // ★ 这里**故意写字面量 256**，不写 `MAX_RESOLUTION_DEPTH`：
  //   `expect(loop.limit).toBe(MAX_RESOLUTION_DEPTH)` 两边是同一个常量，恒真 ——
  //   把上限改成 8 或 512 它照样绿，于是「上限值就是 IR v1 §7 资源上限表里的
  //   『单次结算栈深度 256』」这句话在全仓没有任何机器校验。
  //   这一行就是那道校验：改了常量而没同步规范（或反过来），它当场红。
  //   本文件其余几处仍用 `MAX_RESOLUTION_DEPTH` —— 那些钉的是「错误对象带着上限值」
  //   这条一致性，不是上限取多少。
  expect(loop.limit).toBe(256);
  expect(MAX_RESOLUTION_DEPTH).toBe(256);
});

test("★ 两张各自合法的卡组合成环（自召唤亡语 + 减血上限光环）⇒ 同样抛错", () => {
  // 这条是"不能靠禁某种写法来防环"的证据：`T_REBORN` 单独跑是上面第一条测试
  // （正常收口），`T_BLIGHT` 单独跑就是一张普通削弱牌 —— 环由**组合**产生。
  const [state, deps, blight] = twoCardLoop();

  const loop = expectLoopError(() => runActs(state, [{ op: "act.nothing" }], blight, deps));
  expect(loop.limit).toBe(MAX_RESOLUTION_DEPTH);
});

test("合法但超预算的长链同样被截断：上限管的是步数预算，不区分「环」与「长」", () => {
  // 512 层是**有限**的、语义上完全合法的一条链，但它要弹 512 次栈。
  // 引擎不会（也没法）分辨"很长"与"无限"，于是一视同仁 —— 这正是选 256 这个数
  // 而不是做环检测的代价，写下来免得将来有人把这条当 bug 修。
  const loop = expectLoopError(() => runChain(MAX_RESOLUTION_DEPTH * 2));
  expect(loop.limit).toBe(MAX_RESOLUTION_DEPTH);
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 失败形态：可诊断 + 状态怎么处置
// ═══════════════════════════════════════════════════════════════════════════

test("失败形态可诊断：事件流挂在错误上、eventLog 已排空、证据指得出罪魁卡", () => {
  const deps = cardDeps([SELF_LOOP]);
  const state = openGame();
  const unit = putCard(state, 0, 0, SELF_LOOP);
  // 直接调 `resolve()`（不经 `runActs` 的 clone），这样抛错之后还能读到那份 state。
  pushActs(
    state,
    [{ op: "act.hit", target: { op: "sel.entity", id: unit }, amount: 9 }],
    createCtx(unit),
  );

  const loop = expectLoopError(() => resolve(state, deps));

  // a. 抛错路径同样遵守「返回时 eventLog 为空」（`events/log.ts` 的不变量）——
  //    事件挂在错误对象上，不滞留在状态里等着下次结算重复下发。
  expect(state.eventLog).toHaveLength(0);
  expect(loop.events.length).toBeGreaterThan(0);
  // b. ★ 证据能指认罪魁：事件流里带着召唤事件的 `cardId`，运维不必去猜是哪张卡成的环。
  //    写错（抛错时不带事件、或 `unit_summoned` 不带 cardId）会让这一步只剩"某处成环了"。
  const culprits = new Set(
    loop.events.flatMap((event) => (event.name === "unit_summoned" ? [event.cardId] : [])),
  );
  expect([...culprits]).toEqual(["T_SELF_LOOP"]);
  // c. `resolve()` **原地改状态、不做事务**：抛错时这份 state 是半跑的（栈没空、墓地一堆尸体），
  //    调用方必须丢弃它。`apply()` 的调用方为什么不用管，见下一条测试。
  expect(state.stack.length).toBeGreaterThan(0);
  expect(getZone(state, 0, "graveyard").length).toBeGreaterThan(0);
});

test("★ 生产路径：自动相位里撞环 ⇒ apply 往外抛，且入参状态一字未改", () => {
  const deps = cardDeps([SELF_LOOP, BLIGHT]);
  const state = openGame();
  putCard(state, 0, 8, BLIGHT, { atk: 0, health: 9 });
  putCard(state, 0, 0, SELF_LOOP, { atk: 1, health: 5 });
  // p1 的 5 攻单位正对 p0 的 0 格：战斗里把链头打死 ⇒ 环在**自动相位**里炸，
  // 而不是在玩家提交的那条动作里 —— 这正是"房间会不会卡死"要问的那条路径。
  putCard(state, 1, 0, scriptCard("T_PLAIN", {}), { atk: 5, health: 5 });

  const opened = passOnce(state, deps).state;
  const before = JSON.stringify(opened);

  // 第二次 pass ⇒ `advancePhases` 进 combat ⇒ 战斗第 ④ 步开闸跑亡语 ⇒ 成环。
  const loop = expectLoopError(() => apply(opened, { t: "pass", player: opened.priority }, deps));
  expect(loop.limit).toBe(MAX_RESOLUTION_DEPTH);

  // ★ 上限抛出来的不是"非法意图"，所以 `apply` 不该把它翻成 `ok:false`（那会让房间
  //   带着一份坏状态继续跑）；但 `apply` 是先 clone 再跑的，**入参那份状态一字未改** ——
  //   于是房间丢掉这一次意图就行，不需要回滚到快照。
  //   写错（`apply` 直接在入参上跑 / 捕获后返回 ok:false）会让这两条断言各红一条。
  expect(JSON.stringify(opened)).toBe(before);
});
