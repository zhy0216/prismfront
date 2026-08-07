// packages/ir/src/validate —— IR 校验器（架构 §2.3 的 `validate(bundle)`）。
//
// 本目录只落地 IR §7 的前两层：
//   L1 结构（kinds.ts + schemas.ts + walk.ts）：字段存在性、类型、枚举值
//   L2 种类（同一次遍历）：靠前缀，`act.hit.target` 只接受 `sel.*`，`amount` 只接受 number / `num.*`
// L3 语义与 §7 的资源上限表是 M11 的事，那时 op 集才稳定（IR §12）。
//
// 零运行时依赖：不用 JSON Schema 库、不用 zod（包级 biome.json 直接拦截），
// 整个校验器由 T1 的 TS 类型驱动 —— 见 schemas.ts 顶部对五种「编译不过」的说明。

export type {
  IssueCode,
  IssueSeverity,
  ValidationIssue,
  ValidationLayer,
  ValidationResult,
} from "./issues.ts";
export {
  describeValue,
  fieldPath,
  formatIssue,
  formatIssues,
  ISSUE_CODES,
  itemPath,
  makeIssue,
  VALIDATION_LAYERS,
} from "./issues.ts";
export type {
  EnumKindSpec,
  FieldKind,
  FieldSpec,
  KindSpec,
  KindValueMap,
  ListKindSpec,
  MapKindSpec,
  NodeKindSpec,
  NodeLiteral,
  NullKindSpec,
  ScalarKindSpec,
  StructKind,
  StructKindSpec,
  TaggedKind,
  TaggedKindSpec,
  UnionKindSpec,
  ValueOfKind,
} from "./kinds.ts";
export { isOptionalSpec, KIND_SPECS, kindOfSpec, specOf } from "./kinds.ts";
export type { ObjectSchema, RuntimeObjectSchema } from "./schemas.ts";
export {
  ACT_SCHEMAS,
  CARD_SCHEMAS,
  COND_SCHEMAS,
  familyPrefixOf,
  NODE_SCHEMAS,
  NUM_SCHEMAS,
  SEL_SCHEMAS,
  SLOT_SCHEMAS,
  STRUCT_SCHEMAS,
  TAGGED_SCHEMAS,
} from "./schemas.ts";
export type { ValidateOptions } from "./validate.ts";
export {
  assertValidBundle,
  assertValidCard,
  assertValidEnchantment,
  ValidationError,
  validate,
  validateCard,
  validateEnchantment,
  validateL1,
  validateL2,
  validateNode,
} from "./validate.ts";
export type { WalkContext } from "./walk.ts";
export { checkKind, checkObject, createContext, MAX_WALK_DEPTH } from "./walk.ts";
