import type { EndReason, GameStatus, Player, RatingPoint, RatingRestriction, TimeMode } from '@gyeol/core';
import type { Rating } from './glicko';

export interface PlayerRecord extends Rating {
  id: string;
  token: string;
  name: string;
  ranked: number;
  rated?: number;
  wins: number;
  losses: number;
  createdAt: number;
  seenAt: number;
  /** AI 플레이어 (레이팅 고정, packages/ai/src/persona.ts) */
  bot?: boolean;
  /** 기준점 대전 전적과 실제 사람 상대 전적을 분리한 버전 */
  botRosterVersion?: number;
  /** 마지막으로 RD를 계산한 시각. 로그인만으로 바꾸지 않는다 */
  ratingAt?: number;
  peakRating?: number;
  lowestRating?: number;
  historyComplete?: boolean;
  /** 과거 300개 제한 이후부터는 모든 레이팅 변화를 보존한다 */
  history?: RatingPoint[];
}

export interface GameRecord {
  id: string;
  code: string | null;
  ranked: boolean;
  /** 예전 저장 파일에는 없음 */
  mode?: TimeMode;
  greenId: string | null;
  brownId: string | null;
  moves: number[];
  status: GameStatus;
  winner: Player | 0 | null;
  endReason: EndReason | null;
  turnLimitMs: number | null;
  clock?: { green: number; brown: number } | null;
  turnStartedAt: number;
  createdAt: number;
  updatedAt: number;
  ratingChange: { green: number; brown: number } | null;
  ratingRestriction?: { green?: RatingRestriction; brown?: RatingRestriction };
  revision?: number;
  ruleVersion?: 'facing-25-v1';
  initialBoard?: number[];
  initialPlayer?: Player;
}

export interface Data {
  version: 1;
  players: Record<string, PlayerRecord>;
  games: Record<string, GameRecord>;
}
/** 이미 삭제된 이력은 추측해서 복원하지 않는다. 기존 계정·점수·전적은 유지한다. */
export function initializeRatingRecord(p: PlayerRecord) {
  p.rated ??= p.ranked;
  p.historyComplete ??= (p.history?.length ?? 0) === p.ranked;
  p.ratingAt ??= p.history?.at(-1)?.at ?? p.createdAt;
  if (p.bot) return;
  p.history ??= [];
  if (p.historyComplete && (p.history[0]?.at ?? Infinity) > p.createdAt) {
    p.history.unshift({ at: p.createdAt, rating: 1500 });
  }
  p.peakRating ??= p.history.reduce((peak, h) => Math.max(peak, h.rating), Math.round(p.rating));
  p.lowestRating ??= p.history.reduce((lowest, h) => Math.min(lowest, h.rating), Math.round(p.rating));
}
