import type { PromptMsg, SnapshotMsg, TagValues } from "@prismfront/shared";
import { type GameObjects, Scene } from "phaser";
import {
  CARD_FACE_HEIGHT,
  CARD_FACE_WIDTH,
  CARD_TEMPLATE_ASSETS,
  type ClientCardData,
  type Color,
  cardFaceSpec,
} from "../core/card-face.ts";
import { createCardFaceTexture } from "../core/card-texture.ts";
import {
  absoluteSlotToWorld,
  BOARD_CARD_HEIGHT,
  BOARD_CARD_WIDTH,
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  worldPointToSlot,
} from "../core/layout.ts";
import { configureDesignCamera, RENDER_DENSITY, TEXT_SAFE_PADDING } from "../core/rendering.ts";
import cardsBundle from "../generated/cards.client.json";
import { BUS_EVENTS, MATCH_BUS } from "./match-bus.ts";

const MAX_COLUMNS = 5;
const BUTTON_WIDTH = 240;
const BUTTON_HEIGHT = 66;
const BUTTON_GAP = 20;
const PANEL_PADDING_X = 48;
const PANEL_PADDING_TOP = 112;
const PANEL_PADDING_BOTTOM = 48;
const DEPLOY_RACK_Y = 950;
const DEPLOY_CARD_WIDTH = 160;
const DEPLOY_CARD_HEIGHT = DEPLOY_CARD_WIDTH * (CARD_FACE_HEIGHT / CARD_FACE_WIDTH);
const DEPLOY_CARD_GAP = 28;
const DEPLOY_SURFACE_Y = 950;
const DEPLOY_SURFACE_HEIGHT = 260;
const DEPLOY_CONFIRM_X = 1740;
const DEPLOY_CONFIRM_WIDTH = 220;
const DEPLOY_CONFIRM_HEIGHT = 72;

interface OverlayOption {
  readonly label: string;
  readonly kind: string;
  readonly value: number | string | null;
}

interface DeployPointer {
  readonly worldX: number;
  readonly worldY: number;
}

interface DeployCardData {
  readonly id: number;
  readonly cardId: string;
  readonly origin: { readonly x: number; readonly y: number };
}

function displayCardLabel(label: string): string {
  return label.replaceAll("_", " ").replaceAll("-", " ");
}

function fallbackColor(cardId: string): Color {
  const id = cardId.toUpperCase();
  if (id.includes("GREEN") || id.startsWith("PF1_G")) return "green";
  if (id.includes("RED") || id.startsWith("PF1_R")) return "red";
  return "blue";
}

function fallbackHeroName(cardId: string): string {
  return (
    (
      {
        GOLDEN_HERO_RED: "燎火汗王",
        GOLDEN_HERO_GREEN: "翠冠贤者",
        GOLDEN_HERO_BLUE: "折光导师",
      } as Readonly<Record<string, string>>
    )[cardId] ?? displayCardLabel(cardId)
  );
}

function cardDataFor(cardId: string, tags: TagValues): ClientCardData {
  const bundled = (cardsBundle.cards as Record<string, ClientCardData>)[cardId];
  if (bundled !== undefined) return bundled;
  return {
    id: cardId,
    name: { zh: fallbackHeroName(cardId) },
    kind: "hero",
    colors: [fallbackColor(cardId)],
    atk: tags.atk,
    health: tags.health,
  };
}

