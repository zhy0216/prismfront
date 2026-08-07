// 具名选择器常量（IR §3.1 的"TS 常量 → IR"对照表 + DSL v2.1 §11.2 的词汇分化）。
//
// 三条来自规范的定案，全部落在这个文件里：
//
// 1. **`ENEMY_HERO` → `ENEMY_BASE`**（v2.1 §11.2、架构 §10 第 3 项）：
//    承接"方向指空格"伤害的实体改名 base，`ZoneName` 里 `"hero"` 已删。
//    IR §3.1 表里的 `ENEMY_HERO = zone(enemy, "hero")` 因此写作 `zone(enemy, "base")`。
//
// 2. **`*_UNITS` 与 `*_MINIONS` 分化**（v2.1 §11.2）：
//    `FRIENDLY_UNITS` = 场上全部（**含英雄**）= `zone(friendly, "board")`；
//    `FRIENDLY_MINIONS` = 排除英雄 = `zone(friendly,"board").where(is_kind(it,"minion"))`。
//    于是已有卡的"友方随从"语义自动正确（光环不吃英雄）；
//    伤害法术的默认目标域建议用 `*_UNITS`。
//    ⚠ v1（IR §10.3 / §10.4）里的 `FRIENDLY_MINIONS` 写于英雄占格之前，
//    那时两者同义，对应到今天应读作 `FRIENDLY_UNITS`。
//
// 3. **`ANY_CHARACTER` / `ALL_CHARACTERS` = `zone(both, ["board","base"])`**：
//    IR §3.1/§10.1 原文是 `["board","hero"]`，按第 1 条改名而来。

import type { SelSide, SlotSide } from "../types/index.ts";
import { IsKind } from "./cond.ts";
import { type FluentSel, IT, Zone } from "./sel.ts";

/** 己方（`slot.*` 与 `sel.zone` 通用）。`At(FRIENDLY, 4)` 用的就是它（v2 §7）。 */
export const FRIENDLY = "friendly" satisfies SlotSide & SelSide;
/** 敌方。 */
export const ENEMY = "enemy" satisfies SlotSide & SelSide;
/** 双方。**只有 `sel.zone` 有这一档**，`slot.*` 没有（架构 §10 第 4 项）。 */
export const BOTH = "both" satisfies SelSide;

// ── 战线（board）───────────────────────────────────────────────────────────

/** 己方场上全部单位，**含英雄**（v2.1 §11.2）。按格序 0→8 枚举（v2 §3.2）。 */
export const FRIENDLY_UNITS: FluentSel = Zone(FRIENDLY, "board");
/** 敌方场上全部单位，含英雄。 */
export const ENEMY_UNITS: FluentSel = Zone(ENEMY, "board");
/** 双方场上全部单位，含英雄。 */
export const ALL_UNITS: FluentSel = Zone(BOTH, "board");

/** 己方随从：场上排除英雄（v2.1 §11.2）。 */
export const FRIENDLY_MINIONS: FluentSel = FRIENDLY_UNITS.where(IsKind(IT, "minion"));
/** 敌方随从：场上排除英雄。 */
export const ENEMY_MINIONS: FluentSel = ENEMY_UNITS.where(IsKind(IT, "minion"));
/** 双方随从：场上排除英雄。 */
export const ALL_MINIONS: FluentSel = ALL_UNITS.where(IsKind(IT, "minion"));

/** 己方英雄（`kind:"hero"`，占格参战，v2.1 §11.2）。 */
export const FRIENDLY_HEROES: FluentSel = FRIENDLY_UNITS.where(IsKind(IT, "hero"));
/** 敌方英雄。 */
export const ENEMY_HEROES: FluentSel = ENEMY_UNITS.where(IsKind(IT, "hero"));

// ── 基地（base）与"全体角色"─────────────────────────────────────────────────

/** 己方基地（30 血，归零判负）。v1 叫 `FRIENDLY_HERO`。 */
export const FRIENDLY_BASE: FluentSel = Zone(FRIENDLY, "base");
/** 敌方基地。v1 叫 `ENEMY_HERO`（v2.1 §11.2 改名）。 */
export const ENEMY_BASE: FluentSel = Zone(ENEMY, "base");

/** 双方的单位 + 基地 —— IR §3.1 的 `ALL_CHARACTERS`，伤害法术的最大目标域。 */
export const ALL_CHARACTERS: FluentSel = Zone(BOTH, ["board", "base"]);
/** IR §10.1 火球术用的名字，与 {@link ALL_CHARACTERS} 同义。 */
export const ANY_CHARACTER: FluentSel = ALL_CHARACTERS;

// ── 手牌 / 牌库 / 墓地 ──────────────────────────────────────────────────────

/** 己方手牌。 */
export const FRIENDLY_HAND: FluentSel = Zone(FRIENDLY, "hand");
/** 敌方手牌。 */
export const ENEMY_HAND: FluentSel = Zone(ENEMY, "hand");
/** 己方牌库。 */
export const FRIENDLY_DECK: FluentSel = Zone(FRIENDLY, "deck");
/** 敌方牌库。 */
export const ENEMY_DECK: FluentSel = Zone(ENEMY, "deck");
/** 己方墓地。亡语触发器的 `zone` 也写 `"graveyard"`。 */
export const FRIENDLY_GRAVEYARD: FluentSel = Zone(FRIENDLY, "graveyard");
/** 敌方墓地。 */
export const ENEMY_GRAVEYARD: FluentSel = Zone(ENEMY, "graveyard");
/** 复燃泉：英雄阵亡后待复活的区域（v2.1 §11.3）。 */
export const FRIENDLY_FOUNTAIN: FluentSel = Zone(FRIENDLY, "fountain");
