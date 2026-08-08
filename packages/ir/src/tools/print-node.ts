// 节点级反编译：`sel.*` / `slot.*` / `num.*` / `cond.*` / `card.*` / `act.*` → TS 风格文本。
//
// 定位（IR §11）：`ir:print <cardId>` 的作用是「IR → TS 风格文本（反编译器）。调试和
// admin 展示用」，而 IR §1 原则 3 把它列为"可读性由工具解决，不由格式牺牲"的那个工具。
// 所以本文件是 `builder/` 的**逆运算**：builder 把糖编译成规范形式，printer 把规范形式
// 打回糖。两边的用词必须一致 —— 每个 case 的目标名字都能在 `builder/` 里找到同名导出
// （唯一例外是 `sel.entity`，见该 case 的注释）。
//
// 三条实现约定：
//
// 1. **穷尽 switch + `unreachable(node: never)`**：`Act` / `Sel` / `Num` / `Cond` /
//    `SlotRef` 都是按 `op` 判别的联合，加一个 op 而这里漏写 → 编译不过。
//    这是"反编译器不会悄悄漏掉新 op"的编译期保险（运行期保险是
//    `__tests__/print-card.test.ts` 的叶子覆盖测试）。
// 2. **不做规范化**：printer 只渲染，不重排、不补默认值（那是 `builder/canonical.ts`）。
//    喂进来什么形状就打出什么形状，两者的分工不重叠。
// 3. **还原策略见 `names.ts` 顶部**：具名常量整表还原、标量字段决定的别名还原、
//    结构改写型的糖与摊平型链式方法不还原。
//
// 零依赖，只 import `../types/`（权威类型）与本目录的排版原语。

import type {
  Act,
  CardKind,
  CardRef,
  Color,
  Cond,
  Num,
  Pool,
  Sel,
  SlotRef,
  ZoneName,
} from "../types/index.ts";
import {
  booleanLiteral,
  emitArray,
  emitCall,
  isList,
  nested,
  numberLiteral,
  type PrintContext,
  positional,
  quote,
} from "./format.ts";
import {
  boardKindConstantName,
  COLOR_PREDICATE_NAMES,
  EVENT_ENTITY_CONSTANTS,
  GLOBAL_NUM_CONSTANTS,
  KIND_PREDICATE_NAMES,
  SEL_LEAF_CONSTANTS,
  sideConstant,
  zoneConstantName,
} from "./names.ts";

/** 联合类型没穷尽时的兜底。类型正确的调用永远到不了这里。 */
function unreachable(value: never): never {
  throw new TypeError(`无法反编译的 IR 节点：${JSON.stringify(value)}`);
}

// ── 标量参数 ────────────────────────────────────────────────────────────────

function printZoneArg(zone: ZoneName | readonly ZoneName[], ctx: PrintContext): string {
  return typeof zone === "string" ? quote(zone) : emitArray(zone.map(quote), ctx);
}

function printKindArg(kind: CardKind | readonly CardKind[], ctx: PrintContext): string {
  return typeof kind === "string" ? quote(kind) : emitArray(kind.map(quote), ctx);
}

function printColorArg(color: Color | readonly Color[], ctx: PrintContext): string {
  return typeof color === "string" ? quote(color) : emitArray(color.map(quote), ctx);
}

function printSlotArg(slot: SlotRef | readonly SlotRef[], ctx: PrintContext): string {
  if (isList(slot)) {
    return emitArray(
      slot.map((one) => printSlot(one, nested(ctx))),
      ctx,
    );
  }
  return printSlot(slot, ctx);
}

// ── sel.* ───────────────────────────────────────────────────────────────────

/**
 * `zone(side,"board").where(is_kind(it, kind))` → `FRIENDLY_MINIONS` / `ENEMY_HEROES` …
 * （v2.1 §11.2 的词汇分化，见 `names.ts` 的 `BOARD_KIND_CONSTANTS`）。
 */
function boardKindConstantOf(of: Sel, cond: Cond): string | undefined {
  if (of.op !== "sel.zone" || of.zone !== "board") {
    return undefined;
  }
  if (typeof cond === "boolean" || cond.op !== "cond.is_kind") {
    return undefined;
  }
  if (cond.of.op !== "sel.it" || typeof cond.kind !== "string") {
    return undefined;
  }
  return boardKindConstantName(of.side, cond.kind);
}

