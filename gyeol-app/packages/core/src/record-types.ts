import type { Board, Player } from './rules';

/** keep: 유리함을 지키는 단 하나의 수(한 수 문제) */
export type RecordKind = 'advantage' | 'turnaround' | 'win' | 'keep';
export interface RecordPuzzleData {
  id: string;
  kind: RecordKind;
  board: Board;
  player: Player;
  plies: number;
  target: number;
  raw: number;
  rating: number;
  source: { gameId: string; type: 'online' | 'ai'; reference: string; ply: number; moveNumber: number; playedMove: number };
  proof: [string, [number, number][]][];
  solverNodes: number;
  guaranteedMargin: number;
  /** line(기본): 상대 최선 응수와 종국까지 두는 문제. move: 한 수만 고르는 문제 */
  format?: 'line' | 'move';
  /** move 문제의 판정 근거. exact: 종국까지 계산한 승패, ai: AI 정밀 탐색 */
  judge?: 'exact' | 'ai';
  /** move 문제: 수마다 둔 사람 기준 평가. exact 는 1 승 / 0 무 / -1 패, ai 는 승률(0..1) */
  evals?: [number, number][];
  /** ai 판정에 쓴 모델(sha256 앞 16자) */
  model?: string;
  /** 이 국면을 만든 상대의 직전 실수. 퍼즐은 이 실수를 응징하는 문제다. */
  mistake?: PuzzleMistake;
}

/**
 * 상대(퍼즐을 푸는 쪽의 반대편)가 직전에 둔 실수.
 * board 에서 상대가 action 을 두면 퍼즐 판이 된다. before/after 는 상대 기준 평가다.
 * - exact: 종국까지 계산한 승패(1 승 / 0 무 / -1 패). before = 다른 수로 지킬 수 있던 결과, after = 실제 수의 결과(-1).
 * - ai: AI 탐색 승률(0..1). before = 가장 좋은 다른 수, after = 실제로 둔 수.
 */
export interface PuzzleMistake {
  board: Board;
  action: number;
  judge: 'exact' | 'ai';
  before: number;
  after: number;
  /** before 를 지키는 다른 수 하나(복기·설명용) */
  best: number;
}
