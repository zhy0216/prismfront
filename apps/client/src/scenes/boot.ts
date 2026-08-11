import { Scene } from "phaser";
import { CARD_TEMPLATE_ASSETS, type ClientCardData, cardFaceSpec } from "../core/card-face.ts";
import { createCardFaceTexture } from "../core/card-texture.ts";
import cardsBundle from "../generated/cards.client.json";

export class BootScene extends Scene {
  constructor() {
    super("BootScene");
  }

  preload(): void {
    for (const template of Object.values(CARD_TEMPLATE_ASSETS)) {
      this.load.image(template.key, template.url);
    }
  }

  create(): void {
    for (const card of Object.values(cardsBundle.cards) as ClientCardData[]) {
      createCardFaceTexture(this, cardFaceSpec(card));
    }
    this.scene.start("MatchScene");
  }
}
