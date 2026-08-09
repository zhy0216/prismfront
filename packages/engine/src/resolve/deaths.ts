// 流水线第 5 步：死亡结算（框架 §4.1 的 `processDeaths(state)`）。
// 来源：框架 §4.1 时序规则 3、DSL v2 §4.1（base 归零判定，双亡为平局）、
//       DSL v2 §4.2 第 ④ 步（战斗末尾的统一死亡结算跑到不动点）、
//       DSL v2.1 §11.2/§11.3（base 与英雄的去向）、`state/entity.ts`（血量记账定案）。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 这一步在 M2 是**真实现**，不是空壳 ★
// ═══════════════════════════════════════════════════════════════════════════
// M2 的完成标志是跑通「抽牌 → 放单位到格 → 手动 strike → 死亡」（里程碑 M2 第 5 项），
// 死亡就在这条链的末端。留给 M5 的只有一样：**亡语的匹配**，而那件事根本不在本文件 ——
// 亡语是 `{on:"unit_died", filter:{target:SELF}, zone:"graveyard"}` 的糖（IR v1 §4.1），
// 本文件把死亡事件交给 `triggers.ts`，排队与入栈由那里按时序规则 1 完成。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ M6 往本文件加的第四件事：英雄阵亡发 `hero_died`，**不发** `unit_died` ★
// ═══════════════════════════════════════════════════════════════════════════
// v2.1 §11.3 明写「触发器需明确区分两者」。理由是**既有的卡会被误触发**：
// `{on: "unit_died"}`（「每当一个单位死亡…」）从 M5 起就写得出来了，而英雄是每局
// 只有 3 名、死了还会回来的角色 —— 把它算进单位死亡，一整类计数/收益卡的读数会
// 凭空多出几次，且多出的次数随对局进程漂移（英雄死得越多漂得越远），事后极难归因。
//
// 两个事件名因此是**互斥**的：一个死者只发其中一个，判据与"去哪个区"共用同一条
// （`eval/context.ts` 的 `isHero`，见 {@link sendOffBoard}）—— 事件名与去向由同一个
// 谓词决定，就不可能出现"进了泉却发着 unit_died"这种半边的分叉。
//
// 连带的一个结果，是**规范的意图而不是漏洞**：亡语对英雄**永不响**，而且双重上锁 ——
// 事件名不是 `unit_died`，区域也不是 `graveyard`（它躺在 fountain 里）。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ M5/T3 往本文件加的两件事：`while_source_alive` 的剥离 + 判死前的光环重算 ★
// ═══════════════════════════════════════════════════════════════════════════
// ── 1. `duration: "while_source_alive"` 的剥离点（IR v1 §2.3 / v2 §3.5）─────
// 四种存续期里另外三种都由相位机剥（`rules/phase.ts` 的 `stripEnchantments`：
// `end_of_round` 在 round_end、`end_of_combat` 在战斗第 ⑤ 步、`permanent` 只有
// `act.silence` 能剥）。第四种的时机是「来源不在了」，而**唯一能让一个实体不在了的
// 事件就是死亡** —— 所以它落在本文件，判据是 `AttachedEnchantment.source`
// （一个 id 引用，见 `state/entity.ts`）。落点见 {@link stripLostSourceEnchantments}。
//
// ── 2. **判死之前先重算光环**（v2 §4.2 第 ④ 步原文）────────────────────────
// > 统一死亡结算 → 亡语 → 光环重算 →（有新死亡则循环至不动点）
// 规范把「光环重算」写在了不动点循环**里面**。M2 时这没有可观测差别（`refreshAuras`
// 是恒等的），M5/T3 补上两个 Σ 之后它变成了两个真 bug 的分界线：
//   a. **判死读到过期的血量上限**：`act.buff` 只往 `entity.enchantments` 里塞一条实例
//      （`handlers/tags.ts`：加成本身交给第 ⑥ 步算），此刻 `tags.health` 还是旧的。
//      本函数若直接判死，一条"血量上限 −2"的衰弱附魔挂上去之后当场不生效 ——
//      目标要等**下一次**弹栈才被判死，栈恰好在此刻空掉的话它就带着负血量活下来了。
//   b. **掉光环致死要等下一次弹栈**（M2 在这里留的那条 ⚠ 就是它）：光环源阵亡后，
//      被它撑着血量上限的单位应当**在同一次结算里**跟着死。本函数若不重算，
//      它同样要等下一次 `stack.pop()`，同样会在栈空时活下来。
// 于是循环体改成「剥离 → 重算 → 收集本波 → 移墓地 → 排队触发器」，两条都消失，
// 而框架 §4.1 的六步顺序一行没改（第 ⑥ 步照旧在第 ⑤ 步之后跑一次，重算是幂等的）。
//
// **终止性不受影响**：新增的两步都不会把实体放回场上（剥离只删附魔实例，重算只写
// `tags`/`flags`），每一波仍然至少从 `slots` 移走一个实体 ⇒ 轮数以场上单位数为界。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 第三件事：触发器**推迟到不动点循环之后**一次性入栈 ★
// ═══════════════════════════════════════════════════════════════════════════
// 结算栈是 LIFO，每调一次 `enqueueTriggers` 就压一次 ⇒ **后压的那一批先跑**。
// 本函数在开闸（下一次 `stack.pop()`）之前会经历**多波**，所以逐波入栈的写法让
// 波与波之间按逆序结算：**第 2 波的亡语先于第 1 波**。
// 这与 `rules/combat.ts` 第 ③ 步逐击入栈是**同一个**缺陷，修法也同一条：
// 逐波调 {@link collectOrderedTriggers}（只匹配、只排序）把有序条目累积起来，
// 循环结束后调一次 {@link enqueueTriggers}。最终顺序 = 「事件发出序为外层键、
// 时序规则 1 为内层键」的字典序，与 `triggers.ts` 的 `queueTriggers` 声明的那条一致。
// 钉住它的是 `__tests__/triggers.test.ts` 的「★ 跨波的触发顺序」（掉光环致死造出第 2 波，
// 两条亡语的伤害数值不同 ⇒ 先后是可区分的读数）。
//
// ⚠ **匹配不能跟着一起推迟**（与 combat 同一条）：`zone` / `once` / `filter` / `cond`
//   与排序键读的都是**当下**的盘面，而"当下"在波与波之间会变（上一波的死者已经进墓地、
//   下一轮开头还会剥附魔 + 重算光环）。逐波匹配保住的正是「匹配时看到的世界」——
//   `__tests__/auras.test.ts` 的「★ 亡语的 cond 看到的是…中间盘面」钉着这条时机。
//
// **终止条件不受影响**（这次推迟唯一值得追问的地方）：循环的出口是
// 「`collectLethalUnits` 返回空」，而它只读 `slots` 与 `entities`；`enqueueTriggers`
// 只写 `state.stack`，循环体里**没有任何一步读 `state.stack`**（剥离读 `enchantments`、
// 重算写 `tags`/`flags`、收集读 `slots`、移墓地写 `zones`/`slots`）。
// 于是波序、`waves`、`died` 与推迟前逐字相同，「每一波至少移走一个实体」这条结构性
// 论证也一字不用改 —— 入栈本来就不在"把实体放回场上"的候选里。
//
// ═══════════════════════════════════════════════════════════════════════════
// 时序规则 3（框架 §4.1 原文）
// ═══════════════════════════════════════════════════════════════════════════
// > **死亡结算是独立阶段**：每个 action 结算完统一检查 `health <= 0`，批量移入墓地，
// > 亡语按 `playOrder` 排队。中途新死的要再跑一轮，直到不动点。
//
// 逐条落地：
//   「独立阶段」   → 只由流水线在第 5 步调用一次；handler **不许**自己判死
//                   （见 `deps.ts` 的 handler 契约第 2 条）。
//   「统一检查」   → `damage >= tags.health`，判据是 `state/queries.ts` 的 `isLethal`。
//   「批量移入墓地」→ 先把这一波全部收集齐，再一起搬。逐个搬会让第 2 个单位在第 1 个
//                   已经离场的盘面上被判定，"同归于尽"就成不了。
//   「按 playOrder」→ 一波之内按 `playOrder` 升序处理，事件流顺序随之确定。
//   「跑到不动点」 → `for(;;)` 直到某一波为空。**不需要循环次数上限**：每一波至少从
//                   `slots` 移走一个实体，而死亡结算期间没有任何东西能把实体放回场上
//                   （亡语只入栈不执行，光环重算不召唤），所以轮数以场上单位数为界，
//                   结构性终止。（刻意不加一个永远走不到的 guard 分支 —— 走不到的
//                   分支既测不了，又会在覆盖率里变成噪声，同 `rng/rng.ts` 的取舍。）
//
// ═══════════════════════════════════════════════════════════════════════════
// 不消耗 RNG（IR v1 §5.4 规则 5）
// ═══════════════════════════════════════════════════════════════════════════
// 死亡结算与光环重算**每步都跑**，一旦消耗 RNG，随机流的推进次数就会随盘面细节漂移，
// 回放立刻对不上。本文件因此不 import `../rng`，一次 `nextInt` 都不调。
// M5/T3 起本文件会调 `refreshAuras`，而**它**的求值理论上碰得到 `sel.random` ——
// 那条同样禁止，防线是 `auras.ts` 的 `AuraRandomError`（L3 的运行期兜底），不在这里重复。

