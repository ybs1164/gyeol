import { PASS, apply, legal, type Board, type Player } from './rules';

/**
 * 수 평가 타입. 판 위에서 바로 확인할 수 있는 사실만으로 정한다.
 *   attack  (!)  뒤집었고, 상대가 되받아 뒤집을 수 있는 장수가 그보다 적다.
 *   defense      상대가 한 수로 뒤집을 수 있던 장수를 줄였다.
 *   gift    (?)  상대가 뒤집을 수 있는 장수가 늘었고, 내가 뒤집은 것보다 많다.
 */
export const MOVE_TYPES = ['attack', 'defense', 'gift'] as const;
export type MoveType = typeof MOVE_TYPES[number];
export interface MoveTypeInfo {
  type: MoveType | null;
  /** 이 수로 뒤집은 장수 */
  flips: number;
  /** 두기 전 판에서 상대가 한 수로 뒤집을 수 있던 최대 장수 */
  threatBefore: number;
  /** 둔 뒤 상대가 한 수로 뒤집을 수 있는 최대 장수 */
  threatAfter: number;
}

/** player가 그 판에서 한 수로 뒤집을 수 있는 최대 장수. */
export function maxCapture(board: Board, player: Player): number {
  let max = 0;
  for (const action of legal(board, player)) {
    if (action === PASS) break;
    max = Math.max(max, apply(board, player, action).last.flipped!.length);
  }
  return max;
}

export function moveType(board: Board, player: Player, action: number): MoveTypeInfo {
  if (action === PASS) return { type: null, flips: 0, threatBefore: 0, threatAfter: 0 };
  const opponent = -player as Player;
  const next = apply(board, player, action);
  const flips = next.last.flipped!.length;
  const threatBefore = maxCapture(board, opponent), threatAfter = maxCapture(next.board, opponent);
  const type: MoveType | null = flips >= 1 && threatAfter < flips ? 'attack'
    : threatBefore > 0 && threatAfter < threatBefore ? 'defense'
    : threatAfter > threatBefore && threatAfter > flips ? 'gift' : null;
  return { type, flips, threatBefore, threatAfter };
}
