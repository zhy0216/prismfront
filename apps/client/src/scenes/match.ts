import type {
  ClientEvent,
  PlayerId,
  PlayerView,
  ServerMsg,
  SnapshotMsg,
  Transport,
} from "@prismfront/shared";
import { type GameObjects, Scene } from "phaser";
import { Director, type RenderContext } from "../core/director.ts";
import { IntentController } from "../core/input.ts";
import {
  absoluteSlotToWorld,
  BOARD_X0,
  beamPath,
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  SLOT_H,
  SLOT_W,
} from "../core/layout.ts";
import { BUS_EVENTS, MATCH_BUS } from "./match-bus.ts";

const SLOT_FILL = 0x25304a;

class PhaserRenderContext implements RenderContext {
  private readonly scene: MatchScene;

  constructor(scene: MatchScene) {
    this.scene = scene;
  }

  animate(
    kind: Parameters<RenderContext["animate"]>[0],
    events: readonly ClientEvent[],
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    MATCH_BUS.emit(BUS_EVENTS.beat, { kind, events });
    return new Promise((resolve) => {
      const timer = this.scene.time.delayedCall(durationMs, resolve);
      signal.addEventListener(
        "abort",
        () => {
          timer.remove(false);
          resolve();
        },
        { once: true },
      );
    });
  }

  complete(kind: Parameters<RenderContext["complete"]>[0], events: readonly ClientEvent[]): void {
    MATCH_BUS.emit(BUS_EVENTS.beat, { kind, events, complete: true });
  }

  idle(): void {
    MATCH_BUS.emit(BUS_EVENTS.idle);
  }
}

export class MatchScene extends Scene {
  private viewer: PlayerId = 0;
  private view: PlayerView | null = null;
  private readonly units = new Map<number, GameObjects.Container>();
  private readonly boardObjects: GameObjects.GameObject[] = [];
  private readonly handObjects: GameObjects.GameObject[] = [];
  private readonly beams: GameObjects.Graphics[] = [];
  private director!: Director;
  private transport: Transport | undefined;
  private intent: IntentController | null = null;
  private selectedHero: number | null = null;
  private authoritative: PlayerView | null = null;
  private lastSnapshotSeq = -1;
  private pendingEventSeq = -1;
  private autoActed = "";
  // HotseatTransport owns both controllers when autoplay is requested. Letting
  // MatchScene also submit would race the two sockets at the same seq.
  private readonly autoplay =
    new URLSearchParams(location.search).has("autoplay") &&
    !new URLSearchParams(location.search).has("hotseat");
  private lastLegal: SnapshotMsg["legal"] | null = null;
  private endLabel!: GameObjects.Text;

  constructor(transport?: Transport) {
    super("MatchScene");
    this.transport = transport;
  }

  create(): void {
    this.cameras.main.setBackgroundColor(0x0c1222);
    this.endLabel = this.add
      .text(DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2, "", {
        color: "#ffffff",
        backgroundColor: "#16213cee",
        fontSize: "40px",
        padding: { x: 28, y: 20 },
      })
      .setOrigin(0.5)
      .setVisible(false);
    this.drawBoard();
    this.director = new Director(new PhaserRenderContext(this));
    document.body.dataset.directorReady = "true";
    MATCH_BUS.on(
      BUS_EVENTS.beat,
      ({ events, complete }: { events: readonly ClientEvent[]; complete?: boolean }) =>
        this.renderBeat(events, complete === true),
    );
    MATCH_BUS.on(BUS_EVENTS.idle, () => {
      if (this.authoritative !== null) {
        this.view = this.authoritative;
        this.renderView(this.authoritative);
      }
    });
    this.transport?.onMessage((message) => this.onServerMessage(message));
    MATCH_BUS.on(BUS_EVENTS.input, (action: { kind: string; value?: number | string | null }) => {
      if (action.kind === "pass") this.intent?.pass();
      else if (action.kind === "mulligan") {
        this.intent?.commitMulligan();
      } else if (action.kind === "toggle-mulligan" && typeof action.value === "number") {
        this.intent?.toggleMulligan(action.value);
      } else if (action.kind === "select-hero" && typeof action.value === "number") {
        this.selectedHero = action.value;
      } else if (action.kind === "select-slot" && typeof action.value === "number") {
        if (this.selectedHero !== null) this.intent?.placeHero(this.selectedHero, action.value);
      } else if (action.kind === "deploy") this.intent?.commitDeploy();
      else if (action.kind === "respond") this.intent?.respond(action.value ?? null);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.director.fastForward();
    });
    this.scene.launch("HudScene");
    this.scene.launch("OverlayScene");
    document.body.dataset.clientReady = "true";
  }

