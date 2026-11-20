/** 온라인 대국 서버 ↔ 클라이언트 메시지 (WebSocket, JSON) */
import { apply, initial, winner, type Board, type Player } from './rules';

export interface PublicPlayer {
  id: string;
  name: string;
  rating: number;
  rd: number;
  ranked: number;
  /** 점수 제한 없이 평가된 랭크전 수. 이전 서버에는 없음 */
  rated?: number;
  wins: number;
  losses: number;
  /** AI 플레이어 */
  bot?: boolean;
}

export type GameStatus = 'waiting' | 'active' | 'finished';
export const PLACEMENT_GAMES = 5;
export type RatingRestriction = 'early' | 'repeat' | 'provisional';
export interface RatingSummary {
  peak: number;
  lowest: number;
  /** 계정 생성부터의 기록이 모두 남아 있는지 */
  complete: boolean;
}

/** 온라인 시간 모드: 1분·3분·5분은 각자 한 판 전체 시간, 1일은 한 수에 24시간 */
export type TimeMode = 'bullet' | 'blitz' | 'rapid' | 'daily';
export const TIME_MODES: { id: TimeMode; clockMs: number | null; turnMs: number | null }[] = [
  { id: 'bullet', clockMs: 60_000, turnMs: null },
  { id: 'blitz', clockMs: 180_000, turnMs: null },
  { id: 'rapid', clockMs: 300_000, turnMs: null },
  { id: 'daily', clockMs: null, turnMs: 86_400_000 },
];
export const isTimeMode = (m: unknown): m is TimeMode => TIME_MODES.some((x) => x.id === m);

/** 레이팅 기록 한 점 */
export interface RatingPoint {
  at: number;
  rating: number;
}
export type EndReason = 'normal' | 'resign' | 'timeout';

export interface OnlineGame {
  id: string;
  /** 친구 초대 코드 (랭크전은 null) */
  code: string | null;
  ranked: boolean;
  mode: TimeMode;
  green: PublicPlayer | null;
  brown: PublicPlayer | null;
  moves: number[];
  status: GameStatus;
  winner: Player | 0 | null;
  endReason: EndReason | null;
  /** 한 수 제한 시간(ms). 1일 모드 또는 예전 대국. null 이면 한 수 제한 없음 */
  turnLimitMs: number | null;
  /** 1분·3분·5분: turnStartedAt 시점의 각자 남은 시간(ms) */
  clock: { green: number; brown: number } | null;
  turnStartedAt: number;
  /** 서버가 이 메시지를 보낸 시각 (기기 시계 차이 보정용) */
  now: number;
  createdAt: number;
  updatedAt: number;
  ratingChange: { green: number; brown: number } | null;
  ratingRestriction?: { green?: RatingRestriction; brown?: RatingRestriction };
  online: { green: boolean; brown: boolean };
}

export type ColorChoice = 'green' | 'brown' | 'random';

export type ClientMsg =
  | { t: 'hello'; token?: string }
  | { t: 'name'; name: string }
  | { t: 'create'; color: ColorChoice; mode?: TimeMode }
  | { t: 'join'; code: string }
  | { t: 'open'; id: string }
  | { t: 'move'; id: string; ply: number; action: number }
  | { t: 'resign'; id: string }
  | { t: 'queue'; mode?: TimeMode }
  | { t: 'unqueue' }
  | { t: 'games' }
  | { t: 'leaderboard' }
  | { t: 'history' };

export type ErrorCode =
  | 'not_found'
  | 'not_your_turn'
  | 'illegal'
  | 'stale'
  | 'full'
  | 'bad_name'
  | 'finished'
  | 'not_player'
  | 'hello_first'
  | 'rate_limited'
  | 'bad_request';

export type ServerMsg =
  | { t: 'welcome'; token: string; me: PublicPlayer }
  | { t: 'me'; me: PublicPlayer }
  | { t: 'game'; game: OnlineGame }
  | { t: 'games'; games: OnlineGame[] }
  | { t: 'queued'; size: number; mode: TimeMode }
  | { t: 'unqueued' }
  | { t: 'leaderboard'; players: PublicPlayer[] }
  | { t: 'history'; points: RatingPoint[]; summary?: RatingSummary }
  | { t: 'error'; code: ErrorCode };

/** 수 목록을 처음부터 다시 두어 현재 국면을 만든다 */
export function replay(moves: number[]): { board: Board; player: Player } {
  let board = initial();
  let player: Player = 1;
  for (const a of moves) {
    board = apply(board, player, a).board;
    player = -player as Player;
  }
  return { board, player };
}

/** 국면이 끝났으면 승자 */
export function gameOver(moves: number[]): Player | 0 | null {
  const { board, player } = replay(moves);
  return winner(board, player);
}

export const NAME_MAX = 12;
export function validName(name: string): boolean {
  const n = name.trim();
  return n.length >= 1 && n.length <= NAME_MAX && !/[<>\n\r\t]/.test(n);
}
