import type { Scene } from "phaser";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "./layout.ts";

const devicePixelRatio =
  typeof window === "undefined" || !Number.isFinite(window.devicePixelRatio)
    ? 1
    : window.devicePixelRatio;

/**
 * Keep the 1920x1080 world coordinates while giving Retina displays a denser
 * backing buffer. Capping at 2 avoids turning a 3x phone screen into a very
 * expensive 5760x3240 render target.
 */
export const RENDER_DENSITY = Math.min(2, Math.max(1, devicePixelRatio));
export const RENDER_WIDTH = Math.round(DESIGN_WIDTH * RENDER_DENSITY);
export const RENDER_HEIGHT = Math.round(DESIGN_HEIGHT * RENDER_DENSITY);

/** Make a scene camera show the fixed design canvas on the denser buffer. */
export function configureDesignCamera(scene: Scene): void {
  scene.cameras.main
    .setViewport(0, 0, RENDER_WIDTH, RENDER_HEIGHT)
    .setZoom(RENDER_DENSITY)
    .centerOn(DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2);
}