import type { Duration, EntityId, ZoneName } from "@prismfront/ir";
import type { CardLookup } from "../eval/index.ts";
import { isHero } from "../eval/index.ts";
import { emitEvent } from "../events/index.ts";
import type { GameState, PlayerId, ZoneKey } from "../state/index.ts";
import {
  baseOf,
  getEntity,
  getSlots,
  isLethal,
  isOver,
  PLAYER_IDS,
  zoneKey,
  zoneOf,
} from "../state/index.ts";
import { refreshAuras } from "./auras.ts";
import type { TriggerDeps } from "./deps.ts";
import type { QueuedTrigger } from "./triggers.ts";
import { collectOrderedTriggers, enqueueTriggers } from "./triggers.ts";

/** {@link processDeaths} 的产出，供流水线与测试断言。 */
export interface DeathReport {
  /** 本次结算中离场的实体 id，按处理顺序（波次升序、波内 `playOrder` 升序）。 */
  readonly died: readonly EntityId[];
  /** 跑了几波才到不动点。`0` = 没有任何东西死。 */
  readonly waves: number;
}

/** 一个待移出场的单位。`slot` 在收集时就取好 —— 搬走之后就再也问不到它死在哪一格。 */
interface LethalUnit {
  readonly id: EntityId;
  /** 死亡时的**控制者**（不一定是 owner，`act.steal` 会让两者不同）。 */
  readonly controller: PlayerId;
  readonly slot: number;
  readonly playOrder: number;
}

