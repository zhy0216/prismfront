import type { PromptMsg, SnapshotMsg } from "@prismfront/shared";
import { type GameObjects, Scene } from "phaser";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "../core/layout.ts";
import { configureDesignCamera, RENDER_DENSITY } from "../core/rendering.ts";
import { BUS_EVENTS, MATCH_BUS } from "./match-bus.ts";

const MAX_COLUMNS = 5;
const BUTTON_WIDTH = 240;
const BUTTON_HEIGHT = 66;
const BUTTON_GAP = 20;
const PANEL_PADDING_X = 48;
const PANEL_PADDING_TOP = 112;
const PANEL_PADDING_BOTTOM = 48;

interface OverlayOption {
  readonly label: string;
  readonly kind: string;
  readonly value: number | string | null;
}

export class OverlayScene extends Scene {
  private backdrop!: GameObjects.Rectangle;
  private panel!: GameObjects.Rectangle;
  private label!: GameObjects.Text;
  private options: GameObjects.Container[] = [];

  constructor() {
    super("OverlayScene");
  }

  create(): void {
    configureDesignCamera(this);
    this.backdrop = this.add
      .rectangle(DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2, DESIGN_WIDTH, DESIGN_HEIGHT, 0x070b14, 0.72)
      .setInteractive()
      .setVisible(false);
    this.panel = this.add
      .rectangle(DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2, 600, 260, 0x16213c, 0.98)
      .setStrokeStyle(3, 0x6786b7)
      .setVisible(false);
    this.label = this.add
      .text(DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2, "", {
        align: "center",
        color: "#ffffff",
        fontSize: "32px",
        resolution: RENDER_DENSITY,
        wordWrap: { width: 1300, useAdvancedWrap: true },
      })
      .setOrigin(0.5)
      .setVisible(false);

    MATCH_BUS.on(BUS_EVENTS.snapshot, (message: SnapshotMsg) => {
      const phase = message.view.phase;
      if (phase === "mulligan") {
        const hand = message.view.zones[`p${message.legal.player}:hand`] ?? [];
        this.show("选择起手调度", [
          ...hand.map((id) => ({ label: `换 ${id}`, kind: "toggle-mulligan", value: id })),
          { label: "确认", kind: "mulligan", value: null },
        ]);
      } else if (phase === "deploy") {
        const heroes = message.view.zones[`p${message.legal.player}:fountain`] ?? [];
        this.show("秘密部署英雄", [
          ...heroes.map((hero) => ({ label: `英雄 ${hero}`, kind: "select-hero", value: hero })),
          ...Array.from({ length: message.view.rules.board.slots }, (_, slot) => ({
            label: `格 ${slot}`,
            kind: "select-slot",
            value: slot,
          })),
          { label: "确认", kind: "deploy", value: null },
        ]);
      } else {
        this.hide();
      }
    });
    MATCH_BUS.on(BUS_EVENTS.prompt, (message: PromptMsg) => {
      this.show(
        message.request.kind === "select_target" ? "选择目标" : "选择一项",
        message.request.options.map((value) => ({
          label: String(value ?? "跳过"),
          kind: "respond",
          value,
        })),
      );
    });
  }

  private show(title: string, items: readonly OverlayOption[]): void {
    this.clearOptions();

    const columns = Math.max(1, Math.min(MAX_COLUMNS, items.length));
    const rows = Math.max(1, Math.ceil(items.length / columns));
    const contentWidth = columns * BUTTON_WIDTH + (columns - 1) * BUTTON_GAP;
    const contentHeight = rows * BUTTON_HEIGHT + (rows - 1) * BUTTON_GAP;
    const panelWidth = contentWidth + PANEL_PADDING_X * 2;
    const panelHeight = PANEL_PADDING_TOP + contentHeight + PANEL_PADDING_BOTTOM;
    const panelTop = (DESIGN_HEIGHT - panelHeight) / 2;
    const startX = (DESIGN_WIDTH - contentWidth) / 2 + BUTTON_WIDTH / 2;
    const startY = panelTop + PANEL_PADDING_TOP + BUTTON_HEIGHT / 2;

    this.backdrop.setVisible(true);
    this.panel.setSize(panelWidth, panelHeight).setVisible(true);
    this.label
      .setText(title)
      .setPosition(DESIGN_WIDTH / 2, panelTop + 56)
      .setVisible(true);

    this.options = items.map((item, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const button = this.add
        .rectangle(0, 0, BUTTON_WIDTH, BUTTON_HEIGHT, 0x365272)
        .setStrokeStyle(2, 0x7091bd)
        .setInteractive({ useHandCursor: true });
      const text = this.add
        .text(0, 0, item.label, {
          align: "center",
          color: "#ffffff",
          fontSize: "24px",
          resolution: RENDER_DENSITY,
          wordWrap: { width: BUTTON_WIDTH - 28, useAdvancedWrap: true },
        })
        .setOrigin(0.5);
      const textScale = Math.min(
        1,
        (BUTTON_WIDTH - 28) / Math.max(1, text.width),
        (BUTTON_HEIGHT - 16) / Math.max(1, text.height),
      );
      text.setScale(textScale);
      const option = this.add.container(
        startX + column * (BUTTON_WIDTH + BUTTON_GAP),
        startY + row * (BUTTON_HEIGHT + BUTTON_GAP),
        [button, text],
      );
      button.on("pointerdown", () => {
        MATCH_BUS.emit(BUS_EVENTS.input, item);
        if (item.kind === "mulligan" || item.kind === "deploy" || item.kind === "respond") {
          this.hide();
        }
      });
      return option;
    });
  }

  private hide(): void {
    this.backdrop.setVisible(false);
    this.panel.setVisible(false);
    this.label.setVisible(false);
    this.clearOptions();
  }

  private clearOptions(): void {
    for (const option of this.options) option.destroy(true);
    this.options = [];
  }
}
