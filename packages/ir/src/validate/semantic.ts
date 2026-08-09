/* c8 ignore file -- exercised by the cards package's ir:validate gate. */
import { type ownershipOfOccurrence, ownsOccurrence } from "../color-ownership.ts";
import type { Bundle, Card, Color, Enchantment } from "../types/index.ts";
import type { ValidationIssue } from "./issues.ts";
import { describeValue, fieldPath, makeIssue } from "./issues.ts";

const issue = (
  path: string,
  expected: string,
  actual: unknown,
  message?: string,
): ValidationIssue =>
  makeIssue(
    message === undefined
      ? { layer: "L3", code: "wrong-sort", path, expected, actual: describeValue(actual) }
      : { layer: "L3", code: "wrong-sort", path, expected, actual: describeValue(actual), message },
  );

const warning = (
  path: string,
  expected: string,
  actual: unknown,
  message?: string,
): ValidationIssue => ({
  ...issue(path, expected, actual, message),
  severity: "warning",
});

// 表达式节点 = sel.* / cond.* / num.*。资源上限表的「表达式深度 ≤ 32」（IR §7）只计表达式
// 嵌套，动作容器（act.when / act.repeat / act.for_each 等）不增加表达式深度——动作层的
// 嵌套由「单卡节点数 ≤ 512」兜底，两层各管各的。
const isExpressionNode = (op: string): boolean =>
  op.startsWith("sel.") || op.startsWith("cond.") || op.startsWith("num.");

const inspectTree = (value: unknown): { nodes: number; expressionDepth: number } => {
  if (Array.isArray(value)) {
    return value.reduce(
      (total, item) => {
        const current = inspectTree(item);
        return {
          nodes: total.nodes + current.nodes,
          expressionDepth: Math.max(total.expressionDepth, current.expressionDepth),
        };
      },
      { nodes: 0, expressionDepth: 0 },
    );
  }
  if (typeof value !== "object" || value === null) return { nodes: 0, expressionDepth: 0 };

  const object = value as Record<string, unknown>;
  const isNode = typeof object.op === "string";
  const isExpression = isNode && isExpressionNode(object.op as string);
  let nodes = isNode ? 1 : 0;
  let expressionDepth = isExpression ? 1 : 0;
  for (const child of Object.values(object)) {
    const current = inspectTree(child);
    nodes += current.nodes;
    expressionDepth = Math.max(
      expressionDepth,
      isExpression ? current.expressionDepth + 1 : current.expressionDepth,
    );
  }
  return { nodes, expressionDepth };
};

const validateLimits = (value: unknown, path: string, issues: ValidationIssue[]): void => {
  const limits = inspectTree(value);
  if (limits.nodes > 512) issues.push(issue(path, "单卡节点数不超过 512", limits.nodes));
  if (limits.expressionDepth > 32)
    issues.push(issue(path, "表达式深度不超过 32", limits.expressionDepth));
};

const walk = (
  value: unknown,
  path: string,
  fn: (value: Record<string, unknown>, path: string) => void,
): void => {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) walk(item, `${path}[${i}]`, fn);
  } else if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    fn(object, path);
    for (const [key, child] of Object.entries(object)) walk(child, fieldPath(path, key), fn);
  }
};

function cardOccurrences(
  card: Card,
  enchantments: Readonly<Record<string, Enchantment>>,
): readonly { occurrence: Parameters<typeof ownershipOfOccurrence>[1]; path: string }[] {
  const out: { occurrence: Parameters<typeof ownershipOfOccurrence>[1]; path: string }[] = [];
  const keywordText = JSON.stringify(card.data.text ?? "").toLowerCase();
  walk(card.script, `card.${card.id}.script`, (node, path) => {
    const op = typeof node.op === "string" ? node.op : undefined;
    if (op !== undefined) {
      // Keyword implementations are ordinary internal actions. Their public
      // capability is linted by the keyword occurrence below, not by the
      // helper action (e.g. Retaliate's internal act.hit is green-legal).
      if (!(op === "act.hit" && keywordText.includes("retaliate"))) {
        out.push({ occurrence: { kind: "op", op }, path });
      }
      if (op === "act.set_tag" || op === "act.mod_tag") {
        const tag = node.tag;
        const value = node.value ?? node.delta;
        if (
          typeof tag === "string" &&
          ((tag !== "atk" && tag !== "health") || typeof value !== "number" || value > 0)
        )
          out.push({ occurrence: { kind: "tagKey", tagKey: tag }, path: `${path}.tag` });
      }
      if (op === "act.buff" && typeof node.ench === "string") {
        const enchantment = enchantments[node.ench];
        for (const tag of Object.keys(enchantment?.mods ?? {})) {
          const amount = enchantment?.mods?.[tag as keyof NonNullable<Enchantment["mods"]>];
          if ((tag === "atk" || tag === "health") && typeof amount === "number" && amount > 0) {
            out.push({
              occurrence: { kind: "tagKey", tagKey: tag },
              path: `${path}.ench.${node.ench}.mods.${tag}`,
            });
          }
        }
      }
      if (op === "act.set_flag" && typeof node.flag === "string")
        out.push({ occurrence: { kind: "flag", flag: node.flag }, path: `${path}.flag` });
    }
  });
  // Keywords are represented by recognizable trigger shapes and card text.
  const text = JSON.stringify(card.data.text ?? "").toLowerCase();
  for (const keyword of ["retaliate", "cleave", "siege", "growth", "divine_shield", "aura"]) {
    if (text.includes(keyword.replace("_", " ")) || text.includes(keyword))
      out.push({ occurrence: { kind: "keyword", keyword }, path: `card.${card.id}.data.text` });
  }
  return out;
}

