import type { Bundle } from "../types/index.ts";

export interface BundleDiff {
  readonly addedCards: readonly string[];
  readonly removedCards: readonly string[];
  readonly changedCards: readonly string[];
  readonly addedEnchantments: readonly string[];
  readonly removedEnchantments: readonly string[];
  readonly changedEnchantments: readonly string[];
}

function diffMap(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): readonly [readonly string[], readonly string[], readonly string[]] {
  const added = Object.keys(after)
    .filter((id) => !(id in before))
    .sort();
  const removed = Object.keys(before)
    .filter((id) => !(id in after))
    .sort();
  const changed = Object.keys(before)
    .filter((id) => id in after && JSON.stringify(before[id]) !== JSON.stringify(after[id]))
    .sort();
  return [added, removed, changed];
}

/** Stable structural diff used by the ir:diff CLI/admin tooling. */
export function diffBundles(before: Bundle, after: Bundle): BundleDiff {
  const [addedCards, removedCards, changedCards] = diffMap(before.cards, after.cards);
  const [addedEnchantments, removedEnchantments, changedEnchantments] = diffMap(
    before.enchantments,
    after.enchantments,
  );
  return {
    addedCards,
    removedCards,
    changedCards,
    addedEnchantments,
    removedEnchantments,
    changedEnchantments,
  };
}
