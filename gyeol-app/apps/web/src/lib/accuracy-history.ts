import type { AccuracyEntry } from './storage';

export const TREND_GAMES = 10;
export interface AccuracyTrend {
  /** Rounded difference from the average of the earlier games. */
  delta: number;
  /** How many earlier games the average covers. */
  count: number;
  personalBest: boolean;
}

/** Compares one game with the games played before it. Null when there is nothing earlier to compare with. */
export function accuracyTrend(entries: readonly AccuracyEntry[], current: AccuracyEntry): AccuracyTrend | null {
  const earlier = entries.filter(e => e.id !== current.id && e.date < current.date).sort((a, b) => b.date - a.date);
  if (!earlier.length) return null;
  const recent = earlier.slice(0, TREND_GAMES);
  const average = recent.reduce((n, e) => n + e.accuracy, 0) / recent.length;
  return {
    delta: Math.round(current.accuracy) - Math.round(average), count: recent.length,
    personalBest: earlier.every(e => current.accuracy > e.accuracy),
  };
}
