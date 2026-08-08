// 规则配置校验的单元测试（M3 任务书第 4b 项 + `validate-config.ts`）。
//
// ★ 本文件最重要的一条是「playerActions 恒关」★
// 决策 #3 已拍板：`move_unit` / `set_direction` **不实现、也不静默忽略，配置校验期直接抛错**。
// 理由是《数值基准》§1.2 把 `direction` 定成**红 primary / 绿 forbidden**，
// 玩家能免费改方向 = 红色主色身份蒸发 + 绿色禁令失效。抛错是为了让将来任何人打开
// 这个开关时**当场撞墙**，而不是跑出一局与设计文档不一致的对局。
// 所以这条测试同时也是那份设计决定的"守卫"：有人把校验删了，它立刻红。
//
// 注：本文件**不 import `@prismfront/ir` 的任何值**（架构 §2.2 禁令 1）。

import { expect, test } from "bun:test";
import type { PlayerActionKind, RulesConfig } from "@prismfront/ir";
import { createGame, RulesConfigError, validateRulesConfig } from "../index.ts";

const VALID: RulesConfig = {
  board: { slots: 9 },
  crystals: { initial: 5, growth: 1, capMax: 10 },
  pass: { combatAfterConsecutivePasses: 2 },
  initiative: "alternate",
  baseHp: 30,
  deck: { size: 30, maxCopies: 2, startingHand: 4, drawPerRound: 1, fatigue: true },
  playerActions: ["play_card"],
  actionSeconds: 30,
  reconnectSeconds: 90,
  heroes: { perDeck: 3, deploySchedule: [2, 1], respawnDelay: 1 },
};

function rulesWith(patch: Partial<RulesConfig>): RulesConfig {
  return { ...VALID, ...patch };
}