  setTransport(transport: Transport): void {
    this.transport = transport;
    transport.onMessage((message) => this.onServerMessage(message));
  }

  renderBeat(events: readonly ClientEvent[], complete = false): void {
    if (complete) {
      for (const beam of this.beams) beam.destroy();
      this.beams.length = 0;
      document.body.dataset.lastBeatComplete = "true";
      return;
    }
    for (const beam of this.beams) beam.destroy();
    this.beams.length = 0;
    const eventView = this.authoritative ?? this.view;
    if (eventView === null) return;
    for (const event of events) {
      if (event.name !== "struck" || event.source === null || event.source === undefined) continue;
      const source = eventView.entities[event.source];
      if (source === undefined || !("owner" in source) || source.slot === null) continue;
      const target =
        event.target === null || event.target === undefined
          ? undefined
          : eventView.entities[event.target];
      const targetIsUnit = target !== undefined && "slot" in target && target.slot !== null;
      const [from, to] =
        targetIsUnit && "owner" in target
          ? [
              absoluteSlotToWorld(this.viewer, source.owner, source.slot),
              absoluteSlotToWorld(this.viewer, target.owner, target.slot ?? 0),
            ]
          : beamPath(this.viewer, source.owner, source.slot, source.tags.direction, false);
      const beam = this.add
        .graphics()
        .lineStyle(10, 0x88e8ff, 0.9)
        .lineBetween(from.x, from.y, to.x, to.y);
      this.beams.push(beam);
    }
  }

  private onServerMessage(message: ServerMsg): void {
    if (message.t === "seat") {
      this.viewer = message.seat;
      if (this.transport !== undefined)
        this.intent = new IntentController(this.transport, this.viewer);
      this.drawBoard();
      if (this.view !== null) this.renderView(this.view);
    }
    if (message.t === "snapshot") {
      const recovery =
        this.lastSnapshotSeq < 0 ||
        message.seq > this.lastSnapshotSeq + 1 ||
        message.view.seq > this.lastSnapshotSeq + 1;
      this.authoritative = message.view;
      this.lastSnapshotSeq = Math.max(this.lastSnapshotSeq, message.seq);
      if (recovery) this.director.fastForward();
      // The authoritative snapshot is also the input for queued beats. Keeping
      // it in presentation would make a newly summoned unit invisible to the
      // following struck beam. Beat completion still redraws the final frame.
      this.view = message.view;
      this.lastLegal = message.legal;
      this.intent?.sync(message.seq, message.legal);
      if (message.view.phase === "mulligan" && this.intent?.mode.kind === "idle")
        this.intent.beginMulligan();
      if (message.view.phase === "deploy" && this.intent?.mode.kind === "idle") {
        this.intent.beginDeploy();
      }
      if (recovery || !this.director.isPlaying) this.renderView(message.view);
      MATCH_BUS.emit(BUS_EVENTS.snapshot, message);
      if (this.autoplay) this.autoAct(message);
    } else if (message.t === "events") {
      this.pendingEventSeq = Math.max(this.pendingEventSeq, message.seq);
      this.director.enqueue(message.events);
      MATCH_BUS.emit(BUS_EVENTS.events, message);
      const oldCount = Number(document.body.dataset.eventCount ?? 0);
      document.body.dataset.eventCount = String(oldCount + message.events.length);
      if (message.events.some((event) => event.name === "card_played")) {
        document.body.dataset.cardPlayed = "true";
      }
    } else if (message.t === "prompt") {
      this.intent?.prompt(message.request);
      MATCH_BUS.emit(BUS_EVENTS.prompt, message);
    } else if (message.t === "rejected") {
      document.body.dataset.rejections = String(Number(document.body.dataset.rejections ?? 0) + 1);
      document.body.dataset.lastReject = message.code;
      this.intent?.reject();
      MATCH_BUS.emit(BUS_EVENTS.rejected, message);
    } else if (message.t === "over") {
      document.body.dataset.matchOver = `${message.winner ?? "draw"}:${message.reason}`;
      this.director.fastForward();
      this.endLabel
        .setText(
          `对局结束：${message.winner === null ? "平局" : `玩家 ${message.winner + 1} 胜`}\n${message.reason}`,
        )
        .setVisible(true);
    }
  }

