// bundle → `cards.client.json`（架构 §5.2 客户端的输入）。
//
// > 只含展示字段：`id / name / text / kind / cost / colors / atk / health / rarity / art`。
// > **绝不含 `script`。** 由 `ir:build` 从同一份源产出，所以不会漂移。
//
// 为什么这条是**安全边界**而不是瘦身优化（架构 §2.2 禁令 3 / §6.2）：
// 客户端一旦拿到卡牌逻辑，就能预判隐藏信息 —— 对手手牌里那张牌会做什么、
// `sel.random` 会挑中谁、亡语会召唤出什么，全部可以在本地先算一遍。
// 所以这里是**白名单投影**（逐字段挑出来），不是"从 Card 上删掉 script"的黑名单：
// 将来 IR 加了新字段，白名单默认不放行，黑名单默认放行。
//
// `atk` / `health` 从 `data.tags` 里摊平：客户端要的是卡面上印的那两个数字，
// 不需要知道它们在 IR 里是 tag（生效值 = base + Σ附魔 + Σ光环，那是 engine 与投影层的事）。

import type { Bundle, Card, CardId, CardKind, Color, LocalizedText, Rarity } from "@prismfront/ir";

/** 一张卡的展示投影（架构 §5.2 的字段表，顺序照抄）。 */
export interface ClientCard {
  id: CardId;
  name: LocalizedText;
  text?: LocalizedText;
  kind: CardKind;
  cost?: number;
  colors: readonly Color[];
  atk?: number;
  health?: number;
  rarity?: Rarity;
  art?: string;
}

/**
 * `cards.client.json` 的整体形状。
 *
 * 除了卡表还带两个 bundle 级字段：客户端要能核对"我手上的卡面数据是不是这场对局
 * 钉住的那个 bundle"（IR §2.1：对局开始时钉住 bundleId 并写进回放）。两者都不是卡牌逻辑。
 * 卡按 id 建索引而不是数组：客户端拿到的事件里只有 cardId。
 */
export interface ClientBundle {
  bundleId: string;
  irVersion: string;
  cards: Readonly<Record<CardId, ClientCard>>;
}

/**
 * 逐字段挑，顺序照抄架构 §5.2 的字段表（也是 {@link ClientCard} 的声明顺序）。
 *
 * 用条件展开而不是"先建对象再补字段"，是为了让**缺省字段不出现**的同时
 * **键序仍然固定** —— 与 IR 规范形式的第 2、3 条规则同一个道理（IR §1 原则 1）：
 * 同一份源永远产出同一份 JSON，diff 才有意义。
 */
function projectCard(card: Card): ClientCard {
  const { data } = card;
  const tags = data.tags ?? {};
  return {
    id: card.id,
    name: data.name,
    ...(data.text === undefined ? {} : { text: data.text }),
    kind: data.kind,
    ...(data.cost === undefined ? {} : { cost: data.cost }),
    colors: data.colors,
    ...(tags.atk === undefined ? {} : { atk: tags.atk }),
    ...(tags.health === undefined ? {} : { health: tags.health }),
    ...(data.rarity === undefined ? {} : { rarity: data.rarity }),
    ...(data.art === undefined ? {} : { art: data.art }),
  };
}

/**
 * 白名单投影。入参是**已经建好的 bundle**而不是卡表源，这样两份产物必然同源同序
 * （架构 §5.2「由 ir:build 从同一份源产出，所以不会漂移」）。
 */
export function projectClient(bundle: Bundle): ClientBundle {
  const cards: Record<CardId, ClientCard> = {};
  // bundle.cards 已按 id 排序（buildBundle），照它的顺序走，客户端产物同样确定。
  for (const [id, card] of Object.entries(bundle.cards)) {
    cards[id] = projectCard(card);
  }
  return { bundleId: bundle.bundleId, irVersion: bundle.irVersion, cards };
}