export function validateSemantic(bundle: Bundle): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const cards = bundle.cards;
  for (const card of Object.values(cards)) {
    const data = card.data;
    if (data.kind === "hero" && data.hero !== undefined)
      issues.push(issue(`card.${card.id}.data.hero`, "英雄卡不得设置 hero", data.hero));
    if (
      data.kind !== "hero" &&
      data.collectible !== false &&
      data.kind !== "token" &&
      data.hero === undefined
    ) {
      issues.push(issue(`card.${card.id}.data.hero`, "可收藏非英雄卡必须指定所属英雄", data.hero));
    }
    if (data.hero !== undefined) {
      const hero = cards[data.hero];
      if (hero === undefined)
        issues.push(issue(`card.${card.id}.data.hero`, "存在的英雄 id", data.hero));
      else if (hero.data.kind !== "hero")
        issues.push(issue(`card.${card.id}.data.hero`, "kind=hero 的卡", hero.data.kind));
      else if (!data.colors.some((color) => hero.data.colors.includes(color)))
        issues.push(issue(`card.${card.id}.data.colors`, "包含所属英雄颜色", data.colors));
    }
    for (const { occurrence, path } of cardOccurrences(card, bundle.enchantments)) {
      for (const color of data.colors as readonly Color[]) {
        const keywordImplementation =
          occurrence.kind === "op" &&
          occurrence.op === "act.hit" &&
          path.includes("triggers") &&
          JSON.stringify(data.text ?? "")
            .toLowerCase()
            .includes("retaliate");
        if (keywordImplementation) continue;
        if (
          color === "red" &&
          occurrence.kind === "tagKey" &&
          occurrence.tagKey === "health" &&
          path.includes(".ench.")
        ) {
          issues.push(issue(path, "红色 buff 只能增加 atk（colorNotes.red）", occurrence));
          continue;
        }
        if (!ownsOccurrence(color, occurrence))
          issues.push(issue(path, `${color} 色允许该能力`, occurrence));
      }
    }
    walk(card.script, `card.${card.id}.script`, (node, path) => {
      if (node.op === "sel.entity")
        issues.push(issue(path, "编写子集不得出现 sel.entity", node.op));
      if (node.op === "act.strike" && Object.hasOwn(node, "amount"))
        issues.push(issue(`${path}.amount`, "运行时字段不得由卡表填写", node.amount));
      if (
        typeof node.op === "string" &&
        (node.op.endsWith(".random") || node.op === "slot.random_empty")
      ) {
        // Random is legal in ordinary effects, but not in aura/intercept conditions.
        const ancestor = path;
        if (ancestor.includes("auras") || ancestor.includes("intercepts"))
          issues.push(issue(path, "aura/intercept 不得使用随机节点", node.op));
      }
      if (
        node.op === "slot.at" &&
        typeof node.index === "number" &&
        (node.index < 0 || node.index > 8)
      )
        issues.push(issue(`${path}.index`, "slot.at.index 在 [0, 8] 内", node.index));
      if (node.op === "act.shift" && node.delta === 0)
        issues.push(
          warning(
            `${path}.delta`,
            "act.shift.delta 不应为 0",
            node.delta,
            `${path}.delta：字面量 0 无操作，可能是笔误`,
          ),
        );
      if (node.op === "act.repeat" && typeof node.n === "number" && node.n > 64)
        issues.push(issue(`${path}.n`, "act.repeat.n 不超过 64", node.n));
    });
    // 拦截器链长度 ≤ 8 由引擎运行时强制（MAX_INTERCEPT_CHAIN，计真正应用了几条，
    // 见 engine resolve/interceptors.ts）：链长是跨实体按 priority 动态收集的结果，
    // 静态看单卡 intercepts 数组长度既会误报（多个拦截器可能只有一条命中）也漏报
    // （多个实体的拦截器拼出超长链），bundle 校验不做这个判断。
    validateLimits(card.script, `card.${card.id}`, issues);
    const bytes = JSON.stringify(card).length;
    if (bytes > 64 * 1024) issues.push(issue(`card.${card.id}`, "单卡不超过 64KB", bytes));
  }
  // Reference completeness for every card and enchantment id.
  walk(bundle, "bundle", (node, path) => {
    if (
      node.op === "act.buff" &&
      typeof node.ench === "string" &&
      bundle.enchantments[node.ench] === undefined
    )
      issues.push(issue(`${path}.ench`, "存在的 enchantment id", node.ench));
    if (node.op === "act.give" || node.op === "act.summon" || node.op === "act.transform") {
      const ref = node.card;
      const id =
        typeof ref === "string"
          ? ref
          : typeof ref === "object" && ref !== null && (ref as Record<string, unknown>).id;
      if (typeof id === "string" && cards[id] === undefined)
        issues.push(issue(`${path}.card`, "存在的 card id", id));
    }
  });
  for (const enchantment of Object.values(bundle.enchantments)) {
    if (enchantment.attachesTo !== "minion" && enchantment.mods?.direction !== undefined)
      issues.push(
        warning(
          `enchantment.${enchantment.id}.mods.direction`,
          "direction 只用于 minion 附魔",
          enchantment.mods.direction,
          `enchantment.${enchantment.id}.mods.direction：非 minion 附魔不应包含 direction`,
        ),
      );
    validateLimits(enchantment.script, `enchantment.${enchantment.id}`, issues);
  }
  return issues;
}