  private autoAct(message: Extract<ServerMsg, { t: "snapshot" }>): void {
    const key = `${message.seq}:${message.view.phase}:${message.view.priority}:${this.viewer}`;
    if (key === this.autoActed || this.intent === null) return;
    if (message.view.phase === "mulligan") {
      this.autoActed = key;
      if (this.intent.mode.kind !== "mulligan") this.intent.beginMulligan();
      this.intent.commitMulligan();
      return;
    }
    if (message.view.phase === "deploy") {
      this.autoActed = key;
      if (this.intent.mode.kind !== "deploy") this.intent.beginDeploy();
      const available = message.view.zones[`p${this.viewer}:fountain`] ?? [];
      const count = message.view.rules.heroes.deploySchedule[message.view.round - 1] ?? 0;
      const eligible = available.filter((id) => {
        const entity = message.view.entities[id];
        return (
          entity !== undefined &&
          "respawnAt" in entity &&
          (entity.respawnAt ?? 0) <= message.view.round
        );
      });
      for (let index = 0; index < Math.min(count, eligible.length); index += 1) {
        const id = eligible[index];
        if (id !== undefined) this.intent.placeHero(id, index);
      }
      this.intent.commitDeploy();
      return;
    }
    if (message.view.pendingInput?.player === this.viewer) {
      this.autoActed = key;
      this.intent.respond(message.view.pendingInput.options[0] ?? null);
      return;
    }
    if (message.view.phase === "actions" && message.view.priority === this.viewer) {
      this.autoActed = key;
      const legal = message.legal.playCard.find((move) => move.legal && move.card !== null);
      if (legal?.card !== null && legal !== undefined && legal.slot !== null) {
        this.intent.beginCard(legal.card);
        this.intent.playAt(legal.slot);
      } else {
        this.intent.pass();
      }
    }
  }

  private drawBoard(): void {
    for (const object of this.boardObjects) object.destroy();
    this.boardObjects.length = 0;
    for (const owner of [0, 1] as const) {
      for (let index = 0; index < 9; index += 1) {
        const { x, y } = absoluteSlotToWorld(this.viewer, owner, index);
        const slot = this.add
          .rectangle(x, y, SLOT_W - 8, SLOT_H - 8, SLOT_FILL, 0.65)
          .setStrokeStyle(2, 0x5972a5)
          .setInteractive()
          .on("pointerup", () => {
            if (owner === this.viewer) this.intent?.playAt(index);
          });
        this.boardObjects.push(
          slot,
          this.add.text(x - 72, y - 74, String(index), { color: "#8ca4d3", fontSize: "18px" }),
        );
      }
    }
    this.boardObjects.push(
      this.add
        .text(DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2 - 16, "PRISMFRONT · 九曜战线", {
          color: "#b9d3ff",
          fontSize: "30px",
        })
        .setOrigin(0.5),
    );
  }