/** 反编译一个选择器。 */
export function printSel(node: Sel, ctx: PrintContext): string {
  const inner = nested(ctx);
  switch (node.op) {
    case "sel.self":
    case "sel.target":
    case "sel.controller":
    case "sel.opponent":
    case "sel.chosen":
    case "sel.it":
      return SEL_LEAF_CONSTANTS[node.op];
    case "sel.event":
      return EVENT_ENTITY_CONSTANTS[node.field];
    case "sel.entity":
      // IR §5.6 的**运行时超集**：编写层没有（也不该有）对应构造器，
      // builder 刻意不提供写它的路径。打成 `Entity(id)` 只为 dump 结算栈时可读
      // （IR §1 原则 2 末句），它不是可以贴回卡牌源码的写法。
      return emitCall("Entity", [numberLiteral(node.id)], ctx);
    case "sel.zone": {
      const named = zoneConstantName(node.side, node.zone);
      return (
        named ?? emitCall("Zone", [sideConstant(node.side), printZoneArg(node.zone, inner)], ctx)
      );
    }
    case "sel.and":
      return emitCall(
        "Intersect",
        node.of.map((one) => printSel(one, inner)),
        ctx,
      );
    case "sel.or":
      return emitCall(
        "Union",
        node.of.map((one) => printSel(one, inner)),
        ctx,
      );
    case "sel.minus":
      return emitCall(`${printSel(node.of, ctx)}.not`, [printSel(node.exclude, inner)], ctx);
    case "sel.where": {
      const named = boardKindConstantOf(node.of, node.cond);
      return (
        named ?? emitCall(`${printSel(node.of, ctx)}.where`, [printCond(node.cond, inner)], ctx)
      );
    }
    case "sel.random":
      return emitCall(
        `${printSel(node.of, ctx)}.random`,
        positional([
          node.n === undefined ? undefined : printNum(node.n, inner),
          node.distinct === undefined ? undefined : booleanLiteral(node.distinct),
        ]),
        ctx,
      );
    case "sel.limit":
      return emitCall(
        `${printSel(node.of, ctx)}.limit`,
        positional([
          printNum(node.n, inner),
          node.from === undefined ? undefined : quote(node.from),
        ]),
        ctx,
      );
    case "sel.sort":
      return emitCall(
        `${printSel(node.of, ctx)}.sort`,
        positional([quote(node.by), node.dir === undefined ? undefined : quote(node.dir)]),
        ctx,
      );
    case "sel.at":
      return emitCall("UnitsAt", [printSlotArg(node.slot, inner)], ctx);
    case "sel.opposite":
      return emitCall("OPPOSITE", [printSel(node.of, inner)], ctx);
    case "sel.combat_target":
      return emitCall("COMBAT_TARGET", [printSel(node.of, inner)], ctx);
    case "sel.attackers_of":
      return emitCall("AttackersOf", [printSel(node.of, inner)], ctx);
    case "sel.adjacent":
      return emitCall(
        "Adjacent",
        positional([
          printSel(node.of, inner),
          node.dist === undefined ? undefined : printNum(node.dist, inner),
        ]),
        ctx,
      );
    default:
      return unreachable(node);
  }
}

// ── slot.* ──────────────────────────────────────────────────────────────────

/** 反编译一个位置引用。 */
export function printSlot(node: SlotRef, ctx: PrintContext): string {
  const inner = nested(ctx);
  switch (node.op) {
    case "slot.at":
      return emitCall("At", [sideConstant(node.side), printNum(node.index, inner)], ctx);
    case "slot.of":
      return emitCall("SlotOf", [printSel(node.of, inner)], ctx);
    case "slot.opposite":
      // v2 §8.2 空袭猎手写的就是 `SlotOf(SELF).opposite()`。
      return emitCall(`${printSlot(node.of, ctx)}.opposite`, [], ctx);
    case "slot.shift":
      return emitCall(`${printSlot(node.of, ctx)}.shift`, [printNum(node.delta, inner)], ctx);
    case "slot.random_empty":
      return emitCall("RandomEmptySlot", [sideConstant(node.side)], ctx);
    case "slot.first_empty":
      return emitCall(
        "FirstEmptySlot",
        positional([
          sideConstant(node.side),
          node.from === undefined ? undefined : quote(node.from),
        ]),
        ctx,
      );
    default:
      return unreachable(node);
  }
}

