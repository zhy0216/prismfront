// act.* 节点族：动作（状态变更 + 事件）。
// 来源：IR v1 §3.4 + §9（基线）、DSL v2 §3.4（增/改/删）、§7（TS 权威类型）。
//
// ★ **字段声明顺序即求值顺序**（IR v1 §5.4 规则 1）：
//   一个动作的字段按签名中的**声明顺序**求值，`act.hit(target, amount)` → 先 target 后 amount。
//   推进 RNG 的节点（`sel.random` / `num.random` / `card.random` / `slot.random_empty`）
//   的求值顺序直接决定对局结果，所以下面每个成员的字段顺序**与规范签名逐字对齐，不许重排**。
//
// 没有 `act.seq`：**数组本身就是序列**，`play` / `then` / `do` 都是 `Act[]`（IR v1 §3.4）。

import type { CardRef, Pool } from "./card-ref.ts";
import type { EnchantId } from "./common.ts";
import type { Cond } from "./cond.ts";
import type { Num } from "./num.ts";
import type { Sel } from "./sel.ts";
import type { SlotRef } from "./slot.ts";
import type { FlagName, TagKey } from "./tag.ts";
import type { MoveSide, ZoneName } from "./zone.ts";

/**
 * 动作节点（IR v1 §3.4、DSL v2 §3.4）。
 *
 * 空集合语义（IR v1 §5.2）：`target` / `player` 求值为空集 → **静默跳过**，
 * 不报错、不产生事件。"造成 6 点伤害"打空气不该崩，也不该记事件。
 * 位置版同理（v2 §3.1）：SlotRef 参数解析为无效槽 → 该动作静默跳过。
 *
 * **v2 相对 v1 的删除项**（v2 §3.4）：
 * - `act.attack` —— 玩家指定攻击已不存在，效果驱动的出手改用 `act.strike`
 * - `act.gain_mana` → 改名 `act.gain_crystal`
 * - `act.gain_max_mana` → 改名 `act.gain_crystal_cap`
 */
