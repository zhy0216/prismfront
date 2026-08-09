import { Events } from "phaser";

export const MATCH_BUS = new Events.EventEmitter();

export const BUS_EVENTS = {
  snapshot: "match:snapshot",
  events: "match:events",
  beat: "match:beat",
  prompt: "match:prompt",
  rejected: "match:rejected",
  input: "match:input",
  idle: "match:idle",
} as const;
