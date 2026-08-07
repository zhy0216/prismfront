// act.* 的编写层构造器（IR §3.4、DSL v2 §3.4、v2 §7 糖面清单）。
//
// 两条贯穿全文件的约定：
// 1. **字段顺序 = 规范签名的声明顺序**（IR §5.4 规则 1：声明顺序即求值顺序）。
//    对象字面量怎么写，JSON 的键就怎么排，推进 RNG 的节点求值先后因此是可审计的。
// 2. **可选字段缺省就不写进 IR**。两个例外都有出处：
//    - `act.summon.at`：v2 §3.4 规定规范形式必填，省略时补 `slot.random_empty(friendly)`（v2 §7）
//    - `act.discover.show / pick`：IR §10.5 的规范 JSON 把默认值 3 / 1 显式写了出来
//
// 没有 `Seq(...)`：**数组本身就是序列**（IR §3.4）。

import type {
  Act,
  ActNode,
  CardRef,
  Cond,
  EnchantId,
  FlagName,
  MoveSide,
  Num,
  Pool,
  Sel,
  SlotRef,
  TagKey,
  ZoneName,
} from "../types/index.ts";
import { toCardRef } from "./card-ref.ts";
import { toArray } from "./list.ts";
import { Neg } from "./num.ts";
import { RandomEmptySlot } from "./slot.ts";

/** 单个动作或动作数组 —— 编写层两种写法都收，规范形式永远是数组（IR §1 原则 1）。 */
export type ActLike = Act | readonly Act[];

/**
 * ★ 规范化的第一条：`play: Hit(...)` 与 `play: [Hit(...)]` 必须产出同一份 JSON。
 * 所有吃动作序列的位置（`play` / `then` / `else` / `do` / `deathrattle`）都过这个函数。
 */
export function toActs(acts: ActLike | undefined): readonly Act[] {
  return toArray(acts);
}

// ── 伤害与治疗 ──────────────────────────────────────────────────────────────

/** `act.hit`：造成伤害。`spellDamage` 表示是否吃法术伤害加成。 */
export function Hit(target: Sel, amount: Num, spellDamage?: boolean): ActNode<"act.hit"> {
  const node: ActNode<"act.hit"> = { op: "act.hit", target, amount };
  if (spellDamage !== undefined) {
    node.spellDamage = spellDamage;
  }
  return node;
}

/** `act.heal`：治疗。 */
export function Heal(target: Sel, amount: Num): ActNode<"act.heal"> {
  return { op: "act.heal", target, amount };
}

/** `act.set_health`：直接设置血量。 */
export function SetHealth(target: Sel, value: Num): ActNode<"act.set_health"> {
  return { op: "act.set_health", target, value };
}

/** `act.gain_armor`：获得护甲（落在 `armor` tag 上）。 */
export function GainArmor(target: Sel, amount: Num): ActNode<"act.gain_armor"> {
  return { op: "act.gain_armor", target, amount };
}

// ── 牌与区域 ────────────────────────────────────────────────────────────────

/** `act.draw`：抽牌，`count` 默认 1。 */
export function Draw(player: Sel, count?: Num): ActNode<"act.draw"> {
  const node: ActNode<"act.draw"> = { op: "act.draw", player };
  if (count !== undefined) {
    node.count = count;
  }
  return node;
}

/** `act.give`：生成到手牌，`count` 默认 1。 */
export function Give(player: Sel, card: CardRef, count?: Num): ActNode<"act.give"> {
  const node: ActNode<"act.give"> = { op: "act.give", player, card };
  if (count !== undefined) {
    node.count = count;
  }
  return node;
}

/**
 * `AddToHand(CONTROLLER, CHOSEN)`（IR §10.5）—— `Give` 的糖：
 * 第二参写选择器时自动包成 `card.of`，写字符串时就是字面卡牌 id。
 */
export function AddToHand(player: Sel, card: CardRef | Sel, count?: Num): ActNode<"act.give"> {
  return Give(player, toCardRef(card), count);
}

/** `act.shuffle`：洗入牌库，`count` 默认 1。 */
export function Shuffle(player: Sel, card: CardRef, count?: Num): ActNode<"act.shuffle"> {
  const node: ActNode<"act.shuffle"> = { op: "act.shuffle", player, card };
  if (count !== undefined) {
    node.count = count;
  }
  return node;
}

