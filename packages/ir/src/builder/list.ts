// 「单个 or 数组」的归一化。
//
// IR §1 原则 1：**IR 是规范形式，糖只存在于编写层**。
// 编写层允许 `play: Hit(...)`、`triggers: on(...)`、`aura: Aura(...)` 这种省略中括号的写法，
// 规范形式里它们**必须**是数组 —— 否则同一张卡会有两份 JSON，diff、缓存 key、哈希全会出问题。
//
// IR 里没有任何一个合法节点本身是数组（`Act` / `Trigger` / `Aura` … 都是对象），
// 所以 `Array.isArray` 足以判别，不会误伤。

/** 归一成只读数组：`undefined` → `[]`，单个 → `[单个]`，数组 → 原样。 */
export function toArray<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) {
    return [];
  }
  return isArray(value) ? value : [value];
}

function isArray<T>(value: T | readonly T[]): value is readonly T[] {
  return Array.isArray(value);
}
