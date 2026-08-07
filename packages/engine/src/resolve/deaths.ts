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
// 本文件把 `unit_died` 事件交给 `triggers.ts`，排队与入栈由那里按时序规则 1 完成。
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

import type { EntityId } from "@prismfront/ir";
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
} from "../state/index.ts";
import { queueTriggers } from "./triggers.ts";

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
 * 把一个致死单位移出场并送进墓地，发 `unit_died`。
 *
 * 进**谁的**墓地：`entity.owner`。理由是 IR v1 §3.4 的 `act.move.side` 默认值就是
 * `"owner"` —— 被 `act.steal` 偷走的单位死后回到原主的墓地，牌张归属才不会因为
 * 一次偷取而永久转移（否则牌库/墓地的记账会随控制权漂移）。
 *
 * ⚠ M6 的英雄分支就加在这里：`kind: "hero"` 的实体不进墓地，而是移入 `"fountain"`、
 *   置 `respawnAt = round + 1 + rules.heroes.respawnDelay`、发 `hero_died` 而**不发**
 *   `unit_died`（v2.1 §11.3 明确要求触发器能区分两者）。M2 判不了 `kind`（没有卡表，
 *   `state/entity.ts` 只存 `cardId`），所以这里不写一个恒假的 `isHero()` 占位分支 ——
 *   一个永远走不到的分支既测不了也会误导读者，注释比空分支诚实。
 */
function sendToGraveyard(state: GameState, unit: LethalUnit): void {
  const entity = getEntity(state, unit.id);
  if (entity === undefined) {
    return;
  }
  const row = state.slots[unit.controller];
  if (row[unit.slot] === unit.id) {
    row[unit.slot] = null;
  }
  removeFromZone(state, entity.zone, unit.id);
  const grave = zoneKey(entity.owner, "graveyard");
  state.zones[grave].push(unit.id);
  entity.zone = grave;
  entity.slot = null;
  // `playOrder` **保留不清**：亡语要按它排队（时序规则 3），而亡语是在实体已经躺进
  // 墓地之后才排的（IR v1 §4.1 的 `zone: "graveyard"`）。
  emitEvent(state, { name: "unit_died", target: unit.id, slot: unit.slot });
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
 * 与时序规则 2 的接缝：本函数把每一波的 `unit_died` 交给 `queueTriggers`，
 * 亡语与「每当有单位死亡」的触发器**只入栈不执行** —— 它们要等下一次
 * `stack.pop()` 才开始，正是规则 2 说的「B 要等 A 这一步的死亡结算做完才开始」。
 *
 * 与时序规则 4 的接缝：本函数**不重算光环**。一波单位离场会让依附它们的光环失效，
 * 而重算是流水线第 6 步的事，紧接着就会跑（`resolve.ts`）。
 * 已知的边角（留给 M5）：若重算后有实体因为掉了光环 buff 而变成致死，它要等
 * **下一次**弹栈才被判死；栈恰好在此刻空掉的话就会活下来。框架 §4.1 的六步顺序
 * 就是这么定的，改它要连同规则 3/4 一起重新论证，不是本文件能单方面决定的事。
 */
export function processDeaths(state: GameState): DeathReport {
  if (isOver(state)) {
    return { died: [], waves: 0 };
  }
  const died: EntityId[] = [];
  let waves = 0;
  for (;;) {
    const wave = collectLethalUnits(state);
    if (wave.length === 0) {
      break;
    }
    waves += 1;
    const mark = state.eventLog.length;
    // 先收集齐再一起搬 —— "批量"是"同归于尽"能成立的全部原因。
    for (const unit of wave) {
      sendToGraveyard(state, unit);
      died.push(unit.id);
    }
    // 本波产出的 `unit_died` 全部走触发器排队（亡语就是其中一种，见文件头）。
    queueTriggers(state, state.eventLog.slice(mark));
  }
  settleBases(state);
  return { died, waves };
}
