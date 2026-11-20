import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { PASS, initial, apply, moveType, type Player } from '@gyeol/core';
import { decideMove, type CandidateEvaluation, type MoveAnalysis } from '@gyeol/ai';
import { MoveReview, moveReason } from '../src/components/MoveReview';
import { MoveTypeBadge } from '../src/components/MoveTypeBadge';
import { AnalysisGraph } from '../src/components/AnalysisGraph';
import { GameReport } from '../src/components/GameReport';
import { resolveMoveType, type TypedMove } from '../src/lib/move-types';
import { accuracyTrend } from '../src/lib/accuracy-history';

const move = (values: number[], status: 'estimated' | 'stable' | 'exact' = 'estimated', ply = 1, player: 1 | -1 = -1): MoveAnalysis => {
  const candidates: CandidateEvaluation[] = values.map((value, action) => ({ action, value, status, simulations: status === 'stable' ? 96 : 0, pv: [action], ...(status === 'stable' ? { drift: 0 } : {}) }));
  return { ply, player, played: 0, candidates, ...decideMove(candidates, 0, PASS) };
};
const typed = (player: 1 | -1, type: TypedMove['type'], threatAfter = 0, cause: TypedMove['cause'] = type ? 'tiles' : null): TypedMove => ({ player, type, flips: 0, threatBefore: 0, threatAfter, cause });

test('each move shows one of three types, or nothing, and never an evaluation number', () => {
  expect(renderToStaticMarkup(createElement(MoveTypeBadge, { type: null }))).toBe('');
  for (const [type, name] of [['attack', '공격'], ['defense', '방어'], ['best', '최선 수'], ['gift', '내준 수']] as const) {
    const badge = renderToStaticMarkup(createElement(MoveTypeBadge, { type }));
    expect(badge).toContain(`type-${type}`); expect(badge).toContain(name); expect(badge).toContain(`data-type-icon="${type}"`);
    const card = renderToStaticMarkup(createElement(MoveReview, { move: move([-0.8, 0.8]), type, onLine: () => {} }));
    expect(card).toContain(`type-${type}`); expect(card).toContain('data-type-reason');
    expect(card).not.toMatch(/\d+(\.\d+)?점/); expect(card).not.toContain('손실'); expect(card).not.toContain('추정'); expect(card).not.toContain('%');
    expect(card).not.toContain('move-comparison'); expect(card).not.toContain('grade-blunder');
    expect(card.indexOf('추천 수 보기')).toBeLessThan(card.indexOf('실제 수 보기'));
  }
  // A move of no type keeps the card to the move number and the two buttons.
  const plain = renderToStaticMarkup(createElement(MoveReview, { move: move([0.1, 0.1]), type: null, onLine: () => {} }));
  expect(plain).not.toContain('move-grade'); expect(plain).not.toContain('grade-reason'); expect(plain).toContain('추천 수 보기');
});

test('solved moves add the outcome as a fact beside the type', () => {
  const decision = move([-1, 1], 'exact');
  expect(moveReason(decision)).toBe('이길 수 있었지만 패배하는 수입니다.');
  const card = renderToStaticMarkup(createElement(MoveReview, { move: decision, type: 'gift', onLine: () => {} }));
  expect(card).toContain('결과 확인'); expect(card).toContain('패배'); expect(card).toContain('승리'); expect(card).toContain('type-gift');
  expect(card).not.toContain('100.0');
  expect(moveReason(move([-1, -1], 'exact'))).toContain('최선으로 두어도 패배');
});

test('a forced pass has no type and offers no recommendation', () => {
  const candidates: CandidateEvaluation[] = [{ action: PASS, value: -0.4, status: 'estimated', simulations: 0, pv: [PASS] }];
  const decision = { ply: 1, player: 1 as const, played: PASS, candidates, ...decideMove(candidates, PASS, PASS) };
  const html = renderToStaticMarkup(createElement(MoveReview, { move: decision, type: null, onLine: () => {} }));
  expect(html).toContain('강제 패스'); expect(html).toContain('차례를 넘깁니다');
  expect(html).not.toContain('move-comparison'); expect(html).not.toContain('추천 수 보기'); expect(html).not.toContain('move-grade');
});

