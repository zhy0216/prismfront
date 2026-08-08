// `cond.has_color` 的验收测试（决策 #9 / M4，irVersion 2.2.0 新增的唯一一个 op）。
//
// 为什么单独一个文件：这个 op 横跨类型、op 全集、规范化、builder 糖、校验器、printer，
// 分散到六份测试里就没人能一眼确认"这条待办真的落地了"。逐 op 的**覆盖完整性**
// 仍然由各族原有的 `satisfies Record<XxxOp, …>` 表兜底（漏登记直接编译不过），
// 这里只管这个 op 自己的语义与形状。
//
// 四组：
//   1. 语义规格 —— 全称 / 存在两层量化与空集语义，写成**可执行的参照实现**
//   2. 规范形式 —— 单元素塌缩、按色轮顺序去重（规则 4，与 `cond.is_kind` 同款）
//   3. 校验器 —— 单色与色表都过 L1+L2，颜色越界 / 位置放错都报得出来
//   4. 词汇表 —— op 进了 `COND_OPS`，且 `bundle.opsUsed` 认得它

import { describe, expect, test } from "bun:test";
import {
  canonicalizeCond,
  canonicalJson,
  HasColor,
  IsBlue,
  IsRed,
  IT,
  SELF,
} from "../builder/index.ts";
import type { Card, Color, Cond } from "../types/index.ts";
import { COND_OPS, IR_VERSION } from "../types/index.ts";
import { ISSUE_CODES, validateCard, validateNode } from "../validate/index.ts";

// ── 1. 语义规格（IR §3.3 全称量化 + 决策 #9 的存在量化）─────────────────────

/**
 * `cond.has_color` 的**参照语义**，M4 求值器（engine 侧）必须与之逐条一致。
 *
 * 这里写成一个二十行的纯函数而不是散在注释里，是因为这条 op 有两层量化、方向相反，
 * 最容易出的错是把 `of` 上的全称写成存在（那样空集会变 `false`，与 IR §5.2 的统一表冲突）。
 * 参数是"每个成员的卡面颜色"——`packages/ir` 里没有求值器，也不该有（求值是 engine 的事）。
 */
const hasColor = (
  members: readonly (readonly Color[])[],
  color: Color | readonly Color[],
): boolean => {
  const wanted = typeof color === "string" ? [color] : color;
  // `of` 上是**全称**量化：每个成员都要命中 → 空集为真（数学惯例，IR §5.2）
  return members.every((colors) =>
    // 参数上是**存在**量化：与 wanted 有交集即可 → 融合卡的两个颜色各算一次命中
    colors.some((own) => wanted.includes(own)),
  );
};

describe("语义：of 全称量化、color 存在量化（决策 #9）", () => {
  test("空集 → true（全称量化的数学惯例，与 cond.has_* 家族一致，IR §5.2）", () => {
    expect(hasColor([], "red")).toBe(true);
    expect(hasColor([], ["red", "blue"])).toBe(true);
  });

  test("of 全称：有一个成员不含该色就为 false", () => {
    expect(hasColor([["red"], ["red"]], "red")).toBe(true);
    expect(hasColor([["red"], ["green"]], "red")).toBe(false);
  });

  test("color 列表存在量化：命中其一即可（不是要求全都命中）", () => {
    expect(hasColor([["green"]], ["red", "green"])).toBe(true);
    expect(hasColor([["green"]], ["red", "blue"])).toBe(false);
  });

  test("融合卡同时命中它的两个颜色（v2.1 §11.4 colors 长度 2）", () => {
    const fusion = [["red", "blue"]] as const satisfies readonly (readonly Color[])[];
    expect(hasColor(fusion, "red")).toBe(true);
    expect(hasColor(fusion, "blue")).toBe(true);
    // "发现一张红牌"应当包含红蓝融合卡；它仍然不是绿牌
    expect(hasColor(fusion, "green")).toBe(false);
  });

  test('"存在一张红牌"要显式写 Any(...)，不能指望 has_color 自己变存在量化', () => {
    // 反例锚点：池子里混着非红卡时，全称量化就是 false —— 这正是 IR §3.3 的那个陷阱
    expect(hasColor([["red"], ["blue"]], "red")).toBe(false);
  });
});