// ── num.* ───────────────────────────────────────────────────────────────────

/** 反编译一个数值（字面数字直接打数字 —— IR §1 原则 4，字面量不包装）。 */
export function printNum(node: Num, ctx: PrintContext): string {
  if (typeof node === "number") {
    return numberLiteral(node);
  }
  const inner = nested(ctx);
  switch (node.op) {
    case "num.count":
      return emitCall("Count", [printSel(node.of, inner)], ctx);
    case "num.attr":
      // 方向是普通 Tag（v2 §2.3），但 builder 给了 `Direction(of)` 这个读数别名。
      return node.tag === "direction"
        ? emitCall("Direction", [printSel(node.of, inner)], ctx)
        : emitCall("Attr", [printSel(node.of, inner), quote(node.tag)], ctx);
    case "num.sum":
      return emitCall("Sum", [printSel(node.of, inner), quote(node.tag)], ctx);
    case "num.add":
      return emitCall(
        "Add",
        node.of.map((one) => printNum(one, inner)),
        ctx,
      );
    case "num.mul":
      return emitCall(
        "Mul",
        node.of.map((one) => printNum(one, inner)),
        ctx,
      );
    case "num.max":
      return emitCall(
        "Max",
        node.of.map((one) => printNum(one, inner)),
        ctx,
      );
    case "num.min":
      return emitCall(
        "Min",
        node.of.map((one) => printNum(one, inner)),
        ctx,
      );
    case "num.sub":
      return emitCall("Sub", [printNum(node.l, inner), printNum(node.r, inner)], ctx);
    case "num.div":
      return emitCall("Div", [printNum(node.l, inner), printNum(node.r, inner)], ctx);
    case "num.neg":
      // IR §10.4 谜之勇士：`Count(FRIENDLY_MINIONS).negate()`。
      // 字面数字挂不住链式方法（`2 .negate()` 不合法），退回自由函数 `Neg(2)`。
      return typeof node.of === "number"
        ? emitCall("Neg", [numberLiteral(node.of)], ctx)
        : emitCall(`${printNum(node.of, ctx)}.negate`, [], ctx);
    case "num.clamp":
      return emitCall(
        "Clamp",
        [printNum(node.of, inner), printNum(node.lo, inner), printNum(node.hi, inner)],
        ctx,
      );
    case "num.if":
      return emitCall(
        "NumIf",
        [printCond(node.cond, inner), printNum(node.then, inner), printNum(node.else, inner)],
        ctx,
      );
    case "num.random":
      return emitCall("RandomInt", [printNum(node.lo, inner), printNum(node.hi, inner)], ctx);
    case "num.tag":
      return GLOBAL_NUM_CONSTANTS[node.tag];
    case "num.field":
      return emitCall("Field", [quote(node.field)], ctx);
    case "num.slot_index":
      return emitCall("SlotIndex", [printSel(node.of, inner)], ctx);
    default:
      return unreachable(node);
  }
}

// ── cond.* ──────────────────────────────────────────────────────────────────

/**
 * 比较类条件。`l` 是节点时打链式（IR §10.4 `Attr(SELF,"atk").gte(3)`、
 * §10.6 `Field("amount").gt(0)`），是字面数字时退回自由函数（字面量挂不住方法）。
 */
function printComparison(method: string, free: string, l: Num, r: Num, ctx: PrintContext): string {
  const inner = nested(ctx);
  if (typeof l === "number") {
    return emitCall(free, [numberLiteral(l), printNum(r, inner)], ctx);
  }
  return emitCall(`${printNum(l, ctx)}.${method}`, [printNum(r, inner)], ctx);
}