test('the graph marks attacks, defenses and gifts, separates the two sides and has no value scale', () => {
  const positions = [0.5, 0.6, 0.4, 0.5, 0.5].map(green => ({ green, status: 'estimated' as const }));
  const marks = [typed(1, 'attack'), typed(-1, 'gift'), typed(1, 'defense'), typed(-1, null)];
  const html = renderToStaticMarkup(createElement(AnalysisGraph, { analysis: { positions, marks }, at: 1, perspective: 1, jump: () => {} }));
  expect(html).toMatch(/data-type="attack" data-side="own"[^>]*>!<title>[^<]*· 공격<\/title>/);
  expect(html).toMatch(/data-type="gift" data-side="opponent"[^>]*>\?<title>[^<]*· 내준 수<\/title>/);
  expect((html.match(/data-type="defense" data-side="own"/g) ?? []).length).toBe(1); expect((html.match(/grade-event/g) ?? []).length).toBe(3);
  // The opponent's mark sits below the curve, the viewer's above it; switching the viewed color swaps them.
  const yOf = (markup: string, type: string) => Number(new RegExp(`y="([\\d.]+)"[^>]*data-type="${type}"`).exec(markup)![1]);
  const lineY = (green: number) => 12 + (1 - green) * 123;
  expect(yOf(html, 'attack')).toBeLessThan(lineY(0.6)); expect(yOf(html, 'gift')).toBeGreaterThan(lineY(0.4));
  const flipped = renderToStaticMarkup(createElement(AnalysisGraph, { analysis: { positions, marks }, at: 1, perspective: -1, jump: () => {} }));
  expect(flipped).toContain('data-type="attack" data-side="opponent"'); expect(flipped).toContain('data-type="gift" data-side="own"');
  expect(html).not.toMatch(/>(50|100)<\/text>/); expect(html).not.toContain('~'); expect(html).not.toContain('◇');
});

test('the game report shows accuracy and the three type counts, one per line, and nothing below', () => {
  const moves = [move([-0.3, 0.3], 'stable', 1, 1), move([0.3, 0.28], 'stable', 2, -1), move([0.1, 0.1], 'stable', 3, 1)];
  const types = [typed(1, 'gift', 2), typed(-1, 'attack'), typed(1, 'gift', 3), typed(-1, 'defense'), typed(1, 'gift', 0, 'outcome'), typed(-1, 'best', 0, 'analysis'), typed(1, 'best', 0, 'analysis')];
  const html = renderToStaticMarkup(createElement(GameReport, { analysis: { moves }, typed: types, me: 1 }));
  expect(html.indexOf('data-side="1"')).toBeLessThan(html.indexOf('data-side="-1"'));
  expect(html).toContain('<span class="report-score" data-accuracy="true">100</span>');
  const count = (side: string, type: string) => new RegExp(`data-type-count="${type}">.*?<span class="report-count">(\\d+)</span></li>`).exec(side)![1];
  const [, mine, theirs] = html.split('data-side=');
  expect([count(mine, 'attack'), count(mine, 'defense'), count(mine, 'best'), count(mine, 'gift')]).toEqual(['0', '0', '1', '3']);
  expect([count(theirs, 'attack'), count(theirs, 'defense'), count(theirs, 'best'), count(theirs, 'gift')]).toEqual(['1', '1', '1', '0']);
  // Each type is its own line, in the order attack, defense, best, gift, and the list closes the side.
  expect((mine.match(/<li class="report-type"/g) ?? []).length).toBe(4);
  expect(mine.indexOf('"attack"')).toBeLessThan(mine.indexOf('"defense"')); expect(mine.indexOf('"defense"')).toBeLessThan(mine.indexOf('"best"')); expect(mine.indexOf('"best"')).toBeLessThan(mine.indexOf('"gift"'));
  expect(mine).toMatch(/<\/ul><\/div><div class="report-side" $/); expect(theirs).toMatch(/<\/ul><\/div><\/div><\/section>$/);
  for (const gone of ['돌아볼 수', '개인 최고', '최근', 'report-trend', 'report-review', '묘수', '응징', '손실', '추정']) expect(html).not.toContain(gone);
  // Types are shown even before the AI analysis exists; only the accuracy waits.
  const early = renderToStaticMarkup(createElement(GameReport, { analysis: null, typed: types, me: null }));
  expect(early).toContain('data-type-count="gift"'); expect(early).not.toContain('report-score');
  expect(renderToStaticMarkup(createElement(GameReport, { analysis: null, typed: [], me: 1 }))).toBe('');
});

