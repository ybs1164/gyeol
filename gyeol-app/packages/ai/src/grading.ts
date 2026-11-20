export const GRADING_VERSION = 4;
export const GRADES = ['best', 'good', 'fair', 'inaccuracy', 'mistake', 'blunder'] as const;
export type MoveGrade = typeof GRADES[number];
export type EvaluationStatus = 'estimated' | 'stable' | 'exact';
export type MoveBadge = 'missedWin' | 'missedChance' | 'missedDefense' | 'onlyWin' | 'onlyDefense' | 'convertedChance' | 'brilliant' | 'decisive';
export const MOVE_BADGES: readonly MoveBadge[] = ['missedWin', 'missedChance', 'missedDefense', 'onlyWin', 'onlyDefense', 'convertedChance', 'brilliant', 'decisive'];
export const GRADE_SYMBOLS: Record<MoveGrade, string> = {
  best: '★', good: '!', fair: '○', inaccuracy: '?!', mistake: '?', blunder: '??',
};
/** An earned mark shown in place of ★; never a loss band. */
export const BRILLIANT_SYMBOL = '!!';

export const GRADE_LIMITS: Record<MoveGrade, number> = { best: 2, good: 5, fair: 10, inaccuracy: 20, mistake: 35, blunder: 100 };
/** At or beyond this value (80 / 20 points) the game is treated as decided: losses there are capped at `fair`. */
export const DECIDED_VALUE = 0.6;
/** Lead over every other option, in points, after subtracting observed search drift. */
export const DECISIVE_GAP = 10;
export const BRILLIANT_GAP = 15;
/** How much worse the move looked at the shallow first pass than the then-best candidate. */
export const BRILLIANT_SURPRISE = 10;
/** Drift assumed for a rival that was never refined. */
const UNMEASURED_DRIFT = 0.12;
/** Absorb arithmetic round-off at exact boundaries, well below displayed precision. */
const LOSS_EPSILON = 1e-9;
export const MOVE_REASONS = ['loss', 'preservedWin', 'preservedDraw', 'allLose', 'winToDraw', 'drawToLoss', 'winToLoss', 'forced', 'forcedPass', 'decidedAhead', 'decidedBehind'] as const;
export type MoveReason = typeof MOVE_REASONS[number];

export interface GradingCandidate {
  action: number;
  value: number;
  status: EvaluationStatus;
  simulations: number;
  drift?: number;
  /** Value from the shallow first pass, kept when the candidate was searched deeper. */
  shallow?: number;
  /** Identical recentered child boards are one option even with distinct action IDs. */
  resultKey?: string;
}
export interface MoveDecision {
  bestActions: number[];
  bestValue: number;
  playedValue: number;
  lossPoints: number;
  /** Compatibility alias: evaluation points, not calibrated probability pp. */
  lossPp: number;
  lossRange?: [number, number];
  grade: MoveGrade | null;
  provisionalGrade: MoveGrade | null;
  reasonCode: MoveReason;
  badges: MoveBadge[];
  forced: boolean;
  status: EvaluationStatus;
}

/** Boundaries are AI evaluation points on a 0..100 scale. */
export function gradeMove(lossPoints: number): MoveGrade {
  if (!Number.isFinite(lossPoints) || lossPoints < 0 || lossPoints > 100) throw new Error('Invalid move loss');
  return GRADES.find(grade => lossPoints <= GRADE_LIMITS[grade] + LOSS_EPSILON)!;
}

/** @deprecated Use gradeMove; candidate or baseline conditions never override quality. */
export function candidateGrade(lossPoints: number, _candidates?: readonly { action: number; value: number }[], _played?: number, _baselineValue?: number): MoveGrade {
  return gradeMove(lossPoints);
}

export function exactGrade(best: number, played: number): MoveGrade {
  if (best === played) return 'best';
  return best === 1 && played === -1 ? 'blunder' : 'mistake';
}