/** `act.discard`：弃牌。 */
export function Discard(target: Sel): ActNode<"act.discard"> {
  return { op: "act.discard", target };
}

/** `act.move`：移动到某区域，`side` 默认 `"owner"`。 */
export function Move(target: Sel, zone: ZoneName, side?: MoveSide, pos?: Num): ActNode<"act.move"> {
  const node: ActNode<"act.move"> = { op: "act.move", target, zone };
  if (side !== undefined) {
    node.side = side;
  }
  if (pos !== undefined) {
    node.pos = pos;
  }
  return node;
}

/** `act.steal`：偷取到 `to` 所属玩家。 */
export function Steal(target: Sel, to: Sel): ActNode<"act.steal"> {
  return { op: "act.steal", target, to };
}

// ── 场面 ────────────────────────────────────────────────────────────────────

/**
 * `Summon(CONTROLLER, "id")` / `Summon(CONTROLLER, "id", At(FRIENDLY, Num))`（v2 §7）。
 *
 * `at` 省略时补 `slot.random_empty(friendly)` —— v2 §3.4 要求规范形式里 `at` 必填，
 * 把随机落点显式化，RNG 顺序才可审计。`count > 1` 时每个后续单位重新求值 `at`。
 */
export function Summon(
  player: Sel,
  card: CardRef,
  at: SlotRef = RandomEmptySlot("friendly"),
  count?: Num,
): ActNode<"act.summon"> {
  const node: ActNode<"act.summon"> = { op: "act.summon", player, card, at };
  if (count !== undefined) {
    node.count = count;
  }
  return node;
}

/** `act.destroy`：直接消灭。 */
export function Destroy(target: Sel): ActNode<"act.destroy"> {
  return { op: "act.destroy", target };
}

/** `act.transform`：变形为另一张卡。 */
export function Transform(target: Sel, card: CardRef): ActNode<"act.transform"> {
  return { op: "act.transform", target, card };
}

// ── 属性修改 ────────────────────────────────────────────────────────────────

/** `act.buff`：附加附魔。v2 §8.1 斜刺长枪兵：`Buff(SELF, "GRID_001e")`。 */
export function Buff(target: Sel, ench: EnchantId): ActNode<"act.buff"> {
  return { op: "act.buff", target, ench };
}

/** `act.silence`：剥离附魔并复位 tag —— 包括 `direction`（v2 §2.3 的免费收益）。 */
export function Silence(target: Sel): ActNode<"act.silence"> {
  return { op: "act.silence", target };
}

/** `act.set_tag`：设置属性。 */
export function SetTag(target: Sel, tag: TagKey, value: Num): ActNode<"act.set_tag"> {
  return { op: "act.set_tag", target, tag, value };
}

/** `act.mod_tag`：增减属性。 */
export function ModTag(target: Sel, tag: TagKey, delta: Num): ActNode<"act.mod_tag"> {
  return { op: "act.mod_tag", target, tag, delta };
}

/** `SetTag(target, "direction", value)` 的别名 —— 方向是普通 Tag，不是新机制（v2 §2.3）。 */
export function SetDirection(target: Sel, value: Num): ActNode<"act.set_tag"> {
  return SetTag(target, "direction", value);
}

/** `ModTag(target, "direction", delta)` 的别名。 */
export function ModDirection(target: Sel, delta: Num): ActNode<"act.mod_tag"> {
  return ModTag(target, "direction", delta);
}

/** `act.set_flag`：设置标志位。注意 `value` 是 boolean，不是 Num。 */
export function SetFlag(target: Sel, flag: FlagName, value: boolean): ActNode<"act.set_flag"> {
  return { op: "act.set_flag", target, flag, value };
}

// ── 位置四件套 + 出手（v2 §3.4 新增）────────────────────────────────────────

/** `act.move_to`：瞬移。`to` 被占或无效 → 跳过。发 `unit_moved` 事件。 */
export function MoveTo(target: Sel, to: SlotRef): ActNode<"act.move_to"> {
  return { op: "act.move_to", target, to };
}

/**
 * `act.shift`：位移。**逐格推，被占或到边即停，不连推**（v2 §3.3）。
 * `delta` 是带符号整数而不是 "left/right"：双方共享索引轴，左右随视角翻转，数轴不会。
 */
export function Shift(target: Sel, delta: Num): ActNode<"act.shift"> {
  return { op: "act.shift", target, delta };
}

