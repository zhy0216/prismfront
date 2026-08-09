// @prismfront/shared —— 跨端协议（架构 §2.3、§5.3）。
//
// 只声明 wire shape，不依赖 engine 实现。这样 client/server 可以共享协议，shared 仍保持
// 纯包边界。服务端把 engine 类型赋给这些结构时由 TypeScript 做结构兼容检查。

import type { CardId, Color, EntityId, RulesConfig } from "@prismfront/ir";

export const PROTOCOL_VERSION = 1 as const;

export type PlayerId = 0 | 1;
export type MatchWinner = PlayerId | "draw";

export type IllegalReason =
  | "game_over"
  | "awaiting_input"
  | "not_suspended"
  | "wrong_phase"
  | "invalid_choice"
  | "wrong_player"
  | "unknown_entity"
  | "wrong_zone"
  | "not_controlled"
  | "invalid_slot"
  | "slot_occupied"
  | "not_enough_crystals"
  | "color_locked"
  | "unknown_intent"
  | "protocol_mismatch"
  | "stale_seq"
  | "match_paused";

export interface DeployPick {
  readonly hero: EntityId;
  readonly slot: number;
}

type WithSeq<T> = T & { readonly seq: number };
type ClientEnvelope<T> = WithSeq<T> & { readonly version: typeof PROTOCOL_VERSION };

/** 客户端动作必须携带它基于的权威 seq；旧快照上的动作不会被重新解释。 */
export type ClientIntent =
  | ClientEnvelope<{
      readonly t: "mulligan";
      readonly toss?: readonly EntityId[];
      readonly keep?: readonly EntityId[];
    }>
  | ClientEnvelope<{
      readonly t: "deploy";
      readonly picks?: readonly DeployPick[];
      readonly placements?: readonly DeployPick[];
    }>
  | ClientEnvelope<{
      readonly t: "play_card";
      readonly card: EntityId;
      readonly slot?: number;
      readonly at?: number;
    }>
  | ClientEnvelope<{ readonly t: "pass" }>
  | ClientEnvelope<{ readonly t: "respond"; readonly chosen: EntityId | CardId | null }>
  | ClientEnvelope<{ readonly t: "concede" }>;

export type ResyncRequest = {
  readonly version: typeof PROTOCOL_VERSION;
  readonly seq: number;
};

export type EndReason =
  | "base_destroyed"
  | "concede"
  | "timeout"
  | "disconnect_timeout"
  | "engine_fault"
  | "server_shutdown";

export interface TagValues {
  readonly atk: number;
  readonly health: number;
  readonly cost: number;
  readonly armor: number;
  readonly direction: number;
}

export interface VisibleEntity {
  readonly id: EntityId;
  readonly cardId: CardId;
  readonly owner: PlayerId;
  readonly zone: string;
  readonly slot: number | null;
  readonly tags: TagValues;
  readonly damage: number;
  readonly respawnAt: number | null;
}

export interface HiddenEntity {
  readonly id: EntityId;
  readonly cardId: null;
}

export interface ProjectedInputRequest {
  readonly player: PlayerId;
  readonly kind: "discover" | "select_target" | "choose_one";
  readonly options: readonly (EntityId | CardId | null)[];
  readonly optional: boolean;
  readonly deadline: number | null;
}

export interface PlayerView {
  readonly bundleId: string;
  readonly rules: RulesConfig;
  readonly seq: number;
  readonly round: number;
  readonly phase:
    | "mulligan"
    | "round_start"
    | "deploy"
    | "actions"
    | "combat"
    | "round_end"
    | "over";
  readonly priority: PlayerId;
  readonly initiative: PlayerId;
  readonly firstPasser: PlayerId | null;
  readonly consecutivePasses: number;
  readonly players: readonly [
    {
      readonly crystals: number;
      readonly crystalCap: number;
      readonly baseId: EntityId;
      readonly fatigue: number;
    },
    {
      readonly crystals: number;
      readonly crystalCap: number;
      readonly baseId: EntityId;
      readonly fatigue: number;
    },
  ];
  readonly entities: Readonly<Record<EntityId, VisibleEntity | HiddenEntity>>;
  readonly zones: Readonly<Record<string, readonly EntityId[]>>;
  readonly zoneCounts: Readonly<Record<string, number>>;
  readonly slots: readonly [readonly (EntityId | null)[], readonly (EntityId | null)[]];
  readonly pendingInput: ProjectedInputRequest | null;
  readonly winner: MatchWinner | null;
}

export interface ClientEvent {
  readonly name: string;
  readonly source?: EntityId | null;
  readonly target?: EntityId | null;
  readonly player?: EntityId;
  readonly cardId?: CardId | null;
  readonly fromCardId?: CardId | null;
  readonly toCardId?: CardId | null;
  readonly amount?: number;
  readonly slot?: number;
  readonly fromSlot?: number;
  readonly toSlot?: number;
  readonly respawnAt?: number;
  readonly round?: number;
}

export interface LegalAction {
  readonly intent:
    | {
        readonly t: "play_card";
        readonly player: PlayerId;
        readonly card: EntityId;
        readonly slot: number;
      }
    | { readonly t: "pass"; readonly player: PlayerId };
  readonly t: "play_card" | "pass";
  readonly card: EntityId | null;
  readonly slot: number | null;
  readonly legal: boolean;
  readonly reason: Exclude<IllegalReason, "stale_seq" | "match_paused"> | null;
  readonly illegalReason: Exclude<IllegalReason, "stale_seq" | "match_paused"> | null;
  readonly missingColors: readonly Color[];
  readonly slots: readonly number[];
}

export interface LegalMoves {
  readonly player: PlayerId;
  readonly actions: readonly LegalAction[];
  readonly playCard: readonly LegalAction[];
  readonly pass: LegalAction;
}

export type SnapshotMsg = {
  readonly t: "snapshot";
  readonly version: typeof PROTOCOL_VERSION;
  readonly seq: number;
  readonly playerId: string;
  readonly view: PlayerView;
  readonly legal: LegalMoves;
};

export type EventsMsg = {
  readonly t: "events";
  readonly version: typeof PROTOCOL_VERSION;
  readonly seq: number;
  readonly events: readonly ClientEvent[];
};

export type PromptMsg = {
  readonly t: "prompt";
  readonly version: typeof PROTOCOL_VERSION;
  readonly seq: number;
  readonly request: ProjectedInputRequest;
};

export type RejectedMsg = {
  readonly t: "rejected";
  readonly version: typeof PROTOCOL_VERSION;
  readonly seq: number;
  readonly code: IllegalReason;
};

export type OverMsg = {
  readonly t: "over";
  readonly version: typeof PROTOCOL_VERSION;
  readonly seq: number;
  readonly winner: PlayerId | null;
  readonly reason: EndReason;
};

export type SeatMsg = {
  readonly t: "seat";
  readonly version: typeof PROTOCOL_VERSION;
  readonly seq: number;
  /** 服务端签发的不透明身份；绝不等于连接/session id。 */
  readonly playerId: string;
  readonly seat: PlayerId;
};

export type ServerMsg = SnapshotMsg | EventsMsg | PromptMsg | RejectedMsg | OverMsg | SeatMsg;

export interface Transport {
  send(intent: ClientIntent): void;
  onMessage(callback: (message: ServerMsg) => void): () => void;
  close?(): void;
}
