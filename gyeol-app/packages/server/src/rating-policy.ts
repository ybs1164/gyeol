import { PLACEMENT_GAMES, type RatingRestriction } from '@gyeol/core';
import { withInactivity } from './glicko';
import type { GameRecord, PlayerRecord } from './store';

export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RATED_PAIR_LIMIT = 2;
export const MIN_COMPETITIVE_PLIES = 6;
export const LEADERBOARD_MAX_RD = 150;

export function calibratedOpponent(p: PlayerRecord): boolean {
  return !!p.bot || (p.rated ?? p.ranked) >= PLACEMENT_GAMES;
}

export function effectiveRating(p: PlayerRecord, now = Date.now()) {
  return p.bot ? p : withInactivity(p, p.ratingAt ?? p.createdAt, now);
}

export function ratingRestriction(g: GameRecord, games: Iterable<GameRecord>, humanPair: boolean, now: number): RatingRestriction | undefined {
  if (g.endReason !== 'normal' && g.moves.length < MIN_COMPETITIVE_PLIES) return 'early';
  if (!humanPair) return;
  let count = 0;
  for (const other of games) {
    if (other.id === g.id || !other.ranked || other.status !== 'finished' || other.updatedAt < now - REPEAT_WINDOW_MS) continue;
    if (other.endReason !== 'normal' && other.moves.length < MIN_COMPETITIVE_PLIES) continue;
    if ((other.greenId === g.greenId && other.brownId === g.brownId) || (other.greenId === g.brownId && other.brownId === g.greenId)) {
      if (++count >= RATED_PAIR_LIMIT) return 'repeat';
    }
  }
}

export function leaderboardEligible(p: PlayerRecord, now: number): boolean {
  return p.bot ? p.ranked > 0 : (p.rated ?? p.ranked) >= PLACEMENT_GAMES && effectiveRating(p, now).rd <= LEADERBOARD_MAX_RD;
}
