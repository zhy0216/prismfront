import { Scene } from "phaser";
import type { ClientCardData } from "../core/card-face.ts";
import { cardFaceSpec } from "../core/card-face.ts";
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
        fallback.fillStyle(spec.frameColor).fillRect(0, 0, 220, 170);
        fallback.lineStyle(3, 0xffffff, 0.45);
        for (let y = 18; y < 170; y += 28) fallback.lineBetween(0, y, 220, y - 18);
        fallback.generateTexture(spec.artLayer.key, 220, 170).destroy();
      }
      // Image and fallback both become the same art texture key before the shared face compositor.
      const frame = this.add.rectangle(0, 0, 240, 340, spec.frameColor).setStrokeStyle(8, 0xeaf2ff);
      const art = this.add.image(0, -48, spec.artLayer.key).setDisplaySize(220, 170);
      const name = this.add
        .text(0, 58, spec.name, { color: "#101522", fontSize: "23px" })
        .setOrigin(0.5);
      const stats = this.add
        .text(0, 126, `${spec.atk ?? "·"} / ${spec.health ?? "·"}`, {
          color: "#101522",
          fontSize: "22px",
        })
        .setOrigin(0.5);
      const dots = spec.colorDots.map((color, index) =>
        this.add.circle(-78 + index * 26, -140, 9, color).setStrokeStyle(2, 0xffffff),
      );
      const face = this.add
        .container(120, 170, [frame, art, name, stats, ...dots])
        .setVisible(false);
      const texture = this.add.renderTexture(0, 0, 240, 340).setVisible(false);
      texture.draw(face).saveTexture(spec.key);
      texture.destroy();
      face.destroy(true);
    }
    this.scene.start("MatchScene");
  }
}
