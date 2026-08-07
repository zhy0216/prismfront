import { defineConfig } from "vite";

// M0/S2 spike：验证 Vite 8 在 Bun 的 Node 兼容层下能否驱动 Phaser 4（架构 §1.2 风险 B）。
// 保持最小——M10 再加 alias / 环境变量 / 构建产物切分。
export default defineConfig({
  server: {
    // host 必须显式钉死。Vite 默认 host 是 "localhost"，而 Bun 解析 "localhost" 时
    // ::1 与 127.0.0.1 的先后顺序在不同进程之间会翻转（实测同一条命令两次分别绑到
    // [::1]:5273 和 127.0.0.1:5273），于是「curl 127.0.0.1 连不上」会偶发。
    // Node 下没这个抖动。钉死之后 CI/冒烟脚本才能写死地址。
    host: "127.0.0.1",
    port: 5273,
    strictPort: true,
  },
});
