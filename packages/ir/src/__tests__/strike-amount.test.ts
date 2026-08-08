// `act.strike.amount` 的验收测试（M5/T5，irVersion 2.3.0 加的**运行时超集字段**）。
//
// 为什么单独一个文件：与 `has-color.test.ts` 同一条理由 —— 这一个字段横跨类型、
// 校验器、规范形式、printer 与"编写层刻意不给路径"这条边界，分散到五份测试里
// 就没人能一眼确认它真的落地了、而且真的**没有**泄漏进编写子集。
//
// 它是干什么用的：战斗第 ② 步「记录 {attacker, target, amount}，记录后全部冻结」
// （v2 §4.2）。冻结值以前**没法**随动作一起走管线（IR 的 `act.strike` 只有两个字段），
// 于是 engine 只能在应用那一刻重读 `attacker.tags.atk` —— M5 的拦截器 `then` 与
// 光环重算都能在批次中途改掉它。加了这个字段之后，冻结值是随动作走的。
// engine 侧的落点与那两条真实漂移路径见 `engine/src/rules/__tests__/combat.test.ts`。
//
// 四组：
//   1. 边界    —— 编写层没有写它的路径（`Strike` 恒两参），这是 IR §5.6 的安全边界
//   2. 校验器  —— L1/L2 认它（可选、只接 num.*），种类放错报得出来
//   3. 规范形式 + printer —— 有就带着走，不许悄悄丢
//   4. 版本    —— minor bump，major 不变（既有 bundle 的读法一字未改）

import { describe, expect, test } from "bun:test";
import * as builder from "../builder/index.ts";
import { canonicalizeAct, canonicalJson, SELF, Strike } from "../builder/index.ts";
import { printAct, rootContext } from "../tools/index.ts";
import type { Act } from "../types/index.ts";
import { ACT_NUM_FIELDS, IR_VERSION, IR_VERSION_MAJOR } from "../types/index.ts";
import { ISSUE_CODES, validateNode } from "../validate/index.ts";

/** 一条**引擎自造**的出手：目标冻成 `sel.entity`、数值冻成字面量（IR §5.6 运行时超集）。 */
const FROZEN: Act = {
  op: "act.strike",
  attacker: { op: "sel.entity", id: 7 },
  target: { op: "sel.entity", id: 9 },
  amount: 3,
};

// ── 1. 编写子集的边界（IR §5.6）────────────────────────────────────────────

describe("编写层没有写 amount 的路径", () => {
  test("Strike 恒产出两个字段的节点 —— 缺省语义仍是「attacker 当前 atk」（v2 §3.4）", () => {
    const act = Strike(SELF, { op: "sel.target" });
    expect(Object.hasOwn(act, "amount")).toBe(false);
    // 键序 = 签名序 = 求值序（IR §5.4 规则 1）：amount 排在最后，缺省时整个键不出现。
    expect(canonicalJson(canonicalizeAct(act))).toBe(
      '{"op":"act.strike","attacker":{"op":"sel.self"},"target":{"op":"sel.target"}}',
    );
  });

  test("Strike 的签名**恒两参** —— 编写层没有开口子（IR §5.6 的边界）", () => {
    // 与 `sel.entity` 同款边界：运行时超集只由引擎生成，永不来自外部输入（IR §5.6 末句）。
    // ⚠ 如实描述这条断言的**判别力**：它查的是函数元数（`Function.length`）。
    //   TS 的 `amount?: Num` 在 JS 里仍是一个真参数 ⇒ 加了就是 3，这条当场红（实测）。
    //   够不着的只有「带默认值的参数」（`amount = 0` 不计入 `length`）——
    //   那一种由上面那条 `canonicalJson` 兜底：`Strike(SELF, TARGET)` 的产物里
    //   一旦多出 `"amount"` 键，那条就红。两条合起来才是"没开口子"。
    expect(builder.Strike.length).toBe(2);
  });
});

// ── 2. 校验器（IR §7 的 L1 + L2）───────────────────────────────────────────

describe("校验器认得这个字段", () => {
  test("带 amount 与不带 amount 都过 L1 + L2（可选字段）", () => {
    expect(validateNode(FROZEN, "act").ok).toBe(true);
    expect(validateNode(Strike(SELF, { op: "sel.target" }), "act").ok).toBe(true);
  });

  test("amount 位塞 sel.* 报 L2 的 wrongSort（它是 num 位，不是 sel 位）", () => {
    const bad = { ...FROZEN, amount: { op: "sel.self" } };
    const result = validateNode(bad, "act");
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(ISSUE_CODES.wrongSort);
    expect(result.issues[0]?.path).toBe("node.amount");
  });

  test("字段名写错仍然报多余字段 —— 加一个可选字段没有把校验放宽成「随便写」", () => {
    const bad = { ...FROZEN, amonut: 3 };
    const result = validateNode(bad, "act");
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe(ISSUE_CODES.unknownField);
  });

  test("amount 在 ACT_NUM_FIELDS 里 ⇒ 拦截器读得到、改得动（num.field / set_field）", () => {
    // 这不是新加的项（`act.hit.amount` 早就在），但 strike 从今天起也落在这个可读写面上：
    // v2 §3.4 说的"拦截器两处都能拦"于是对**数值**也成立了，不只是 cancel / retarget。
    expect(ACT_NUM_FIELDS as readonly string[]).toContain("amount");
  });
});

// ── 3. 规范形式与 printer：有就带着走 ──────────────────────────────────────

describe("工具链不会悄悄丢掉冻结值", () => {
  test("canonicalize 保留 amount（丢掉 = 冻结的出手数变回当前 atk）", () => {
    expect(canonicalJson(canonicalizeAct(FROZEN))).toBe(
      '{"op":"act.strike","attacker":{"op":"sel.entity","id":7},' +
        '"target":{"op":"sel.entity","id":9},"amount":3}',
    );
  });

  test("canonicalize 幂等（不动点）", () => {
    const once = canonicalizeAct(FROZEN);
    expect(canonicalJson(canonicalizeAct(once))).toBe(canonicalJson(once));
  });

  test("printer 把它打成第三个参数 —— dump 结算栈时看得见这一击冻了多少", () => {
    // 与 `sel.entity` → `Entity(id)` 同款例外：打出来是给人读的，不是可贴回的源码
    // （编写层的 `Strike` 只收两参，见上面第 1 组）。
    expect(printAct(FROZEN, rootContext())).toBe("Strike(Entity(7), Entity(9), 3)");
    expect(printAct(Strike(SELF, { op: "sel.target" }), rootContext())).toBe(
      "Strike(SELF, TARGET)",
    );
  });
});

// ── 4. 版本 ────────────────────────────────────────────────────────────────

describe("版本", () => {
  test("加一个运行时超集字段 = minor bump，major 不变（IR §8 的意图）", () => {
    // 判据是"旧文档还能不能按原意读"：这个字段编写产物里永不出现、缺省语义又没动，
    // 于是既有 bundle 一字未变 —— 与"新增 op"在兼容性上同形。完整论证在 ir-version.ts。
    //
    // ★ 这里**只钉 major**，不钉当前值 `2.3.0`：当前值由
    //   `types/__tests__/types.test.ts` 独家钉住（**全仓只有那一处**）。
    //   下一次 minor bump 时只需改那一处，不必满仓找 `"2.3.0"` 字面量 ——
    //   `has-color.test.ts` 的同名测试出于同一理由也只钉 major。
    expect(IR_VERSION_MAJOR).toBe(2);
    expect(IR_VERSION.startsWith("2.")).toBe(true);
  });
});