export type Act =
  // ── 伤害与治疗（IR v1 §3.4）─────────────────────────────────────────────
  /** 造成伤害。`spellDamage` 表示是否吃法术伤害加成。 */
  | { op: "act.hit"; target: Sel; amount: Num; spellDamage?: boolean }
  /** 治疗。 */
  | { op: "act.heal"; target: Sel; amount: Num }
  /**
   * 直接设置血量。
   * 注：IR v1 §9 的 TS 类型漏了这一条，但 §3.4 的签名表有它，
   * 且 v2 §7 的"v1 保留"清单明确列出 `set_health` —— 以保留为准。
   */
  | { op: "act.set_health"; target: Sel; value: Num }
  /** 获得护甲（落在 `armor` tag 上）。 */
  | { op: "act.gain_armor"; target: Sel; amount: Num }

  // ── 牌与区域（IR v1 §3.4）───────────────────────────────────────────────
  /** 抽牌。`count` 默认 1。 */
  | { op: "act.draw"; player: Sel; count?: Num }
  /** 生成到手牌。`count` 默认 1。 */
  | { op: "act.give"; player: Sel; card: CardRef; count?: Num }
  /** 洗入牌库。`count` 默认 1。 */
  | { op: "act.shuffle"; player: Sel; card: CardRef; count?: Num }
  /** 弃牌。 */
  | { op: "act.discard"; target: Sel }
  /** 移动到某区域。`side` 默认 `"owner"`。 */
  | { op: "act.move"; target: Sel; zone: ZoneName; side?: MoveSide; pos?: Num }
  /** 偷取到 `to` 所属玩家。 */
  | { op: "act.steal"; target: Sel; to: Sel }

  // ── 场面（IR v1 §3.4，summon 在 v2 §3.4 变更）────────────────────────────
  /**
   * 召唤到指定格。
   *
   * **`at` 在规范形式中必填**（v2 §3.4）：TS builder 省略时由编译器补
   * `{op:"slot.random_empty", side:"friendly"}`，显式化以保证 RNG 顺序可审计。
   * `at` 被占或无效 → 跳过；`count > 1` 时**每个后续单位重新求值 `at`**。
   */
  | { op: "act.summon"; player: Sel; card: CardRef; at: SlotRef; count?: Num }
  /** 直接消灭。 */
  | { op: "act.destroy"; target: Sel }
  /** 变形为另一张卡。 */
  | { op: "act.transform"; target: Sel; card: CardRef }

  // ── 属性修改（IR v1 §3.4）───────────────────────────────────────────────
  /** 附加附魔。`ench` 指向 bundle 的 `enchantments`（L3 校验引用完整性）。 */
  | { op: "act.buff"; target: Sel; ench: EnchantId }
  /** 沉默：剥离附魔并复位 tag —— 包括 `direction`（v2 §2.3 的免费收益）。 */
  | { op: "act.silence"; target: Sel }
  /** 设置属性。 */
  | { op: "act.set_tag"; target: Sel; tag: TagKey; value: Num }
  /** 增减属性。 */
  | { op: "act.mod_tag"; target: Sel; tag: TagKey; delta: Num }
  /** 设置标志位。注意这里的 `value` 是 boolean，不是 Num。 */
  | { op: "act.set_flag"; target: Sel; flag: FlagName; value: boolean }

  // ── 位置四件套 + 出手（DSL v2 §3.4 新增）─────────────────────────────────
  /** 瞬移。`to` 被占或无效 → 跳过。发 `unit_moved` 事件。 */
  | { op: "act.move_to"; target: Sel; to: SlotRef }
  /**
   * 位移：**逐格推，被占或到边即停，不连推**（v2 §3.3 示例）。
   * `delta` 用带符号整数而不是 "left/right" —— 双方索引轴共享，
   * "左右"随视角翻转，数轴不会。builder 用 `Push` / `Pull` 处理符号。
   * 字面量 0 → 告警（无操作，多半是笔误，v2 §9）。
   */
  | { op: "act.shift"; target: Sel; delta: Num }
  /** 换位。`a`、`b` 须各为单个在场单位，否则跳过。 */
  | { op: "act.swap"; a: Sel; b: Sel }
  /**
   * 立即出手一次：`amount` 缺省 = attacker **当前** atk（v2 §3.4）。
   * 内部走 `act.hit` 管线（拦截器因此两处都能拦），并发 `struck` 事件。
   * 绿色的解牌"决斗"就是它（《数值基准》§1.2）。
   *
   * ★ `amount` 是**运行时超集**字段（IR v1 §5.6），编写子集不开放 ★
   * 它的唯一来源是战斗第 ② 步的快照（v2 §4.2「记录 {attacker, target, amount}，
   * 记录后列表与数值全部冻结」）：引擎把冻结下来的那个数写进这个字段，
   * 于是「批次中途 atk 变了」不再影响已经冻结的出手 —— 冻结值是随动作一起
   * 走完管线的，而不是在应用那一刻重新读一次 `attacker.tags.atk`。
   *
   * 编写层**没有**写它的路径（`builder/act.ts` 的 `Strike` 只收两个参数），
   * 与 `sel.entity` 是同一条边界：运行时超集只由引擎自己生成，永不来自外部输入
   * （IR v1 §5.6 末句，UGC 场景的安全边界）。L3 要把「bundle 里出现
   * `act.strike.amount`」判成编写子集违规（M11，与禁 `sel.entity` 同一条）。
   *
   * ⚠ 缺省语义**一字未改**：没有这个字段的 `act.strike` 仍然是「attacker 当前 atk」，
   *   所以既有 bundle 的含义与字节都没动 —— 版本按 minor 记，理由写在 `ir-version.ts`。
   *
   * ⚠ 副作用（有意接受）：`amount` 进了 {@link ACT_NUM_FIELDS} 的可读写面，于是
   *   `num.field("amount")` / `set_field` / `mod_field` 拦 `act.strike` 对**战斗出手**
   *   真的生效（减伤因此在 §3.4 说的"两处"都拦得住）；而卡牌驱动的
   *   `Strike(a, t)` 没有这个字段，`set_field` 对它静默跳过（IR v1 §5.2）——
   *   要拦那一条请拦它内部压出来的 `act.hit`。
   */
  | { op: "act.strike"; attacker: Sel; target: Sel; amount?: Num }

  // ── 资源（DSL v2 §3.4 改名，v1 的 gain_mana / gain_max_mana 已删）──────────
  /** 本回合水晶。 */
  | { op: "act.gain_crystal"; player: Sel; amount: Num }
  /** 水晶上限。 */
  | { op: "act.gain_crystal_cap"; player: Sel; amount: Num }

  // ── 控制流（IR v1 §3.4）─────────────────────────────────────────────────
  /** 条件分支。**只求值命中的那个分支**（IR v1 §5.4 规则 4）。 */
  | { op: "act.when"; cond: Cond; then: readonly Act[]; else?: readonly Act[] }
  /**
   * 重复 n 次。★ **每轮重新求值**（IR v1 §5.3 规则 2）——
   * 与 `sel.random(n)` 的一次性求值语义完全不同，别写混。
   * `n` 为字面量时上限 64（IR v1 §7 资源上限）。
   */
  | { op: "act.repeat"; n: Num; do: readonly Act[] }
  /** 遍历。绑定 `sel.it`；**列表在循环开始时快照**（IR v1 §5.3 规则 1）。 */
  | { op: "act.for_each"; of: Sel; do: readonly Act[] }

  // ── 需要玩家输入：挂起点（IR v1 §3.4 / §6）───────────────────────────────
  /**
   * 发现。`show` 默认 3，`pick` 默认 1。结果绑定到 `sel.chosen`。
   * 超时兜底：取第一项（IR v1 §6.1）。
   */
  | { op: "act.discover"; from: Sel | Pool; show?: Num; pick?: Num }
  /**
   * 指定目标。结果绑定到 `sel.chosen`。
   * 超时兜底：`optional=true` 则跳过，否则取第一个合法目标（IR v1 §6.1）。
   */
  | { op: "act.select_target"; from: Sel; optional?: boolean }

  /** 空操作。 */
  | { op: "act.nothing" };