/** `Push(X, 1)`（v2 §7）→ `act.shift(delta = +distance)`，索引增大方向。 */
export function Push(target: Sel, distance: Num = 1): ActNode<"act.shift"> {
  return Shift(target, distance);
}

/** `Pull(X, 1)`（v2 §7）→ `act.shift(delta = -distance)`，索引减小方向。 */
export function Pull(target: Sel, distance: Num = 1): ActNode<"act.shift"> {
  return Shift(target, typeof distance === "number" ? -distance : Neg(distance));
}

/** `act.swap`：换位。`a`、`b` 须各为单个在场单位，否则跳过。v2 §8.4 换位术。 */
export function Swap(a: Sel, b: Sel): ActNode<"act.swap"> {
  return { op: "act.swap", a, b };
}

/**
 * `Strike(SELF, COMBAT_TARGET(SELF))`（v2 §7）→ `act.strike`：
 * 立即出手一次，`amount` = attacker **当前** atk。内部走 `act.hit` 管线并发 `struck` 事件。
 */
export function Strike(attacker: Sel, target: Sel): ActNode<"act.strike"> {
  return { op: "act.strike", attacker, target };
}

// ── 资源（v2 §3.4 改名，v1 的 gain_mana / gain_max_mana 已删）───────────────

/** `act.gain_crystal`：本回合水晶。 */
export function GainCrystal(player: Sel, amount: Num): ActNode<"act.gain_crystal"> {
  return { op: "act.gain_crystal", player, amount };
}

/** `act.gain_crystal_cap`：水晶上限。 */
export function GainCrystalCap(player: Sel, amount: Num): ActNode<"act.gain_crystal_cap"> {
  return { op: "act.gain_crystal_cap", player, amount };
}

// ── 控制流 ──────────────────────────────────────────────────────────────────

/**
 * `when(cond, then, else?)`（IR §10.4 用的就是小写）→ `act.when`。
 * **只求值命中的那个分支**（IR §5.4 规则 4）。分支写单个动作或数组都行。
 */
export function when(cond: Cond, then: ActLike, otherwise?: ActLike): ActNode<"act.when"> {
  // `then` 是 IR §3.4 规定的字段名（act.when 的命中分支），不是 thenable：
  // IR 节点是纯数据、永不被 await，改名会让产物偏离规范。
  const node: ActNode<"act.when"> = { op: "act.when", cond, then: toActs(then) };
  if (otherwise !== undefined) {
    node.else = toActs(otherwise);
  }
  return node;
}

/**
 * `act.repeat`：重复 n 次。★ **每轮重新求值**（IR §5.3 规则 2）——
 * 与 `.random(n)` 的一次性求值语义完全不同，别写混。
 */
export function Repeat(n: Num, body: ActLike): ActNode<"act.repeat"> {
  return { op: "act.repeat", n, do: toActs(body) };
}

/** `act.for_each`：遍历，绑定 `IT`；**列表在循环开始时快照**（IR §5.3 规则 1）。 */
export function ForEach(of: Sel, body: ActLike): ActNode<"act.for_each"> {
  return { op: "act.for_each", of, do: toActs(body) };
}

// ── 挂起点（IR §3.4 / §6）───────────────────────────────────────────────────

/**
 * `act.discover`：发现。结果绑定到 `CHOSEN`，超时兜底取第一项（IR §6.1）。
 *
 * `show` / `pick` **总是写进 IR**（默认 3 / 1）：IR §10.5 的规范 JSON 就是这么写的，
 * 而"给玩家看几张、选几张"直接决定挂起协议的形状，显式化才好审计。
 */
export function Discover(from: Sel | Pool, show: Num = 3, pick: Num = 1): ActNode<"act.discover"> {
  return { op: "act.discover", from, show, pick };
}

/**
 * `act.select_target`：指定目标（第二目标 → 挂起等输入 → `CHOSEN`，v2 §8.4）。
 * 超时兜底：`optional=true` 则跳过，否则取第一个合法目标（IR §6.1）。
 */
export function SelectTarget(from: Sel, optional?: boolean): ActNode<"act.select_target"> {
  const node: ActNode<"act.select_target"> = { op: "act.select_target", from };
  if (optional !== undefined) {
    node.optional = optional;
  }
  return node;
}

/** `act.nothing`：空操作。 */
export function Nothing(): ActNode<"act.nothing"> {
  return { op: "act.nothing" };
}