/**
 * 收集当前一波致死的单位。
 *
 * 枚举来源是 `state.slots` 而不是 `zones["px:board"]`：`slots` 是位置的唯一真相源，
 * 顺着它扫既能拿到格位下标（`unit_died.slot` 需要），也天然是 v2 §3.2 规定的
 * 「board 按格序 0→8 枚举」。
 *
 * **只扫在场单位**。手牌与牌库里的实体在 M2 没有卡表、`tags.health` 恒为 0，
 * `isLethal` 对它们恒真 —— 把它们纳进来会当场清空双方牌库。
 * 「在场才判死」本来也是规则本意（框架 §4.1 说的是场上的 action 结算）。
 *
 * 排序：`playOrder` 升序（时序规则 3），同值按实体 id 升序兜底成**全序**，
 * 于是结果与扫描顺序、与引擎排序算法的实现细节都无关（架构 §6.1 的哈希比对
 * 会把任何抖动放大成假红）。
 */
function collectLethalUnits(state: GameState): LethalUnit[] {
  const out: LethalUnit[] = [];
  for (const player of PLAYER_IDS) {
    const row = getSlots(state, player);
    for (let index = 0; index < row.length; index += 1) {
      const id = row[index];
      // 三态：`undefined` = 无效槽、`null` = 空格、其余 = 有人占（v2 §3.1）。
      if (id === null || id === undefined) {
        continue;
      }
      const entity = getEntity(state, id);
      if (entity === undefined || !isLethal(entity)) {
        continue;
      }
      out.push({ id, controller: player, slot: index, playOrder: entity.playOrder });
    }
  }
  out.sort((a, b) => (a.playOrder !== b.playOrder ? a.playOrder - b.playOrder : a.id - b.id));
  return out;
}

/** 从有序区域列表里摘掉一个 id（`zones[k]` 含 id ⇔ `entities[id].zone === k`，状态不变量 1）。 */
function removeFromZone(state: GameState, key: ZoneKey, id: EntityId): void {
  const list = state.zones[key];
  const index = list.indexOf(id);
  if (index >= 0) {
    list.splice(index, 1);
  }
}