/** `act.*` 的 op 全集。handler 表写成 `Record<ActOp, Handler>` 即可获得穷尽检查。 */
export type ActOp = Act["op"];

/** 按 op 取出单个动作节点类型，例：`ActNode<"act.hit">`。无参时等价于 `Act`。 */
export type ActNode<K extends ActOp = ActOp> = Extract<Act, { op: K }>;

/**
 * 动作里**实体（Sel）类**字段的名字。
 *
 * 用途：`intercept.filter` 的键（IR v1 §4.2）—— 按被拦截动作的实体字段过滤，
 * 例如圣盾写 `filter: { target: sel.self }`。
 *
 * 控制流与挂起点的集合参数（`act.for_each.of`、`act.discover.from`、
 * `act.select_target.from`）不在此列：拦截它们没有语义。
 *
 * ⚠ `"to"` 在 `act.steal` 里是 Sel、在 `act.move_to` 里是 SlotRef，
 * 只有前者可作为过滤对象。
 */
export const ACT_ENTITY_FIELDS = ["target", "player", "attacker", "a", "b", "to"] as const;

export type ActEntityField = (typeof ACT_ENTITY_FIELDS)[number];

/**
 * 动作里**数值（Num）类**字段的名字。
 *
 * 用途：`num.field(field)`（拦截器上下文专用节点，读取被拦截动作的字段值，IR v1 §4.2）
 * 与 `intercept.effect` 的 `set_field` / `mod_field`。
 *
 * 逐个来源：
 * `amount`（hit/heal/gain_armor/gain_crystal/gain_crystal_cap，
 * 外加 **strike 的运行时超集字段**，见 `act.strike` 的说明）、
 * `value`（set_health/set_tag）、`count`（draw/give/shuffle/summon）、
 * `pos`（move）、`delta`（mod_tag/shift）、`n`（repeat）、`show` `pick`（discover）。
 *
 * ⚠ `act.set_flag.value` 是 boolean，不是 Num —— 对它用 `num.field` 无意义。
 */
export const ACT_NUM_FIELDS = [
  "amount",
  "value",
  "count",
  "pos",
  "delta",
  "n",
  "show",
  "pick",
] as const;

export type ActNumField = (typeof ACT_NUM_FIELDS)[number];