/** 反编译一个条件（字面布尔直接打 —— IR §1 原则 4）。 */
export function printCond(node: Cond, ctx: PrintContext): string {
  if (typeof node === "boolean") {
    return booleanLiteral(node);
  }
  const inner = nested(ctx);
  switch (node.op) {
    case "cond.exists":
      return emitCall(
        "Exists",
        positional([
          printSel(node.of, inner),
          node.atLeast === undefined ? undefined : printNum(node.atLeast, inner),
        ]),
        ctx,
      );
    case "cond.eq":
      return printComparison("eq", "Eq", node.l, node.r, ctx);
    case "cond.ne":
      return printComparison("ne", "Ne", node.l, node.r, ctx);
    case "cond.gt":
      return printComparison("gt", "Gt", node.l, node.r, ctx);
    case "cond.gte":
      return printComparison("gte", "Gte", node.l, node.r, ctx);
    case "cond.lt":
      return printComparison("lt", "Lt", node.l, node.r, ctx);
    case "cond.lte":
      return printComparison("lte", "Lte", node.l, node.r, ctx);
    case "cond.and":
      return emitCall(
        "And",
        node.of.map((one) => printCond(one, inner)),
        ctx,
      );
    case "cond.or":
      return emitCall(
        "Or",
        node.of.map((one) => printCond(one, inner)),
        ctx,
      );
    case "cond.not":
      // v2 §8.2 空袭猎手：`Not(Occupied(SlotOf(SELF).opposite()))`。
      // 用自由函数而不是链式 `.not()`：`Sel` 上的 `.not()` 是差集，同名不同义，
      // 打成自由函数就没有这层歧义。
      return emitCall("Not", [printCond(node.of, inner)], ctx);
    case "cond.has_tag":
      return emitCall(
        "HasTag",
        positional([
          printSel(node.of, inner),
          quote(node.tag),
          node.value === undefined ? undefined : printNum(node.value, inner),
        ]),
        ctx,
      );
    case "cond.has_flag":
      return emitCall("HasFlag", [printSel(node.of, inner), quote(node.flag)], ctx);
    case "cond.is_kind": {
      const predicate = typeof node.kind === "string" ? KIND_PREDICATE_NAMES[node.kind] : undefined;
      if (predicate !== undefined) {
        // `IsSpell()` / `IsMinion()`：省略实参即判迭代游标 `IT`（IR §10.5 的写法）。
        return node.of.op === "sel.it"
          ? emitCall(predicate, [], ctx)
          : emitCall(predicate, [printSel(node.of, inner)], ctx);
      }
      return emitCall("IsKind", [printSel(node.of, inner), printKindArg(node.kind, inner)], ctx);
    }
    case "cond.has_color": {
      if (typeof node.color === "string") {
        // `IsRed()` / `IsBlue()`：省略实参即判迭代游标 `IT`（卡池过滤的写法，决策 #9）。
        const predicate = COLOR_PREDICATE_NAMES[node.color];
        return node.of.op === "sel.it"
          ? emitCall(predicate, [], ctx)
          : emitCall(predicate, [printSel(node.of, inner)], ctx);
      }
      return emitCall(
        "HasColor",
        [printSel(node.of, inner), printColorArg(node.color, inner)],
        ctx,
      );
    }
    case "cond.has_tribe":
      return emitCall("HasTribe", [printSel(node.of, inner), quote(node.tribe)], ctx);
    case "cond.in_zone":
      return emitCall("InZone", [printSel(node.of, inner), quote(node.zone)], ctx);
    case "cond.dead":
      return emitCall("IsDead", [printSel(node.of, inner)], ctx);
    case "cond.occupied":
      return emitCall("Occupied", [printSlot(node.slot, inner)], ctx);
    default:
      return unreachable(node);
  }
}

// ── card.* ──────────────────────────────────────────────────────────────────

/** 反编译一个卡池。 */
export function printPool(pool: Pool, ctx: PrintContext): string {
  return emitCall("CardPool", [printCond(pool.filter, nested(ctx))], ctx);
}

/** 反编译 `Sel | Pool`（`card.random.from` 与 `act.discover.from` 的参数位）。 */
export function printSelOrPool(from: Sel | Pool, ctx: PrintContext): string {
  return from.op === "card.pool" ? printPool(from, ctx) : printSel(from, ctx);
}

