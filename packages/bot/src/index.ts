// @prismfront/bot —— 对局 AI（架构 §2.3）
// bot 不认识网络或完整真相：只消费座位投影与合法动作快照。

import type { Intent, LegalAction, LegalMoves, PlayerView } from "@prismfront/engine";

export interface Bot {
  choose(view: PlayerView, legal: LegalMoves): Intent;
}

function playable(moves: LegalMoves): LegalAction[] {
  return moves.actions.filter((move) => move.legal);
}

/** 可注入的确定性随机 bot；默认种子保证 CLI 与测试可复现。 */
export class RandomBot implements Bot {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0;
  }

  private nextInt(max: number): number {
    this.state = (Math.imul(this.state ^ (this.state >>> 16), 0x45d9f3b) + 0x6d2b79f5) >>> 0;
    this.state ^= this.state >>> 13;
    return max <= 1 ? 0 : (this.state >>> 0) % max;
  }

  choose(_view: PlayerView, legal: LegalMoves): Intent {
    const options = playable(legal);
    if (options.length === 0) {
      return legal.pass.intent;
    }
    return options[this.nextInt(options.length)]?.intent ?? legal.pass.intent;
  }
}

/** 低风险启发式：优先打出当前能支付的最高费用牌，否则 pass。 */
export class GreedyBot implements Bot {
  choose(view: PlayerView, legal: LegalMoves): Intent {
    const options = playable(legal).filter((move) => move.t === "play_card");
    let best: LegalAction | undefined;
    let bestCost = -1;
    for (const move of options) {
      if (move.card === null) {
        continue;
      }
      const entity = view.entities[move.card];
      const cost = entity !== undefined && "tags" in entity ? entity.tags.cost : 0;
      if (best === undefined || cost > bestCost) {
        best = move;
        bestCost = cost;
      }
    }
    return best?.intent ?? legal.pass.intent;
  }
}

export function createBot(name: "random" | "greedy", seed?: number): Bot {
  return name === "random" ? new RandomBot(seed) : new GreedyBot();
}
