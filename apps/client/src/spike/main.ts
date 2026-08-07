// M0/S2 spike —— Vite 8 × Bun × Phaser 4（架构 §1.2 风险 B / 风险 D）。
//
// 只验证三件事：
//   1. Vite 8 的 dev server 能在 Bun 的 Node 兼容层下起来并转译 .ts；
//   2. Phaser 4 的 ESM 产物能被 Vite 预打包并在浏览器里 boot 出渲染器；
//   3. 程序化生成的纹理（Graphics → generateTexture）能贴到 Sprite 上渲染出来。
//
// 刻意不做的事：不连服务端、不引 @prismfront/engine|cards（turbo tag "no-rules"）、
// 不引任何图片资源（美术未介入，占位一律程序化，见《Phaser 客户端技术设计》§7.3）。
//
// ★ M10 必须记住的坑：phaser@4.0.0 的 ESM 产物（dist/phaser.esm.js）**只有具名导出，
//   没有 default 导出**，而它的 types/phaser.d.ts 写的是 `export = Phaser`。
//   于是 `import Phaser from "phaser"` 能过 tsc（esModuleInterop 兜住了），
//   一到浏览器就炸 “does not provide an export named 'default'”。
//   全仓统一用具名导入——顺带也才吃得到 §11 要的 tree-shaking。

import { AUTO, Game, Scene, VERSION } from "phaser";

const BLOCK_TEXTURE = "spike-block";
const BLOCK_SIZE = 160;

class SpikeScene extends Scene {
  constructor() {
    super("SpikeScene");
  }

  // 注意：Phaser 4 的 .d.ts 只声明了 Scene#update，没有声明 init/preload/create。
  // 所以在 noImplicitOverride 下 create 不能写 override，而 update 必须写 override。
  create(): void {
    const { width, height } = this.scale;

    // 程序化占位纹理：Graphics 画一个带描边的方块 → 烘成 texture → 之后当普通 Sprite 用。
    // 这正是 §7.1 卡面合成管线的最小形态。
    const pen = this.make.graphics({ x: 0, y: 0 });
    pen.fillStyle(0x38e8c8, 1);
    pen.fillRect(0, 0, BLOCK_SIZE, BLOCK_SIZE);
    pen.lineStyle(6, 0xffffff, 1);
    pen.strokeRect(3, 3, BLOCK_SIZE - 6, BLOCK_SIZE - 6);
    pen.generateTexture(BLOCK_TEXTURE, BLOCK_SIZE, BLOCK_SIZE);
    pen.destroy();

    const block = this.add.sprite(width / 2, height / 2, BLOCK_TEXTURE);

    // 转一下：证明的是「渲染循环在跑」，不是「首帧碰巧画出来了」。
    this.tweens.add({
      targets: block,
      angle: 360,
      duration: 4000,
      repeat: -1,
    });

    // 给 spike 验收用的探针（不进 M10）。
    document.body.dataset.spikeReady = VERSION;
  }
}

const game = new Game({
  type: AUTO,
  parent: "game-root",
  width: 640,
  height: 480,
  backgroundColor: "#10131a",
  scene: SpikeScene,
});

// 让 evaluate_script 能拿到 game 实例做验收断言。
(globalThis as unknown as { __spikeGame: Game }).__spikeGame = game;