/** 反编译一个卡牌引用（字面 cardId 直接打字符串 —— IR §1 原则 4）。 */
export function printCardRef(ref: CardRef, ctx: PrintContext): string {
  if (typeof ref === "string") {
    return quote(ref);
  }
  const inner = nested(ctx);
  switch (ref.op) {
    case "card.of":
      return emitCall("CardOf", [printSel(ref.of, inner)], ctx);
    case "card.random":
      return emitCall("RandomCard", [printSelOrPool(ref.from, inner)], ctx);
    default:
      return unreachable(ref);
  }
}

// ── act.* ───────────────────────────────────────────────────────────────────

/**
 * 动作序列。**单个动作打成裸动作**（`play: Buff(SELF, "GRID_001e")`，v2 §8.1），
 * 多个打成数组（`play: [Hit(TARGET, 2), Push(TARGET, 1)]`，v2 §8.3）——
 * builder 的 `toActs` 两种都收且产出同一份 JSON（IR §1 原则 1），所以这是可逆的。
 */
export function printActs(acts: readonly Act[], ctx: PrintContext): string {
  const [only] = acts;
  if (acts.length === 1 && only !== undefined) {
    return printAct(only, ctx);
  }
  return emitArray(
    acts.map((act) => printAct(act, nested(ctx))),
    ctx,
  );
}

