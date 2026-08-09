// 英雄作为**在场实体**的单元测试（M6 的三个条目：`kind:"hero"` 占格参战、
// 新事件 `hero_deployed` / `hero_died`、以及部署与复活的时间线）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 这个条目的全部内容就是一句话：**英雄与随从同规则，区别只在 kind 与死亡去向**
// ═══════════════════════════════════════════════════════════════════════════
// 所以本文件的每条断言都是**对照式**的 —— 盘面上一律同时摆一个英雄与一个随从，
// 断言"该一样的地方一模一样、该不一样的只有那一处"。只测英雄单边的写法对
// 「引擎给英雄开了一条特殊通路」这类 bug 没有判别力，而那正是最容易写出来的错。
//
// 三件被钉住的事，各自对应一种真实的写错方式：
//   1. **有攻血** —— 部署时从卡表把 `data.tags` 写进 `base`/`tags`（`rules/phase.ts`）。
//      不写的话英雄是建局时那个 0/0，一上场就在第一次死亡结算里暴毙
//      （`state/entity.ts` 的血量记账），而症状是"英雄凭空消失"，很难指向部署那一步。
//   2. **按方向出手 / 可被打 / 同时结算** —— 战斗侧一行英雄特判都没有
//      （`rules/combat.ts` 只扫 `state.slots`）。这里测的是"确实没有特判"，
//      于是 direction 也是免费拿到的：它与 atk/health 走同一条卡面管线。
//   3. **死亡去向** —— 英雄进 `fountain`，随从进 `graveyard`（v2.1 §11.3）。
//      连带的一条：`while_source_alive` 的剥离判据必须认得复燃泉，
//      否则死掉的英雄挂在别人身上的 buff 永远剥不掉（`resolve/deaths.ts`）。
//
// 第 4 节是**事件名**那一条（v2.1 §11.3）：英雄的两个专属事件，以及"随从那两个事件
// 不该被英雄惊动"的反面断言。它与前三节共用同一套夹具，所以放在同一个文件里。
//
// 第 5 节是**部署与复活的时间线**（v2.1 §11.3）：排期 `[2, 1]` 的两个回合，
// 以及"阵亡 → 缺席**恰好一整回合** → 回场"。它跨 5 个回合，需要一套自己的夹具
// （三名英雄、一律 0 攻），所以那一节的夹具单独放在它自己的开头。
//
// 第 6 节是**色门与融合卡**（v2.1 §11.4）：`play_card` 要求这张牌的每个颜色都有一名
// 己方存活在场的英雄。它是前五节的**下游** —— 「英雄站在战线上」「阵亡进泉」这两件事
// 正是色门开合的输入，所以放在同一个文件里，夹具也接着用（英雄卡 + `deployHeroes`）。
// 它的最后一条是第 5 节与第 6 节的**交点**（排期 × 色门），理由写在那一条的开头。
//
// 注：本文件**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1）。

import { expect, test } from "bun:test";
import type { Act, Card, CardId, Color, EnchantId, Enchantment, EntityId } from "@prismfront/ir";
import { DEFAULT_DEPS } from "../../handlers/index.ts";
import type { ResolveDeps } from "../../resolve/index.ts";
import type { EntityData, GameState, PlayerId } from "../../state/index.ts";
import { getEntity, getZone, zoneKey } from "../../state/index.ts";
import type { Step } from "../../testkit/index.ts";
import {
  cardDeps,
  damageOf,
  enchantsOf,
  eventNames,
  expectOk,
  fightOnce,
  flagOf,
  handOf,
  makeTestDeck,
  passOnce,
  passThroughCombat,
  putCard,
  putCardInHand,
  putUnit,
  runActs,
  scriptCard,
  setFace,
  setFlag,
  slotOf,
  startMatch,
  tagOf,
} from "../../testkit/index.ts";
import type { ApplyResult, DeployPick } from "../index.ts";
import {
  apply,
  createGame,
  DEFAULT_RULES,
  deployCountFor,
  deployQuotaOf,
  lockedColorsOf,
  needsDeploy,
} from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 两名英雄，卡面数字**两两不同**（3/5 与 2/4）：一份写死的常量或者"抄了另一名英雄的
 * 卡面"这两种写错，都会在断言里露出来。
 *
 * 蓝英雄的 `direction: 1` 是有意的 —— 方向在 IR 里就是一个普通 Tag（v2 §2.3），
 * 它跟 atk/health 一起从 `data.tags` 里出来。写错（部署只挑 atk/health 两个键写）
 * 会让蓝英雄打到正对的那一格上，本文件的战斗那条会红。
 */
const RED_HERO: Card = scriptCard(
  "H_RED",
  {},
  { kind: "hero", colors: ["red"], tags: { atk: 3, health: 5 } },
);
const BLUE_HERO: Card = scriptCard(
  "H_BLUE",
  {},
  { kind: "hero", colors: ["blue"], tags: { atk: 2, health: 4, direction: 1 } },
);

/** 「来源存活期间有效」的 +1 攻附魔 —— 死亡去向影响剥离判据，见文件头第 3 条。 */
const SOURCE_ENCH: Enchantment = {
  id: "E_HERO_SOURCE",
  attachesTo: "hero",
  mods: { atk: 1 },
  duration: "while_source_alive",
};

/** 接了这两张英雄卡与那条附魔的完整 `deps`。不传它 = 引擎不认识任何具体卡。 */
const HERO_DEPS: ResolveDeps = cardDeps([RED_HERO, BLUE_HERO], [SOURCE_ENCH]);

/**
 * 每方两名英雄的卡组外名单（第 1~4 节用；第 5 节的时间线自带一套三名的）。
 *
 * 取 2 名而不是规则里的 3 名（`heroes.perDeck`），是为了让 r1 的排期（`[2, 1]` 的第一项）
 * 一次把泉清空：r2 的 `deployCountFor` 于是为 0、不再进 deploy 相位，
 * 前四节那些断言就不必先应付一个与它们无关的部署选择。
 * 引擎只收「已经合法的 id 列表」（`state/create.ts`），名单长度不受 `perDeck` 约束。
 */
const HERO_NAMES: readonly [readonly CardId[], readonly CardId[]] = [
  [RED_HERO.id, BLUE_HERO.id],
  [RED_HERO.id, BLUE_HERO.id],
];

/** 建一局带英雄的对战，停在第 1 回合的 `deploy` 相位。 */
function heroGame(deps: ResolveDeps = HERO_DEPS): GameState {
  const start = createGame(DEFAULT_RULES, [makeTestDeck("A"), makeTestDeck("B")], 0x11e0, {
    shuffle: false,
    firstPlayer: 0,
    heroes: HERO_NAMES,
  });
  return startMatch(start, deps).state;
}

/**
 * 某方复燃泉里第 `index` 名英雄的实体 id。
 *
 * 读区域列表而不是照 `state/create.ts` 的分配顺序算一个字面量：那个顺序一旦调整，
 * 算出来的 id 会**静默**指向别的实体（多半是一张牌库里的牌），断言随之变得毫无意义。
 */
function heroInFountain(state: GameState, player: PlayerId, index: number): EntityId {
  const id = getZone(state, player, "fountain")[index];
  if (id === undefined) {
    throw new Error(`夹具错误：p${player} 的复燃泉里没有第 ${index} 名英雄`);
  }
  return id;
}

/**
 * 双方按给定格位把泉里的英雄依次部署上场（`slots[p][i]` = 第 i 名英雄站哪一格）。
 *
 * deploy 是**双方聚合后的单条 intent**（v2.1 §11.3），且 `checkDeploy` 要求名数**刚好**，
 * 所以两边必须在同一条意图里一起给齐。
 */
function deployHeroes(
  state: GameState,
  slots: readonly [readonly number[], readonly number[]],
  deps: ResolveDeps = HERO_DEPS,
): Step {
  const pickFor = (player: PlayerId): DeployPick[] =>
    slots[player].map((slot, index) => ({ hero: heroInFountain(state, player, index), slot }));
  return expectOk(apply(state, { t: "deploy", player: 0, picks: [pickFor(0), pickFor(1)] }, deps));
}

/** 打一个具体实体 `amount` 点（`sel.entity` 是 IR v1 §5.6 的运行时超集，测试可用）。 */
function hit(target: EntityId, amount: number): Act {
  return { op: "act.hit", target: { op: "sel.entity", id: target }, amount };
}

