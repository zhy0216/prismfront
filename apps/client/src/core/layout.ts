import type { PlayerId } from "@prismfront/shared";
import { CARD_FACE_HEIGHT, CARD_FACE_WIDTH } from "./card-face.ts";

export const DESIGN_WIDTH = 1920;
export const DESIGN_HEIGHT = 1080;

/** 棋盘上卡牌的展示尺寸（竖版，高为长边）。 */
export const BOARD_CARD_HEIGHT = 200;
export const BOARD_CARD_WIDTH = BOARD_CARD_HEIGHT * (CARD_FACE_WIDTH / CARD_FACE_HEIGHT);

/** 格子在卡牌四周的单侧留白：让格子是长方形、且只比卡牌大一点。 */
const SLOT_PADDING = 15;
export const SLOT_W = BOARD_CARD_WIDTH + SLOT_PADDING * 2;
export const SLOT_H = BOARD_CARD_HEIGHT + SLOT_PADDING * 2;
export const SLOT_GAP = 8;
export const SLOT_COUNT = 9;
export const BOARD_X0 = (DESIGN_WIDTH - (SLOT_COUNT * SLOT_W + (SLOT_COUNT - 1) * SLOT_GAP)) / 2;
export const ROW_Y = { enemy: 300, friendly: 640 } as const;
export const BASE_Y = { enemy: 96, friendly: 844 } as const;

export type ViewSide = "friendly" | "enemy";

export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

/** 只按 viewer 翻转上下；index 永远直接落在共享 X 数轴，不做左右镜像。 */
export function viewSide(viewer: PlayerId, owner: PlayerId): ViewSide {
  return viewer === owner ? "friendly" : "enemy";
}

export function slotToWorld(side: ViewSide, index: number): WorldPoint {
  return {
    x: BOARD_X0 + index * (SLOT_W + SLOT_GAP) + SLOT_W / 2,
    y: ROW_Y[side],
  };
}

/** Return the lane under a world-space point, excluding the gaps between lanes. */
export function worldPointToSlot(side: ViewSide, x: number, y: number): number | null {
  if (Math.abs(y - ROW_Y[side]) > SLOT_H / 2) return null;
  const relativeX = x - BOARD_X0;
  if (relativeX < 0) return null;
  const pitch = SLOT_W + SLOT_GAP;
  const index = Math.floor(relativeX / pitch);
  if (index < 0 || index >= SLOT_COUNT || relativeX - index * pitch > SLOT_W) return null;
  return index;
}

export function absoluteSlotToWorld(viewer: PlayerId, owner: PlayerId, index: number): WorldPoint {
  return slotToWorld(viewSide(viewer, owner), index);
}

export function baseToWorld(viewer: PlayerId, owner: PlayerId): WorldPoint {
  const side = viewSide(viewer, owner);
  return { x: DESIGN_WIDTH / 2, y: BASE_Y[side] };
}

/** 空格/越界时光束延伸至基地；有实体时止于对应绝对 index。 */
export function beamPath(
  viewer: PlayerId,
  sourceOwner: PlayerId,
  sourceIndex: number,
  direction: number,
  hitUnit: boolean,
): readonly [WorldPoint, WorldPoint] {
  const targetOwner: PlayerId = sourceOwner === 0 ? 1 : 0;
  const targetIndex = sourceIndex + direction;
  const from = absoluteSlotToWorld(viewer, sourceOwner, sourceIndex);
  if (hitUnit && targetIndex >= 0 && targetIndex < SLOT_COUNT) {
    return [from, absoluteSlotToWorld(viewer, targetOwner, targetIndex)];
  }
  const base = baseToWorld(viewer, targetOwner);
  const targetX = BOARD_X0 + targetIndex * (SLOT_W + SLOT_GAP) + SLOT_W / 2;
  return [from, { x: targetX, y: base.y }];
}
