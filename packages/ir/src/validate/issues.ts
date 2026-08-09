// 校验错误对象：**带路径与原因**，不是一个布尔。
//
// 为什么这么在意：M4 的 `ir:build` 与 M11 的 `ir:validate` 都要靠它把问题定位到具体字段
// （架构 §5.1 / IR §11）。"这个 bundle 不合法"对写卡的人毫无用处，
// "card.GRID_001.script.play[0].target：期望 sel.*（选择器），实际 num.count" 才有用。

/** 校验层（IR §7）。L3 语义校验是 M11 的事，这里只登记 M1 落地的两层。 */
export const VALIDATION_LAYERS = ["L1", "L2"] as const;

export type ValidationLayer = "L1" | "L2" | "L3";

/**
 * 问题类型。
 *
 * 用 `as const` 对象而不是 enum：仓库开了 `erasableSyntaxOnly`（架构 §2.2），
 * enum 不可被纯类型剥离，编译不过。
 */
export const ISSUE_CODES = {
  /** 值的形状不对（该是对象却是数组、该是数字却是字符串……）。 */
  badType: "bad-type",
  /** 节点对象没有 `op` 字段。 */
  missingOp: "missing-op",
  /** `op` 不在 IR 的 op 全集里（拼错或用了未来版本的 op）。 */
  unknownOp: "unknown-op",
  /** 必填字段缺失。 */
  missingField: "missing-field",
  /** 出现了 schema 里没有的字段（多半是拼错）。 */
  unknownField: "unknown-field",
  /** 枚举取值不在词汇表里。 */
  badEnum: "bad-enum",
  /** 数字不合法（NaN / Infinity / 该是整数却是小数）。 */
  badNumber: "bad-number",
  /** 字符串不合法（空串、irVersion 不是三段式、createdAt 不是 ISO 8601）。 */
  badString: "bad-string",
  /** `cards` / `enchantments` 的键与文档自己的 `id` 对不上（IR §2.1 以 id 为键）。 */
  keyMismatch: "key-mismatch",
  /** 嵌套过深 —— 防爆栈护栏，见 walk.ts 的 `MAX_WALK_DEPTH`。 */
  tooDeep: "too-deep",
  /** L2：节点出现在不接受它这一族的位置（IR §7 的种类校验）。 */
  wrongSort: "wrong-sort",
} as const;

export type IssueCode = (typeof ISSUE_CODES)[keyof typeof ISSUE_CODES];

/**
 * 严重度。M1 的 L1/L2 只产 `"error"`；
 * `"warning"` 留给 M11 的 L3（如 v2 §9 的「`act.shift.delta` 字面量 0」告警）。
 */
export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  readonly layer: ValidationLayer;
  readonly severity: IssueSeverity;
  readonly code: IssueCode;
  /** 出错位置，如 `card.GRID_001.script.play[0].target`。 */
  readonly path: string;
  /** 该位置期望什么，如 `sel.*（选择器）`。 */
  readonly expected: string;
  /** 实际拿到了什么，如 `num.count`。 */
  readonly actual: string;
  /** 拼好的中文单行说明，直接打给写卡的人看。 */
  readonly message: string;
}

export interface ValidationResult {
  /** 无 `error` 即为通过。 */
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

/** 只有形如标识符的键才用点号，其余用方括号引号，保证路径能被无歧义地读回去。 */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `base` 下某个字段的路径。 */
export const fieldPath = (base: string, key: string): string =>
  IDENTIFIER.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;

/** `base` 下某个数组元素的路径。 */
export const itemPath = (base: string, index: number): string => `${base}[${index}]`;

const MAX_LITERAL_CHARS = 40;

/** 把任意运行时值描述成一句能进错误信息的话（节点对象直接报它的 op）。 */
export const describeValue = (value: unknown): string => {
  if (value === null) return "null";
  if (value === undefined) return "缺失";
  if (Array.isArray(value)) return `数组（长度 ${value.length}）`;
  if (typeof value === "object") {
    const op = (value as { readonly op?: unknown }).op;
    return typeof op === "string" ? op : "对象";
  }
  if (typeof value === "string") {
    const text = value.length > MAX_LITERAL_CHARS ? `${value.slice(0, MAX_LITERAL_CHARS)}…` : value;
    return `字符串 ${JSON.stringify(text)}`;
  }
  if (typeof value === "number") return `数字 ${value}`;
  if (typeof value === "boolean") return `布尔 ${value}`;
  return typeof value;
};

export interface IssueInput {
  readonly layer: ValidationLayer;
  readonly code: IssueCode;
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
  /** 覆盖默认句式，用于「缺失字段」这类不适合说"实际是…"的场合。 */
  readonly message?: string;
}

/** 造一个 issue。默认句式：`路径：期望 X，实际 Y`。 */
export const makeIssue = (input: IssueInput): ValidationIssue => ({
  layer: input.layer,
  severity: "error",
  code: input.code,
  path: input.path,
  expected: input.expected,
  actual: input.actual,
  message: input.message ?? `${input.path}：期望 ${input.expected}，实际 ${input.actual}`,
});

/** 单条 issue 的可读形式，CLI 与测试失败信息用。 */
export const formatIssue = (issue: ValidationIssue): string =>
  `[${issue.layer} ${issue.code}] ${issue.message}`;

/** 整份结果的可读形式。 */
export const formatIssues = (issues: readonly ValidationIssue[]): string =>
  issues.map(formatIssue).join("\n");
