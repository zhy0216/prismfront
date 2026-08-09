import type { Bundle, CardId, RulesConfig } from "@prismfront/ir";

export class DeckValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeckValidationError";
  }
}

/** Validates construction-only hero ownership before a deck reaches createGame. */
export function validateConstructedDeck(
  bundle: Bundle,
  rules: RulesConfig,
  heroes: readonly CardId[],
  deck: readonly CardId[],
): void {
  const cardsPerHero = rules.heroes.cardsPerHero ?? 10;
  if (rules.deck.size !== rules.heroes.perDeck * cardsPerHero) {
    throw new DeckValidationError("deck.size 必须等于 heroes.perDeck × heroes.cardsPerHero");
  }
  if (heroes.length !== rules.heroes.perDeck)
    throw new DeckValidationError("英雄数量不符合 perDeck");
  if (!(rules.heroes.allowDuplicates ?? false) && new Set(heroes).size !== heroes.length) {
    throw new DeckValidationError("英雄必须互不相同");
  }
  const selected = new Set(heroes);
  const heroCounts = new Map<CardId, number>();
  const copies = new Map<CardId, number>();
  for (const id of deck) {
    const card = bundle.cards[id];
    if (card === undefined) throw new DeckValidationError(`卡牌不存在：${id}`);
    if (card.data.hero === undefined || !selected.has(card.data.hero)) {
      throw new DeckValidationError(`卡牌 ${id} 不属于所选英雄`);
    }
    heroCounts.set(card.data.hero, (heroCounts.get(card.data.hero) ?? 0) + 1);
    const count = (copies.get(id) ?? 0) + 1;
    if (count > rules.deck.maxCopies) throw new DeckValidationError(`卡牌 ${id} 超过 maxCopies`);
    copies.set(id, count);
  }
  if (deck.length !== rules.deck.size) throw new DeckValidationError("牌库张数不符合 deck.size");
  for (const hero of heroes) {
    if (heroCounts.get(hero) !== cardsPerHero)
      throw new DeckValidationError(`英雄 ${hero} 必须恰好携带 ${cardsPerHero} 张专属卡`);
  }
}

/** Validates bundle diversity can satisfy each hero quota. */
export function validateHeroPoolFloor(bundle: Bundle, rules: RulesConfig): void {
  const cardsPerHero = rules.heroes.cardsPerHero ?? 10;
  const minimum = Math.ceil(cardsPerHero / rules.deck.maxCopies);
  for (const hero of Object.values(bundle.cards).filter((card) => card.data.kind === "hero")) {
    const ownedKinds = Object.values(bundle.cards).filter(
      (card) => card.data.hero === hero.id,
    ).length;
    if (ownedKinds < minimum)
      throw new DeckValidationError(`英雄 ${hero.id} 的专属卡种类 ${ownedKinds} < ${minimum}`);
  }
}
