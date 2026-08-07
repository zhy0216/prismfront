// 反编译器的排版原语 —— 一个够用就好的宽度感知 pretty-printer。
//
// 为什么需要排版而不是简单拼字符串：IR §1 原则 3「可读性由工具解决，不由格式牺牲」，
// `ir:print` 的产物要给人读（调试 + admin 后台展示卡牌逻辑）。一行到底的
// `defineCard({id:"GRID_001",name:"斜刺长枪兵",...})` 不算"打回 TS 风格文本"。
//
// 规则只有一条：**能放下就放一行，放不下就每个元素一行**。
// 折行宽度默认 100，与仓库 `biome.json` 的 `formatter.lineWidth` 一致，
// 于是把产物贴回 .ts 文件时不会被格式化器立刻改写。
//
// ⚠ 已知的近似：实参 / 数组元素 / 对象值都是**先渲染再摆放**的（渲染时只知道自己
// 属于哪一层缩进，还不知道最终落在第几列），所以嵌套元素判断"放不放得下"用的是
// 所在层的缩进而不是真实起始列，深层嵌套可能比 `width` 多出几个字符。
// 这是排版误差不是正确性问题（产物照样是合法 TS），`__tests__/print-card.test.ts`
// 的「折行宽度是真的守住了」用例对全部示例卡与全字段卡钉住了实际效果。
// 真要做到严格不超宽，得把元素改成惰性 thunk 再二次渲染 —— 收益不值那个复杂度。
//
// 本文件零依赖、纯函数、无 Bun.* / bun:*（架构 §2.2 禁令 5）。

/** 打印上下文：当前行首缩进列 + 折行宽度。 */
export interface PrintContext {
  /** 当前表达式所在行的行首缩进（空格数）。 */
  readonly indent: number;
  /** 超过它就折行。 */
  readonly width: number;
}

/** 默认折行宽度。与 `biome.json` 的 `formatter.lineWidth` 对齐。 */
export const DEFAULT_PRINT_WIDTH = 100;

/** 每层缩进的空格数。与 `biome.json` 的 `formatter.indentWidth` 对齐。 */
export const INDENT_STEP = 2;

/** 顶层上下文。 */
export function rootContext(width: number = DEFAULT_PRINT_WIDTH): PrintContext {
  return { indent: 0, width };
}

/**
 * 下一层上下文。**实参、数组元素、对象值一律用它渲染** ——
 * 这样它们自己折行时会比外层多缩进一级。
 */
export function nested(ctx: PrintContext): PrintContext {
  return { indent: ctx.indent + INDENT_STEP, width: ctx.width };
}

function pad(columns: number): string {
  return " ".repeat(columns);
}

function isMultiline(text: string): boolean {
  return text.includes("\n");
}

/** 文本最后一行的结束列。`startColumn` 只在文本本身不含换行时才算数。 */
function endColumn(text: string, startColumn: number): number {
  const cut = text.lastIndexOf("\n");
  return cut < 0 ? startColumn + text.length : text.length - cut - 1;
}

/**
 * 单行形式放得下吗。
 *
 * `startColumn` 默认是 `ctx.indent`（表达式贴着行首缩进开始），但当它前面还挂着东西时
 * 必须显式给 —— `emitObjectCall` 的对象前面就有 `defineCard(` 这五到十几个字符，
 * 不算进去会系统性地超宽。
 */
function fits(
  inline: string,
  parts: readonly string[],
  ctx: PrintContext,
  startColumn: number = ctx.indent,
): boolean {
  return !parts.some(isMultiline) && endColumn(inline, startColumn) <= ctx.width;
}

function block(open: string, parts: readonly string[], close: string, ctx: PrintContext): string {
  const inner = pad(ctx.indent + INDENT_STEP);
  return `${open}\n${inner}${parts.join(`,\n${inner}`)},\n${pad(ctx.indent)}${close}`;
}

/** 「单个 or 数组」的类型守卫（IR 里没有任何合法节点本身是数组，所以判别是安全的）。 */
export function isList<T>(value: T | readonly T[]): value is readonly T[] {
  return Array.isArray(value);
}

/** TS 字符串字面量。双引号，与仓库 biome 的 `quoteStyle: "double"` 一致。 */
export function quote(text: string): string {
  return JSON.stringify(text);
}

/** TS 数字字面量。 */
export function numberLiteral(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

/** TS 布尔字面量。 */
export function booleanLiteral(value: boolean): string {
  return value ? "true" : "false";
}

/**
 * 调用表达式。
 *
 * `head` 既可以是标识符（`"Hit"`），也可以是"接收者.方法"（`"SELF.where"`）——
 * 链式糖（`.where()` / `.negate()` / `.opposite()`）就是靠后者打出来的。
 * `args` 必须**已经用 {@link nested} 渲染过**。
 */
export function emitCall(head: string, args: readonly string[], ctx: PrintContext): string {
  if (args.length === 0) {
    return `${head}()`;
  }
  const inline = `${head}(${args.join(", ")})`;
  if (fits(inline, args, ctx)) {
    return inline;
  }
  return block(`${head}(`, args, ")", ctx);
}

/**
 * 对象字面量。`entries` 的值必须已经用 {@link nested} 渲染过。
 * `startColumn` 见 {@link fits}：对象前面挂了别的东西时要把它算进宽度。
 */
export function emitObject(
  entries: readonly (readonly [string, string])[],
  ctx: PrintContext,
  startColumn: number = ctx.indent,
): string {
  if (entries.length === 0) {
    return "{}";
  }
  const parts = entries.map(([key, value]) => `${key}: ${value}`);
  const inline = `{ ${parts.join(", ")} }`;
  if (fits(inline, parts, ctx, startColumn)) {
    return inline;
  }
  return block("{", parts, "}", ctx);
}

/** 数组字面量。`items` 必须已经用 {@link nested} 渲染过。 */
export function emitArray(items: readonly string[], ctx: PrintContext): string {
  if (items.length === 0) {
    return "[]";
  }
  const inline = `[${items.join(", ")}]`;
  if (fits(inline, items, ctx)) {
    return inline;
  }
  return block("[", items, "]", ctx);
}

/**
 * 「单个对象实参」形式的调用：`defineCard({ ... })` / `trigger({ ... })` / `aura({ ... })`。
 *
 * 与 {@link emitCall} 的区别是对象**贴着括号**排版（`defineCard({` 而不是
 * `defineCard(\n  {`）—— IR §10 与 v2 §8 的源码就是这个形状。
 * `entries` 的值必须已经用 {@link nested} 渲染过。
 */
export function emitObjectCall(
  head: string,
  entries: readonly (readonly [string, string])[],
  ctx: PrintContext,
): string {
  // `+ 1` 是那个左括号：对象的单行形式要连同 `head(` 一起算宽度，
  // 否则 `aura({ ... })` 这种前缀短、对象长的调用会稳定超出折行宽度。
  return `${head}(${emitObject(entries, ctx, ctx.indent + head.length + 1)})`;
}

/**
 * 位置实参列表：**去掉尾部缺省实参**，中间的空洞写成 `undefined`。
 *
 * builder 一律用 `x !== undefined` 判断可选实参（见 `builder/sel.ts` 等），
 * 所以 `Random(of, undefined, false)` 与"只给了 distinct"是同一件事 ——
 * 这个函数就是那条约定的逆运算。
 */
export function positional(args: readonly (string | undefined)[]): readonly string[] {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) {
    end -= 1;
  }
  return args.slice(0, end).map((arg) => arg ?? "undefined");
}
