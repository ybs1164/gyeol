import { describe, expect, test } from 'vitest';
import { PASS } from '@gyeol/core';
import { ACCURACY_SCALE, GRADES, GRADE_LIMITS, analysisSummary, gameReport, moveAccuracy, moveAchievements, moveDisplayMark, decideMove, emptyAnalysis, gradeMove, isConfirmedIssue, isIssueMove, moveDisplayGrade, type GradingCandidate, type MoveAnalysis } from '../src';

const candidate = (action: number, value: number, drift = 0): GradingCandidate => ({ action, value, drift, status: 'stable', simulations: 96 });
const exact = (action: number, value: number, resultKey = String(action)): GradingCandidate => ({ action, value, status: 'exact', simulations: 0, resultKey });
const decide = (candidates: GradingCandidate[], played = 1) => decideMove(candidates, played, PASS);

describe('intuitive move grading', () => {
  test('all six loss ranges are monotonic, including either side of every boundary', () => {
    for (const [i, grade] of GRADES.entries()) {
      const edge = GRADE_LIMITS[grade];
      expect(gradeMove(edge - 0.00001)).toBe(grade);
      expect(gradeMove(edge)).toBe(grade);
      if (i < GRADES.length - 1) expect(gradeMove(edge + 0.00001)).toBe(GRADES[i + 1]);
    }
    let previous = 0;
    for (let loss = 0; loss <= 100; loss += 0.01) {
      const rank = GRADES.indexOf(gradeMove(loss));
      expect(rank).toBeGreaterThanOrEqual(previous); previous = rank;
    }
    for (const invalid of [NaN, Infinity, -1, 101]) expect(() => gradeMove(invalid)).toThrow();
  });

  test('best and good are provisional when observed drift crosses their boundary', () => {
    const best = decide([candidate(1, 0.5, 0.03), candidate(2, 0.49, 0.03)]);
    expect(best.grade).toBeNull(); expect(best.provisionalGrade).toBe('best'); expect(best.status).toBe('estimated');
    const good = decide([candidate(1, 0.42, 0.03), candidate(2, 0.5, 0.03)]);
    expect(good.grade).toBeNull(); expect(good.provisionalGrade).toBe('good');
  });

  test('floating point round-off does not demote a move at the two-point boundary', () => {
    const move = decide([candidate(1, 0.16), candidate(2, 0.2)]);
    expect(move.lossPoints).toBeCloseTo(2, 12);
    expect(move.grade).toBe('best'); expect(move.bestActions).toEqual([1, 2]);
    expect(gradeMove(2.00001)).toBe('good');
  });

  test('a loss that leaves the game decided is capped at fair and says why', () => {
    const ahead = decide([candidate(1, 0.62), candidate(2, 0.98)]);
    expect(ahead.lossPoints).toBeCloseTo(18, 9); expect(ahead.grade).toBe('fair'); expect(ahead.reasonCode).toBe('decidedAhead');
    expect(isIssueMove(ahead)).toBe(false);
    const behind = decide([candidate(1, -0.98), candidate(2, -0.62)]);
    expect(behind.grade).toBe('fair'); expect(behind.reasonCode).toBe('decidedBehind');
    // Just outside the decided zone the same loss is still an inaccuracy.
    const open = decide([candidate(1, 0.58), candidate(2, 0.94)]);
    expect(open.grade).toBe('inaccuracy'); expect(open.reasonCode).toBe('loss');
    // Small losses keep their own grade and reason inside the zone.
    expect(decide([candidate(1, 0.9), candidate(2, 0.98)])).toMatchObject({ grade: 'good', reasonCode: 'loss' });
  });

  test('earned marks need a confirmed best move that stands clear of every other board', () => {
    expect(decide([candidate(1, 0.3, 0.01), candidate(2, 0.1, 0.01)]).badges).toEqual([]); // 9 points after drift
    expect(decide([candidate(1, 0.3, 0.01), candidate(2, 0.05, 0.01)]).badges).toEqual(['decisive']);
    // Brilliant: clear by 15 points and it looked 10 points worse at the shallow pass.
    const deep = { ...candidate(1, 0.4, 0.01), shallow: -0.1 };
    const brilliant = decide([deep, { ...candidate(2, 0, 0.01), shallow: 0.2 }]);
    expect(brilliant.badges).toEqual(['brilliant']); expect(brilliant.grade).toBe('best'); expect(moveDisplayMark(brilliant)).toBe('brilliant');
    expect(decide([{ ...deep, shallow: 0.15 }, { ...candidate(2, 0, 0.01), shallow: 0.2 }]).badges).toEqual(['decisive']);
    // Not when the alternative also wins comfortably, when every move is lost, or when the grade is unconfirmed.
    expect(decide([candidate(1, 0.95, 0.01), candidate(2, 0.65, 0.01)]).badges).toEqual([]);
    expect(decide([candidate(1, -0.65, 0.01), candidate(2, -0.95, 0.01)]).badges).toEqual([]);
    expect(decide([{ ...candidate(1, 0.4), status: 'estimated' }, candidate(2, 0)]).badges).toEqual([]);
    // An unrefined rival is given a wider margin; an identical resulting board is the same option.
    expect(decide([candidate(1, 0.3, 0.01), { ...candidate(2, -0.1), drift: undefined, status: 'estimated' }]).badges).toEqual(['decisive']);
    expect(decide([candidate(1, 0.3, 0.01), { ...candidate(2, 0), drift: undefined, status: 'estimated' }]).badges).toEqual([]);
    expect(decide([{ ...candidate(1, 0.3, 0.01), resultKey: 'k' }, { ...candidate(2, 0.3, 0.01), resultKey: 'k' }, candidate(3, 0, 0.01)]).badges).toEqual(['decisive']);
  });

  test('a clearly superior move is stable even with drift, and tied stable moves can share best', () => {
    expect(decide([candidate(1, 0.5, 0.01), candidate(2, 0.3, 0.01)]).grade).toBe('best');
    const tied = decide([candidate(1, 0.5, 0.001), candidate(2, 0.5, 0.001)]);
    expect(tied.grade).toBe('best'); expect(tied.bestActions).toEqual([1, 2]);
  });

  test('missing drift or shallow unrefined leaders cannot produce a stable grade', () => {
    for (const unmeasured of [{ ...candidate(2, 0.5), drift: undefined }, { ...candidate(2, 0.5), simulations: 0 }, { ...candidate(2, 0.5), status: 'estimated' as const }]) {
      const move = decide([candidate(1, 0.49), unmeasured]);
      expect(move.grade).toBeNull(); expect(move.provisionalGrade).toBe('best');
    }
  });

  test.each([
    [1, 1, 'best', 'preservedWin'], [0, 0, 'best', 'preservedDraw'], [-1, -1, 'best', 'allLose'],
    [1, 0, 'mistake', 'winToDraw'], [0, -1, 'mistake', 'drawToLoss'], [1, -1, 'blunder', 'winToLoss'],
  ] as const)('proven best %s, played %s -> %s / %s', (best, played, grade, reason) => {
    const move = decide([exact(1, played), exact(2, best)]);
    expect(move.grade).toBe(grade); expect(move.reasonCode).toBe(reason);
    expect(move.status).toBe('exact'); expect(move.provisionalGrade).toBeNull();
  });

  test('special achievements preserve best and group actions with identical resulting boards', () => {
    const move = decide([exact(1, 1, 'same'), exact(2, 1, 'same'), exact(3, -1)]);
    expect(move.grade).toBe('best'); expect(move.badges).toEqual(['onlyWin']);
    expect(decide([exact(1, 1), exact(2, 1), exact(3, -1)]).badges).toEqual([]);
    expect(decide([exact(1, 0), exact(2, -1)]).badges).toEqual(['onlyDefense']);
    expect(decide([exact(1, -1), exact(2, 0)]).badges).toEqual(['missedDefense']);
  });

  test('forced moves and passes have reasons but no grades, achievements, or issues', () => {
    for (const action of [1, PASS]) {
      const move = decide([exact(action, -1)], action);
      expect(move.grade).toBeNull(); expect(move.provisionalGrade).toBeNull(); expect(move.badges).toEqual([]);
      expect(move.reasonCode).toBe(action === PASS ? 'forcedPass' : 'forced');
      expect(moveDisplayGrade(move)).toBe('forced'); expect(isIssueMove(move)).toBe(false);
    }
  });

  test('provisional issues stay visible but do not affect confirmed counts or average loss', () => {
    const wrap = (candidates: GradingCandidate[], ply: number): MoveAnalysis => ({ ply, player: 1, played: 1, candidates: candidates.map(c => ({ ...c, pv: [c.action] })), ...decide(candidates) });
    const provisional = wrap([{ ...candidate(1, -0.8), status: 'estimated' }, candidate(2, 0.8)], 1);
    expect(isIssueMove(provisional)).toBe(true); expect(isConfirmedIssue(provisional)).toBe(false);
    const proven = wrap([exact(1, -1), exact(2, 1)], 2);
    const stable = wrap([candidate(1, 0), candidate(2, 0.6)], 3);
    const forced = wrap([exact(1, -1)], 4);
    const analysis = { ...emptyAnalysis(4, 'standard'), moves: [provisional, proven, stable, forced] };
    expect(analysisSummary(analysis, 1)).toMatchObject({ total: 3, graded: 2, provisional: 1, exact: 1, mistakes: 2, averageLoss: 30 });
  });
});

