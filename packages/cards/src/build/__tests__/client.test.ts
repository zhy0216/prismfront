// `cards.client.json` 投影的测试（架构 §5.2 + §6.2 隐藏信息）。
//
// 第一条测试是**安全性质**，不是格式检查：客户端一旦拿到 script，就能预判隐藏信息
// （对手手牌那张牌会做什么、`sel.random` 会挑中谁）。所以除了"没有 script 键"，
// 还要断言整份 JSON 里**一个 op 都不出现** —— 逻辑泄漏未必以 `script` 这个键名出现。

import { describe, expect, test } from "bun:test";
import type { Card } from "@prismfront/ir";
import { defineCard, ENEMY_UNITS, Hit, TARGET } from "@prismfront/ir";
import { CARD_SOURCES, ENCHANTMENT_SOURCES } from "../../index.ts";
import { buildBundle } from "../bundle.ts";
import { projectClient } from "../client.ts";

/** 夹具：字段给满的一张法术（含 text / rarity / art），确保每个可选字段都走到。 */
const FULL: Card = defineCard({
  id: "TEST_S01",
  name: { zh: "试针", en: "Test Needle" },
  text: { zh: "造成 3 点伤害。" },
  kind: "spell",
  cost: 1,
  colors: "red",
  rarity: "rare",
  art: "pf1/test-needle",
  target: ENEMY_UNITS,
  play: Hit(TARGET, 3),
});

/** 字段给到最少的一张随从：可选字段缺省时**不许**出现在产物里。 */
const BARE: Card = defineCard({
  id: "TEST_M01",
  name: "试桩",
  kind: "minion",
  cost: 1,
  colors: ["red", "green"],
  atk: 1,
  health: 1,
});

const CLIENT = projectClient(buildBundle({ cards: [FULL, BARE], enchantments: [] }));

describe("projectClient —— 隐藏信息边界（架构 §6.2）", () => {
  test("★ 产物里没有 script，也没有任何 op", () => {
    const json = JSON.stringify(CLIENT);
    expect(json).not.toContain("script");
    expect(json).not.toContain('"op"');
  });

  test("白名单：卡上只有架构 §5.2 列出的那些字段，且顺序与 §5.2 一致", () => {
    expect(Object.keys(CLIENT.cards.TEST_S01 ?? {})).toEqual([
      "id",
      "name",
      "text",
      "kind",
      "cost",
      "colors",
      "rarity",
      "art",
    ]);
  });

  test("atk / health 从 data.tags 摊平到卡面", () => {
    expect(CLIENT.cards.TEST_M01?.atk).toBe(1);
    expect(CLIENT.cards.TEST_M01?.health).toBe(1);
  });

  test("缺省字段不出现（法术没有攻血、净水卡没有 text）", () => {
    expect(Object.hasOwn(CLIENT.cards.TEST_S01 ?? {}, "atk")).toBe(false);
    expect(Object.hasOwn(CLIENT.cards.TEST_M01 ?? {}, "text")).toBe(false);
    expect(Object.hasOwn(CLIENT.cards.TEST_M01 ?? {}, "rarity")).toBe(false);
  });

  test("融合卡的两个颜色都带过去（v2.1 §11.4：colors 长度 2）", () => {
    expect(CLIENT.cards.TEST_M01?.colors).toEqual(["red", "green"]);
  });

  test("带上 bundleId / irVersion，客户端才能核对拿到的是不是这局钉住的那份", () => {
    const bundle = buildBundle({ cards: [FULL, BARE], enchantments: [] });
    expect(projectClient(bundle).bundleId).toBe(bundle.bundleId);
    expect(projectClient(bundle).irVersion).toBe(bundle.irVersion);
  });
});

describe("projectClient —— 真正的卡表", () => {
  test("两份产物同源同序（架构 §5.2：由 ir:build 从同一份源产出，不会漂移）", () => {
    const bundle = buildBundle({ cards: CARD_SOURCES, enchantments: ENCHANTMENT_SOURCES });
    const client = projectClient(bundle);
    expect(Object.keys(client.cards)).toEqual(Object.keys(bundle.cards));
    expect(JSON.stringify(client)).not.toContain("script");
  });
});
