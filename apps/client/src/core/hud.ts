import type { PlayerId, PlayerView } from "@prismfront/shared";
import type { Color } from "./card-face.ts";

export interface LightState {
  readonly color: Color;
  readonly lit: boolean;
  readonly returnsIn: number | null;
}

export interface HudModel {
  readonly crystals: number;
  readonly crystalCap: number;
  readonly ownBaseHealth: number;
  readonly enemyBaseHealth: number;
  readonly fountain: readonly { readonly id: number; readonly returnsIn: number }[];
  readonly lights: readonly LightState[];
  readonly timerSeconds: number;
  readonly priority: PlayerId;
}

function healthOf(view: PlayerView, entityId: number): number {
  const entity = view.entities[entityId];
  if (entity === undefined || entity.cardId === null) return 0;
  return Math.max(0, entity.tags.health - entity.damage);
}

/** Light status is derived only from public view data. Hero card identity is not inferred locally. */
export function hudModel(
  view: PlayerView,
  viewer: PlayerId,
  heroColors: Readonly<Record<string, readonly Color[]>>,
): HudModel {
  const board = view.zones[`p${viewer}:board`] ?? [];
  const fountainIds = view.zones[`p${viewer}:fountain`] ?? [];
  const open = new Set<Color>();
  for (const id of board) {
    const entity = view.entities[id];
    if (entity?.cardId === null || entity === undefined) continue;
    for (const color of heroColors[entity.cardId] ?? []) open.add(color);
  }
  const fountain = fountainIds.map((id) => {
    const entity = view.entities[id];
    const respawnAt =
      entity !== undefined && "respawnAt" in entity ? (entity.respawnAt ?? view.round) : view.round;
    return { id, returnsIn: Math.max(0, respawnAt - view.round) };
  });
  const lights = (["red", "green", "blue"] as const).map((color) => {
    const returning = fountain.find((entry) => {
      const entity = view.entities[entry.id];
      return (
        entity?.cardId !== null &&
        entity !== undefined &&
        (heroColors[entity.cardId] ?? []).includes(color)
      );
    });
    return {
      color,
      lit: open.has(color),
      returnsIn: open.has(color) ? null : (returning?.returnsIn ?? null),
    };
  });
  const opponent: PlayerId = viewer === 0 ? 1 : 0;
  return {
    crystals: view.players[viewer].crystals,
    crystalCap: view.players[viewer].crystalCap,
    ownBaseHealth: healthOf(view, view.players[viewer].baseId),
    enemyBaseHealth: healthOf(view, view.players[opponent].baseId),
    fountain,
    lights,
    timerSeconds: view.rules.actionSeconds,
    priority: view.priority,
  };
}

/** Deterministic replay-only heroes are not part of the generated PF1 card presentation bundle. */
export const GOLDEN_HERO_COLORS: Readonly<Record<string, readonly Color[]>> = {
  GOLDEN_HERO_RED: ["red"],
  GOLDEN_HERO_BLUE: ["blue"],
};