/** 反编译一个动作。 */
export function printAct(node: Act, ctx: PrintContext): string {
  const inner = nested(ctx);
  switch (node.op) {
    case "act.hit":
      return emitCall(
        "Hit",
        positional([
          printSel(node.target, inner),
          printNum(node.amount, inner),
          node.spellDamage === undefined ? undefined : booleanLiteral(node.spellDamage),
        ]),
        ctx,
      );
    case "act.heal":
      return emitCall("Heal", [printSel(node.target, inner), printNum(node.amount, inner)], ctx);
    case "act.set_health":
      return emitCall(
        "SetHealth",
        [printSel(node.target, inner), printNum(node.value, inner)],
        ctx,
      );
    case "act.gain_armor":
      return emitCall(
        "GainArmor",
        [printSel(node.target, inner), printNum(node.amount, inner)],
        ctx,
      );
    case "act.draw":
      return emitCall(
        "Draw",
        positional([
          printSel(node.player, inner),
          node.count === undefined ? undefined : printNum(node.count, inner),
        ]),
        ctx,
      );
    case "act.give":
      return emitCall(
        "Give",
        positional([
          printSel(node.player, inner),
          printCardRef(node.card, inner),
          node.count === undefined ? undefined : printNum(node.count, inner),
        ]),
        ctx,
      );
    case "act.shuffle":
      return emitCall(
        "Shuffle",
        positional([
          printSel(node.player, inner),
          printCardRef(node.card, inner),
          node.count === undefined ? undefined : printNum(node.count, inner),
        ]),
        ctx,
      );
    case "act.discard":
      return emitCall("Discard", [printSel(node.target, inner)], ctx);
    case "act.move":
      return emitCall(
        "Move",
        positional([
          printSel(node.target, inner),
          quote(node.zone),
          node.side === undefined ? undefined : quote(node.side),
          node.pos === undefined ? undefined : printNum(node.pos, inner),
        ]),
        ctx,
      );
    case "act.steal":
      return emitCall("Steal", [printSel(node.target, inner), printSel(node.to, inner)], ctx);
    case "act.summon":
      // `at` 在规范形式里必填（v2 §3.4），**永远显式打出来** ——
      // 把随机落点显式化正是那条规定的理由（RNG 顺序可审计）。
      return emitCall(
        "Summon",
        positional([
          printSel(node.player, inner),
          printCardRef(node.card, inner),
          printSlot(node.at, inner),
          node.count === undefined ? undefined : printNum(node.count, inner),
        ]),
        ctx,
      );
    case "act.destroy":
      return emitCall("Destroy", [printSel(node.target, inner)], ctx);
    case "act.transform":
      return emitCall(
        "Transform",
        [printSel(node.target, inner), printCardRef(node.card, inner)],
        ctx,
      );
    case "act.buff":
      return emitCall("Buff", [printSel(node.target, inner), quote(node.ench)], ctx);
    case "act.silence":
      return emitCall("Silence", [printSel(node.target, inner)], ctx);
    case "act.set_tag":
      return node.tag === "direction"
        ? emitCall("SetDirection", [printSel(node.target, inner), printNum(node.value, inner)], ctx)
        : emitCall(
            "SetTag",
            [printSel(node.target, inner), quote(node.tag), printNum(node.value, inner)],
            ctx,
          );
    case "act.mod_tag":
      return node.tag === "direction"
        ? emitCall("ModDirection", [printSel(node.target, inner), printNum(node.delta, inner)], ctx)
        : emitCall(
            "ModTag",
            [printSel(node.target, inner), quote(node.tag), printNum(node.delta, inner)],
            ctx,
          );
    case "act.set_flag":
      return emitCall(
        "SetFlag",
        [printSel(node.target, inner), quote(node.flag), booleanLiteral(node.value)],
        ctx,
      );
    case "act.move_to":
      return emitCall("MoveTo", [printSel(node.target, inner), printSlot(node.to, inner)], ctx);
    case "act.shift": {
      // `Push` / `Pull` 只吃**字面量**符号（v2 §7：`Push(X,1)` / `Pull(X,1)`
      // = `act.shift(delta = +1 / -1)`）。delta 是节点时符号未知，打回 `Shift`。
      const target = printSel(node.target, inner);
      if (typeof node.delta === "number" && node.delta > 0) {
        return emitCall("Push", [target, numberLiteral(node.delta)], ctx);
      }
      if (typeof node.delta === "number" && node.delta < 0) {
        return emitCall("Pull", [target, numberLiteral(-node.delta)], ctx);
      }
      return emitCall("Shift", [target, printNum(node.delta, inner)], ctx);
    }
    case "act.swap":
      return emitCall("Swap", [printSel(node.a, inner), printSel(node.b, inner)], ctx);
    case "act.strike": {
      // 第三个参数是**运行时超集**字段（IR §5.6，战斗第 ② 步冻结的出手数值），
      // 编写层的 `Strike` 只收两个参数 —— 与 `sel.entity` 打成 `Entity(id)` 是
      // 同一条例外：打出来只为 dump 结算栈时可读，**不是可以贴回卡牌源码的写法**。
      // 编写产物里不会出现它，所以 round-trip 语料照旧全部可贴回。
      const args = [printSel(node.attacker, inner), printSel(node.target, inner)];
      if (node.amount !== undefined) {
        args.push(printNum(node.amount, inner));
      }
      return emitCall("Strike", args, ctx);
    }
    case "act.gain_crystal":
      return emitCall(
        "GainCrystal",
        [printSel(node.player, inner), printNum(node.amount, inner)],
        ctx,
      );
    case "act.gain_crystal_cap":
      return emitCall(
        "GainCrystalCap",
        [printSel(node.player, inner), printNum(node.amount, inner)],
        ctx,
      );
    case "act.when":
      return emitCall(
        "when",
        positional([
          printCond(node.cond, inner),
          printActs(node.then, inner),
          node.else === undefined ? undefined : printActs(node.else, inner),
        ]),
        ctx,
      );
    case "act.repeat":
      return emitCall("Repeat", [printNum(node.n, inner), printActs(node.do, inner)], ctx);
    case "act.for_each":
      return emitCall("ForEach", [printSel(node.of, inner), printActs(node.do, inner)], ctx);
    case "act.discover": {
      // builder 的 `Discover(from, show = 3, pick = 1)` 总把默认值写进 IR（IR §10.5 的
      // 规范 JSON 就是 `show:3, pick:1`），所以打回去时把这对默认值省掉才是逆运算。
      const from = printSelOrPool(node.from, inner);
      const defaulted =
        (node.show === undefined || node.show === 3) &&
        (node.pick === undefined || node.pick === 1);
      if (defaulted) {
        return emitCall("Discover", [from], ctx);
      }
      return emitCall(
        "Discover",
        positional([
          from,
          node.show === undefined ? undefined : printNum(node.show, inner),
          node.pick === undefined ? undefined : printNum(node.pick, inner),
        ]),
        ctx,
      );
    }
    case "act.select_target":
      return emitCall(
        "SelectTarget",
        positional([
          printSel(node.from, inner),
          node.optional === undefined ? undefined : booleanLiteral(node.optional),
        ]),
        ctx,
      );
    case "act.nothing":
      return emitCall("Nothing", [], ctx);
    default:
      return unreachable(node);
  }
}
