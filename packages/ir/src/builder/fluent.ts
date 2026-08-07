// 编写层的链式外壳（fluent chain）。
//
// 为什么需要它：IR §10 与 DSL v2 §8 的示例源码大量使用链式写法 ——
//   `SlotOf(SELF).opposite()`                      （v2 §8.2 空袭猎手）
//   `FRIENDLY_MINIONS.not(TARGET)`                 （v2 §8.4 换位术）
//   `Count(FRIENDLY_MINIONS).negate()`             （IR §10.4 谜之勇士）
//   `Attr(SELF,"atk").gte(3)` / `ENEMY_MINIONS.random(2)`（IR §10.4）
//   `IsSpell().and(...)`                           （IR §10.5 发现）
// 这些方法是**糖**，不是 IR 的一部分（IR §1 原则 1：IR 是规范形式，糖只存在于编写层）。
//
// 实现方式：链式方法挂在**原型**上，节点字段作为自有可枚举属性。
// 于是 `Object.keys` / `JSON.stringify` / 展开运算符只看得见数据，看不见方法 ——
// 糖渗不进规范形式。（即便渗进 JSON.stringify，函数值本来也不会被序列化，这是双保险。）
//
// 自有属性的**插入顺序 = 构造器里对象字面量的书写顺序 = 规范签名的字段声明顺序**，
// 所以 `JSON.stringify(Hit(TARGET, 6))` 直接就是规范形式的键序
// （IR §5.4 规则 1：字段声明顺序即求值顺序）。

/**
 * 给一个 IR 节点套上链式方法原型。
 *
 * @param proto 该节点族的方法原型（`selProto` / `numProto` / …），只含方法，不含数据
 * @param node  纯数据节点，字段顺序即规范键序
 * @returns 同一份数据 + 原型方法；自有可枚举属性与 `node` 逐字段一致
 */
export function withChain<TProto extends object, TNode extends object>(
  proto: TProto,
  node: TNode,
): TNode & TProto {
  return Object.assign(Object.create(proto) as TProto, node);
}
