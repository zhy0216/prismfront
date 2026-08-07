// @prismfront/server —— Colyseus 房间与投影（架构 §2.3）
// 内部结构：transport/（Colyseus 隔离层，风险 A 的爆炸半径就限在这一层）、rooms/、
//           projector.ts、persistence/。不含任何卡牌规则。
// 决策 #1（已拍板）：不使用 Colyseus Schema。房间元信息与棋盘一样走 send/onMessage，
//   序列化器 3/4 大版本裂口随即与我们无关（架构 §1.2 首选方案、§9）。
// M0 spike S1 已实测通过，见 spike/ 与其结论。M9 写房间时必须守住的两条：
//   1. 绝不调用 this.setState() —— 一旦调用，序列化器从 none 切到 schema，
//      而本仓当前解析到的是 @colyseus/schema@3.0.76（core 0.17.47 的 peer 要 ^4.0.7），
//      裂口会立刻变成真实的编码错配。客户端断言 room.serializerId === "none" 是这条的哨兵。
//   2. onLeave 里 allowReconnection 的 reject 值是布尔 false，不是 Error（实测）。
// 房间代码属于 M9，本步只留占位。
export {};