/** 给一个具体实体挂一条附魔。 */
function buff(target: EntityId, ench: EnchantId): Act {
  return { op: "act.buff", target: { op: "sel.entity", id: target }, ench };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 有攻血：部署时从卡表写卡面
// ═══════════════════════════════════════════════════════════════════════════

test("部署：英雄带着卡表里的卡面上场，不再是建局时那个 0/0", () => {
  const state = heroGame();
  const red = heroInFountain(state, 0, 0);
  const blue = heroInFountain(state, 0, 1);
  // 建局**不认识任何具体卡**（`state/create.ts` 文件头），泉里的英雄卡面全是 0。
  expect([tagOf(state, red, "atk"), tagOf(state, red, "health")]).toEqual([0, 0]);

  const after = deployHeroes(state, [
    [0, 1],
    [0, 1],
  ]).state;

  // ★ 写错（部署那一步没读卡表）会读到 0/0 —— 而 0 血的英雄会在下一次死亡结算里
  //   凭空消失，症状离"部署"这一步很远。两名英雄的数字不同，抄错一名也会红。
  expect([tagOf(after, red, "atk"), tagOf(after, red, "health")]).toEqual([3, 5]);
  expect([tagOf(after, blue, "atk"), tagOf(after, blue, "health")]).toEqual([2, 4]);
  // 写 `base` 而不是只写 `tags`：`tags` 是派生值，下一次 `refreshAuras` 会从 `base`
  //   重算覆盖（时序规则 4）。只写 `tags` 的话上面两条也绿，但英雄会在第一次重算后归零。
  expect([getEntity(after, red)?.base.atk, getEntity(after, red)?.base.health]).toEqual([3, 5]);
  // 站住了没被判死（`slot` 与墓地一起读：只读其一，"死了但格位没清"照样绿）。
  expect(slotOf(after, red)).toBe(0);
  expect(getZone(after, 0, "graveyard")).toEqual([]);
  expect(after.phase).toBe("actions");
});

test("部署写的是**整份**卡面，不与实体上已有的值合并", () => {
  const state = heroGame();
  const red = heroInFountain(state, 0, 0);
  // 先往实体上写一份与卡表冲突的卡面（复活重部署时，上一条命的残留就是这个形态）。
  setFace(state, red, { atk: 7, health: 9, direction: 4 });

  const after = deployHeroes(state, [
    [0, 1],
    [0, 1],
  ]).state;

  // 写错（逐键合并 / 只覆盖卡表里出现过的键）会读到 7/9 或 direction 4：
  // 红英雄的卡面没有 direction 这一项，它必须被覆盖回 0 而不是留着上一份。
  expect([
    tagOf(after, red, "atk"),
    tagOf(after, red, "health"),
    tagOf(after, red, "direction"),
  ]).toEqual([3, 5, 0]);
});

test("不接卡表：写不出卡面、也认不出英雄 —— 整块退化回 M2~M5 的行为", () => {
  const state = heroGame(DEFAULT_DEPS);
  const red = heroInFountain(state, 0, 0);
  const deployed = deployHeroes(
    state,
    [
      [0, 1],
      [0, 1],
    ],
    DEFAULT_DEPS,
  ).state;

  // `deps.cards` 缺省是 `NO_CARDS`（`eval/context.ts`）⇒ 没有卡面可写。
  // 这不是"出错"而是"引擎不认识任何具体卡"，M2~M5 的全部测试跑的就是这个形态。
  expect([tagOf(deployed, red, "atk"), tagOf(deployed, red, "health")]).toEqual([0, 0]);

  const after = fightOnce(deployed, DEFAULT_DEPS).state;
  // ★ 认不出英雄 ⇒ 0 血的它按**随从**进墓地。写错（把"查不到卡"当成"是英雄"）
  //   会让它进复燃泉 —— 于是不带卡表的老测试会读到一个空墓地。
  expect(getZone(after, 0, "graveyard")).toContain(red);
  expect(getZone(after, 0, "fountain")).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. 参战：按方向出手、可被打，与随从同一套同时结算（v2 §4.2）
// ═══════════════════════════════════════════════════════════════════════════

test("战斗：英雄与随从对轰同时结算，方向照 tags.direction 走", () => {
  const state = heroGame();
  const red = heroInFountain(state, 0, 0);
  const blue = heroInFountain(state, 0, 1);
  // p0：红英雄（3/5，direction 0）站 0 号格、蓝英雄（2/4，direction 1）站 4 号格。
  // p1：两名英雄摆到 7、8 号格上，正对的是空格 ⇒ 它们只打 p0 的基地，不搅进下面的读数。
  const deployed = deployHeroes(state, [
    [0, 4],
    [7, 8],
  ]).state;

  // 正对红英雄的随从：双向对轰的另一半。
  const brawler = putUnit(deployed, 1, 0, { atk: 2, health: 9 });
  // 蓝英雄 direction=1 的落点（0 攻 ⇒ 它不出手，于是英雄身上的伤害只可能来自 brawler）。
  const dummy = putUnit(deployed, 1, 5, { atk: 0, health: 9 });
  const after = fightOnce(deployed, HERO_DEPS).state;

  // ★ 同时结算（v2 §4.2 第 ②③ 步）：双方按同一份快照各挨一下，没有先后。
  //   写错（英雄不进快照）会读到 brawler 毫发无伤；写错（英雄不可被打）会读到英雄 0 伤。
  expect(damageOf(after, red)).toBe(2);
  expect(damageOf(after, brawler)).toBe(3);
  // ★ 按方向出手：蓝英雄打的是敌方 **5** 号格，不是正对的 4 号格。
  //   写错（部署没写 direction / 战斗给英雄加了特判）会读到 0 —— 那一击落进了 p1 的基地。
  expect(damageOf(after, dummy)).toBe(2);
  // 两名英雄都活着，且还站在原来的格上（战斗不该顺手挪动谁）。
  expect([slotOf(after, red), slotOf(after, blue)]).toEqual([0, 4]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. 死亡去向：英雄进复燃泉，随从进墓地（v2.1 §11.3）
// ═══════════════════════════════════════════════════════════════════════════

test("阵亡：英雄进复燃泉、随从进墓地 —— 同一波结算里的唯一区别", () => {
  const state = heroGame();
  const red = heroInFountain(state, 0, 0);
  const blue = heroInFountain(state, 0, 1);
  const deployed = deployHeroes(state, [
    [0, 1],
    [7, 8],
  ]).state;

  // 一个与红英雄**同一波**致死的随从：对照组，它必须照旧进墓地。
  const chaff = putUnit(deployed, 0, 2, { atk: 0, health: 1 });
  putUnit(deployed, 1, 0, { atk: 9, health: 9 }); // 打死红英雄（5 血）
  putUnit(deployed, 1, 2, { atk: 9, health: 9 }); // 打死 chaff
  const after = fightOnce(deployed, HERO_DEPS).state;

  // ★ 写错（英雄分支没接）会读到 graveyard = [red, chaff]、fountain = []。
  //   ★ 写错（判据取反 / 把全部死者都塞进泉）会读到 fountain = [red, chaff]。
  expect(getZone(after, 0, "fountain")).toEqual([red]);
  expect(getZone(after, 0, "graveyard")).toEqual([chaff]);
  // 位置一致性：离场就得腾格、清 `slot`、改 `zone`，三处一起读（漏一处就是盘面分叉）。
  expect(after.slots[0][0]).toBeNull();
  expect(getEntity(after, red)?.slot).toBeNull();
  expect(getEntity(after, red)?.zone).toBe(zoneKey(0, "fountain"));
  // 没被顺手波及：活着的蓝英雄还站在 1 号格上。
  expect(slotOf(after, blue)).toBe(1);
});

test("阵亡的英雄进的是泉，`while_source_alive` 照样剥离", () => {
  const state = heroGame();
  const red = heroInFountain(state, 0, 0);
  const deployed = deployHeroes(state, [
    [0, 1],
    [7, 8],
  ]).state;
  // 0 攻的靶子 ⇒ 它的生效 atk 就是"还挂着几条 +1 攻的附魔"。
  const ally = putUnit(deployed, 0, 3, { atk: 0, health: 9 });
  const buffed = runActs(deployed, [buff(ally, SOURCE_ENCH.id)], red, HERO_DEPS).state;
  expect(tagOf(buffed, ally, "atk")).toBe(1);

  const after = runActs(buffed, [hit(red, 9)], ally, HERO_DEPS).state;

  expect(getZone(after, 0, "fountain")).toEqual([red]);
  // ★ 写错（剥离判据只认墓地）会读到 ["E_HERO_SOURCE"] / atk 1：一名死掉的英雄给别人
  //   挂的 buff 永远剥不掉。而且这个 bug **只在带卡表的对局里**显形 —— 不带卡表时
  //   英雄照旧进墓地，判据碰巧成立，所以它躲得过 M2~M5 的全部测试。
  expect(enchantsOf(after, ally)).toEqual([]);
  expect(tagOf(after, ally, "atk")).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. 事件：hero_deployed / hero_died —— 触发器必须区分得开（v2.1 §11.3）
// ═══════════════════════════════════════════════════════════════════════════
// 这一条要挡的**不是**"英雄没有事件"，而是**既有的卡被误触发**：「每当一个单位死亡…」
// 从 M5 起就写得出来了，英雄阵亡若也发 `unit_died`，那类卡的读数会凭空多出几次，
// 且多出的次数随对局进程漂移（英雄死得越多漂得越远），事后极难归因。
//
// ★ 判别力全在**事件名**上，不在"响了几条"上：下面第二条测试的盘面里两个观察者
//   各自会响一次，无论引擎发的是哪个名字，抽牌数都是 1。只有名字断得出对错。

/** 观察者的效果取"抽一张"：0 攻的它们不会搅进战斗，而抽牌数是个干净的读数。 */
const DRAW_ONE: Act = { op: "act.draw", player: { op: "sel.controller" } };

/** 「每当一个单位死亡」—— M5 起就写得出的既有卡形态。英雄阵亡**不该**惊动它。 */
const WATCH_UNIT_DIED: Card = scriptCard("T_ON_UNIT_DIED", {
  triggers: [{ on: "unit_died", zone: "board", do: [DRAW_ONE] }],
});
/** 「每当一名英雄阵亡」—— 新事件的订阅方。与上面那张只差一个 `on`。 */
const WATCH_HERO_DIED: Card = scriptCard("T_ON_HERO_DIED", {
  triggers: [{ on: "hero_died", zone: "board", do: [DRAW_ONE] }],
});
/** 「每当一个单位上场」—— 英雄部署**不该**惊动它（部署发的是 `hero_deployed`）。 */
const WATCH_SUMMONED: Card = scriptCard("T_ON_SUMMONED", {
  triggers: [{ on: "unit_summoned", zone: "board", do: [DRAW_ONE] }],
});
/** 「每当一名英雄部署」。 */
const WATCH_HERO_DEPLOYED: Card = scriptCard("T_ON_HERO_DEPLOYED", {
  triggers: [{ on: "hero_deployed", zone: "board", do: [DRAW_ONE] }],
});

/** 四张观察者卡都接进来的 `deps`（英雄卡与那条附魔照旧要在，否则英雄认不出来）。 */
const WATCH_DEPS: ResolveDeps = cardDeps(
  [RED_HERO, BLUE_HERO, WATCH_UNIT_DIED, WATCH_HERO_DIED, WATCH_SUMMONED, WATCH_HERO_DEPLOYED],
  [SOURCE_ENCH],
);

test("阵亡：英雄发 hero_died（带 respawnAt），随从发 unit_died —— 同一发致死动作", () => {
  const state = heroGame();
  const red = heroInFountain(state, 0, 0);
  const deployed = deployHeroes(state, [
    [0, 1],
    [7, 8],
  ]).state;
  // 对照组：同一侧、同样被一发 9 点打死的随从。两次结算只差"死的是谁"。
  const chaff = putUnit(deployed, 0, 2, { atk: 0, health: 1 });

  const heroStep = runActs(deployed, [hit(red, 9)], chaff, HERO_DEPS);
  const minionStep = runActs(deployed, [hit(chaff, 9)], red, HERO_DEPS);

  // ★ 写错（英雄照发 unit_died）会让上下两行读到同一个名字 —— 而"每当一个单位死亡"
  //   的既有卡正是靠这个名字数数的。
  expect(eventNames(heroStep.events)).toEqual(["damaged", "hero_died"]);
  expect(eventNames(minionStep.events)).toEqual(["damaged", "unit_died"]);
  // 负载：`slot` 是它死在哪一格（搬走之后就问不到了），`respawnAt` 是复活回合。
  // ★ r1 阵亡 ⇒ 1 + 1 + respawnDelay(1) = 3：缺席 r2 一整回合，r3 的 deploy 相位回来。
  //   两种典型错法在这里读到别的数：`+2+delay`（缺席两回合）给 4、`+delay`（当场就能回）给 2。
  expect(deployed.round).toBe(1);
  expect(heroStep.events[1]).toEqual({ name: "hero_died", target: red, slot: 0, respawnAt: 3 });
  expect(minionStep.events[1]).toEqual({ name: "unit_died", target: chaff, slot: 2 });
  // ★ 事件流与状态必须说同一个数：客户端拿到的是事件流并据此重放自己那份状态（M7 投影），
  //   两边分叉的话，要等好几个回合后的 deploy 相位才显形。
  expect(getEntity(heroStep.state, red)?.respawnAt).toBe(3);
});

test("订阅 unit_died 的触发器不被英雄阵亡惊动，订阅 hero_died 的才响", () => {
  const state = heroGame(WATCH_DEPS);
  const red = heroInFountain(state, 0, 0);
  const deployed = deployHeroes(
    state,
    [
      [0, 1],
      [7, 8],
    ],
    WATCH_DEPS,
  ).state;
  // 两个观察者**同时**在场：每次死亡恰好该响一个，于是抽牌数恒为 1、断不出对错，
  // 判别力全落在事件名上（见本节开头）。
  putCard(deployed, 0, 2, WATCH_UNIT_DIED, { atk: 0, health: 9 });
  putCard(deployed, 0, 3, WATCH_HERO_DIED, { atk: 0, health: 9 });
  const chaff = putUnit(deployed, 0, 4, { atk: 0, health: 1 });
  const before = handOf(deployed, 0).length;

  const minion = runActs(deployed, [hit(chaff, 9)], chaff, WATCH_DEPS);
  const hero = runActs(deployed, [hit(red, 9)], chaff, WATCH_DEPS);

  // 随从死 ⇒ `unit_died` 那个观察者响（`card_drawn` 排在死亡事件**之后**：触发只入栈，
  // 时序规则 2）。这一行同时证明整条链是通的 —— 下面那行的"没多响"才不是假绿。
  expect(eventNames(minion.events)).toEqual(["damaged", "unit_died", "card_drawn"]);
  expect(handOf(minion.state, 0).length).toBe(before + 1);
  // ★ 英雄死 ⇒ 换成 `hero_died` 那个观察者响。写错（英雄照发 unit_died）会读到
  //   `unit_died` —— 而抽牌数**一模一样**（只是换了个观察者），所以条数掩盖不了它。
  expect(eventNames(hero.events)).toEqual(["damaged", "hero_died", "card_drawn"]);
  expect(handOf(hero.state, 0).length).toBe(before + 1);
});

test("部署：发的是 hero_deployed 且触发器订阅得到，「单位上场时」一条都不响", () => {
  const state = heroGame(WATCH_DEPS);
  putCard(state, 0, 2, WATCH_HERO_DEPLOYED, { atk: 0, health: 9 });
  putCard(state, 0, 3, WATCH_SUMMONED, { atk: 0, health: 9 });
  const before = handOf(state, 0).length;

  const step = deployHeroes(
    state,
    [
      [0, 1],
      [7, 8],
    ],
    WATCH_DEPS,
  );

  // 双方各 2 名 ⇒ 4 条 `hero_deployed`，一条 `unit_summoned` 都没有。
  // ★ 后面 4 条 `card_drawn` 证明**相位机产的事件也进触发器**（`rules/phase.ts` 的
  //   `runStep` 先排队后压栈 ⇒ 触发器一律排在这一步自己发的事件之后）。
  //   写错（部署改发 unit_summoned）会让响的换成另一个观察者，但事件名会在这里露出来。
  expect(eventNames(step.events)).toEqual([
    "hero_deployed",
    "hero_deployed",
    "hero_deployed",
    "hero_deployed",
    "card_drawn",
    "card_drawn",
    "card_drawn",
    "card_drawn",
  ]);
  expect(handOf(step.state, 0).length).toBe(before + 4);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. 部署与复活的时间线（v2.1 §11.3）
// ═══════════════════════════════════════════════════════════════════════════
// 两件事，都只在**跨回合**的尺度上才看得见，所以这一节的每条测试都要走好几个回合：
//   1. **排期** `deploySchedule: [2, 1]` —— r1 部署 2 名、r2 部署第 3 名，之后不再进
//      deploy 相位（索引 = 第几个回合、值 = 该回合几名，架构 §10 第 6 项）。
//   2. **复活** —— 阵亡 → 复燃泉，`respawnAt = 当前回合 + 1 + respawnDelay`，
//      也就是**缺席恰好一整回合**：r3 阵亡的英雄在 **r5** 的 deploy 相位回来。
//
// ★ 「恰好一整回合」是这一节全部的重点。两种错法各差一个回合，而且都**跑得起来、
//   看起来也挺合理**：`+2+delay` 让它缺席 r4/r5 两回合（r6 才回来），
//   `+delay` 让它当场就能回（r4 就回来）。所以下面不只断言"r5 回来了"，
//   还要断言"**r4 根本没有 deploy 相位**、它那一整个回合都躺在泉里"——
//   只断言前者的话，`+delay` 那种错法照样绿（r4 回来的英雄 r5 当然也在场上）。

/**
 * 时间线专用的三名英雄（`heroes.perDeck` 的默认值）。
 *
 * 三名一律 **0 攻**：这一节要连着推进四五次战斗相位，让英雄互相打起来会把
 * "谁在哪一回合回来"与"谁又被谁打死了"两件事搅在一起，断言就再也指不准原因。
 * 致死一律用 `act.hit` 显式打（第 3/4 节的路子）。血量 5/6/7 两两不同 ——
 * 卡面抄错一名会在断言里露出来。
 */
const TRIO_HEROES: readonly Card[] = [
  scriptCard("H_T1", {}, { kind: "hero", colors: ["red"], tags: { health: 5 } }),
  scriptCard("H_T2", {}, { kind: "hero", colors: ["blue"], tags: { health: 6 } }),
  scriptCard("H_T3", {}, { kind: "hero", colors: ["green"], tags: { health: 7 } }),
];

/**
 * 一条**永久**附魔（+2 攻）。它是"上一条命的残留会不会跟着回场"这条断言的载体：
 * `while_source_alive` 那条会在来源阵亡时自己剥掉（第 3 节），`permanent` 不会 ——
 * 只有回场那一步显式清，它才会消失。
 */
const PERM_ENCH: Enchantment = {
  id: "E_PERM",
  attachesTo: "hero",
  mods: { atk: 2 },
  duration: "permanent",
};

const TRIO_DEPS: ResolveDeps = cardDeps(TRIO_HEROES, [PERM_ENCH]);

const TRIO_NAMES: readonly [readonly CardId[], readonly CardId[]] = [
  TRIO_HEROES.map((card) => card.id),
  TRIO_HEROES.map((card) => card.id),
];

/** 建一局每方三名英雄的对战，停在第 1 回合的 `deploy` 相位。 */
function trioGame(): GameState {
  const start = createGame(DEFAULT_RULES, [makeTestDeck("A"), makeTestDeck("B")], 0x71e5, {
    shuffle: false,
    firstPlayer: 0,
    heroes: TRIO_NAMES,
  });
  return startMatch(start, TRIO_DEPS).state;
}

/** 推进到下一个回合的第一个等待相位（`deploy` 或 `actions`）。 */
function toNextRound(state: GameState): GameState {
  return passThroughCombat(state, TRIO_DEPS).state;
}

/**
 * 走完整张排期表：r1 上两名、r2 上第三名，停在 **r3 的 `actions` 相位**，
 * 双方各三名英雄在场（p0 站 0/1/2 号格）。
 *
 * 返回 p0 三名英雄与 p1 第一名英雄的实体 id —— 后者只当"打人的那个 `ctx.self`"用，
 * 免得测试里出现"英雄自己打死自己"这种会让人多想一步的盘面。
 */
function deployedTrio(): { state: GameState; heroes: readonly EntityId[]; foe: EntityId } {
  const r1 = trioGame();
  const heroes = [0, 1, 2].map((index) => heroInFountain(r1, 0, index));
  const foe = heroInFountain(r1, 1, 0);
  const afterR1 = deployHeroes(
    r1,
    [
      [0, 1],
      [0, 1],
    ],
    TRIO_DEPS,
  ).state;
  const r2 = toNextRound(afterR1);
  const afterR2 = deployHeroes(r2, [[2], [2]], TRIO_DEPS).state;
  const state = toNextRound(afterR2);
  if (state.round !== 3 || state.phase !== "actions") {
    throw new Error(
      `夹具错误：走完排期该停在 r3 的 actions（round=${state.round} ${state.phase}）`,
    );
  }
  return { state, heroes, foe };
}

/**
 * 取一串实体 id 里的第 `index` 个（`deployedTrio` 给的英雄按泉里的顺序 = 部署顺序）。
 *
 * 有这个小夹具只因为 `noUncheckedIndexedAccess`：下标读出来是 `EntityId | undefined`，
 * 而测试里用 `!` 抹掉它，会让"夹具本身摆错了"表现成某条断言莫名其妙地红。
 */
function idAt(ids: readonly EntityId[], index: number): EntityId {
  const id = ids[index];
  if (id === undefined) {
    throw new Error(`夹具错误：这一串里没有第 ${index} 个实体`);
  }
  return id;
}

test("排期：r1 部署 2 名、r2 部署第 3 名，r3 起不再进 deploy 相位", () => {
  const r1 = trioGame();
  const first = heroInFountain(r1, 0, 0);
  const second = heroInFountain(r1, 0, 1);
  const third = heroInFountain(r1, 0, 2);
  // ★ `deploySchedule[0]`。写错（读成 `perDeck` 一次全上、或恒定 1 名）在这里就红。
  expect([r1.round, r1.phase, deployQuotaOf(r1), deployCountFor(r1, 0)]).toEqual([
    1,
    "deploy",
    2,
    2,
  ]);

  const afterR1 = deployHeroes(
    r1,
    [
      [0, 1],
      [0, 1],
    ],
    TRIO_DEPS,
  ).state;
  expect([slotOf(afterR1, first), slotOf(afterR1, second)]).toEqual([0, 1]);
  // 第 3 名**留在泉里**：r1 的排期只有 2 名，泉里有 3 名可用也不多上。
  expect(getZone(afterR1, 0, "fountain")).toEqual([third]);

  const r2 = toNextRound(afterR1);
  // ★ `deploySchedule[1]`：第 3 名在 r2 上，而不是 r1 一次上齐、也不是拖到 r3。
  expect([r2.round, r2.phase, deployQuotaOf(r2), deployCountFor(r2, 0)]).toEqual([
    2,
    "deploy",
    1,
    1,
  ]);

  const afterR2 = deployHeroes(r2, [[2], [2]], TRIO_DEPS).state;
  expect(slotOf(afterR2, third)).toBe(2);
  expect(getZone(afterR2, 0, "fountain")).toEqual([]);

  const r3 = toNextRound(afterR2);
  // 排期只有两项 ⇒ r3 起既没有名额、泉里也没人 ⇒ **根本不进** deploy 相位
  // （`needsDeploy` 读的是同一个名数，所以这里读到的 `actions` 就是那条判据的结果）。
  expect([r3.round, r3.phase, deployQuotaOf(r3), deployCountFor(r3, 0)]).toEqual([
    3,
    "actions",
    0,
    0,
  ]);
});

test("★ 复活：r3 阵亡的英雄在 r5 的 deploy 相位回归 —— 恰好缺席 r4 一整回合", () => {
  const { state, heroes, foe } = deployedTrio();
  const fallen = idAt(heroes, 0);

  const dead = runActs(state, [hit(fallen, 9)], foe, TRIO_DEPS).state;
  // 阵亡那一侧（第 4 节已逐字钉过）：进泉 + 写 `respawnAt = 3 + 1 + respawnDelay(1)`。
  expect(getZone(dead, 0, "fountain")).toEqual([fallen]);
  expect(getEntity(dead, fallen)?.respawnAt).toBe(5);
  expect(dead.slots[0][0]).toBeNull();

  const r4 = toNextRound(dead);
  // ★ 缺席的那一整个回合：r4 **连 deploy 相位都不出现**，英雄整回合躺在泉里。
  //   写错（`respawnAt = 回合 + respawnDelay` ⇒ 4）会让这一行读到 `deploy` / 1 / false ——
  //   而那种错法在下面 r5 的断言里是**看不出来**的（r4 就回来的英雄，r5 当然也在场上）。
  expect([r4.round, r4.phase, deployCountFor(r4, 0), needsDeploy(r4)]).toEqual([
    4,
    "actions",
    0,
    false,
  ]);
  expect(getZone(r4, 0, "fountain")).toEqual([fallen]);

  const r5 = toNextRound(r4);
  // ★ 回来的那一回合。写错（`回合 + 2 + delay` ⇒ 6）会让这里还是 `actions`。
  expect([r5.round, r5.phase, needsDeploy(r5)]).toEqual([5, "deploy", true]);
  // ★ 名额**不来自排期**：排期表 r3 起恒为 0，来的是复活那一支。
  //   写错（把复活也塞进 `min(排期, …)`）会让 `deployCountFor` 读到 0 ——
  //   于是英雄永远回不来，而症状看起来像 `respawnAt` 算错，离真正的错处很远。
  expect([deployQuotaOf(r5), deployCountFor(r5, 0), deployCountFor(r5, 1)]).toEqual([0, 1, 0]);

  // 回场时**重新选格**（v2.1 §11.3）：不必是它死时那一格。
  const back = deployHeroes(r5, [[4], []], TRIO_DEPS).state;
  expect([slotOf(back, fallen), back.phase]).toEqual([4, "actions"]);
  expect(getZone(back, 0, "fountain")).toEqual([]);
  // 上场即不再等待复活；三名英雄又都在场上了。
  expect(getEntity(back, fallen)?.respawnAt).toBeNull();
  expect([slotOf(back, idAt(heroes, 1)), slotOf(back, idAt(heroes, 2))]).toEqual([1, 2]);
});

test("复活重部署：伤害 / 附魔 / 标志位都不跟过来（`firedOnce` 是唯一例外）", () => {
  const { state, heroes, foe } = deployedTrio();
  const fallen = idAt(heroes, 0);

  // 死之前先给它攒一身"上一条命的残留"：一条永久附魔 + 3 点非致死伤害 + 一个卡面标志位。
  const scarred = runActs(
    state,
    [buff(fallen, PERM_ENCH.id), hit(fallen, 3)],
    foe,
    TRIO_DEPS,
  ).state;
  setFlag(scarred, fallen, "silenced");
  // `firedOnce` 没有 act 能写它（它由 `resolve/triggers.ts` 在 `once` 触发器烧掉时记账），
  // 所以照 `setFlag` 的路子直接摆状态 —— 本条测的是"回场那一步清不清它"，
  // 不是"它当初是怎么被记上的"。
  entityOf(scarred, fallen).firedOnce = ["T_ONCE"];
  expect([tagOf(scarred, fallen, "atk"), damageOf(scarred, fallen)]).toEqual([2, 3]);

  const dead = runActs(scarred, [hit(fallen, 9)], foe, TRIO_DEPS).state;
  // 入泉那一步**什么都不清**（`resolve/deaths.ts` 只搬区域、只写 `respawnAt`）——
  // 清理落在回场那一步，这一行钉住的就是这个分工。
  expect([damageOf(dead, fallen), enchantsOf(dead, fallen)]).toEqual([12, [PERM_ENCH.id]]);

  const r5 = toNextRound(toNextRound(dead));
  const back = deployHeroes(r5, [[4], []], TRIO_DEPS).state;

  // ★ `damage` 不清 ⇒ 12 点伤害压着 5 点血量的卡面，回场即处于致死状态。
  expect(damageOf(back, fallen)).toBe(0);
  // ★ 附魔不清 ⇒ atk 读到 2：一名死过的英雄会带着上一条命的加成回来，
  //   于是"阵亡"变成一件带收益的事（§11.3 的方向恰恰相反：缺席一整回合是惩罚）。
  expect(enchantsOf(back, fallen)).toEqual([]);
  expect([tagOf(back, fallen, "atk"), tagOf(back, fallen, "health")]).toEqual([0, 5]);
  // 标志位同理：被沉默/滞光的那一条命结束了，回场的是干净的卡面。
  expect(flagOf(back, fallen, "silenced")).toBe(false);
  // ★ `firedOnce` 是三项清理里**唯一的例外**，这一行就是为了钉住那个不对称 ——
  //   否则下一个人会以「三项都清了，这项漏了」为由顺手把它一起清掉，而那是**改规则**：
  //   清掉等于让阵亡刷新一次性能力，把惩罚（缺席一整回合 + 该色牌锁定）变成收益。
  //   取舍与理由写在 `rules/phase.ts` 的 `applyDeploy` 文档注释里。
  expect(entityOf(back, fallen).firedOnce).toEqual(["T_ONCE"]);

  // ★ 上面那几条都是"当下"的读数，这一条是**后果**：带着 12 点伤害回场的英雄，
  //   会在本回合战斗的死亡结算里当场再死一次 —— 于是它根本不在 4 号格上，而是回到了泉里。
  const r6 = toNextRound(back);
  expect(slotOf(r6, fallen)).toBe(4);
  expect(getZone(r6, 0, "fountain")).toEqual([]);
});

test("复活回场同受空格约束：战线站满就等下一回合", () => {
  const { state, heroes, foe } = deployedTrio();
  const fallen = idAt(heroes, 0);
  const dead = runActs(state, [hit(fallen, 9)], foe, TRIO_DEPS).state;

  // 缺席期间把 p0 的战线站满（0 攻，免得搅进战斗）：0 号格是它死时腾出来的那一格。
  const blockers = [0, 3, 4, 5, 6, 7, 8].map((slot) =>
    putUnit(dead, 0, slot, { atk: 0, health: 9 }),
  );
  const r5 = toNextRound(toNextRound(dead));

  // ★ `respawnAt` 到期了，但**没地方站** ⇒ 这一回合上不了场，也就不进 deploy 相位。
  //   这是规则结果不是要绕过的限制：名数由 min(…, 空格数) 给（`rules/phase.ts`）。
  expect([r5.round, r5.phase, deployCountFor(r5, 0)]).toEqual([5, "actions", 0]);
  expect(getZone(r5, 0, "fountain")).toEqual([fallen]);

  // 腾出一格，下一回合它就回来了 —— 它一直排在队里，不是被"过期作废"了。
  const freed = runActs(r5, [hit(idAt(blockers, 0), 9)], foe, TRIO_DEPS).state;
  const r6 = toNextRound(freed);
  expect([r6.round, r6.phase, deployCountFor(r6, 0)]).toEqual([6, "deploy", 1]);
  const back = deployHeroes(r6, [[0], []], TRIO_DEPS).state;
  expect(slotOf(back, fallen)).toBe(0);
});

// ★ 上面几条全部跑在 `respawnDelay: 1`（PF1 默认）上，于是有两处**只有非默认配置才走得到**
//   的分支一直没被执行，两处都能在全绿的情况下被改坏：
//     1. `resolve/deaths.ts` 的 `当前回合 + 1 + respawnDelay` —— 写死成 `回合 + 2`
//        在默认配置下逐字等价，config 驱动的那一半等于没测；
//     2. `rules/phase.ts` 的 `min(排期名额 + 复活名额, 空格数)` —— 该函数注释花了整段论证
//        「必须相加、不能取大」，而默认配置下两支永不同时非零（排期 r1/r2 走完，
//        而任何阵亡最早也要 r3 才到期），改成 `max` 照样全绿。
//   `respawnDelay: 0` 一次把两处都拉进可达范围：r1 阵亡的英雄 r2 就回来，
//   正好撞上排期表里第三名那一格。
test("★ respawnDelay: 0 —— 复活公式读配置，且 r2 的排期名额与复活名额相加不取大", () => {
  const rules = {
    ...DEFAULT_RULES,
    heroes: { ...DEFAULT_RULES.heroes, respawnDelay: 0 },
  };
  const start = createGame(rules, [makeTestDeck("A"), makeTestDeck("B")], 0x9d00, {
    shuffle: false,
    firstPlayer: 0,
    heroes: TRIO_NAMES,
  });
  const r1 = startMatch(start, TRIO_DEPS).state;
  const fallen = heroInFountain(r1, 0, 0);
  const foe = heroInFountain(r1, 1, 0);
  const afterR1 = deployHeroes(
    r1,
    [
      [0, 1],
      [0, 1],
    ],
    TRIO_DEPS,
  ).state;

  const dead = runActs(afterR1, [hit(fallen, 9)], foe, TRIO_DEPS).state;
  // ★ `1 + 1 + respawnDelay(0)` = 2。写死成 `回合 + 2` 会读到 3 —— 那种写法在
  //   默认配置的全部测试里都是对的，只有这一行分得开它。
  expect(getEntity(dead, fallen)?.respawnAt).toBe(2);

  const r2 = toNextRound(dead);
  // 泉里此刻**两种英雄各一名**：没上过场的第三名（受排期约束）与刚回来的那名（不受）。
  // 顺序 = 入泉顺序：第三名一直躺着，阵亡那名是后进来的。
  expect(getZone(r2, 0, "fountain")).toEqual([heroInFountain(r2, 0, 0), fallen]);
  // ★ 判别力全在这一行：排期给 1 名、复活给 1 名，**两支相加 = 2**。
  //   改成 `max(排期, 复活)` 会读到 1 —— 于是两名里有一名被静默挤掉，
  //   而挤掉哪一名取决于遍历顺序，症状是"某名英雄莫名其妙晚一回合才上场"。
  expect([r2.round, r2.phase, deployQuotaOf(r2), deployCountFor(r2, 0)]).toEqual([
    2,
    "deploy",
    1,
    2,
  ]);
  // ★ 对照组：p1 没死过人，同一个排期名额下只有 1 名 —— `1 + 0` 与 `max(1, 0)` 在这里
  //   读数相同。两行并排才说明 p0 的那个 2 确实来自"相加"，不是来自排期本身变大了。
  expect(deployCountFor(r2, 1)).toBe(1);

  const back = deployHeroes(r2, [[2, 3], [2]], TRIO_DEPS).state;
  // 两名同一回合一起上场，泉清空；复活那名的 `respawnAt` 归位。
  expect(getZone(back, 0, "fountain")).toEqual([]);
  expect(slotOf(back, fallen)).toBe(3);
  expect(getEntity(back, fallen)?.respawnAt).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. 色门与融合卡（v2.1 §11.4）
// ═══════════════════════════════════════════════════════════════════════════
// 规则一句话：**这张牌的每个颜色，都要有一名己方存活在场的英雄**。
// 于是"英雄阵亡缺席期间该色牌全部锁定"不是一条额外规则，而是这条判据的推论 ——
// 躺在复燃泉里的英雄不在战线上，它的颜色也就不再开着。
//
// 这一节要挡住三种各自都**跑得起来、也各自都能在 PF1 上全绿**的写错：
//   1. **按归属判**（"这张牌所属的英雄在不在场"）—— PF1 每色恰好一名英雄，
//      它与正确实现逐字等价，要"同色两名英雄"的盘面才分得开（第 4 条测试，
//      也是 M6 必守点点名的那个坑）。
//   2. **按阵亡去算锁哪几色**（读"死了谁"而不是读"谁还站着"）—— 同样只在
//      同色两名英雄时才分得开：死一名、另一名还在，那种写法会把红锁上。
//   3. **要求一名英雄独自覆盖整张牌的颜色** —— 在单色牌上完全正确，
//      只有融合卡分得开（第 3 条测试：红英雄 + 蓝英雄两名**不同**的英雄）。
// 所以本节的每条测试都写成"改一个变量、其余全不动"的对照，且都同时断言
// **端到端的 `apply` 回执**与**结构化的 `lockedColorsOf`** —— 后者是 M7 legalActions
// 要复用的那一份，只测前者的话它可以永远返回一个空数组也全绿。

/**
 * 三张只有**颜色**不同的 0 费随从：红 / 蓝 / 红蓝融合。
 *
 * 0 费是为了把水晶这个变量从本节全部断言里去掉（唯一一处要它的地方显式改 `cost`）；
 * 9 血是为了让"打出去了"能靠"它站在那一格上"来断言 —— 0 血的牌一上场就被判死，
 * 那时 `ok:true` 与"牌没打出去"在盘面上长得一模一样。
 */
const RED_CARD: Card = scriptCard("C_RED", {}, { colors: ["red"], cost: 0, tags: { health: 9 } });
const BLUE_CARD: Card = scriptCard(
  "C_BLUE",
  {},
  { colors: ["blue"], cost: 0, tags: { health: 9 } },
);
/** ★ 融合卡 = `colors` 长度 2（v2.1 §11.4）。引擎里没有、也不该有"融合卡"这个分支。 */
const FUSION_CARD: Card = scriptCard(
  "C_FUSION",
  {},
  { colors: ["red", "blue"], cost: 0, tags: { health: 9 } },
);

/** 红/蓝两名英雄 + 上面三张牌。附魔照旧接着，免得与 1~4 节的夹具在别处不一致。 */
const GATE_DEPS: ResolveDeps = cardDeps(
  [RED_HERO, BLUE_HERO, RED_CARD, BLUE_CARD, FUSION_CARD],
  [SOURCE_ENCH],
);

/** 本节的盘面：双方英雄已上场（p0 红 0 号格 / 蓝 1 号格），p0 手里握着那三张牌。 */
interface GateBoard {
  readonly state: GameState;
  /** p0 的红英雄（0 号格）。 */
  readonly red: EntityId;
  /** p0 的蓝英雄（1 号格）。 */
  readonly blue: EntityId;
  /** p1 的一名英雄，只当"打人的那个 `ctx.self`"用（免得出现英雄自己打死自己的盘面）。 */
  readonly foe: EntityId;
  readonly hand: { readonly red: EntityId; readonly blue: EntityId; readonly fusion: EntityId };
}

/** 建一局停在 r1 `actions` 相位、双方各两名英雄在场的对战。 */
function gateGame(): GateBoard {
  const start = heroGame(GATE_DEPS);
  const red = heroInFountain(start, 0, 0);
  const blue = heroInFountain(start, 0, 1);
  const foe = heroInFountain(start, 1, 0);
  // p1 的两名摆到 7/8 号格：它们正对的是空格，只打 p0 的基地，不搅进本节的读数。
  const state = deployHeroes(
    start,
    [
      [0, 1],
      [7, 8],
    ],
    GATE_DEPS,
  ).state;
  return {
    state,
    red,
    blue,
    foe,
    hand: {
      red: putCardInHand(state, 0, RED_CARD),
      blue: putCardInHand(state, 0, BLUE_CARD),
      fusion: putCardInHand(state, 0, FUSION_CARD),
    },
  };
}

/** p0 试着打出手里的一张牌。**不** `expectOk` —— 本节大半断言的正是"被拒了"。 */
function tryPlay(
  state: GameState,
  card: EntityId,
  slot: number,
  deps: ResolveDeps = GATE_DEPS,
): ApplyResult {
  return apply(state, { t: "play_card", player: 0, card, slot }, deps);
}

/**
 * 断言这张牌打得出来，**且真的落到了那一格上**。
 *
 * 多断一行落点是因为：色门是**校验层**的事，而"这张牌上没上场"是**结算层**的结果。
 * 只断 `ok:true` 的话，一个"校验放行了、效果段却没把牌搬上去"的实现照样全绿，
 * 而那正是本节几条"门开着"的对照断言想排除的另一种可能。
 */
function expectPlayable(
  state: GameState,
  card: EntityId,
  slot: number,
  deps: ResolveDeps = GATE_DEPS,
): void {
  const step = expectOk(tryPlay(state, card, slot, deps));
  expect(slotOf(step.state, card)).toBe(slot);
}

/**
 * 取一个一定存在的实体 —— `lockedColorsOf` 收的是**实体**（M7 遍历手牌时手里就是实体，
 * 不必为每张牌再查一次表），而 `getEntity` 的返回带 `undefined`。
 */
function entityOf(state: GameState, id: EntityId): EntityData {
  const entity = getEntity(state, id);
  if (entity === undefined) {
    throw new Error(`夹具错误：实体 ${id} 不存在`);
  }
  return entity;
}

/** p0 打出这张牌还缺哪些颜色（结构化的那一份拒绝原因）。 */
function missingColors(
  state: GameState,
  card: EntityId,
  deps: ResolveDeps = GATE_DEPS,
): readonly Color[] {
  return lockedColorsOf(state, 0, entityOf(state, card), deps.cards);
}

test("★ 红英雄阵亡后，该回合起红色牌不可打出 —— 蓝色牌不受牵连", () => {
  const { state, red, foe, hand } = gateGame();
  // 对照组：门开着的时候这张牌打得出。少了这一行，下面的"打不出"可能是别的原因
  // （水晶、格位、行动权）造成的，整条测试就变成了假绿。
  expectPlayable(state, hand.red, 3);
  expect(missingColors(state, hand.red)).toEqual([]);

  const dead = runActs(state, [hit(red, 9)], foe, GATE_DEPS).state;
  expect(getZone(dead, 0, "fountain")).toEqual([red]);
  // ★ 场上摆一个**红色随从**：它开不了红门。判据是「英雄」（`isHero`，全引擎唯一的一处），
  //   不是「任何红色实体」—— 漏了那一半，下面两行会读到"红牌照样打得出"。
  putCard(dead, 0, 5, RED_CARD, { atk: 0, health: 9 });

  // ★ 同一张牌、同一个空格、同样够水晶 —— 唯一变了的是红英雄不在战线上了。
  expect(tryPlay(dead, hand.red, 3)).toEqual({ ok: false, code: "color_locked" });
  expect(missingColors(dead, hand.red)).toEqual(["red"]);
  // ★ 只锁**那一个颜色**。写错（"有英雄阵亡就整手锁死"、或按在场英雄的**数量**判）
  //   会让这一行也被拒 —— 而那种实现在只有一名英雄的盘面上与正确实现读数相同。
  expectPlayable(dead, hand.blue, 3);

  // ★ 色门排在水晶之前（`apply.ts` 的 `checkPlayCard`）：两条都不满足时报更根本的那一条。
  //   客户端要据此把牌置灰，`not_enough_crystals` 会让玩家以为"攒够水晶就能打"。
  setFace(dead, hand.red, { cost: 99 });
  expect(tryPlay(dead, hand.red, 3)).toEqual({ ok: false, code: "color_locked" });
});

test("色门问的是「存活在场」：0 血却站着的开不了门，满血躺在泉里的也开不了", () => {
  const { state, red, foe, hand } = gateGame();

  // ── 一半：**在场**。躺在复燃泉里的英雄不算数，与它还剩多少血无关。 ──────────
  const inFountain = runActs(state, [hit(red, 9)], foe, GATE_DEPS).state;
  // 把它的血量按回去（"满血却躺在泉里" —— `rules/phase.ts` 明说这个中间态不该存在，
  // 这里只是把判据逼出来）。
  setFace(inFountain, red, { health: 99 });
  // ★ 写错（把泉里的英雄也算进在场英雄）会读到"红门还开着"。而那种写法**在今天的
  //   引擎上与正确实现读数完全相同** —— 泉里的英雄要么没写过卡面（0 血）、要么带着
  //   致死的伤害，两种都被下面那半个判据挡住了。等哪天有人把 `damage` 的清理从
  //   "回场时"挪到"入泉时"（`rules/phase.ts` 的取舍，规范没写），它就会当场显形。
  expect(missingColors(inFountain, hand.red)).toEqual(["red"]);
  expect(tryPlay(inFountain, hand.red, 3)).toEqual({ ok: false, code: "color_locked" });

  // ── 另一半：**存活**。把血量按到 0 但不跑结算 —— 这正是"光环刚掉、死亡还没轮到"
  //    那个瞬间的盘面（流水线第 ⑥ 步排在第 ⑤ 步之后，`resolve/resolve.ts`）。 ────
  setFace(state, red, { health: 0 });
  // ★ 判据用 `isLethal`，与死亡结算**同一个谓词**（引擎里"死"只有一个定义），
  //   于是 M7 的投影在这种中间态上问色门，答案与流水线一致。
  expect(missingColors(state, hand.red)).toEqual(["red"]);
  expect(tryPlay(state, hand.red, 3)).toEqual({ ok: false, code: "color_locked" });
});

test("色门跟着战线走：英雄躺在泉里就一直锁着，回场那一刻就开", () => {
  const { state, red, foe, hand } = gateGame();
  const dead = runActs(state, [hit(red, 9)], foe, GATE_DEPS).state;
  expect(getEntity(dead, red)?.respawnAt).toBe(3); // r1 阵亡 ⇒ 缺席 r2、r3 回来（第 4 节）

  // r2 的先手轮给了 p1（`initiative: "alternate"`），先让它 pass 一次行动权才回到 p0 ——
  // 否则 `apply` 会先撞上 `wrong_player`，那与色门无关。
  const r2 = passThroughCombat(dead, GATE_DEPS).state;
  expect([r2.round, r2.phase, r2.priority]).toEqual([2, "actions", 1]);
  const r2p0 = passOnce(r2, GATE_DEPS).state;
  // ★ 整个缺席回合都锁着。注意实现里**没有一行读 `respawnAt`**：锁不锁只由
  //   "它现在站没站在战线上"决定，`respawnAt` 只管它哪一回合能回来。
  expect(tryPlay(r2p0, hand.red, 3)).toEqual({ ok: false, code: "color_locked" });

  const r3 = passThroughCombat(r2p0, GATE_DEPS).state;
  // 到期回场（第 5 节的时间线）：r3 有 deploy 相位，泉里那名红英雄回到 2 号格。
  expect([r3.round, r3.phase]).toEqual([3, "deploy"]);
  const back = deployHeroes(r3, [[2], []], GATE_DEPS).state;
  expect(slotOf(back, red)).toBe(2);

  // ★ 回场那一刻门就开了 —— 不必等到下一回合，也不必回到它死时那一格。
  expect(missingColors(back, hand.red)).toEqual([]);
  expectPlayable(back, hand.red, 3);
});

test("融合卡需要两色英雄同时存活在场 —— 两名单色英雄就够，不必是一名双色英雄", () => {
  const { state, red, blue, foe, hand } = gateGame();
  // ★ 红英雄 + 蓝英雄两名**不同**的英雄就打得出红蓝融合卡（v2.1 §11.4）。
  //   写错（要求"存在一名英雄，其 colors 覆盖这张牌的全部颜色"）在这一行就红 ——
  //   而那种写法在单色牌上完全正确，只测单色牌是永远发现不了它的。
  expectPlayable(state, hand.fusion, 3);
  expect(missingColors(state, hand.fusion)).toEqual([]);

  const noBlue = runActs(state, [hit(blue, 9)], foe, GATE_DEPS).state;
  // 死一名 ⇒ 融合卡锁住，缺的是**那一个**颜色；另一色的单色牌照旧打得出。
  expect(tryPlay(noBlue, hand.fusion, 3)).toEqual({ ok: false, code: "color_locked" });
  expect(missingColors(noBlue, hand.fusion)).toEqual(["blue"]);
  expectPlayable(noBlue, hand.red, 3);

  // ★ 两色都没了 ⇒ 结构化原因**逐项**给全，且顺序 = 卡面 `colors` 的声明顺序
  //   （M7 的 legalActions 要照它写"缺一名红色英雄、一名蓝色英雄"这类文案，
  //   所以它不能只报第一个缺的颜色，也不能随遍历顺序抖动）。
  const neither = runActs(noBlue, [hit(red, 9)], foe, GATE_DEPS).state;
  expect(missingColors(neither, hand.fusion)).toEqual(["red", "blue"]);
  expect(missingColors(neither, hand.red)).toEqual(["red"]);
});

// ── 「同色两名英雄」的盘面：PF1 每色恰好一名，所以这个夹具得手工造 ─────────────
// 第二名红英雄血量 6（不是 5）：两名英雄的卡面数字不同，抄错一名会在断言里露出来。

const RED_HERO_B: Card = scriptCard(
  "H_RED_B",
  {},
  { kind: "hero", colors: ["red"], tags: { health: 6 } },
);
const TWIN_DEPS: ResolveDeps = cardDeps([RED_HERO, RED_HERO_B, RED_CARD]);
const TWIN_NAMES: readonly [readonly CardId[], readonly CardId[]] = [
  [RED_HERO.id, RED_HERO_B.id],
  [RED_HERO.id, RED_HERO_B.id],
];

test("★ 色门只看颜色不看归属：同色两名英雄，死一名照样打得出那个颜色的牌", () => {
  const start = createGame(DEFAULT_RULES, [makeTestDeck("A"), makeTestDeck("B")], 0x5c01, {
    shuffle: false,
    firstPlayer: 0,
    heroes: TWIN_NAMES,
  });
  const r1 = startMatch(start, TWIN_DEPS).state;
  const first = heroInFountain(r1, 0, 0);
  const second = heroInFountain(r1, 0, 1);
  const foe = heroInFountain(r1, 1, 0);
  const state = deployHeroes(
    r1,
    [
      [0, 1],
      [7, 8],
    ],
    TWIN_DEPS,
  ).state;
  const card = putCardInHand(state, 0, RED_CARD);

  const dead = runActs(state, [hit(first, 9)], foe, TWIN_DEPS).state;
  expect(getZone(dead, 0, "fountain")).toEqual([first]);

  // ★ 红门仍然开着：另一名红英雄还站着。两种写错在这里同时露出来 ——
  //   (a) 按**归属**判（"这张牌所属的那名英雄在不在场"）；
  //   (b) 按**阵亡**去算锁哪几色（读"死了谁"而不是读"谁还站着"）。
  //   两者在 PF1（每色恰好一名英雄）上都与正确实现逐字等价，只有这个盘面分得开，
  //   而等英雄扩池那天它们会表现成"某些牌莫名打不出"，很难往回追到色门这一步。
  expect(missingColors(dead, card, TWIN_DEPS)).toEqual([]);
  expectPlayable(dead, card, 3, TWIN_DEPS);

  // 两名都不在战线上了才锁 —— 这才叫"这个颜色没有英雄"。
  const none = runActs(dead, [hit(second, 9)], foe, TWIN_DEPS).state;
  expect(getZone(none, 0, "fountain")).toEqual([first, second]);
  expect(tryPlay(none, card, 3, TWIN_DEPS)).toEqual({ ok: false, code: "color_locked" });
  expect(missingColors(none, card, TWIN_DEPS)).toEqual(["red"]);
});

// ── 排期 × 色门的交点：「r1 只部署两色 → 第三色及其融合 r2 起才可用」（v2.1 §11.4）──
//
// 上面那几条都在**阵亡**这一侧问色门（英雄上过场、然后倒下）。规范 §11.4 还写了另一侧：
// 排期是 `[2, 1]`，所以 r1 结束时第三名英雄**根本还没上过场** —— 它那一色以及带它的
// 融合卡整个 r1 都打不出。这是第 5 节（排期时间线）与第 6 节（色门）唯一的交点，
// 两节各自都测不到它：第 5 节的夹具没有带颜色的手牌，第 6 节的夹具只有两名英雄、
// r1 一次上齐，泉里根本不会留人。
//
// ★ 为什么这一条非写不可 ★
// 泉里的英雄有**两种**，而它们的 `respawnAt` 落在时间轴的两边：
//   - **阵亡**的：`respawnAt` 是**未来**的回合（r1 阵亡 ⇒ 3），上面几条测的全是它；
//   - **还没轮到首次部署**的：`respawnAt` 建局时就写成 `FIRST_ROUND`（= 1），
//     于是它在 r1 就已经满足"到期"，只是被**排期**按住了（`rules/phase.ts`）。
// 一个把"到期可部署的英雄"也算进开着的颜色的实现（"它马上就上场了，别锁玩家的手牌"，
// 是个听起来很合理的顺手优化），只有第二种英雄才**必然**分得开 —— 第一种要靠盘面
// 恰好有一名"满血躺在泉里"的英雄才碰得到（上面那条同名测试正是为此摆的）。
// 实测（注入该实现）：本条与上面五条色门测试一起变红，共 6 条 —— 也就是说这一条不是
// 唯一的防线，但它是唯一**不依赖夹具恰好摆对**的那一条，所以照样非写不可。
//
// 判据仍然只有一条 ——「站没站在战线上」。实现里没有一行读 `respawnAt`，
// 所以这一条测的不是又一条规则，而是那一条判据在另一种泉里实体上的**同一个**结论。

/** 第三色（绿）的单色牌，与 `RED_CARD` 只差颜色。 */
const GREEN_CARD: Card = scriptCard(
  "C_GREEN",
  {},
  { colors: ["green"], cost: 0, tags: { health: 9 } },
);
/**
 * 红绿融合卡。颜色**红在前**是有意的：r1 时红门已开、绿门未开，
 * 于是"缺哪些颜色"必须恰好是 `["green"]` —— 一个把整张牌一锅端（缺一色就报全部颜色）
 * 的实现会在那一行读到 `["red", "green"]`，而端到端的 `ok:false` 是分不出这两者的。
 */
const RG_FUSION: Card = scriptCard(
  "C_RG",
  {},
  { colors: ["red", "green"], cost: 0, tags: { health: 9 } },
);

/** 第 5 节那三名英雄（红/蓝/绿）+ 本节的三张牌。走的是 PF1 的真配置：`perDeck: 3`、排期 `[2, 1]`。 */
const SCHEDULE_DEPS: ResolveDeps = cardDeps([...TRIO_HEROES, RED_CARD, GREEN_CARD, RG_FUSION]);

test("★ 第三色要等 r2：r1 只部署两色 ⇒ 绿牌与红绿融合卡当回合打不出", () => {
  const start = createGame(DEFAULT_RULES, [makeTestDeck("A"), makeTestDeck("B")], 0x3c01, {
    shuffle: false,
    firstPlayer: 0,
    heroes: TRIO_NAMES,
  });
  const r1 = startMatch(start, SCHEDULE_DEPS).state;
  const green = heroInFountain(r1, 0, 2);
  // 红蓝上场（排期第一项 = 2 名），绿留在泉里。p1 的两名摆到 7/8 号格，不搅进读数。
  const state = deployHeroes(
    r1,
    [
      [0, 1],
      [7, 8],
    ],
    SCHEDULE_DEPS,
  ).state;
  const redCard = putCardInHand(state, 0, RED_CARD);
  const greenCard = putCardInHand(state, 0, GREEN_CARD);
  const fusion = putCardInHand(state, 0, RG_FUSION);

  // ★ 泉里这名英雄是**没上过场**的那一种，不是阵亡的：`respawnAt` 建局时就到期（= 1）、
  //   身上一点伤都没有。这两行钉住"本条测的是排期，不是死亡" —— 少了它们，
  //   这条测试会被误当成第 5 节那几条的重复而被"简化"掉。
  expect(getZone(state, 0, "fountain")).toEqual([green]);
  expect([getEntity(state, green)?.respawnAt, damageOf(state, green)]).toEqual([1, 0]);
  expect([state.round, state.phase]).toEqual([1, "actions"]);

  // ── r1：红门开着，绿门没开 ────────────────────────────────────────────────
  expectPlayable(state, redCard, 3, SCHEDULE_DEPS);
  expect(tryPlay(state, greenCard, 4, SCHEDULE_DEPS)).toEqual({
    ok: false,
    code: "color_locked",
  });
  expect(missingColors(state, greenCard, SCHEDULE_DEPS)).toEqual(["green"]);
  // ★ 融合卡：缺的**只有**没上场那一色（v2.1 §11.4「r1 只部署两色 → 第三色及其融合
  //   r2 起才可用」）。红那一半已经开着，所以这一行同时排除了"缺一色就整张一锅端"。
  expect(tryPlay(state, fusion, 4, SCHEDULE_DEPS)).toEqual({ ok: false, code: "color_locked" });
  expect(missingColors(state, fusion, SCHEDULE_DEPS)).toEqual(["green"]);

  // ── r2：排期第二项把第三名送上场，绿门与融合卡一起开 ──────────────────────
  const r2 = passThroughCombat(state, SCHEDULE_DEPS).state;
  expect([r2.round, r2.phase, deployQuotaOf(r2)]).toEqual([2, "deploy", 1]);
  const deployed = deployHeroes(r2, [[2], [2]], SCHEDULE_DEPS).state;
  expect(slotOf(deployed, green)).toBe(2);
  expect(getZone(deployed, 0, "fountain")).toEqual([]);
  // r2 的先手轮给了 p1（`initiative: "alternate"`）：先让它把行动权让回来，
  // 否则 `apply` 先撞上 `wrong_player`，那与色门无关。
  expect(deployed.priority).toBe(1);
  const turn = passOnce(deployed, SCHEDULE_DEPS).state;

  // ★ 上场那一刻门就开了。写错（把"到期可部署"也算进开着的颜色）会让上面 r1 那三行
  //   提前变绿 —— 而这里照旧是绿的，所以判别力全在 r1 那一侧。
  expect(missingColors(turn, greenCard, SCHEDULE_DEPS)).toEqual([]);
  expectPlayable(turn, greenCard, 4, SCHEDULE_DEPS);
  expect(missingColors(turn, fusion, SCHEDULE_DEPS)).toEqual([]);
  expectPlayable(turn, fusion, 5, SCHEDULE_DEPS);
});