/** 跑一次校验并取回抛出来的那个错误（没抛就是测试失败）。 */
function errorOf(rules: RulesConfig): RulesConfigError {
  try {
    validateRulesConfig(rules);
  } catch (error) {
    if (error instanceof RulesConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("期望抛出 RulesConfigError，但校验通过了");
}

// ═══════════════════════════════════════════════════════════════════════════
// ★ 决策 #3：playerActions 恒关 ★
// ═══════════════════════════════════════════════════════════════════════════

test("★ playerActions 含 move_unit / set_direction ⇒ 配置校验期直接抛错（决策 #3）", () => {
  for (const kind of [
    "move_unit",
    "set_direction",
  ] as const satisfies readonly PlayerActionKind[]) {
    const error = errorOf(rulesWith({ playerActions: ["play_card", kind] }));
    expect([kind, error.field]).toEqual([kind, "playerActions"]);
    // 错误信息要能自己解释清楚：哪个值、为什么 —— 撞上它的人不该再去翻规范。
    expect(error.message).toContain(kind);
    expect(error.message).toContain("《数值基准》§1.2");
    expect(error.message).toContain("决策 #3");
    // 只写这一项（不带 play_card）也一样拒。
    expect(errorOf(rulesWith({ playerActions: [kind] })).field).toBe("playerActions");
  }
});

test("★ 校验点在 createGame 的第一行：坏配置连状态都造不出来", () => {
  // 不是"建局成功但开关静默无效"，而是**建不出这一局**。
  //
  // ⚠ 两个 kind 都要走一遍这一关：只测其中一个的话，另一个从 `createGame` 这一侧漏掉
  //   （比如校验挪进了某条只有 `set_direction` 才走到的分支）不会有任何测试变红 ——
  //   直调 `validateRulesConfig` 的那条测试照样全绿，而**真实调用方只有 `createGame`**。
  for (const kind of [
    "move_unit",
    "set_direction",
  ] as const satisfies readonly PlayerActionKind[]) {
    const bad = rulesWith({ playerActions: ["play_card", kind] });
    let caught: unknown = null;
    try {
      createGame(bad, [[], []], 1);
    } catch (error) {
      caught = error;
    }
    expect([kind, caught instanceof RulesConfigError]).toEqual([kind, true]);
  }
  // 对照组：默认白名单照常建局。
  expect(createGame(VALID, [[], []], 1).phase).toBe("mulligan");
});

test("playerActions 的另外两种非法形态：空白名单、域外取值", () => {
  expect(errorOf(rulesWith({ playerActions: [] })).field).toBe("playerActions");
  const bogus = ["fly_away"] as unknown as readonly PlayerActionKind[];
  expect(errorOf(rulesWith({ playerActions: bogus })).message).toContain("不是已知的玩家 action");
});

test("★ 原型键不算取值：constructor / __proto__ 之流一律拒（`in` 会把它们放行）", () => {
  // 准入表是普通对象字面量，`"constructor" in 表` 走**原型链**恒为 true ——
  // 于是一份 `playerActions: ["constructor"]` 的配置能通过校验、真的建出一局，
  // `initiative: "toString"` 同样放行（随后 `nextInitiative` 的 switch 落到没人认领的
  // 分支上）。本文件头写着配置可能来自数据库/配置文件/网络，而 JSON 里 `"__proto__"`
  // 就是一个谁都写得出来的普通字符串键，所以这是威胁模型之内的洞。
  // 判据必须是 `Object.hasOwn`：表里有几项就只放行几项。
  const prototypeKeys = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"];
  for (const key of prototypeKeys) {
    const kinds = [key] as unknown as readonly PlayerActionKind[];
    const action = errorOf(rulesWith({ playerActions: kinds }));
    expect([key, action.field]).toEqual([key, "playerActions"]);
    expect(action.message).toContain("不是已知的玩家 action");

    const initiative = errorOf(rulesWith({ initiative: key as RulesConfig["initiative"] }));
    expect([key, initiative.field]).toEqual([key, "initiative"]);
  }

  // 与决策 #3 那两项一样，拒绝发生在**建局之前**：不是"校验说不行但 createGame 照建"。
  const bad = rulesWith({
    playerActions: ["constructor"] as unknown as readonly PlayerActionKind[],
  });
  let caught: unknown = null;
  try {
    createGame(bad, [[], []], 1);
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof RulesConfigError).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 其余字段
// ═══════════════════════════════════════════════════════════════════════════

test("默认配置与本文件的夹具都合法（对照组：校验器不是恒抛）", () => {
  expect(() => validateRulesConfig(VALID)).not.toThrow();
});

test("逐字段的非法取值都带上字段名与原因", () => {
  const cases: readonly [string, RulesConfig][] = [
    ["board.slots", rulesWith({ board: { slots: 0 } })],
    ["crystals.initial", rulesWith({ crystals: { initial: -1, growth: 1, capMax: 10 } })],
    ["crystals.growth", rulesWith({ crystals: { initial: 5, growth: 1.5, capMax: 10 } })],
    // capMax < initial：第 1 回合的 min() 会立刻把开局水晶砍掉，initial 就没意义了。
    ["crystals.capMax", rulesWith({ crystals: { initial: 5, growth: 1, capMax: 3 } })],
    // 阈值 0 会让 actions 相位在第一次检查时就直接进战斗。
    ["pass.combatAfterConsecutivePasses", rulesWith({ pass: { combatAfterConsecutivePasses: 0 } })],
    ["initiative", rulesWith({ initiative: "coin_flip" as RulesConfig["initiative"] })],
    ["baseHp", rulesWith({ baseHp: 0 })],
    ["deck.startingHand", rulesWith({ deck: { ...VALID.deck, startingHand: -1 } })],
    ["actionSeconds", rulesWith({ actionSeconds: -1 })],
    // Σ deploySchedule ≠ perDeck ⇒ 有英雄永远上不了场（或要部署卡组外没有的）。
    [
      "heroes.deploySchedule",
      rulesWith({ heroes: { perDeck: 3, deploySchedule: [2], respawnDelay: 1 } }),
    ],
    [
      "heroes.deploySchedule[0]",
      rulesWith({ heroes: { perDeck: 3, deploySchedule: [-1, 4], respawnDelay: 1 } }),
    ],
    [
      "heroes.respawnDelay",
      rulesWith({ heroes: { perDeck: 3, deploySchedule: [2, 1], respawnDelay: -1 } }),
    ],
  ];
  for (const [field, rules] of cases) {
    const error = errorOf(rules);
    expect([field, error.field]).toEqual([field, field]);
    expect(error.name).toBe("RulesConfigError");
    expect(error.message).toContain(field);
  }
});

test("Σ deploySchedule === perDeck 的合法变体照常通过（不是只认默认值）", () => {
  expect(() =>
    validateRulesConfig(
      rulesWith({ heroes: { perDeck: 4, deploySchedule: [1, 1, 2], respawnDelay: 0 } }),
    ),
  ).not.toThrow();
  // 完全不带英雄的变体同样合法。
  expect(() =>
    validateRulesConfig(rulesWith({ heroes: { perDeck: 0, deploySchedule: [], respawnDelay: 0 } })),
  ).not.toThrow();
});
