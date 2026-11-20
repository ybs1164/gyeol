import type { Board, Player } from './rules';

export type RecordKind = 'advantage' | 'turnaround' | 'win';
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
}
