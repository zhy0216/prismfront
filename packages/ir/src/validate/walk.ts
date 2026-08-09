// 一次遍历，两层校验（IR §7）。
//
// L1 结构：值的形状、`op` 是否已知、必填字段、多余字段、枚举取值、数字与字符串的基本合法性。
// L2 种类：节点的 `op` 是否属于该位置接受的族 —— 就是一次前缀检查，不做任何类型推导。
//
// 两层共用这一次遍历：**判断照做，只在 push 时按 `layers` 过滤**。
// 这样 `validateL1` 与 `validateL2` 不可能因为走了不同的路径而给出互相矛盾的结论。
//
// 遍历顺序 = schema 的字段声明顺序 = IR §5.4 的求值顺序，所以错误也是按求值顺序报出来的。

import type { NodeOp } from "../types/index.ts";
import type { IssueCode, ValidationIssue, ValidationLayer } from "./issues.ts";
import { describeValue, fieldPath, ISSUE_CODES, itemPath, makeIssue } from "./issues.ts";
import type { FieldKind } from "./kinds.ts";
import { DELETED_EVENTS, isOptionalSpec, kindOfSpec, specOf } from "./kinds.ts";
import type { RuntimeObjectSchema } from "./schemas.ts";
import { familyPrefixOf, NODE_SCHEMAS, STRUCT_SCHEMAS, TAGGED_SCHEMAS } from "./schemas.ts";

/**
 * 防爆栈护栏。
 *
 * ⚠ 这**不是** IR §7 的资源上限表（单卡节点数 512 / 表达式深度 32 …）——
 * 那张表连同 L3 一起在 M11 做。这里只是保证：喂进来一份一万层深的 JSON 时，
 * 校验器报错而不是把栈打爆。
 */
export const MAX_WALK_DEPTH = 256;

export interface WalkContext {
  readonly layers: ReadonlySet<ValidationLayer>;
  readonly issues: ValidationIssue[];
  /**
   * 每走到一个 **op 已知**的节点回调一次（同一个 op 出现几次就回调几次）。
   *
   * 存在的理由只有一个：`bundle.opsUsed`（IR §2.1）需要"扫一遍整份 IR 收集用到的 op"，
   * 而那正是本文件已经在做的事。给一个回调口，全仓就只有**这一份**遍历 ——
   * op 集每次增长（如 2.2.0 的 `cond.has_color`）时不会有第二份遍历悄悄漏掉分支。
   * 收集器见 `ops-used.ts`。
   */
  readonly onNode: (op: NodeOp) => void;
}

/** 不收集 op 时的回调。校验路径上每个节点都会调它一次，所以要保持空实现。 */
const IGNORE_NODE = (): void => {};

export const createContext = (
  layers: readonly ValidationLayer[],
  onNode: (op: NodeOp) => void = IGNORE_NODE,
): WalkContext => ({
  layers: new Set(layers),
  issues: [],
  onNode,
});

interface PushInput {
  readonly layer: ValidationLayer;
  readonly code: IssueCode;
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
  readonly message?: string;
}

const push = (ctx: WalkContext, input: PushInput): void => {
  if (!ctx.layers.has(input.layer)) return;
  ctx.issues.push(makeIssue(input));
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 值的粗形状，联合分支靠它选成员（联合成员的形状必须互斥，见 KIND_SPECS 的注释）。 */
type Shape = "null" | "array" | "object" | "number" | "string" | "boolean";

const shapeOf = (value: unknown): Shape | undefined => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "object":
      return "object";
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    default:
      return undefined;
  }
};

/** 某个 token 能不能接住这种形状的值。 */
const acceptsShape = (kind: FieldKind, shape: Shape): boolean => {
  const spec = specOf(kind);
  switch (spec.form) {
    case "null":
      return shape === "null";
    case "list":
      return shape === "array";
    case "node":
      return shape === "object" || (spec.literal !== undefined && shape === spec.literal);
    case "enum":
      return shape === "string";
    case "scalar":
      return spec.type === "int" ? shape === "number" : shape === spec.type;
    case "struct":
    case "tagged":
    case "map":
      return shape === "object";
    case "union":
      return (spec.of as readonly FieldKind[]).some((member) => acceptsShape(member, shape));
    default:
      return false;
  }
};

