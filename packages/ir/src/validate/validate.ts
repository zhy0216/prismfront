// 校验器的对外入口（架构 §2.3 的 `validate(bundle)`）。
//
// 本里程碑落地 IR §7 的前两层：
//   L1 结构 —— 字段存在性、类型、枚举值
//   L2 种类 —— 靠前缀，一次遍历，无需推导
// L3 语义（引用完整性、上下文合法性、确定性、编写子集）与 §7 的资源上限表都是 M11 的事，
// 那时 op 集才稳定（IR §12：最后写校验器，因为要等 op 集稳定）。
//
// 三个约定：
//   1. 入参一律是 `unknown` —— 校验器要能吃从磁盘读进来的 JSON，不能假设它已经是 `Bundle`
//   2. 出参是带路径的 issue 列表，不是布尔（见 issues.ts）
//   3. 通过校验后可以安全地按 `Bundle` 使用（`assertValidBundle` 提供这层断言）

import type { Bundle, Card, Enchantment } from "../types/index.ts";
import type { ValidationIssue, ValidationLayer, ValidationResult } from "./issues.ts";
import { describeValue, formatIssues, makeIssue, VALIDATION_LAYERS } from "./issues.ts";
import type { FieldKind } from "./kinds.ts";
import { validateSemantic } from "./semantic.ts";
import { checkKind, createContext } from "./walk.ts";

export interface ValidateOptions {
  /** 只跑哪几层，默认 `["L1", "L2"]`。 */
  readonly layers?: readonly ValidationLayer[];
  /** 错误路径的根。默认按被校验对象推断（`bundle` / `card.<id>` / `enchantment.<id>`）。 */
  readonly path?: string;
}

const toResult = (issues: readonly ValidationIssue[]): ValidationResult => ({
  ok: !issues.some((issue) => issue.severity === "error"),
  issues,
});

const addHeroRules = (value: unknown, path: string, issues: ValidationIssue[]): void => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const object = value as Record<string, unknown>;
  const data = object.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return;
  const cardData = data as Record<string, unknown>;
  if (cardData.kind !== "hero") return;
  if (Object.hasOwn(cardData, "cost"))
    issues.push(
      makeIssue({
        layer: "L1",
        code: "wrong-sort",
        path: `${path}.data.cost`,
        expected: "hero 卡不得设置 cost",
        actual: describeValue(cardData.cost),
      }),
    );
  if (!Array.isArray(cardData.colors) || cardData.colors.length !== 1)
    issues.push(
      makeIssue({
        layer: "L1",
        code: "wrong-sort",
        path: `${path}.data.colors`,
        expected: "hero 卡 colors 恰 1 个",
        actual: describeValue(cardData.colors),
      }),
    );
  if (cardData.collectible !== false)
    issues.push(
      makeIssue({
        layer: "L1",
        code: "wrong-sort",
        path: `${path}.data.collectible`,
        expected: "hero 卡 collectible 必须为 false（不入 30 张卡组）",
        actual: describeValue(cardData.collectible),
      }),
    );
};

const addL1Rules = (
  value: unknown,
  kind: FieldKind,
  defaultPath: string,
  issues: ValidationIssue[],
): void => {
  if (kind === "cardDoc") addHeroRules(value, defaultPath, issues);
  if (kind !== "bundle" || typeof value !== "object" || value === null || Array.isArray(value))
    return;
  const cards = (value as Record<string, unknown>).cards;
  if (typeof cards !== "object" || cards === null || Array.isArray(cards)) return;
  for (const [id, card] of Object.entries(cards)) addHeroRules(card, `card.${id}`, issues);
};

/** 所有入口的公共实现：建上下文 → 从根 token 开始走一遍 → 收结果。 */
const run = (
  value: unknown,
  kind: FieldKind,
  defaultPath: string,
  options: ValidateOptions | undefined,
): ValidationResult => {
  const ctx = createContext(options?.layers ?? VALIDATION_LAYERS);
  checkKind(value, kind, options?.path ?? defaultPath, ctx, 0);
  if ((options?.layers ?? VALIDATION_LAYERS).includes("L1"))
    addL1Rules(value, kind, options?.path ?? defaultPath, ctx.issues);
  return toResult(ctx.issues);
};