/** Shared by quick analysis, detailed analysis, and cache validation. */
export function decideMove(candidates: readonly GradingCandidate[], played: number, passAction: number): MoveDecision {
  if (!candidates.length || candidates.some(c => !Number.isFinite(c.value) || Math.abs(c.value) > 1)) throw new Error('Invalid move candidates');
  const actual = candidates.find(c => c.action === played);
  if (!actual) throw new Error('Played move missing');
  const best = Math.max(...candidates.map(c => c.value));
  const exact = candidates.every(c => c.status === 'exact');
  if (candidates.some(c => c.status === 'exact' && ![-1, 0, 1].includes(c.value))) throw new Error('Invalid exact outcome');
  const forced = candidates.length === 1;
  const lossPoints = Math.max(0, (best - actual.value) * 50);
  // A loss that leaves the mover clearly ahead, or that happens when every option is clearly behind, did not decide the game.
  const decided = exact || forced ? null : actual.value >= DECIDED_VALUE ? 'decidedAhead' : best <= -DECIDED_VALUE ? 'decidedBehind' : null;
  const worseThanFair = (g: MoveGrade) => GRADES.indexOf(g) > GRADES.indexOf('fair');
  const gradeHere = (loss: number): MoveGrade => { const g = gradeMove(loss); return decided && worseThanFair(g) ? 'fair' : g; };
  const proposed = exact ? exactGrade(best, actual.value) : gradeHere(lossPoints);
  const leaders = candidates.filter(c => best - c.value <= 0.12 + (c.drift ?? 0));
  const measured = (c: GradingCandidate) => c.status === 'exact' || c.status === 'stable' && c.simulations > 0 && c.drift !== undefined && Number.isFinite(c.drift) && c.drift >= 0 && c.drift <= 0.06;
  let lossRange: [number, number] | undefined;
  if (!exact && measured(actual) && leaders.every(measured)) {
    const others = leaders.filter(c => c.action !== played);
    const drift = (c: GradingCandidate) => c.status === 'exact' ? 0 : c.drift!;
    const lower = Math.max(0, (Math.max(-1, ...others.map(c => c.value - drift(c))) - actual.value - drift(actual)) * 50);
    const upper = Math.min(100, Math.max(0, (Math.max(-1, ...others.map(c => c.value + drift(c))) - actual.value + drift(actual)) * 50));
    lossRange = [lower, upper];
  }
  const stable = !!lossRange && gradeHere(lossRange[0]) === proposed && gradeHere(lossRange[1]) === proposed;
  const grade = forced ? null : exact || stable ? proposed : null;
  const badges: MoveBadge[] = [];
  const unique = (options: readonly GradingCandidate[]) => new Set(options.map(c => c.resultKey ?? String(c.action))).size === 1;
  if (!forced && exact) {
    const safe = candidates.filter(c => c.value >= 0), wins = candidates.filter(c => c.value === 1);
    if (best === 1 && actual.value < 1) badges.push('missedWin');
    if (safe.length && unique(safe) && actual.value < 0) badges.push('missedDefense');
    if (wins.length && unique(wins) && actual.value === 1) badges.push('onlyWin');
    else if (safe.length && unique(safe) && actual.value >= 0) badges.push('onlyDefense');
  } else if (!forced && grade && best >= 0.5 && actual.value <= 0.1 && lossPoints >= 20) badges.push('missedChance');
  else if (!forced && grade === 'best') {
    // Earned marks need a confirmed best move that stands clear of every other resulting board.
    const rivals = candidates.filter(c => c.action !== played && !(actual.resultKey !== undefined && c.resultKey === actual.resultKey));
    const margin = (c: GradingCandidate) => c.status === 'exact' ? 0 : measured(c) ? c.drift! : UNMEASURED_DRIFT;
    if (rivals.length) {
      const rivalBest = Math.max(...rivals.map(c => c.value)), rivalHigh = Math.max(...rivals.map(c => c.value + margin(c)));
      const gap = (actual.value - margin(actual) - rivalHigh) * 50;
      const surprise = actual.shallow === undefined ? 0 : (Math.max(...candidates.map(c => c.shallow ?? c.value)) - actual.shallow) * 50;
      if (best > -DECIDED_VALUE && rivalBest < DECIDED_VALUE && gap >= DECISIVE_GAP - LOSS_EPSILON)
        badges.push(gap >= BRILLIANT_GAP - LOSS_EPSILON && surprise >= BRILLIANT_SURPRISE - LOSS_EPSILON ? 'brilliant' : 'decisive');
    }
  }
  const reasonCode: MoveReason = forced ? played === passAction ? 'forcedPass' : 'forced'
    : !exact ? decided && worseThanFair(gradeMove(lossPoints)) ? decided : 'loss' : best === actual.value ? best === 1 ? 'preservedWin' : best === 0 ? 'preservedDraw' : 'allLose'
    : best === 1 ? actual.value === 0 ? 'winToDraw' : 'winToLoss' : 'drawToLoss';
  return {
    bestActions: candidates.filter(c => exact ? c.value === best : (best - c.value) * 50 <= GRADE_LIMITS.best + LOSS_EPSILON).map(c => c.action),
    bestValue: best, playedValue: actual.value, lossPoints, lossPp: lossPoints, ...(lossRange ? { lossRange } : {}),
    grade, provisionalGrade: forced || grade ? null : proposed, reasonCode, badges, forced,
    status: exact ? 'exact' : stable ? 'stable' : 'estimated',
  };
}

export const moveDisplayGrade = (move: Pick<MoveDecision, 'forced' | 'grade' | 'provisionalGrade'>) => move.forced ? 'forced' : move.grade ?? move.provisionalGrade!;
/** What the badge shows: an earned mark replaces ★. */
export const moveDisplayMark = (move: Pick<MoveDecision, 'forced' | 'grade' | 'provisionalGrade' | 'badges'>) =>
  !move.forced && move.grade === 'best' && move.badges.includes('brilliant') ? 'brilliant' : moveDisplayGrade(move);
export const isProvisionalMove = (move: Pick<MoveDecision, 'forced' | 'grade'>) => !move.forced && move.grade === null;
export const isIssueMove = (move: MoveDecision) => !move.forced && (['inaccuracy', 'mistake', 'blunder'].includes(moveDisplayGrade(move)) || move.badges.some(b => b.startsWith('missed')));
export const isConfirmedIssue = (move: MoveDecision) => !isProvisionalMove(move) && isIssueMove(move);
