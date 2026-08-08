// v2 §8.7 表达力验收 —— 四条 Artifact 关键词 + 三条自洽性（M5/T6 的完成判据）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 这一份要证明的是什么
// ═══════════════════════════════════════════════════════════════════════════
// §8.7 的主张有两层，两层都得验：
//   1. 四条关键词**写得出来**（编写层的 builder 一行就是规范里那一行，无需新 op）；
//   2. 四条关键词**跑得起来、效果对**（喂进引擎打一局，盘面上读得到伤害与方向）。
// 只验第 1 层就是"类型能过"——`defineCard` 不做任何语义校验，一段没人认识的 IR
// 照样能构造出来。所以每条关键词都有一条**跑引擎**的断言，读的是 `damageOf` /
// `tagOf` 这类盘面读数，不是节点长什么样。
// 顺带用 `validate(buildBundle(...))` 过一遍 L1/L2，把"结构合法"也钉住
// （校验器是纯函数，这几张卡不进 bundle 不妨碍拿它当输入）。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 三条自洽性：它们的正确写法是「**没有**为它们写代码」★
// ═══════════════════════════════════════════════════════════════════════════
// §8.7 末段原文：「三条都不需要特判 —— 是空集语义和事件/动作二分在兜底。」
// 落地时确实没有为它们写任何代码：T6 新增的只有本目录的两个文件
// （外加 `src/index.ts` 文件头三行说明），`packages/engine` 与 `packages/ir`
// 一个字节都没动。
//
// 于是"没有特判"这句话必须由**注入实验**来证，不能靠 diff 是空的来证 ——
// 空 diff 只说明"今天没写"，不说明"写没写在别处"。本文件每条测试旁都写明
// 注入什么会让它红，全部在仓库副本里实跑过（见各条的 ★ 注释），汇总：
//   自洽性 1  `hitHandler` 补发一条 `struck`
//             → 「★ 两个 Retaliate 照面」红（实测 47 条事件 / 23 条 `struck`，
//                两边各挨 22 / 23 点；血量调到 1000 谁都死不了时抛 `ResolutionLoopError`
//                —— 这条连锁本身没有收口点）
//   自洽性 2  `eval/sel.ts` 的 `sel.adjacent` 去掉 `slot === null` 的跳过
//             → 「★ Cleave 打进基地」**单独**红（`null` 在算术里当 0 用，
//                基地被当成站在 0 号格）
//   自洽性 3  `Siege()` 去掉 `when(IsMinion(...))` 这一层
//             → 「★ Siege 打空格」**单独**红；正向那条「Siege 1」照绿 ——
//                所以双重计算的唯一防线就是打空格那一条，它不能删
//
// ═══════════════════════════════════════════════════════════════════════════
// 夹具与盘面
// ═══════════════════════════════════════════════════════════════════════════
// 引擎侧走 `@prismfront/engine/testkit`（engine 是 devDependency，架构 §2.2 禁令 4：
// 只有测试能用）。不写状态字面量。
//
// 靶子一律用 **PF1_R01**（净水 3/1，没有任何脚本）而不是新造一张：
//   - `IsMinion` 读的是**卡表里的** `data.kind`（`engine/src/eval/cond.ts`），
//     所以靶子必须是一张 `deps.cards` 查得到的真卡 —— 用 PF1 的净水随从最省事，
//     顺带说明了这条判据的数据来源就是卡面；
//   - 攻血由 `putCard` 的 `face` 逐条覆盖：靶子几乎都要 `atk: 0`（不还手，
//     于是战斗快照里只有一条出手，读数不会被对方的反击搅进来）。
import { describe, expect, test } from "bun:test";
import {
  baseIdOf,
  cardDeps,
  castCard,
  damageOf,
  enchantsOf,
  eventNames,
  fightOnce,
  openGame,
  putCard,
  strikeNow,
  tagOf,
} from "@prismfront/engine/testkit";
import { validate } from "@prismfront/ir";
import { buildBundle } from "../../build/bundle.ts";
import { PF1_R01 } from "../../pf1/R/index.ts";
import {
  KEYWORD_CARDS,
  KEYWORD_ENCHANTMENTS,
  KW_CLEAVE,
  KW_COMPEL,
  KW_COMPEL_ENCH,
  KW_RETALIATE,
  KW_SIEGE,
} from "../index.ts";

/** 四条范式 + 靶子卡的接线。每条测试都从这里取 `deps`，免得漏接一张卡。 */
const DEPS = cardDeps([...KEYWORD_CARDS, PF1_R01], [...KEYWORD_ENCHANTMENTS]);