/** 对象上的 `id` 字段（用来拼默认路径），拿不到就用 `?`。 */
const idOf = (value: unknown): string => {
  if (typeof value !== "object" || value === null) return "?";
  const id = (value as { readonly id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : "?";
};

/**
 * 校验一份 bundle（IR §2.1），即 `cards.ir.json` 的内容。
 *
 * 不做版本兼容判断：`irVersion` 这里只查形状（semver 三段式），
 * "major 不匹配直接拒载"是 engine 启动时的事（IR §8、架构 §5.1）。
 */
export const validate = (bundle: unknown, options?: ValidateOptions): ValidationResult =>
  run(bundle, "bundle", "bundle", options);

/**
 * 只跑 L1 结构层的 bundle 校验。
 * 单卡 / 单附魔想分层跑，传 `{ layers: ["L1"] }` 给对应入口即可。
 */
export const validateL1 = (bundle: unknown, options?: ValidateOptions): ValidationResult =>
  validate(bundle, { ...options, layers: ["L1"] });

/** 只跑 L2 种类层的 bundle 校验。 */
export const validateL2 = (bundle: unknown, options?: ValidateOptions): ValidationResult =>
  validate(bundle, { ...options, layers: ["L2"] });

/** M11 semantic/reference/colour-wheel lint. */
export const validateL3 = (bundle: unknown, options?: ValidateOptions): ValidationResult => {
  const structural = validate(bundle, { ...options, layers: ["L1", "L2"] });
  if (!structural.ok) {
    if (structural.issues.every((item) => item.code === "bad-enum")) {
      return toResult([...structural.issues, ...validateSemantic(bundle as Bundle)]);
    }
    return structural;
  }
  return toResult(validateSemantic(bundle as Bundle));
};

/** 校验单张卡（M4 的构建流程按卡校验，报错路径就是 `card.<id>.…`）。 */
export const validateCard = (card: unknown, options?: ValidateOptions): ValidationResult =>
  run(card, "cardDoc", `card.${idOf(card)}`, options);

/** 校验单个附魔。 */
export const validateEnchantment = (
  enchantment: unknown,
  options?: ValidateOptions,
): ValidationResult => run(enchantment, "enchantment", `enchantment.${idOf(enchantment)}`, options);

/**
 * 校验单个节点。`kind` 就是字段位置的种类 token，例如
 * `validateNode(node, "sel")` = "这个值必须是 sel.*"。
 * 工具链与测试用；写卡的人一般走上面三个入口。
 */
export const validateNode = (
  value: unknown,
  kind: FieldKind,
  options?: ValidateOptions,
): ValidationResult => run(value, kind, "node", options);

/** 校验失败时抛出的错误，`issues` 原样带着，调用方可以自己排版。 */
export class ValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(subject: string, issues: readonly ValidationIssue[]) {
    super(`${subject} 校验未通过（${issues.length} 处问题）：\n${formatIssues(issues)}`);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

/** 校验通过则把入参窄化成 `Bundle`，否则抛 {@link ValidationError}。 */
export function assertValidBundle(
  bundle: unknown,
  options?: ValidateOptions,
): asserts bundle is Bundle {
  const result = validate(bundle, options);
  if (!result.ok) throw new ValidationError("bundle", result.issues);
}

/** 校验通过则把入参窄化成 `Card`，否则抛 {@link ValidationError}。 */
export function assertValidCard(card: unknown, options?: ValidateOptions): asserts card is Card {
  const result = validateCard(card, options);
  if (!result.ok) throw new ValidationError(`card.${idOf(card)}`, result.issues);
}

/** 校验通过则把入参窄化成 `Enchantment`，否则抛 {@link ValidationError}。 */
export function assertValidEnchantment(
  enchantment: unknown,
  options?: ValidateOptions,
): asserts enchantment is Enchantment {
  const result = validateEnchantment(enchantment, options);
  if (!result.ok) throw new ValidationError(`enchantment.${idOf(enchantment)}`, result.issues);
}
