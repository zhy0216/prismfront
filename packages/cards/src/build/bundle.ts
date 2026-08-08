// 卡表源 → `cards.ir.json`（IR §2.1 的 bundle / 架构 §5.1 引擎的输入）。
//
// 本文件是**纯函数**：卡进 bundle 出，不碰文件系统、不读时钟、不读环境变量。
// 写文件那一步在 `scripts/ir-build.ts`（架构 §2.2 禁令 5 的分界线：
// I/O 与宿主 API 只出现在能被单独审的那一个入口，规则本体保持运行时中立）。
//
// ═══════════════════════════════════════════════════════════════════════════
// ★ 确定性构建（IR §1 原则 1）：同一份源必须产出同一份 JSON ★
// ═══════════════════════════════════════════════════════════════════════════
// 三个下游都押在这条上：
//   1. turbo 把 `dist/cards.ir.json` 当缓存产物 —— 内容随机就等于缓存永远脏
//   2. M8 的 golden replay 靠 `bundleId` 钉住历史对局（IR §2.1：每场对局开始时
//      钉住 bundleId 并写进回放，平衡性补丁才不会让回放失真）
//   3. 平衡改动的 diff 要能一眼看出改了哪张卡
// 落地成三条硬规矩：
//   a. `bundleId` = 卡表内容的指纹，**不含时间戳、不含随机数**（见 `bundleIdOf`）
//   b. 卡与附魔按 id 排序后写入，与源文件的聚合顺序无关
//   c. `createdAt` 见下面 `resolveCreatedAt` 的说明 —— 这是唯一一处真冲突

import type { Bundle, Card, CardId, EnchantId, Enchantment, NodeOp } from "@prismfront/ir";
import { canonicalJson, collectOps, IR_VERSION } from "@prismfront/ir";
import { fingerprint } from "./hash.ts";

/** `bundleId` 的前缀 = 卡集码（《命名与主题》§4：基准集 `PF1`，小写用于 id）。 */
export const BUNDLE_ID_PREFIX = "pf1";

/**
 * `createdAt` 的缺省值 —— **构建纪元**，不是"这次构建的时间"。
 *
 * 取值是 PF1 卡表立项日（M0 的仓库骨架日）。它是个常量，所以两次构建的产物逐字节相同。
 */
export const BUNDLE_EPOCH = "2026-08-07T00:00:00.000Z";

export interface BuildInput {
  readonly cards: readonly Card[];
  readonly enchantments: readonly Enchantment[];
  /** 构建时间戳（ISO 8601）。省略 → {@link BUNDLE_EPOCH}。 */
  readonly createdAt?: string;
}

/**
 * `createdAt` 怎么取：**确定性构建 vs "记录构建时间"是一对真冲突**，这里的选择与理由。
 *
 * IR §2.1 要求 bundle 带一个 ISO 8601 的 `createdAt`，而 `new Date()` 会让同一份源
 * 每次构建产出不同的 JSON —— 上面三条下游全部作废。三个候选：
 *
 *   ✗ 直接取当前时间：最诚实，但直接违背 IR §1 原则 1，且 turbo 的产物缓存会永远脏。
 *   ✗ 把内容指纹映射成一个"日期"：确定是确定了，但那是个**假时间戳**，
 *     比没有还糟 —— 事故复盘时会有人真的照着它去查那天的发布记录。
 *   ✓ **取 `SOURCE_DATE_EPOCH`，缺省回落到固定的 {@link BUNDLE_EPOCH}**。
 *     这是 reproducible-builds 的既有约定（发布流水线把提交时间塞进这个环境变量，
 *     本地与 CI 不设则拿常量），一次同时满足两边：默认路径下产物逐字节可复现，
 *     需要真时间的发布路径也有正规入口，不用改代码。
 *
 * 两条必须一起记住的边界：
 *   1. **`bundleId` 不吃这个变量**（见 {@link bundleIdOf}：指纹只算 irVersion + 卡表）。
 *      所以即使有人设了 `SOURCE_DATE_EPOCH`，回放钉住的身份也不会漂 —— 冲突被限制在
 *      一个纯展示字段上，这正是选它的关键理由。
 *   2. 根 `turbo.json` 的 `ir:build` 没有声明 `env: ["SOURCE_DATE_EPOCH"]`（本条目不改
 *      根配置），因此改这个变量**不会**使 turbo 的产物缓存失效，可能拿到上一次的
 *      `createdAt`。真要在发布流水线里用，先在 turbo.json 的 `ir:build` 补上 `env`。
 */