// ── 2. 规范形式（IR §1 原则 1 的规则 4）─────────────────────────────────────

describe("规范形式：与 cond.is_kind 同款处理", () => {
  test("字段顺序 op → of → color（= 规范签名顺序 = IR §5.4 的求值顺序）", () => {
    expect(canonicalJson(canonicalizeCond(HasColor(IT, "red")))).toBe(
      '{"op":"cond.has_color","of":{"op":"sel.it"},"color":"red"}',
    );
  });

  test("单元素色表退化为标量（规则 4）", () => {
    expect(canonicalJson(canonicalizeCond(HasColor(IT, ["blue"])))).toBe(
      canonicalJson(canonicalizeCond(HasColor(IT, "blue"))),
    );
  });

  test("多元素色表按色轮声明顺序去重（red → blue → green）", () => {
    expect(canonicalJson(canonicalizeCond(HasColor(IT, ["green", "red", "red"])))).toBe(
      '{"op":"cond.has_color","of":{"op":"sel.it"},"color":["red","green"]}',
    );
  });

  test("规范化是幂等的（不动点）", () => {
    const once = canonicalizeCond(HasColor(SELF, ["blue", "red"]));
    expect(canonicalJson(canonicalizeCond(once))).toBe(canonicalJson(once));
  });
});

// ── 3. 校验器（IR §7 的 L1 + L2）────────────────────────────────────────────

describe("校验器认得这个 op", () => {
  test("单色与色表两种写法都合法", () => {
    expect(validateNode(HasColor(IT, "red"), "cond").ok).toBe(true);
    expect(validateNode(HasColor(IT, ["red", "blue"]), "cond").ok).toBe(true);
  });

  test("颜色越界报 badEnum，路径指到出错的那一项", () => {
    const bad = { op: "cond.has_color", of: { op: "sel.it" }, color: ["red", "purple"] };
    const result = validateNode(bad, "cond");
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe(ISSUE_CODES.badEnum);
    expect(result.issues[0]?.path).toBe("node.color[1]");
  });

  test("of 位塞异族节点报 L2 的 wrongSort", () => {
    const bad = {
      op: "cond.has_color",
      of: { op: "num.count", of: { op: "sel.self" } },
      color: "red",
    };
    const result = validateNode(bad, "cond");
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(ISSUE_CODES.wrongSort);
  });

  test("整卡场景：卡池按颜色筛选的发现卡过 L1 + L2（IR §10.5 的今天写法）", () => {
    const card: Card = {
      id: "CORE_050",
      set: "pf1",
      data: { name: { zh: "灵光一闪" }, kind: "spell", cost: 2, colors: ["blue"] },
      script: {
        play: [
          {
            op: "act.discover",
            from: {
              op: "card.pool",
              filter: {
                op: "cond.and",
                of: [
                  { op: "cond.is_kind", of: { op: "sel.it" }, kind: "spell" },
                  { op: "cond.has_color", of: { op: "sel.it" }, color: "blue" },
                ],
              },
            },
            show: 3,
            pick: 1,
          },
        ],
      },
    };
    expect(validateCard(card).ok).toBe(true);
  });
});

// ── 4. 词汇表与版本 ─────────────────────────────────────────────────────────

describe("op 全集与版本", () => {
  test("cond.has_color 在 COND_OPS 里（engine 启动时比对 opsUsed 靠它）", () => {
    expect(COND_OPS).toContain("cond.has_color");
  });

  test("新增 op = minor bump（IR §8）：2.1.0 → 2.2.0，major 不变", () => {
    expect(IR_VERSION).toBe("2.2.0");
  });

  test("糖与节点一一对应：IsRed / IsBlue 不是结构改写型的糖", () => {
    const red: Cond = IsRed();
    const blue: Cond = IsBlue(SELF);
    expect(canonicalJson(red)).toBe(canonicalJson(HasColor(IT, "red")));
    expect(canonicalJson(blue)).toBe(canonicalJson(HasColor(SELF, "blue")));
  });
});
