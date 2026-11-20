import type { Player } from '@gyeol/core';
import { GRADES, GRADE_LIMITS, isIssueMove, isProvisionalMove, moveDisplayGrade, type MoveGrade } from './grading';
import type { GameAnalysis, MoveAnalysis } from './analysis';

/** Points of loss at which a move keeps 1/e of its score. Chosen so a typical game lands near 75. */
export const ACCURACY_SCALE = 25;
/** Consecutive best moves from a worse position needed for `resilience`. */
export const RESILIENCE_RUN = 3;
/** Best available value (40 points) at or below which the mover counts as behind. */
export const BEHIND_VALUE = -0.2;

/** Earned marks, strongest first. The last two depend on neighbouring moves and are never stored. */
export const ACHIEVEMENTS = ['brilliant', 'onlyWin', 'onlyDefense', 'decisive', 'punish', 'resilience'] as const;
export type Achievement = typeof ACHIEVEMENTS[number];
export interface EarnedAchievement { kind: Achievement; provisional: boolean }

/** 0..100 for one move; forced moves have no score. Solved moves score by outcome, not by artificial loss. */
export function moveAccuracy(move: MoveAnalysis): number | null {
  if (move.forced) return null;
  if (move.status === 'exact') return move.grade === 'best' ? 100 : move.grade === 'blunder' ? 0 : 40;
  // A loss capped by the decided-position rule is scored as the grade it was given.
  const loss = Math.min(move.lossPoints, GRADE_LIMITS[moveDisplayGrade(move) as MoveGrade]);
  return 100 * Math.exp(-loss / ACCURACY_SCALE);
}

const isBest = (move: MoveAnalysis | null | undefined): move is MoveAnalysis => !!move && !move.forced && moveDisplayGrade(move) === 'best';

/** Achievements of every move, including those that depend on the surrounding moves. */
export function moveAchievements(moves: readonly (MoveAnalysis | null)[]): EarnedAchievement[][] {
  const runs = new Map<Player, { length: number; provisional: boolean }>();
  return moves.map((move, i) => {
    const earned: EarnedAchievement[] = [];
    if (!move || move.forced) return earned;
    const provisional = isProvisionalMove(move);
    for (const kind of ['brilliant', 'onlyWin', 'onlyDefense', 'decisive'] as const) if (move.badges.includes(kind)) earned.push({ kind, provisional });
    const previous = moves[i - 1];
    if (isBest(move) && previous && !previous.forced && previous.player !== move.player
      && ['mistake', 'blunder'].includes(moveDisplayGrade(previous)))
      earned.push({ kind: 'punish', provisional: provisional || isProvisionalMove(previous) });
    const run = runs.get(move.player) ?? { length: 0, provisional: false };
    if (isBest(move) && move.bestValue <= BEHIND_VALUE) {
      run.length++; run.provisional ||= provisional;
      if (run.length === RESILIENCE_RUN) earned.push({ kind: 'resilience', provisional: run.provisional });
    } else { run.length = 0; run.provisional = false; }
    runs.set(move.player, run);
    return earned.sort((a, b) => ACHIEVEMENTS.indexOf(a.kind) - ACHIEVEMENTS.indexOf(b.kind));
  });
}

export interface GameReport {
  /** Scored moves: analysed and not forced. */
  moves: number;
  accuracy: number | null;
  /** Scored moves whose grade is still an estimate. */
  provisional: number;
  /** Opening, middle and end thirds of the game. */
  phases: (number | null)[];
  grades: Record<MoveGrade, number>;
  bestStreak: number;
  achievements: Record<Achievement, number>;
  highlight: ({ ply: number } & EarnedAchievement) | null;
  /** Up to three moves most worth another look, worst first. */
  review: number[];
}

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

export function gameReport(analysis: Pick<GameAnalysis, 'moves'>, player: Player): GameReport {
  const total = analysis.moves.length;
  const earned = moveAchievements(analysis.moves);
  const mine = analysis.moves.filter((m): m is MoveAnalysis => !!m && m.player === player && !m.forced);
  const scores = mine.map(m => ({ move: m, score: moveAccuracy(m)! }));
  const grades = Object.fromEntries(GRADES.map(g => [g, 0])) as Record<MoveGrade, number>;
  const achievements = Object.fromEntries(ACHIEVEMENTS.map(a => [a, 0])) as Record<Achievement, number>;
  let streak = 0, bestStreak = 0;
  let highlight: GameReport['highlight'] = null;
  const rank = (a: EarnedAchievement) => ACHIEVEMENTS.indexOf(a.kind) * 2 + (a.provisional ? 1 : 0);
  for (const move of mine) {
    grades[moveDisplayGrade(move) as MoveGrade]++;
    streak = isBest(move) ? streak + 1 : 0;
    bestStreak = Math.max(bestStreak, streak);
    for (const a of earned[move.ply - 1]) {
      achievements[a.kind]++;
      if (!highlight || rank(a) < rank(highlight)) highlight = { ply: move.ply, ...a };
    }
  }
  return {
    moves: mine.length, accuracy: mean(scores.map(s => s.score)),
    provisional: mine.filter(isProvisionalMove).length,
    phases: [0, 1, 2].map(phase => mean(scores.filter(s => Math.min(2, Math.floor((s.move.ply - 1) * 3 / Math.max(1, total))) === phase).map(s => s.score))),
    grades, bestStreak, achievements, highlight,
    review: scores.filter(s => isIssueMove(s.move)).sort((a, b) => a.score - b.score || a.move.ply - b.move.ply).slice(0, 3).map(s => s.move.ply),
  };
}