export class OverlayScene extends Scene {
  private backdrop!: GameObjects.Rectangle;
  private panel!: GameObjects.Rectangle;
  private label!: GameObjects.Text;
  private options: GameObjects.Container[] = [];
  private deploySurface!: GameObjects.Rectangle;
  private deployTitle!: GameObjects.Text;
  private deployHint!: GameObjects.Text;
  private deployConfirm: GameObjects.Container | undefined;
  private deployObjects: GameObjects.GameObject[] = [];
  private deployCards = new Map<number, GameObjects.Image>();
  private deployCardData = new Map<number, DeployCardData>();
  private deployPicks = new Map<number, number>();
  private deployView: SnapshotMsg | null = null;
  private deploySeq = -1;
  private deployRequired = 0;

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
        padding: TEXT_SAFE_PADDING,
        resolution: RENDER_DENSITY,
        wordWrap: { width: 1300, useAdvancedWrap: true },
      })
      .setOrigin(0.5)
      .setVisible(false);
    this.deploySurface = this.add
      .rectangle(
        DESIGN_WIDTH / 2,
        DEPLOY_SURFACE_Y,
        DESIGN_WIDTH,
        DEPLOY_SURFACE_HEIGHT,
        0x07101f,
        0.98,
      )
      .setStrokeStyle(3, 0x6786b7)
      .setInteractive()
      .setVisible(false);
    this.deployTitle = this.add
      .text(52, 842, "秘密部署英雄", {
        color: "#ffffff",
        fontSize: "30px",
        fontStyle: "bold",
        padding: TEXT_SAFE_PADDING,
        resolution: RENDER_DENSITY,
      })
      .setVisible(false);
    this.deployHint = this.add
      .text(52, 884, "把英雄拖到己方格子，完成后点击确认", {
        color: "#b9d3ff",
        fontSize: "20px",
        padding: TEXT_SAFE_PADDING,
        resolution: RENDER_DENSITY,
      })
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
        this.showDeploy(message);
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

  private showDeploy(message: SnapshotMsg): void {
    this.clearOptions();
    this.backdrop.setVisible(false);
    this.panel.setVisible(false);
    this.label.setVisible(false);
    this.deploySurface.setVisible(true);
    this.deployTitle.setVisible(true);
    this.deployHint.setVisible(true);

    if (this.deploySeq !== message.view.seq) {
      this.clearDeployObjects();
      this.deploySeq = message.view.seq;
      this.deployPicks.clear();
      this.deployView = message;
      this.createDeployCards(message);
    } else {
      this.deployView = message;
      this.updateDeployConfirm();
    }
  }

  private createDeployCards(message: SnapshotMsg): void {
    const fountain = message.view.zones[`p${message.legal.player}:fountain`] ?? [];
    const eligible = fountain.filter((id) => {
      const entity = message.view.entities[id];
      return (
        entity !== undefined &&
        entity.cardId !== null &&
        (entity.respawnAt ?? 0) <= message.view.round
      );
    });
    const quota = message.view.rules.heroes.deploySchedule[message.view.round - 1] ?? 0;
    this.deployRequired = Math.min(quota, eligible.length);

    const contentWidth =
      eligible.length * DEPLOY_CARD_WIDTH + Math.max(0, eligible.length - 1) * DEPLOY_CARD_GAP;
    const startX = Math.max(250, (DESIGN_WIDTH - contentWidth) / 2 + DEPLOY_CARD_WIDTH / 2 - 180);
    for (const [index, id] of eligible.entries()) {
      const entity = message.view.entities[id];
      if (entity === undefined || entity.cardId === null) continue;
      const origin = {
        x: startX + index * (DEPLOY_CARD_WIDTH + DEPLOY_CARD_GAP),
        y: DEPLOY_RACK_Y,
      };
      const cardData = cardDataFor(entity.cardId, entity.tags);
      const faceKey = `card:${entity.cardId}`;
      if (!this.textures.exists(faceKey)) this.makePlaceholderFace(cardData);
      const card = this.add
        .image(origin.x, origin.y, faceKey)
        .setDisplaySize(DEPLOY_CARD_WIDTH, DEPLOY_CARD_HEIGHT)
        .setInteractive({ useHandCursor: true });
      this.input.setDraggable(card);
      const rackScale = { x: card.scaleX, y: card.scaleY };
      card
        .setData("hero", id)
        .setData("origin", origin)
        .setData("rackScale", rackScale)
        .setData("dragging", false)
        .setData("deploySlot", null);
      card.on("pointerover", () => {
        if (card.getData("dragging") === true || this.deployPicks.has(id)) return;
        this.tweens.add({
          targets: card,
          y: origin.y - 16,
          scaleX: rackScale.x * 1.06,
          scaleY: rackScale.y * 1.06,
          duration: 110,
          ease: "Sine.Out",
        });
      });
      card.on("pointerout", () => {
        if (card.getData("dragging") === true) return;
        if (this.deployPicks.has(id)) return;
        this.tweens.add({
          targets: card,
          x: origin.x,
          y: origin.y,
          scaleX: rackScale.x,
          scaleY: rackScale.y,
          duration: 110,
          ease: "Sine.Out",
        });
      });
      card.on("dragstart", () => this.startDeployDrag(card, id));
      card.on("drag", (pointer: DeployPointer, dragX: number, dragY: number) => {
        card
          .setPosition(dragX, dragY)
          .setRotation(Math.max(-0.08, Math.min(0.08, (dragX - origin.x) / 900)));
        this.emitDeployHover(worldPointToSlot("friendly", pointer.worldX, pointer.worldY), id);
      });
      card.on("dragend", (pointer: DeployPointer) => {
        this.endDeployDrag(card, id, pointer);
      });
      this.deployCards.set(id, card);
      this.deployCardData.set(id, { id, cardId: entity.cardId, origin });
      this.deployObjects.push(card);
    }

    this.createDeployConfirm();
    this.updateDeployConfirm();
  }

  private startDeployDrag(card: GameObjects.Image, hero: number): void {
    this.tweens.killTweensOf(card);
    card
      .setData("dragging", true)
      .setData("previousSlot", this.deployPicks.get(hero) ?? null)
      .setDepth(100)
      .setScale(card.scaleX * 1.08, card.scaleY * 1.08);
    this.emitDeployHover(null, hero);
  }

  private endDeployDrag(card: GameObjects.Image, hero: number, pointer: DeployPointer): void {
    card.setData("dragging", false).setRotation(0);
    const slot = worldPointToSlot("friendly", pointer.worldX, pointer.worldY);
    const previousSlot = card.getData("previousSlot") as number | null;
    if (slot !== null && this.isDeploySlotAvailable(slot)) {
      const displaced = [...this.deployPicks.entries()].find(
        ([, pickedSlot]) => pickedSlot === slot,
      )?.[0];
      if (displaced !== undefined && displaced !== hero) {
        this.deployPicks.delete(displaced);
        this.returnDeployCard(displaced);
      }
      this.deployPicks.set(hero, slot);
      const target = absoluteSlotToWorld(this.viewerFromMessage(), this.viewerFromMessage(), slot);
      card.setPosition(target.x, target.y).setDisplaySize(BOARD_CARD_WIDTH, BOARD_CARD_HEIGHT);
      card.setData("deploySlot", slot).setDepth(80);
      MATCH_BUS.emit(BUS_EVENTS.input, { kind: "deploy-place", hero, value: slot });
    } else if (previousSlot !== null) {
      const target = absoluteSlotToWorld(
        this.viewerFromMessage(),
        this.viewerFromMessage(),
        previousSlot,
      );
      card
        .setPosition(target.x, target.y)
        .setDisplaySize(BOARD_CARD_WIDTH, BOARD_CARD_HEIGHT)
        .setData("deploySlot", previousSlot)
        .setDepth(80);
    } else {
      this.returnDeployCard(hero);
    }
    this.emitDeployHover(null, hero);
    this.updateDeployConfirm();
  }

  private isDeploySlotAvailable(slot: number): boolean {
    const view = this.deployView?.view;
    if (view === undefined) return false;
    const occupiedByUnit = view.slots[this.viewerFromMessage()]?.[slot] != null;
    if (occupiedByUnit) return false;
    return true;
  }

  private returnDeployCard(hero: number): void {
    const card = this.deployCards.get(hero);
    const data = this.deployCardData.get(hero);
    if (card === undefined || data === undefined) return;
    this.deployPicks.delete(hero);
    card
      .setPosition(data.origin.x, data.origin.y)
      .setDisplaySize(DEPLOY_CARD_WIDTH, DEPLOY_CARD_HEIGHT)
      .setData("deploySlot", null)
      .setDepth(0);
  }

  private emitDeployHover(slot: number | null, hero: number): void {
    MATCH_BUS.emit(BUS_EVENTS.input, { kind: "deploy-hover", hero, value: slot });
  }

  private createDeployConfirm(): void {
    const button = this.add
      .rectangle(0, 0, DEPLOY_CONFIRM_WIDTH, DEPLOY_CONFIRM_HEIGHT, 0x365272)
      .setStrokeStyle(2, 0x7091bd)
      .setInteractive({ useHandCursor: true });
    const text = this.add
      .text(0, 0, "确认", {
        align: "center",
        color: "#ffffff",
        fontSize: "26px",
        padding: TEXT_SAFE_PADDING,
        resolution: RENDER_DENSITY,
      })
      .setOrigin(0.5);
    this.deployConfirm = this.add
      .container(DEPLOY_CONFIRM_X, DEPLOY_RACK_Y, [button, text])
      .setVisible(true);
    this.deployObjects.push(this.deployConfirm);
    button.on("pointerdown", () => {
      if (this.deployPicks.size < this.deployRequired) return;
      MATCH_BUS.emit(BUS_EVENTS.input, { kind: "deploy", value: null });
      this.hide();
    });
  }

  private updateDeployConfirm(): void {
    if (this.deployConfirm === undefined) return;
    const button = this.deployConfirm.list[0] as GameObjects.Rectangle | undefined;
    const text = this.deployConfirm.list[1] as GameObjects.Text | undefined;
    const ready = this.deployPicks.size >= this.deployRequired;
    if (button !== undefined) {
      button.setFillStyle(ready ? 0x365272 : 0x27364f, ready ? 1 : 0.65);
    }
    if (text !== undefined) {
      text.setText(
        this.deployRequired === 0
          ? "确认"
          : `确认 (${this.deployPicks.size}/${this.deployRequired})`,
      );
    }
  }

  private viewerFromMessage(): 0 | 1 {
    return this.deployView?.legal.player === 1 ? 1 : 0;
  }

  private makePlaceholderFace(card: ClientCardData): void {
    const spec = cardFaceSpec(card);
    if (!this.textures.exists(spec.template.key)) {
      const template = CARD_TEMPLATE_ASSETS[spec.template.color];
      throw new Error(`missing card template texture ${template.key}`);
    }
    createCardFaceTexture(this, spec);
  }

  private clearDeployObjects(): void {
    for (const object of this.deployObjects) {
      this.tweens.killTweensOf(object);
      object.destroy();
    }
    this.deployObjects = [];
    this.deployCards.clear();
    this.deployCardData.clear();
    this.deployConfirm = undefined;
  }

  private show(title: string, items: readonly OverlayOption[]): void {
    this.clearDeployObjects();
    this.deploySeq = -1;
    this.deployView = null;
    this.deployPicks.clear();
    this.deploySurface.setVisible(false);
    this.deployTitle.setVisible(false);
    this.deployHint.setVisible(false);
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
          padding: TEXT_SAFE_PADDING,
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
    this.deploySurface.setVisible(false);
    this.deployTitle.setVisible(false);
    this.deployHint.setVisible(false);
    this.clearOptions();
    this.clearDeployObjects();
    this.deploySeq = -1;
    this.deployView = null;
    this.deployPicks.clear();
  }

  private clearOptions(): void {
    for (const option of this.options) option.destroy(true);
    this.options = [];
  }
}
