import { describe, expect, test } from "bun:test";
import {
  absoluteSlotToWorld,
  beamPath,
  ROW_Y,
  SLOT_GAP,
  SLOT_W,
  worldPointToSlot,
} from "../layout.ts";

describe("viewer layout", () => {
  test("seat changes only vertical orientation, never horizontal slot index", () => {
    const p0 = absoluteSlotToWorld(0, 0, 2);
    const p1 = absoluteSlotToWorld(1, 0, 2);
    expect(p0.x).toBe(p1.x);
    expect([p0.y, p1.y]).toEqual([ROW_Y.friendly, ROW_Y.enemy]);
  });

  test("beam crosses an empty target lane to the base line", () => {
    const [source, end] = beamPath(0, 0, 1, 1, false);
    expect(end.x).toBe(absoluteSlotToWorld(0, 1, 2).x);
    expect(end.y).toBeLessThan(absoluteSlotToWorld(0, 1, 2).y);
    expect(source.y).toBe(ROW_Y.friendly);
  });

  test("maps world points to slots without accepting the lane gaps", () => {
    const slot = absoluteSlotToWorld(0, 0, 3);
    expect(worldPointToSlot("friendly", slot.x, slot.y)).toBe(3);
    expect(worldPointToSlot("friendly", slot.x, ROW_Y.enemy)).toBeNull();
    expect(worldPointToSlot("friendly", slot.x + SLOT_W / 2 + SLOT_GAP / 2, slot.y)).toBeNull();
  });
});