describe('game report', () => {
  const at = (ply: number, player: 1 | -1, candidates: GradingCandidate[]): MoveAnalysis => ({ ply, player, played: 1, candidates: candidates.map(c => ({ ...c, pv: [c.action] })), ...decide(candidates) });

  test('move accuracy falls with loss, scores solved moves by outcome and skips forced moves', () => {
    expect(moveAccuracy(at(1, 1, [candidate(1, 0.2), candidate(2, 0.2)]))).toBe(100);
    expect(moveAccuracy(at(1, 1, [candidate(1, -0.3), candidate(2, 0.2)]))).toBeCloseTo(100 * Math.exp(-25 / ACCURACY_SCALE), 9);
    // A capped loss is scored as the fair move it was graded as.
    expect(moveAccuracy(at(1, 1, [candidate(1, 0.62), candidate(2, 0.98)]))).toBeCloseTo(100 * Math.exp(-10 / ACCURACY_SCALE), 9);
    expect([[1, 1], [1, 0], [0, -1], [1, -1]].map(([best, played]) => moveAccuracy(at(1, 1, [exact(1, played), exact(2, best)])))).toEqual([100, 40, 40, 0]);
    expect(moveAccuracy(at(1, 1, [exact(1, -1)]))).toBeNull();
  });

  test('punish follows an opponent mistake and resilience needs three best moves from behind', () => {
    const best = (ply: number, player: 1 | -1, value: number) => at(ply, player, [candidate(1, value), candidate(2, value - 0.02)]);
    const moves = [
      at(1, 1, [candidate(1, -0.3), candidate(2, 0.3)]), // green mistake
      best(2, -1, 0.3),                                  // blue punishes
      best(3, 1, -0.3), best(4, -1, 0.3), best(5, 1, -0.3), best(6, -1, 0.3), best(7, 1, -0.3),
    ];
    const earned = moveAchievements(moves).map(list => list.map(a => a.kind));
    expect(earned).toEqual([[], ['punish'], [], [], [], [], ['resilience']]);
    expect(moveAchievements(moves)[1][0].provisional).toBe(false);
    const green = gameReport({ moves }, 1), blue = gameReport({ moves }, -1);
    expect(green).toMatchObject({ moves: 4, bestStreak: 3, review: [1], highlight: { ply: 7, kind: 'resilience' }, provisional: 0 });
    expect(green.grades).toMatchObject({ best: 3, mistake: 1 });
    expect(green.accuracy).toBeCloseTo((300 + 100 * Math.exp(-30 / ACCURACY_SCALE)) / 4, 9);
    expect(green.phases[0]).toBeLessThan(100); expect(green.phases[2]).toBe(100);
    expect(blue).toMatchObject({ accuracy: 100, bestStreak: 3, review: [], highlight: { ply: 2, kind: 'punish' } });
    expect(blue.achievements).toMatchObject({ punish: 1, resilience: 0 });
    // A provisional opponent mistake makes the punish provisional too; an unanalysed game has no score.
    const loose = [at(1, 1, [{ ...candidate(1, -0.3), status: 'estimated' }, candidate(2, 0.3)]), best(2, -1, 0.3)];
    expect(moveAchievements(loose)[1]).toEqual([{ kind: 'punish', provisional: true }]);
    expect(gameReport({ moves: [null, null] }, 1)).toMatchObject({ accuracy: null, moves: 0, highlight: null });
  });
});
