// @prismfront/cards —— 卡牌脚本源（架构 §2.3）
// 将来导出：CARD_SOURCES（TS 源）；由 ir:build 产出 dist/cards.ir.json 与 dist/cards.client.json。
// 内部结构：src/pf1/{R,G,B,heroes,tokens}/ + 同目录 *.test.ts（测试策略第 1 层）。
// 铁律：运行时只依赖 @prismfront/ir；对 @prismfront/engine 只能是 devDependency（§2.2 禁令 4）。
// 不含引擎逻辑。M0/T2 骨架占位，首批卡在 M4 落地。
export {};
