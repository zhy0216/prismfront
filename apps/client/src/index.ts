// @prismfront/client —— Phaser 4 + Vite 8（架构 §2.3，内部设计见《Prismfront Phaser 客户端技术设计》）
// 零规则客户端：不得依赖 @prismfront/engine 或 @prismfront/cards（§2.2 禁令 3，
//   由 turbo tag "no-rules" 强制）。客户端一旦持有卡牌逻辑就能预判隐藏信息。
// 卡牌展示数据由 cards#ir:build 写入 src/generated/cards.client.json（进 .gitignore），
//   客户端只 import 一个纯 JSON（架构 §3.1 注、§5.2）。
// index.html 与 vite.config.ts 属于 M0 的 S2 spike，本步只留占位。
export * from "./core/card-face.ts";
export * from "./core/director.ts";
export * from "./core/hotseat.ts";
export * from "./core/hud.ts";
export * from "./core/input.ts";
export * from "./core/layout.ts";
export * from "./core/rendering.ts";
export * from "./transport/colyseus.ts";
export * from "./transport/hotseat.ts";
export * from "./transport/mock.ts";
export * from "./transport/sequence.ts";
