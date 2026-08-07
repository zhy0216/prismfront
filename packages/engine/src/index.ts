// @prismfront/engine —— 纯规则内核（架构 §2.3）
// 将来导出：apply(state, intent)、resume(state, input)、legalActions(state, player)、
//           project(state, viewer)、projectEvent、createGame(rules, decks, seed)。
// 内部结构：state/ rng/ resolve/ triggers/ deaths/ auras/ combat/ eval/ handlers/ view/ rules/
// 铁律：dependencies 永远为空（§2.2 禁令 1、§6.3）；不得使用 Bun.* 与 bun: 模块（§2.2 禁令 5）；
//       不认识网络、不认识具体卡（按 cardId 查注册表）、不读时间（§6.1 确定性）。
// M0/T2 骨架占位，状态机在 M2 落地。
export {};
