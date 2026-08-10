import { Scene } from "phaser";
import {
  CARD_FACE_HEIGHT,
  CARD_FACE_WIDTH,
  type ClientCardData,
  cardFaceSpec,
} from "../core/card-face.ts";
import { RENDER_DENSITY } from "../core/rendering.ts";
import cardsBundle from "../generated/cards.client.json";

export class BootScene extends Scene {
  constructor() {
    super("BootScene");
  }

  preload(): void {
    for (const card of Object.values(cardsBundle.cards) as ClientCardData[]) {
      const layer = cardFaceSpec(card).artLayer;
      if (layer.kind === "image") this.load.image(layer.key, layer.url);
    }
  }

  create(): void {
    for (const card of Object.values(cardsBundle.cards) as ClientCardData[]) {
      const spec = cardFaceSpec(card);
      if (!this.textures.exists(spec.artLayer.key)) {
        const fallback = this.make.graphics();
        const artWidth = 220 * RENDER_DENSITY;
        const artHeight = 170 * RENDER_DENSITY;
        fallback.fillStyle(spec.frameColor).fillRect(0, 0, artWidth, artHeight);
        fallback.lineStyle(3, 0xffffff, 0.45);
        for (let y = 18; y < 170; y += 28) {
          fallback.lineBetween(0, y * RENDER_DENSITY, artWidth, (y - 18) * RENDER_DENSITY);
        }
        fallback.generateTexture(spec.artLayer.key, artWidth, artHeight).destroy();
      }
      // Image and fallback both become the same art texture key before the shared face compositor.
      const frame = this.add
        .rectangle(0, 0, CARD_FACE_WIDTH, CARD_FACE_HEIGHT, spec.frameColor)
        .setStrokeStyle(8, 0xeaf2ff);
      const art = this.add.image(0, -48, spec.artLayer.key).setDisplaySize(220, 170);
      const name = this.add
        .text(0, 58, spec.name, {
          color: "#101522",
          fontSize: "23px",
          resolution: RENDER_DENSITY,
        })
        .setOrigin(0.5);
      const stats = this.add
        .text(0, 126, `${spec.atk ?? "·"} / ${spec.health ?? "·"}`, {
          color: "#101522",
          fontSize: "22px",
          resolution: RENDER_DENSITY,
        })
        .setOrigin(0.5);
      const dots = spec.colorDots.map((color, index) =>
        this.add.circle(-78 + index * 26, -140, 9, color).setStrokeStyle(2, 0xffffff),
      );
      const face = this.add
        .container(
          (CARD_FACE_WIDTH * RENDER_DENSITY) / 2,
          (CARD_FACE_HEIGHT * RENDER_DENSITY) / 2,
          [frame, art, name, stats, ...dots],
        )
        .setScale(RENDER_DENSITY);
      const texture = this.add
        .renderTexture(0, 0, CARD_FACE_WIDTH * RENDER_DENSITY, CARD_FACE_HEIGHT * RENDER_DENSITY)
        .setVisible(false);
      // Phaser 4 buffers RenderTexture draw commands. Flush them before the
      // temporary compositor objects are destroyed, otherwise the saved card
      // texture is transparent. The source container must also stay visible
      // while it is being drawn; it is destroyed before the first frame.
      texture.draw(face);
      texture.render();
      texture.saveTexture(spec.key);
      texture.destroy();
      face.destroy(true);
    }
    this.scene.start("MatchScene");
  }
}