/**
 * 尸体待的地方。两处要用它：{@link sendOffBoard} 的去向，
 * 以及 {@link isSourceGone} 判「来源还在不在」。engine 只 import ir 的**类型**，值本地写。
 */
const GRAVEYARD: ZoneName = "graveyard";

/**
 * 复燃泉（v2.1 §11.3）：英雄阵亡后待的地方，与 {@link GRAVEYARD} 在本文件里是**同级**的
 * 两个去向 —— 它们各自出现在同样的两处（去向 + 「来源还在不在」）。
 */
const FOUNTAIN: ZoneName = "fountain";

/**
 * 阵亡英雄的**可再部署回合**（v2.1 §11.3，公式由 IR 的 `RulesConfig.heroes.respawnDelay`
 * 注释给定）：`当前回合 + 1 + respawnDelay`。
 *
 * 默认 `respawnDelay = 1` ⇒ r3 阵亡的英雄 `respawnAt = 5`。而 `rules/phase.ts` 的
 * `beginRound` 是**先** `round += 1` **再**判 `needsDeploy`，`deployableHeroes` 的判据是
 * `respawnAt <= round` ⇒ 它在 r5 的 deploy 相位就能上场，**恰好缺席 r4 一整回合**。
 * 缺席两回合（`+2+delay`）与当场就能回来（`+delay`）是这条公式仅有的两种错法，
 * 而它们都要跨好几个回合才显形 —— 所以公式只写在这一处，别在别处再算一遍。
 */
function respawnRoundOf(state: GameState): number {
  return state.round + 1 + state.rules.heroes.respawnDelay;
}

/**
 * 把一个致死单位移出场，送去它该去的**安息区**：随从 / 衍生物 → 墓地，
 * **英雄 → 复燃泉**（v2.1 §11.2/§11.3）。随后发死亡事件：随从发 `unit_died`，
 * 英雄发 `hero_died`。
 *
 * 进**谁的**区：一律 `entity.owner`。理由是 IR v1 §3.4 的 `act.move.side` 默认值就是
 * `"owner"` —— 被 `act.steal` 偷走的单位死后回到原主的墓地，牌张归属才不会因为
 * 一次偷取而永久转移（否则牌库/墓地的记账会随控制权漂移）。英雄同理：偷来的英雄
 * 阵亡后回**原主**的泉，不然它会在对手那边复活。
 *
 * ── ★ 英雄那一支：区别**只在去向**，别的一律同规则 ★ ──────────────────────
 * 英雄占格、有攻血、按方向出手、可被打，走的是与随从**完全同一套**的判死
 * （{@link collectLethalUnits} 只扫 `state.slots`）与同一套出手/受伤管线
 * （`rules/combat.ts` 也只扫 `state.slots`）。所以这个函数里除了目的区之外
 * 一行分叉都没有，判据是**卡面 kind**、且只有 `eval/context.ts` 的 {@link isHero} 一处。
 * 不接卡表 ⇒ `isHero` 恒假 ⇒ 英雄按随从进墓地：那是"引擎不认识任何具体卡"的正确退化，
 * 也正是 M2~M5 那一大批测试一直跑的形态（见 `isHero` 的说明）。
 *
 * `playOrder` **保留不清**：亡语要按它排队（时序规则 3），而亡语是在实体已经躺进
 * 墓地之后才排的（IR v1 §4.1 的 `zone: "graveyard"`）。
 *
 * ── ★ 事件名跟着去向一起分叉（M6：`hero_died` vs `unit_died`）★ ─────────────
 * 为什么两个名字必须互斥、以及"亡语对英雄永不响"为什么是意图，见文件头的 M6 那一节。
 * 判据是同一个 `isHero`，**只算一次**：算两次就给了"进了泉却发着 `unit_died`"
 * 这种半边分叉一个存在的机会。
 *
 * `hero_died` 比 `unit_died` 多一个 `respawnAt`（{@link respawnRoundOf}），
 * 而同一个数**同时写进实体**。两处同写不是冗余：事件流与状态是引擎的两份输出
 * （框架 §3.2/§3.3），客户端拿到的是事件流并据此重放自己那份状态（M7 投影）——
 * 两边各说一个数，服务端与客户端就会在"这名英雄哪一回合回来"上分叉，
 * 而这种分叉要等好几个回合后的 deploy 相位才显形。
 *
 * 复活链路的**消费**侧在 `rules/phase.ts`：`deployCountFor` 给到期的英雄一个不受排期
 * 约束的名额，`applyDeploy` 在它重新上场时把上一条命的 `damage` / `enchantments` /
 * 标志位清掉。本函数因此**什么都不清**（除了区域与 `respawnAt`）—— 清理只有那一处，
 * 泉里那段时间的实体保持它死时的样子。
 */
