// @prismfront/cli —— 对局 / 回放 / ir 工具链 / 批量模拟（架构 §2.3）
// 内部结构：play/ replay/ ir/ sim/。
// sim 是测试策略第 4 层（不变量 fuzz）的宿主：随机 bot 万局，每步断言血量非负、
//   单实体不跨区、槽位无重复占用、clone 一致（架构 §7）。
// M0/T2 骨架占位，随 M8 落地。
export {};