  private renderView(view: PlayerView): void {
    for (const unit of this.units.values()) unit.destroy();
    this.units.clear();
    for (const object of this.handObjects) object.destroy();
    this.handObjects.length = 0;
    for (const owner of [0, 1] as const) {
      for (let index = 0; index < view.slots[owner].length; index += 1) {
        const id = view.slots[owner][index];
        if (id === null || id === undefined) continue;
        const entity = view.entities[id];
        if (entity === undefined || entity.cardId === null) continue;
        const { x, y } = absoluteSlotToWorld(this.viewer, owner, index);
        const faceKey = `card:${entity.cardId}`;
        if (!this.textures.exists(faceKey)) this.makePlaceholderFace(faceKey, entity.cardId);
        const art = this.add.image(0, 0, faceKey).setDisplaySize(140, 180);
        const panel = this.add.rectangle(
          0,
          0,
          140,
          130,
          owner === this.viewer ? 0x315c8d : 0x6f354f,
          0.2,
        );
        const title = this.add
          .text(0, -36, entity.cardId, { color: "#ffffff", fontSize: "14px" })
          .setOrigin(0.5);
        const stats = this.add
          .text(0, 30, `${entity.tags.atk} / ${entity.tags.health - entity.damage}`, {
            color: "#f2f6ff",
            fontSize: "24px",
          })
          .setOrigin(0.5);
        const container = this.add.container(x, y, [art, panel, title, stats]);
        this.units.set(id, container);
      }
    }
    const hand = view.zones[`p${this.viewer}:hand`] ?? [];
    for (let index = 0; index < hand.length; index += 1) {
      const id = hand[index];
      const entity = id === undefined ? undefined : view.entities[id];
      if (id === undefined || entity?.cardId === null || entity === undefined) continue;
      const faceKey = `card:${entity.cardId}`;
      if (!this.textures.exists(faceKey)) this.makePlaceholderFace(faceKey, entity.cardId);
      const card = this.add
        .image(400 + index * 170, 980, faceKey)
        .setDisplaySize(140, 185)
        .setInteractive()
        .on("pointerdown", () => this.intent?.beginCard(id));
      this.input.setDraggable(card);
      card.on("dragstart", () => this.intent?.beginCard(id));
      card.on("dragend", (pointer: { x: number; y: number }) => {
        if (pointer.y < 900) {
          const slot = Math.round((pointer.x - BOARD_X0 - SLOT_W / 2) / (SLOT_W + 8));
          this.intent?.playAt(Math.max(0, Math.min(8, slot)));
        }
      });
      const legal = this.lastLegal?.playCard.find((move) => move.card === id);
      if (legal?.legal === false) {
        card
          .setAlpha(0.45)
          .setData(
            "tooltip",
            legal.reason === "color_locked" ? "缺少对应色光源" : String(legal.reason ?? "不可用"),
          );
      }
      this.handObjects.push(card);
    }
    document.body.dataset.lastSeq = String(view.seq);
    document.body.dataset.phase = view.phase;
    document.body.dataset.unitCount = String(this.units.size);
  }

  private makePlaceholderFace(key: string, label: string): void {
    const graphics = this.make.graphics();
    graphics.fillStyle(0x315c8d).fillRoundedRect(0, 0, 240, 340, 14);
    graphics.lineStyle(5, 0xcce7ff, 0.8).strokeRoundedRect(2, 2, 236, 336, 14);
    const text = this.add
      .text(120, 170, label, { color: "#ffffff", fontSize: "22px", wordWrap: { width: 210 } })
      .setOrigin(0.5)
      .setVisible(false);
    const texture = this.add.renderTexture(0, 0, 240, 340).setVisible(false);
    texture.draw(graphics).draw(text).saveTexture(key);
    texture.destroy();
    text.destroy();
    graphics.destroy();
  }
}
