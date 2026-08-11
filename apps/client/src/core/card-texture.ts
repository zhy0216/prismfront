import type { GameObjects, Scene } from "phaser";
import { CARD_FACE_HEIGHT, CARD_FACE_WIDTH, type CardFaceSpec } from "./card-face.ts";
import { RENDER_DENSITY, TEXT_SAFE_PADDING } from "./rendering.ts";

const FONT_FAMILY = '"Noto Sans SC", "Microsoft YaHei", sans-serif';

function fit(text: GameObjects.Text, maxWidth: number, maxHeight: number): void {
  text.setScale(
    Math.min(1, maxWidth / Math.max(1, text.width), maxHeight / Math.max(1, text.height)),
  );
}

function nameColor(spec: CardFaceSpec): string {
  return spec.template.color === "green" ? "#17351f" : "#fff7e8";
}

/**
 * Composite a generated faction frame with deterministic client presentation
 * fields. Illustration art is intentionally omitted until that asset pass lands.
 */
export function createCardFaceTexture(scene: Scene, spec: CardFaceSpec): void {
  if (scene.textures.exists(spec.key)) return;

  const template = scene.add
    .image(0, 0, spec.template.key)
    .setDisplaySize(CARD_FACE_WIDTH, CARD_FACE_HEIGHT);
  const name = scene.add
    .text(0, 24, spec.name, {
      align: "center",
      color: nameColor(spec),
      fontFamily: FONT_FAMILY,
      fontSize: "15px",
      fontStyle: "bold",
      padding: TEXT_SAFE_PADDING,
      resolution: RENDER_DENSITY,
    })
    .setOrigin(0.5);
  fit(name, 174, 25);

  const rules = scene.add
    .text(0, 54, spec.text, {
      align: "center",
      color: "#1a2028",
      fontFamily: FONT_FAMILY,
      fontSize: "11px",
      lineSpacing: 3,
      padding: TEXT_SAFE_PADDING,
      resolution: RENDER_DENSITY,
      wordWrap: { width: 174, useAdvancedWrap: true },
    })
    .setOrigin(0.5, 0);
  fit(rules, 174, 70);

  const numberStyle = {
    align: "center" as const,
    color: "#ffffff",
    fontFamily: FONT_FAMILY,
    fontSize: "27px",
    fontStyle: "bold",
    padding: TEXT_SAFE_PADDING,
    resolution: RENDER_DENSITY,
    stroke: "#080b12",
    strokeThickness: 5,
  };
  // Generated template sockets: cost top-right, attack bottom-left, health bottom-right.
  const cost = scene.add
    .text(88, -139, spec.cost === null ? "" : String(spec.cost), numberStyle)
    .setOrigin(0.5);
  const attack = scene.add
    .text(-90, 135, spec.atk === null ? "" : String(spec.atk), numberStyle)
    .setOrigin(0.5);
  const health = scene.add
    .text(90, 135, spec.health === null ? "" : String(spec.health), numberStyle)
    .setOrigin(0.5);

  const face = scene.add
    .container((CARD_FACE_WIDTH * RENDER_DENSITY) / 2, (CARD_FACE_HEIGHT * RENDER_DENSITY) / 2, [
      template,
      name,
      rules,
      cost,
      attack,
      health,
    ])
    .setScale(RENDER_DENSITY);
  const texture = scene.add
    .renderTexture(0, 0, CARD_FACE_WIDTH * RENDER_DENSITY, CARD_FACE_HEIGHT * RENDER_DENSITY)
    .setVisible(false);
  // Phaser buffers RenderTexture draw commands; flush before destroying sources.
  texture.draw(face);
  texture.render();
  texture.saveTexture(spec.key);
  texture.destroy();
  face.destroy(true);
}