/** 校验一个字段位置上的值。`depth` 只用于护栏。 */
export function checkKind(
  value: unknown,
  kind: FieldKind,
  path: string,
  ctx: WalkContext,
  depth: number,
): void {
  const spec = specOf(kind);

  if (depth > MAX_WALK_DEPTH) {
    push(ctx, {
      layer: "L1",
      code: ISSUE_CODES.tooDeep,
      path,
      expected: `嵌套深度 ≤ ${MAX_WALK_DEPTH}`,
      actual: `超过 ${MAX_WALK_DEPTH} 层`,
      message: `${path}：嵌套超过 ${MAX_WALK_DEPTH} 层，校验中止（防爆栈护栏）`,
    });
    return;
  }

  if (value === undefined) {
    push(ctx, {
      layer: "L1",
      code: ISSUE_CODES.badType,
      path,
      expected: spec.describe,
      actual: "缺失",
    });
    return;
  }

  switch (spec.form) {
    case "node": {
      // IR 原则 4：常见字面量不包装 —— number / boolean / CardId 直接写。
      if (spec.literal !== undefined && typeof value === spec.literal) {
        if (spec.literal === "number" && !Number.isFinite(value)) {
          push(ctx, {
            layer: "L1",
            code: ISSUE_CODES.badNumber,
            path,
            expected: "有限数字",
            actual: describeValue(value),
          });
        }
        if (spec.literal === "string" && value === "") {
          push(ctx, {
            layer: "L1",
            code: ISSUE_CODES.badString,
            path,
            expected: spec.describe,
            actual: "空字符串",
          });
        }
        return;
      }
      if (!isPlainObject(value)) {
        push(ctx, {
          layer: "L1",
          code: ISSUE_CODES.badType,
          path,
          expected: spec.describe,
          actual: describeValue(value),
        });
        return;
      }
      const op = value.op;
      if (op === undefined) {
        push(ctx, {
          layer: "L1",
          code: ISSUE_CODES.missingOp,
          path,
          expected: spec.describe,
          actual: "没有 op 字段的对象",
        });
        return;
      }
      if (typeof op !== "string") {
        push(ctx, {
          layer: "L1",
          code: ISSUE_CODES.badType,
          path: fieldPath(path, "op"),
          expected: "字符串 op",
          actual: describeValue(op),
        });
        return;
      }
      const schema: RuntimeObjectSchema | undefined = NODE_SCHEMAS[op as NodeOp];
      if (schema === undefined) {
        push(ctx, {
          layer: "L1",
          code: ISSUE_CODES.unknownOp,
          path,
          expected: spec.describe,
          actual: op,
          message: `${path}：未知的 op ${JSON.stringify(op)}（期望 ${spec.describe}）`,
        });
        return;
      }
      // ★ op 已知才回调：`opsUsed` 是 `NodeOp[]`，未知 op 只配进 issue 列表。
      ctx.onNode(op as NodeOp);
      // ★ L2 的全部内容：这个位置接受哪一族前缀，核对一下就完了。
      if (!(spec.ops as readonly string[]).includes(op)) {
        push(ctx, {
          layer: "L2",
          code: ISSUE_CODES.wrongSort,
          path,
          expected: spec.describe,
          actual: op,
          message: `${path}：期望 ${spec.describe}，实际是 ${op}（${familyPrefixOf(op)}* 族）`,
        });
      }
      // 即使种类不对也继续往下走：它自己的内部结构问题一并报出来，一趟修完。
      checkObject(value, schema, path, ctx, depth, "op");
      return;
    }

    case "list": {
      if (!Array.isArray(value)) {
        push(ctx, {
          layer: "L1",
          code: ISSUE_CODES.badType,
          path,
          expected: spec.describe,
          actual: describeValue(value),
        });
        return;
      }
      for (const [index, item] of value.entries()) {
        checkKind(item, spec.of, itemPath(path, index), ctx, depth + 1);
      }
      return;
    }

    case "union": {
      const shape = shapeOf(value);
      const member =
        shape === undefined
          ? undefined
          : (spec.of as readonly FieldKind[]).find((candidate) => acceptsShape(candidate, shape));
      if (member === undefined) {
        push(ctx, {
          layer: "L1",
          code: ISSUE_CODES.badType,
          path,
          expected: spec.describe,
          actual: describeValue(value),
        });
        return;
      }
      checkKind(value, member, path, ctx, depth);
      return;
    }

    case "enum": {
      if (typeof value !== "string") {
        push(ctx, {
          layer: "L1",
          code: ISSUE_CODES.badType,
          path,
          expected: spec.describe,
          actual: describeValue(value),
        });
        return;
      }
      if (!(spec.values as readonly string[]).includes(value)) {
        const replacement = (DELETED_EVENTS as Readonly<Record<string, string | undefined>>)[value];
        push(ctx, {
          layer: "L1",
          code: ISSUE_CODES.badEnum,
          path,
          expected: spec.describe,
          actual: JSON.stringify(value),
          ...(replacement === undefined
            ? {}
            : { message: `${JSON.stringify(value)} 已删除，请改用 ${replacement}` }),
        });
      }
      return;
    }

    case "scalar": {
      if (spec.type === "boolean") {
        if (typeof value !== "boolean") {
          push(ctx, {
            layer: "L1",
            code: ISSUE_CODES.badType,
            path,
            expected: spec.describe,
            actual: describeValue(value),
          });
        }
        return;
      }
      if (spec.type === "int") {
        if (typeof value !== "number") {
          push(ctx, {
            layer: "L1",
            code: ISSUE_CODES.badType,
            path,
            expected: spec.describe,
            actual: describeValue(value),
          });
          return;
        }
        if (!Number.isInteger(value)) {
          push(ctx, {
            layer: "L1",
            code: ISSUE_CODES.badNumber,
            path,
            expected: spec.describe,
            actual: describeValue(value),
          });
        }
        return;
      }
      if (typeof value !== "string") {
        push(ctx, {
          layer: "L1",
          code: ISSUE_CODES.badType,
          path,
          expected: spec.describe,
          actual: describeValue(value),
        });
        return;
      }
      if (value === "") {
        push(ctx, {
          layer: "L1",
          code: ISSUE_CODES.badString,
          path,
          expected: spec.describe,
          actual: "空字符串",
        });
        return;
      }
      if (spec.pattern !== undefined && !spec.pattern.test(value)) {
        push(ctx, {
          layer: "L1",
          code: ISSUE_CODES.badString,
          path,
          expected: spec.describe,
          actual: describeValue(value),
        });
      }
      return;
    }

    case "struct": {
      if (!isPlainObject(value)) {
        push(ctx, {
          layer: "L1",
          code: ISSUE_CODES.badType,
          path,
          expected: spec.describe,
          actual: describeValue(value),
        });
        return;
      }
      const schema: RuntimeObjectSchema | undefined =
        STRUCT_SCHEMAS[kind as keyof typeof STRUCT_SCHEMAS];
      if (schema === undefined) return;
      checkObject(value, schema, path, ctx, depth);
      return;
    }

    case "tagged": {
      if (!isPlainObject(value)) {
        push(ctx, {
          layer: "L1",
          code: ISSUE_CODES.badType,
          path,
          expected: spec.describe,
          actual: describeValue(value),
        });
        return;
      }
      const variants = TAGGED_SCHEMAS[kind as keyof typeof TAGGED_SCHEMAS];
      if (variants === undefined) return;
      const tagValue = value[spec.tag];
      if (typeof tagValue !== "string") {
        push(ctx, {
          layer: "L1",
          code: tagValue === undefined ? ISSUE_CODES.missingField : ISSUE_CODES.badType,
          path: fieldPath(path, spec.tag),
          expected: Object.keys(variants).join(" | "),
          actual: describeValue(tagValue),
        });
        return;
      }
      const schema: RuntimeObjectSchema | undefined = variants[tagValue];
      if (schema === undefined) {
        push(ctx, {
          layer: "L1",
          code: ISSUE_CODES.badEnum,
          path: fieldPath(path, spec.tag),
          expected: Object.keys(variants).join(" | "),
          actual: JSON.stringify(tagValue),
        });
        return;
      }
      checkObject(value, schema, path, ctx, depth, spec.tag);
      return;
    }

    case "map": {
      if (!isPlainObject(value)) {
        push(ctx, {
          layer: "L1",
          code: ISSUE_CODES.badType,
          path,
          expected: spec.describe,
          actual: describeValue(value),
        });
        return;
      }
      const allowed = spec.keys as readonly string[] | null;
      for (const [key, item] of Object.entries(value)) {
        if (allowed !== null && !allowed.includes(key)) {
          push(ctx, {
            layer: "L1",
            code: ISSUE_CODES.unknownField,
            path: fieldPath(path, key),
            expected: `${spec.describe} 的键：${allowed.join(" | ")}`,
            actual: JSON.stringify(key),
          });
          continue;
        }
        const base = spec.pathPrefix === undefined ? path : spec.pathPrefix;
        const childPath = fieldPath(base, key);
        checkKind(item, spec.value, childPath, ctx, depth + 1);
        if (spec.keyField !== undefined && isPlainObject(item)) {
          const id = item[spec.keyField];
          if (typeof id === "string" && id !== key) {
            push(ctx, {
              layer: "L1",
              code: ISSUE_CODES.keyMismatch,
              path: fieldPath(childPath, spec.keyField),
              expected: `与键一致的 ${spec.keyField}（${JSON.stringify(key)}）`,
              actual: JSON.stringify(id),
            });
          }
        }
      }
      return;
    }

    case "null": {
      if (value !== null) {
        push(ctx, {
          layer: "L1",
          code: ISSUE_CODES.badType,
          path,
          expected: spec.describe,
          actual: describeValue(value),
        });
      }
      return;
    }

    default: {
      // KindSpec 是可辨识联合，加了新 form 而没在这里处理 → 这一行编译不过。
      // 运行时到不了这里（KIND_SPECS 已被 `satisfies` 钉死），到了就是校验器自己写错了。
      const unreachable: never = spec;
      throw new Error(`未处理的字段种类 form：${JSON.stringify(unreachable)}`);
    }
  }
}