function sendOffBoard(state: GameState, unit: LethalUnit, cards: CardLookup | undefined): void {
  const entity = getEntity(state, unit.id);
  if (entity === undefined) {
    return;
  }
  const hero = isHero(cards, entity);
  const row = state.slots[unit.controller];
  if (row[unit.slot] === unit.id) {
    row[unit.slot] = null;
  }
  removeFromZone(state, entity.zone, unit.id);
  const rest = zoneKey(entity.owner, hero ? FOUNTAIN : GRAVEYARD);
  state.zones[rest].push(unit.id);
  entity.zone = rest;
  entity.slot = null;
  if (!hero) {
    emitEvent(state, { name: "unit_died", target: unit.id, slot: unit.slot });
    return;
  }
  const respawnAt = respawnRoundOf(state);
  entity.respawnAt = respawnAt;
  emitEvent(state, { name: "hero_died", target: unit.id, slot: unit.slot, respawnAt });
}

// ═══════════════════════════════════════════════════════════════════════════
// `while_source_alive` 的剥离（IR v1 §2.3，见文件头第 1 条）
// ═══════════════════════════════════════════════════════════════════════════

/** 「来源存活期间有效」那一档存续期。engine 只 import ir 的**类型**，值本地写字面量。 */
const SOURCE_BOUND: Duration = "while_source_alive";

/**
 * 附魔的来源是否已经**不在了**（`while_source_alive` 的剥离判据）。
 *
 * 判据取「实体表里查不到，或已经躺进**安息区**（墓地 / 复燃泉）」，而不是
 * 「本波刚死的那几个」：后者漏掉一种真实情形 —— **来源在挂上这条附魔时就已经死了**
 * （亡语里给别人挂一条 `while_source_alive` 的附魔，`act.buff` 的 `source` 取 `ctx.self`，
 * 那时 SELF 已经躺在墓地里了，见 `handlers/tags.ts`）。那条附魔按前者判永远剥不掉。
 *
 * ── ★ 为什么复燃泉也算「不在了」（M6 补入）★ ──────────────────────────────
 * {@link sendOffBoard} 起英雄阵亡进的是 fountain **而不是**墓地。只认墓地的话，
 * 一名死掉的英雄给别人挂的 buff 会**永远剥不掉** —— 而且症状只出现在带卡表的对局里
 * （不接卡表时英雄照旧进墓地，见 `isHero` 的退化口径），非常难往回追。
 * 泉里躺着的另一种实体是**还没首次部署**的英雄，它从没上过场、不可能是任何附魔的来源
 * （`AttachedEnchantment.source` 取的是 `ctx.self`，而它一次都没当过 SELF），
 * 所以这一支不会误伤谁。
 *
 * **不看"在不在场上"**：被弹回手牌 / 洗回牌库的单位仍然活着（IR v1 §2.3 的原文是
 * 「来源**存活**期间有效」），此时附魔应当留着。改成看 board 会让一次弹回手牌
 * 顺手清掉一堆本该留下的 buff —— 这也正是不能把上面那条写成「不在 board 上就算没了」
 * 的原因：那样写虽然一并覆盖了 fountain，却会连手牌那条一起做错。
 *
 * 悬空 id（`getEntity` 给 `undefined`）视为已不在 —— 与 `state/queries.ts` 对悬空 id
 * 的一贯处理一致：那是常态而不是错误。`act.buff` 在取不到 SELF 时写的哨兵 `0`
 * 也从这条走（`state/create.ts`：实体 id 从 1 起，0 永远查不到）。
 */
function isSourceGone(state: GameState, source: EntityId): boolean {
  const entity = getEntity(state, source);
  if (entity === undefined) {
    return true;
  }
  const zone = zoneOf(entity);
  return zone === GRAVEYARD || zone === FOUNTAIN;
}

