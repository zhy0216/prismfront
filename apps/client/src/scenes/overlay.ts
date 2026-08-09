import type { PromptMsg, SnapshotMsg } from "@prismfront/shared";
import { type GameObjects, Scene } from "phaser";
import { BUS_EVENTS, MATCH_BUS } from "./match-bus.ts";

export class OverlayScene extends Scene {
  private label!: GameObjects.Text;
  private options: GameObjects.Text[] = [];

  constructor() {
    super("OverlayScene");
  }

  create(): void {
    this.label = this.add
      .text(960, 520, "", {
        color: "#ffffff",
        backgroundColor: "#16213ccc",
        fontSize: "32px",
        padding: { x: 28, y: 18 },
      })
      .setOrigin(0.5)
      .setVisible(false);
    MATCH_BUS.on(BUS_EVENTS.snapshot, (message: SnapshotMsg) => {
      const phase = message.view.phase;
      if (phase === "mulligan" || phase === "deploy") {
        const kind = phase === "mulligan" ? "mulligan" : "deploy";
        this.show(phase === "mulligan" ? "选择起手调度" : "秘密部署英雄");
        if (phase === "mulligan") {
          const hand = message.view.zones[`p${message.legal.player}:hand`] ?? [];
          this.showOptions([
            ...hand.map((id) => ({ label: `换 ${id}`, kind: "toggle-mulligan", value: id })),
            { label: "确认", kind, value: null },
          ]);
        } else {
          const heroes = message.view.zones[`p${message.legal.player}:fountain`] ?? [];
          this.showOptions([
            ...heroes.map((hero) => ({ label: `英雄 ${hero}`, kind: "select-hero", value: hero })),
            ...Array.from({ length: message.view.rules.board.slots }, (_, slot) => ({
              label: `格 ${slot}`,
              kind: "select-slot",
              value: slot,
            })),
            { label: "确认", kind, value: null },
          ]);
        }
      } else this.label.setVisible(false);
    });
    MATCH_BUS.on(BUS_EVENTS.prompt, (message: PromptMsg) => {
      this.show(message.request.kind === "select_target" ? "选择目标" : "选择一项");
      this.showOptions(
        message.request.options.map((value) => ({
          label: String(value ?? "跳过"),
          kind: "respond",
          value,
        })),
      );
    });
  }

  private showOptions(
    items: readonly { label: string; kind: string; value: number | string | null }[],
  ): void {
    for (const option of this.options) option.destroy();
    this.options = items.map((item, index) =>
      this.add
        .text(760 + index * 180, 600, item.label, {
          backgroundColor: "#365272",
          color: "#ffffff",
          fontSize: "25px",
          padding: { x: 20, y: 12 },
        })
        .setInteractive()
        .on("pointerdown", () => {
          MATCH_BUS.emit(BUS_EVENTS.input, item);
          if (item.kind === "mulligan" || item.kind === "deploy" || item.kind === "respond") {
            this.label.setVisible(false);
            this.showOptions([]);
          }
        }),
    );
  }

  private show(text: string): void {
    this.label.setText(text).setVisible(true);
  }
}