test('a move that flips many tiles but turns a solved win into a loss is a gift, not an attack', () => {
  // Move 20 of a real online game: brown flips five tiles while the opponent can take back only one,
  // yet the graph proves brown was winning before the move and losing after it.
  const moves = [394, 264, 397, 502, 506, 621, 151, 143, 169, 275, 527, 631, 611, 607, 259, 312, 513, 536, 576];
  let board = initial(), player: Player = 1;
  for (const action of moves) { board = apply(board, player, action).board; player = -player as Player; }
  const tiles = moveType(board, player, 596);
  expect(player).toBe(-1); expect(tiles).toMatchObject({ type: 'attack', flips: 5, threatAfter: 1 });
  const before = { status: 'exact', provenOutcome: -1 }, after = { status: 'exact', provenOutcome: 1 };
  expect(resolveMoveType(tiles, player, before, after)).toMatchObject({ type: 'gift', cause: 'outcome', flips: 5 });
  // An attack is shown only when the mover is favored after the move. Brown (-1) is favored when green < 0.5.
  expect(resolveMoveType(tiles, player, { status: 'estimated', green: 0.5 }, { status: 'estimated', green: 0.3 })).toMatchObject({ type: 'attack', cause: 'tiles', flips: 5 });
  expect(resolveMoveType(tiles, player, { status: 'estimated', green: 0.5 }, { status: 'estimated', green: 0.7 })).toMatchObject({ type: null, cause: null, flips: 5 });
  expect(resolveMoveType(tiles, player, null, { status: 'estimated', green: 0.5 })).toMatchObject({ type: null });
  expect(resolveMoveType({ ...tiles }, 1, null, { status: 'estimated', green: 0.7 })).toMatchObject({ type: 'attack' });
  // With nothing known yet, no attack is shown.
  expect(resolveMoveType(tiles, player, null, null)).toMatchObject({ type: null, cause: null });
  // A solved result decides over the estimate: a win keeps the attack, a draw or loss removes it.
  expect(resolveMoveType(tiles, player, before, { ...before, green: 0.9 })).toMatchObject({ type: 'attack', cause: 'tiles' });
  expect(resolveMoveType(tiles, player, after, { ...after, green: 0.1 })).toMatchObject({ type: null, cause: null });
  expect(resolveMoveType(tiles, player, null, { status: 'exact', provenOutcome: 0 })).toMatchObject({ type: null });
  // Without a graph point, the move analysis of the played move decides.
  expect(resolveMoveType(tiles, -1, null, null, move([0.4, 0.6]))).toMatchObject({ type: 'attack', cause: 'tiles' });
  expect(resolveMoveType(tiles, -1, null, null, move([-0.4, 0.6]))).toMatchObject({ type: null });
  // A move that is not an attack, defense or gift but matches the AI's best move is a best move (★).
  const best = { ...move([0.2, 0.6]), played: 1 };
  expect(best.bestActions).toContain(1);
  expect(resolveMoveType({ ...tiles, type: null }, -1, null, null, best)).toMatchObject({ type: 'best', cause: 'analysis' });
  // Giving the opponent a bigger flip on the tiles alone is not a gift; only a worse result is.
  expect(resolveMoveType({ ...tiles, type: 'gift' }, -1, null, null, best)).toMatchObject({ type: 'best', cause: 'analysis' });
  expect(resolveMoveType({ ...tiles, type: 'gift' }, -1, null, null, move([0.2, 0.6]))).toMatchObject({ type: null, cause: null });
  expect(resolveMoveType({ ...tiles, type: 'gift' }, -1, before, before)).toMatchObject({ type: null, cause: null });
  expect(resolveMoveType({ ...tiles, type: 'gift' }, -1, before, after)).toMatchObject({ type: 'gift', cause: 'outcome' });
  expect(resolveMoveType({ ...tiles, type: 'defense' }, -1, null, null, best)).toMatchObject({ type: 'defense', cause: 'tiles' });
  expect(resolveMoveType(tiles, -1, null, { status: 'estimated', green: 0.3 }, best)).toMatchObject({ type: 'attack', cause: 'tiles' });
  // An attack dropped for not being favorable can still be the best move.
  expect(resolveMoveType(tiles, -1, null, { status: 'estimated', green: 0.7 }, best)).toMatchObject({ type: 'best' });
  // Not the best move, or a forced move, is not.
  expect(resolveMoveType({ ...tiles, type: null }, -1, null, null, move([0.2, 0.6]))).toMatchObject({ type: null });
  expect(resolveMoveType({ ...tiles, type: null }, -1, null, null, { ...best, forced: true })).toMatchObject({ type: null });
  // Defense does not depend on the result.
  expect(resolveMoveType({ ...tiles, type: 'defense' }, player, null, null)).toMatchObject({ type: 'defense', cause: 'tiles' });
  expect(resolveMoveType({ ...tiles, type: null }, player, null, null)).toMatchObject({ type: null, cause: null });
  // A solved move decision that lost the result also counts, even without graph proof.
  const lost = move([-1, 1], 'exact');
  expect(resolveMoveType(tiles, -1, null, null, lost)).toMatchObject({ type: 'gift', cause: 'outcome' });
  // The card explains the result instead of the tile reason.
  const card = renderToStaticMarkup(createElement(MoveReview, { move: lost, type: 'gift', byOutcome: true, onLine: () => {} }));
  expect(card).toContain('결과가 나빠집니다'); expect(card).not.toContain('더 크게 뒤집을 수 있게');
});

test('the accuracy trend compares only with earlier games, at most the last ten', () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, date: i + 1, accuracy: 60 + i }));
  expect(accuracyTrend(entries, { id: 'g0', date: 1, accuracy: 60 })).toBeNull();
  expect(accuracyTrend(entries, { id: 'g11', date: 12, accuracy: 71 })).toEqual({ delta: 5, count: 10, personalBest: true });
  expect(accuracyTrend(entries, { id: 'new', date: 13, accuracy: 62 })).toEqual({ delta: -5, count: 10, personalBest: false });
});