/**
 * 剥离全场所有**来源已不在**的 `while_source_alive` 附魔。
 *
 * 只动 `entity.enchantments` 这份实例列表，**不减任何数值** —— 数值由紧随其后的
 * `refreshAuras` 从 `base` 重算出来（时序规则 4：重算而非增量）。这与
 * `rules/phase.ts` 的 `stripEnchantments` 是同一套做法，只是判据不同（那里按 `duration`
 * 整档剥，这里按"来源还在不在"逐条剥），所以没有合并成一个函数：合并之后签名会变成
 * 「duration + 一个可选谓词」，而两个调用点各自只用一半。
 *
 * **不发事件**：v2 §5 没有"附魔到期"这个事件名，理由与 `stripEnchantments` 逐字相同。
 */
function stripLostSourceEnchantments(state: GameState): void {
  for (const entity of Object.values(state.entities)) {
    if (entity.enchantments.length === 0) {
      continue;
    }
    const kept = entity.enchantments.filter(
      (attached) => attached.duration !== SOURCE_BOUND || !isSourceGone(state, attached.source),
    );
    if (kept.length !== entity.enchantments.length) {
      entity.enchantments = kept;
    }
  }
}

/** 某方 base 是否已归零（v2.1 §11.2：base 是胜负判定实体）。 */
function isBaseDown(state: GameState, player: PlayerId): boolean {
  const base = baseOf(state, player);
  return base !== undefined && isLethal(base);
}

/**
 * base 归零判定（DSL v2 §4.1：「任意时刻某 base hp<=0 → over；在死亡结算中判定；双亡 → 平局」）。
 *
 * 三件与单位死亡**不同**的事：
 * 1. **base 不离场**：它不进墓地、不清格（它本来也不占格），只是对局结束；
 * 2. **不发事件**：v2 §5 的 25 个事件名里没有「基地被摧毁」，而借用 `unit_died` 会让
 *    「每当一个单位死亡」的触发器在对局结束时误触发。胜负结果由 `state.winner`
 *    承载，下发客户端是协议层（M9）的事，不是规则事件；
 * 3. **维持状态不变量**：`winner !== null ⇔ phase === "over"`（`state/game-state.ts`），
 *    所以两个字段必须一起写。
 */
function settleBases(state: GameState): void {
  const down0 = isBaseDown(state, 0);
  const down1 = isBaseDown(state, 1);
  if (!down0 && !down1) {
    return;
  }
  state.winner = down0 && down1 ? "draw" : down0 ? 1 : 0;
  state.phase = "over";
}