/** 一个不还手的靶子（`atk: 0` ⇒ 战斗快照里根本不会有它的那一条，v2 §4.2 第 ② 步）。 */
const DUMMY = { atk: 0, health: 9 } as const;

describe("v2 §8.7 Artifact 关键词映射 —— 表达力验收", () => {
  test("四条范式是结构合法的 IR（L1 + L2 全过，不只是「类型能过」）", () => {
    const bundle = buildBundle({ cards: KEYWORD_CARDS, enchantments: KEYWORD_ENCHANTMENTS });

    // "写得出来"这一层要由校验器说了算，而不是由编译器。
    // ★ 实测的判别力注入：把某张卡的 `kind` 换成 `"creature" as never` ⇒ **本条单独红**，
    //   还原即绿。所以它不是空壳。
    // ⚠ 别用"塞一个不存在的 op"做这个注入 —— 试过，走不到这一行：
    //   `defineCard` → `canonicalizeCard` 在**模块加载时**就抛
    //   `TypeError: 未知的 IR 节点`（`ir/src/builder/canonical.ts`），
    //   整个文件以 `0 pass / 1 fail` 的 unhandled error 挂掉，没有任何一条用例被判红。
    //   即 builder 的规范化本身就是第一道闸，`validate` 守的是它之后的那一层。
    // ⚠ 边界：这里的"结构合法"= L1 + L2。**跨引用不在此列** ——
    //   `Buff(TARGET, "KW_MISSING_e")` 这种悬空附魔引用 `validate` 抓不到
    //   （L2 只按前缀判种类，引用完整性是 L3，属 M11）。
    expect(validate(bundle).issues).toEqual([]);
    // 顺带钉住它们**不在** PF1 卡集里（`set` 是 bundle 里唯一能一眼分辨的字段），
    // 也**不可收藏** —— 于是 v2.1 §11.4b 那条「专属卡必须写 `hero`」的 lint 免除，
    // 而 M11 真写 G06 / R05 / R06 时不会误把这几张当成已经写完的卡。
    for (const card of KEYWORD_CARDS) {
      expect(card.set).toBe("kw");
      expect(card.data.collectible).toBe(false);
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Retaliate X —— `on(Struck({target: SELF}), Hit(EVENT.source, X))`
  // ═════════════════════════════════════════════════════════════════════════

  test("Retaliate 2：被出手命中 ⇒ 对出手者反弹 2（v2 §8.6 / §8.7）", () => {
    const state = openGame();
    const attacker = putCard(state, 0, 0, PF1_R01, { atk: 3, health: 9 });
    const thorns = putCard(state, 1, 0, KW_RETALIATE, DUMMY);
    // 对照：**同一张卡**、同一侧、就在隔壁 —— 它没有被打，所以不该反击。
    // 少了这一个，"filter 整个被忽略"与"filter 判对了"读出同样的 2 点反伤。
    const bystander = putCard(state, 1, 1, KW_RETALIATE, DUMMY);

    const step = strikeNow(state, attacker, thorns, DEPS);

    // 写错的三种典型读数：filter 被忽略 → 4；SELF 绑成事件源 → 0；键取成 `source` → 0。
    // ★ 实测把 `Retaliate()` 的键从 `target` 换成 `source`，本条**单独**红。
    expect(damageOf(step.state, attacker)).toBe(2);
    expect(damageOf(step.state, thorns)).toBe(3);
    expect(damageOf(step.state, bystander)).toBe(0);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Cleave X —— `on(Struck({source: SELF}), Hit(Adjacent(EVENT.target), X))`
  // ═════════════════════════════════════════════════════════════════════════

  test("Cleave 1：命中一个单位 ⇒ 其**位置相邻**的单位各挨 1（v2 §3.2 语义变更）", () => {
    const state = openGame();
    const cleaver = putCard(state, 0, 0, KW_CLEAVE, { atk: 2, health: 9 });
    const victim = putCard(state, 1, 0, PF1_R01, DUMMY);
    // ★ `far` 站 **2 号格**，而且**比 neighbour 先上场** —— 这一格同时是两件事的判别点：
    //   a. v1 的"召唤顺序相邻"会选中它（victim 之后上场的就是它）而不是 neighbour
    //      ⇒ v2 §3.2 那次语义变更（顺序相邻 → 位置相邻）真的落地了；
    //   b. `dist` 的默认值若从 1 放宽到 2，它也会挨到这一下。
    // ★ 两条都实跑过注入：(a) 把 `sel.adjacent` 改成"按 `playOrder` 取相邻"⇒ 本条红
    //   （neighbour 读 0、far 读 1，正好对调）；(b) 把 `dist` 默认值改成 2 ⇒ 本条红
    //   （far 读 1）。两次都只红本条。
    // ⚠ 注入 (a) 不能拿 `boardEntities` 的返回序当"召唤顺序"—— 它已经是**格序**
    //   （v2 §3.2），不排序的话注入等价于原实现，测试会照绿（第一次就这么跑空了）。
    const far = putCard(state, 1, 2, PF1_R01, DUMMY);
    const neighbour = putCard(state, 1, 1, PF1_R01, DUMMY);

    const step = strikeNow(state, cleaver, victim, DEPS);

    expect(damageOf(step.state, victim)).toBe(2); // 只挨了出手那一下，没被自己的溅射再打
    expect(damageOf(step.state, neighbour)).toBe(1); // 溅射恰好一次（`dist` 默认 1）
    expect(damageOf(step.state, far)).toBe(0);
    expect(damageOf(step.state, cleaver)).toBe(0);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Siege X —— `on(Struck({source: SELF}), when(IsMinion(EVENT.target), Hit(ENEMY_BASE, X)))`
  // ═════════════════════════════════════════════════════════════════════════

  test("Siege 1：命中一个随从 ⇒ 额外对敌方基地打 1（走真战斗，v2 §4.2）", () => {
    const state = openGame();
    // 走战斗而不是 `strikeNow`：Siege 的两个读数（谁挨打、基地掉多少）在真战斗里
    // 才同时受快照与方向的支配，也才与下面那条"打空格"的盘面**只差对面那一格**。
    putCard(state, 0, 0, KW_SIEGE, { atk: 2, health: 9 });
    const victim = putCard(state, 1, 0, PF1_R01, DUMMY);
    const enemyBase = baseIdOf(state, 1);

    const after = fightOnce(state, DEPS);

    expect(damageOf(after.state, victim)).toBe(2);
    // 写错（触发器没响 / `ENEMY_BASE` 取成己方）会读到 0，而"敲错了哪一边"由下面
    // 那行己方基地的读数分辨。★ 实测把 `ENEMY_BASE` 换成 `FRIENDLY_BASE`，本条单独红。
    // 「条件恒真」那种写法这里读不出来（靶子本来就是随从），由自洽性第 3 条抓。
    expect(damageOf(after.state, enemyBase)).toBe(1);
    expect(damageOf(after.state, baseIdOf(state, 0))).toBe(0);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 改箭头 —— `Buff(TARGET, ench)`，ench 带 `direction` mod（v2 §2.3）
  // ═════════════════════════════════════════════════════════════════════════

  test("改箭头：Buff(TARGET, ench) 改的是**生效** direction，战斗快照当场读到", () => {
    const state = openGame();
    // 敌方射手站 1 号格：方向 0 正对我方 1 号格，方向 -1 打我方 0 号格。
    const shooter = putCard(state, 1, 1, PF1_R01, { atk: 3, health: 9 });
    const straight = putCard(state, 0, 1, PF1_R01, DUMMY);
    const bent = putCard(state, 0, 0, PF1_R01, DUMMY);

    const cast = castCard(state, KW_COMPEL, { target: shooter, deps: DEPS });

    // 附魔真的挂上去了（实例列表），而且**生效值**跟着变了（`base + Σ附魔`，时序规则 4）。
    // 两个读数要一起断：只读实例列表，"挂上了但 Σ 没加"照样绿；只读生效值，
    // "数值对了但附魔没挂"照样绿（下一次沉默 / 剥离就会露馅）。
    expect(enchantsOf(cast.state, shooter)).toEqual([KW_COMPEL_ENCH.id]);
    expect(tagOf(cast.state, shooter, "direction")).toBe(-1);

    const after = fightOnce(cast.state, DEPS);

    // ★ 真正的验收在这两行：`planStrikes` 读的是生效值，所以箭头真的改了。
    //   实测把 `rules/combat.ts` 的 `attacker.tags.direction` 换成 `attacker.base.direction`
    //   （= 战斗读卡面），本条单独红：bent 读 0、straight 读 3。
    expect(damageOf(after.state, bent)).toBe(3);
    expect(damageOf(after.state, straight)).toBe(0);
  });
});

describe("v2 §8.7 三条自洽性 —— 都不需要特判", () => {
  // ═════════════════════════════════════════════════════════════════════════
  // 1. 溅射/反伤走 `act.hit`，不发 `struck` ⇒ 不会连锁
  // ═════════════════════════════════════════════════════════════════════════

  test("★ 两个 Retaliate 照面：反伤不再触发反伤（事件/动作二分在兜底）", () => {
    const state = openGame();
    const striker = putCard(state, 0, 0, KW_RETALIATE, { atk: 3, health: 20 });
    const struck = putCard(state, 1, 0, KW_RETALIATE, { atk: 0, health: 20 });

    const step = strikeNow(state, striker, struck, DEPS);

    // ★ 整段只有**一条** `struck` —— 出手发它，反伤那一下（`act.hit`）不发。
    //   顺序是 `act.strike` 的既定形态（`handlers/damage.ts`：`struck` 的触发器
    //   压在这一击自己的 `act.hit` 之上，于是反伤的 `damaged` 先落）。
    expect(eventNames(step.events)).toEqual(["struck", "damaged", "damaged"]);
    expect(damageOf(step.state, striker)).toBe(2); // 挨了一次反伤，就一次
    expect(damageOf(step.state, struck)).toBe(3); // 挨了那一击，没有被反弹回来的第二下

    // ★ 注入实验：给 `hitHandler` 补发一条 `struck`（"反伤也算出手"）。
    //   实测读到 47 条事件 / 23 条 `struck`，两边各挨 22 / 23 点 —— 连锁一路弹到
    //   其中一个被反伤打死才收口，上面三行同时红。
    //   同一注入 + 两边血量调到 1000（谁都死不了）实测抛 `ResolutionLoopError`：
    //   这条连锁本身没有收口点，"打死了才停"只是血条给的偶然上限。
    //   §8.7「天然不会互相触发成连锁」的全部机制就是那条二分：
    //   `act.strike` 发 `struck`、`act.hit` 不发。
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 2. Cleave 命中基地时 `Adjacent` 为空集 ⇒ 静默跳过（IR v1 §5.2）
  // ═════════════════════════════════════════════════════════════════════════

  test("★ Cleave 打进基地：Adjacent(基地) 是空集，act.hit 静默跳过", () => {
    const state = openGame();
    // 对面 0 号格**空着** ⇒ 方向 0 的出手落在敌方基地上（v2 §4.2 第 ② 步）。
    putCard(state, 0, 0, KW_CLEAVE, { atk: 2, health: 9 });
    // 1 号格站一个：基地若被当成"站在某一格上"，它就是那个会被溅射到的邻居。
    const neighbour = putCard(state, 1, 1, PF1_R01, DUMMY);
    const enemyBase = baseIdOf(state, 1);

    const after = fightOnce(state, DEPS);

    expect(damageOf(after.state, enemyBase)).toBe(2);
    // ★ 判别力在这一行：基地不占格（`entity.slot === null`）⇒ `sel.adjacent` 贡献空集
    //   ⇒ 整个 `act.hit` 跳过。去掉 `eval/sel.ts` 里那句 `slot === null` 的跳过之后，
    //   `null` 在算术里当 0 用，基地会被当成"站在 0 号格"，这里读到 1。
    expect(damageOf(after.state, neighbour)).toBe(0);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 3. Siege 打空格时 `IsMinion` 挡住双重计算
  // ═════════════════════════════════════════════════════════════════════════

  test("★ Siege 打空格：伤害本来就进基地，IsMinion 为假 ⇒ 不再额外打一次", () => {
    const state = openGame();
    // 与上面「Siege 1」那条**只差对面那一格**：那里 0 号格站着靶子，这里空着。
    putCard(state, 0, 0, KW_SIEGE, { atk: 2, health: 9 });
    const enemyBase = baseIdOf(state, 1);

    const after = fightOnce(state, DEPS);

    // ★ 恰好 2（= 出手），不是 3（= 出手 + 额外一发）。
    //   `EVENT.target` 是基地，基地的 `cardId` 在卡表里查不到 ⇒ `IsMinion` 不满足。
    //   ★ 实测：把 `Siege()` 里的 `when(IsMinion(...), ...)` 拆掉，这里读到 3；
    //     而正向那条「Siege 1」照绿 —— 所以本条是双重计算的**唯一**防线。
    expect(damageOf(after.state, enemyBase)).toBe(2);
  });
});