/** 按字段表校验一个对象：缺字段、多字段、逐字段递归。 */
export function checkObject(
  obj: Record<string, unknown>,
  schema: RuntimeObjectSchema,
  path: string,
  ctx: WalkContext,
  depth: number,
  discriminator?: string,
): void {
  const fieldNames = [
    ...(discriminator === undefined ? [] : [discriminator]),
    ...Object.keys(schema),
  ];

  for (const [key, fieldSpec] of Object.entries(schema)) {
    const value = obj[key];
    if (value === undefined) {
      if (!isOptionalSpec(fieldSpec)) {
        const expected = specOf(kindOfSpec(fieldSpec)).describe;
        push(ctx, {
          layer: "L1",
          code: ISSUE_CODES.missingField,
          path: fieldPath(path, key),
          expected,
          actual: "缺失",
          message: `${fieldPath(path, key)}：必填字段缺失（期望 ${expected}）`,
        });
      }
      continue;
    }
    checkKind(value, kindOfSpec(fieldSpec), fieldPath(path, key), ctx, depth + 1);
  }

  for (const key of Object.keys(obj)) {
    if (key === discriminator || Object.hasOwn(schema, key)) continue;
    push(ctx, {
      layer: "L1",
      code: ISSUE_CODES.unknownField,
      path: fieldPath(path, key),
      expected: `以下字段之一：${fieldNames.join(" | ")}`,
      actual: `多余字段 ${JSON.stringify(key)}`,
      message: `${fieldPath(path, key)}：多余字段 ${JSON.stringify(key)}（可用字段：${fieldNames.join(" | ")}）`,
    });
  }
}