/**
 * 死亡结算（框架 §4.1 第 5 步）：批量移墓地 → 亡语排队 → 跑到不动点 → 判胜负。
 *
 * 对局已结束时**直接返回**：`over` 之后没有后续时序可言，继续判死只会把已经归零的
 * base 反复算进来。
 *
 * 与时序规则 2 的接缝：本函数把每一波的死亡事件（`unit_died` / `hero_died`）
 * 交给 {@link collectOrderedTriggers}，
 * 亡语与「每当有单位死亡」的触发器**只入栈不执行** —— 它们要等下一次
 * `stack.pop()` 才开始，正是规则 2 说的「B 要等 A 这一步的死亡结算做完才开始」。
 * ★ 入栈本身推迟到不动点循环**之后**做一次（见文件头第 3 条）：逐波入栈会被 LIFO
 * 整段倒过来，第 2 波的亡语就跑在第 1 波之前。
 *
 * 与时序规则 4 的接缝（**M5/T3 改过，见文件头第 2 条**）：每一轮在收集致死单位**之前**
 * 先剥掉来源已不在的附魔、再重算一次光环，于是「刚挂上的救场 buff」与「掉光环致死」
 * 都在**本次**结算里就算准。流水线第 ⑥ 步照旧在本函数返回后再跑一次（重算是幂等的），
 * 框架 §4.1 的六步顺序一行没改。
 *
 * ── ⚠ 本函数的口径与 `rules/phase.ts` 的三处**并不相同**（别照着那边推）─────
 * 循环体是「剥离 → 重算 → 收集本波 → 移墓地 → 匹配触发器」。剥离/重算确实排在
 * {@link collectOrderedTriggers} 之前，但那是**上一波**的重算 —— 本波死者带来的光环变化要等
 * **下一轮**开头那次重算才落地。于是本波亡语的 `cond` 求值发生在一个**中间盘面**上：
 * 死者已经躺进墓地了，它的光环却还没算掉。实测：一条 `cond: 友军 atk ≥ 5` 的亡语，
 * 在给友军 +5 攻的光环源自己被打死时**照样触发**，而这一步结算完那位友军的 atk 已经是 0
 * （语义由 `__tests__/auras.test.ts` 的「亡语的 cond 看到的是…中间盘面」钉住）。
 *
 * 这**不是**规范违背：框架 §4.1 与 v2 §4.2 第 ④ 步的原文顺序就是
 * 「统一死亡结算 → 亡语 → 光环重算」——**亡语排在光环重算之前**，本函数逐字照做。
 * 而 `rules/phase.ts` 的三处（`runStep` / `stripEnchantments` / `runCombat` 的第 ⑤ 步）
 * 是「剥离 + 重算 → 发事件 → 排触发器」，那里的 `cond` 看到的是严格的结算后盘面。
 *
 * 两边**为什么可以不同**（而不是其中一边写错了）：相位机那三处的盘面变化在发事件
 * **之前**就全部完成了，重算与排队之间没有任何步骤，"结算后"是良定义的；而死亡结算的
 * 盘面变化（谁离场）恰恰是由**这一批事件本身**描述的 —— 想让亡语也看到"算完光环"的盘面，
 * 只能把重算插进「移墓地」与「排队」之间，那等于把规范写死的「亡语 → 光环重算」倒过来。
 * 要统一得先改规范；在那之前本文件按规范原文走。
 *
 * 也因此「四种存续期不分叉」这句话只在 `rules/phase.ts` 的三个剥离点之间成立：
 * `while_source_alive`（本文件）与它们共用「先剥再重算」这半条，但**排队时机**不同。
 *
 * `deps` 有三个去处：{@link collectOrderedTriggers}（亡语就是订阅 `unit_died` 的触发器）、
 * `refreshAuras`（光环与附魔的定义都在 bundle 里），以及 M6 起 {@link sendOffBoard} 要的
 * **卡表**（判 `kind:"hero"` 决定去墓地还是去复燃泉、发哪一个死亡事件名）。
 * 它**必填**，理由与前两个函数逐字相同 —— 忘了传就是
 * "亡语静默不响 / 加成静默归零 / 英雄误入墓地并发错事件名"，没有任何症状可循。
 * 不需要 bundle 的调用点传 `handlers/index.ts` 的 `NO_DEPS`。
 */
export function processDeaths(state: GameState, deps: TriggerDeps): DeathReport {
  if (isOver(state)) {
    return { died: [], waves: 0 };
  }
  const died: EntityId[] = [];
  // ★ 各波匹配出来的触发器**先攒在这里**，不动点循环跑完才一次性入栈（见文件头第 3 条）。
  //   循环体不读 `state.stack`，所以攒着不入栈不改变任何一轮的判死结果与出口条件。
  const queued: QueuedTrigger[] = [];
  let waves = 0;
  for (;;) {
    // ★ 判死之前先把盘面算准（见文件头第 2 条）：剥掉来源已阵亡的附魔 → 重算派生属性。
    //   两步都不会把实体放回场上，所以"轮数以场上单位数为界"这条终止性论证仍然成立。
    stripLostSourceEnchantments(state);
    refreshAuras(state, deps);
    const wave = collectLethalUnits(state);
    if (wave.length === 0) {
      break;
    }
    waves += 1;
    const mark = state.eventLog.length;
    // 先收集齐再一起搬 —— "批量"是"同归于尽"能成立的全部原因。
    for (const unit of wave) {
      sendOffBoard(state, unit, deps.cards);
      died.push(unit.id);
    }
    // 本波产出的死亡事件逐波匹配 + 排序（亡语就是其中一种，见文件头）——
    // ★ 只匹配、只排序，**不压栈**：匹配要在**本波的盘面**上做，入栈则必须等整次结算完。
    for (const trigger of collectOrderedTriggers(state, state.eventLog.slice(mark), deps)) {
      queued.push(trigger);
    }
  }
  // ★ 整次结算只入栈这一次 —— 波与波之间的顺序这才是「事件发出序 × 时序规则 1」的字典序。
  //   逐波入栈会被 LIFO 整段倒过来（见文件头第 3 条）。
  enqueueTriggers(state, queued);
  settleBases(state);
  return { died, waves };
}
