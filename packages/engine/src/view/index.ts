// view/ —— M7 的座位快照、事件投影与合法动作索引。

export type { LegalAction, LegalActionsDeps, LegalMoves } from "./legal-actions.ts";
export { legalActions } from "./legal-actions.ts";
export type {
  ClientEvent,
  HiddenEntity,
  PlayerView,
  ProjectedEntity,
  ProjectedInputRequest,
  VisibleEntity,
} from "./project.ts";
export { project, projectEvent } from "./project.ts";
