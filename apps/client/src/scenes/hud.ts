import type { SnapshotMsg } from "@prismfront/shared";
import { type GameObjects, Scene } from "phaser";
import type { ClientCardData, Color } from "../core/card-face.ts";
import { GOLDEN_HERO_COLORS, hudModel } from "../core/hud.ts";
import cardsBundle from "../generated/cards.client.json";
import { BUS_EVENTS, MATCH_BUS } from "./match-bus.ts";

export class HudScene extends Scene {
  private panel!: GameObjects.Text;
  private lightLabel!: GameObjects.Text;
  private timer!: GameObjects.Graphics;
  private timerStartedAt = 0;
  private timerDurationMs = 1;
  private timerX = 110;
  private readonly heroColors: Readonly<Record<string, readonly Color[]>> = {
    ...GOLDEN_HERO_COLORS,
    ...Object.fromEntries(
      (Object.values(cardsBundle.cards) as ClientCardData[])
        .filter((card) => card.kind === "hero")
        .map((card) => [card.id, card.colors]),
    ),
  };

  constructor() {
    super("HudScene");
  }

  create(): void {
    this.panel = this.add.text(48, 920, "HUD", { color: "#ffffff", fontSize: "26px" });
    this.lightLabel = this.add.text(720, 28, "○ 红  ○ 绿  ○ 蓝", {
      color: "#ffffff",
      fontSize: "26px",
    });
    this.timer = this.add.graphics();
    this.add
      .text(1660, 930, "PASS", {
        backgroundColor: "#365272",
        color: "#ffffff",
        fontSize: "30px",
        padding: { x: 28, y: 16 },
      })
      .setInteractive()
      .on("pointerdown", () => MATCH_BUS.emit(BUS_EVENTS.input, { kind: "pass" }));
    MATCH_BUS.on(BUS_EVENTS.snapshot, (message: SnapshotMsg) => this.render(message));
  }

  override update(): void {
    const elapsed = this.time.now - this.timerStartedAt;
    const remaining = Math.max(0, 1 - elapsed / this.timerDurationMs);
    this.timer.clear();
    this.timer.lineStyle(8, 0x6ee7d8, 1);
    this.timer
      .beginPath()
      .arc(this.timerX, 70, 34, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * remaining)
      .strokePath();
  }

  private render(message: SnapshotMsg): void {
    const model = hudModel(message.view, message.legal.player, this.heroColors);
    this.panel.setText(
      `水晶 ${model.crystals}/${model.crystalCap}   基地 ${model.ownBaseHealth} : ${model.enemyBaseHealth}   ` +
        `复燃泉 ${model.fountain.map((entry) => `${entry.id}(${entry.returnsIn})`).join(" ") || "无"}`,
    );
    this.lightLabel.setText(
      model.lights
        .map(
          (light) =>
            `${light.lit ? "●" : "○"} ${light.color}${light.lit ? "" : `（没有${light.color}色光源${light.returnsIn === null ? "" : `，${light.returnsIn}回合后复燃`}）`}`,
        )
        .join("   "),
    );
    this.timerStartedAt = this.time.now;
    this.timerDurationMs = Math.max(1, model.timerSeconds * 1_000);
    this.timerX = model.priority === 0 ? 110 : 1810;
  }
}