export function resolveCreatedAt(sourceDateEpoch: string | undefined): string {
  const raw = sourceDateEpoch?.trim() ?? "";
  if (raw === "") {
    return BUNDLE_EPOCH;
  }
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error(
      `SOURCE_DATE_EPOCH 必须是非负整数秒，实际是 ${JSON.stringify(sourceDateEpoch)}`,
    );
  }
  // 全包唯一放行 `Date` 的一行，而且它**不读时钟**：把调用方给的显式 epoch 转成 ISO，
  // 是个纯函数（同样的 seconds 永远得到同样的串）。禁令拦的是 `new Date()` / `Date.now()`
  // 这种真的去问系统时间的写法 —— 那会让确定性构建当场作废（`packages/cards/biome.json`
  // 里写了完整理由）。`grep biome-ignore` 就是「哪里碰了时钟」的完整清单，目前只有这一处。
  // biome-ignore lint/style/noRestrictedGlobals: 显式 epoch → ISO 的纯转换，不读系统时钟；详见上一段与 biome.json 里 Date 那条的说明。
  return new Date(seconds * 1000).toISOString();
}

/** 按 id 排序后建索引；撞 id 直接炸（bundle 是 `Record<CardId, …>`，撞了会静默丢卡）。 */
function indexById<T extends { readonly id: string }>(
  items: readonly T[],
  subject: string,
): Readonly<Record<string, T>> {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: Record<string, T> = {};
  for (const item of sorted) {
    if (Object.hasOwn(out, item.id)) {
      throw new Error(`${subject} id 重复：${item.id}（同一个 id 只能有一份）`);
    }
    out[item.id] = item;
  }
  return out;
}

/**
 * 扫出卡表用到的 op 全集（IR §2.1 的 `opsUsed`；engine 启动时拿它做全集比对）。
 *
 * 遍历复用 `@prismfront/ir` 的校验器遍历（`collectOps` → `validate/walk.ts`）：
 * "哪个字段位置上会有节点"只有 `schemas.ts` 一份定义，op 集增长时不会有第二份遍历漏掉。
 * 排序取字典序，产物里这一行才是稳定的。
 */
function opsUsedIn(
  cards: readonly Card[],
  enchantments: readonly Enchantment[],
): readonly NodeOp[] {
  const ops = new Set<NodeOp>();
  for (const card of cards) {
    collectOps(card, "cardDoc", ops);
  }
  for (const enchantment of enchantments) {
    collectOps(enchantment, "enchantment", ops);
  }
  return [...ops].sort();
}

/**
 * `bundleId` = `pf1@<内容指纹>`。
 *
 * 指纹算的是 **irVersion + 全部卡 + 全部附魔**的规范 JSON：
 * 卡改了要换 id（回放要能区分），IR 版本变了也要换（同一张卡在新语义下不是同一张卡）。
 * `createdAt` **不进指纹** —— 它不是卡表内容，进了就等于把确定性拱手让掉。
 *
 * 形状上没有沿用 IR §2.1 示例的 `core@2026.08.05-1`（日期 + 当日序号）：
 * 那种 id 要么手工维护，要么靠时钟，两条都跟确定性构建冲突。内容指纹反而更符合
 * "不可变标识"的原意 —— **同一份卡表永远是同一个 id，不同的卡表一定是不同的 id**。
 */
export function bundleIdOf(
  cards: Readonly<Record<CardId, Card>>,
  enchantments: Readonly<Record<EnchantId, Enchantment>>,
): string {
  const content = canonicalJson({ irVersion: IR_VERSION, cards, enchantments });
  return `${BUNDLE_ID_PREFIX}@${fingerprint(content)}`;
}

/**
 * 卡表源 → 一份完整 bundle（IR §2.1）。
 *
 * 字段顺序 = IR §2.1 的字段声明顺序 = 校验器 `BUNDLE_SCHEMA` 的顺序，
 * 别按字母序重排：规范形式里键序是产物的一部分（IR §1 原则 1）。
 */
export function buildBundle(input: BuildInput): Bundle {
  const cards = indexById(input.cards, "卡牌");
  const enchantments = indexById(input.enchantments, "附魔");
  return {
    irVersion: IR_VERSION,
    bundleId: bundleIdOf(cards, enchantments),
    createdAt: input.createdAt ?? BUNDLE_EPOCH,
    opsUsed: opsUsedIn(input.cards, input.enchantments),
    cards,
    enchantments,
  };
}
