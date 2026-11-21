import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  LESSONS, PASS, apply, correctMoves, puzzleValues, ratedBank, dailyPuzzle, dateKey, decode, legal, loadPuzzleBank, puzzleNumber, result,
  type PuzzleBankFile,
} from '../src';

loadPuzzleBank(JSON.parse(readFileSync(new URL('./puzzle-bank.fixture.json', import.meta.url), 'utf8')) as PuzzleBankFile);

describe('오늘의 퍼즐', () => {
  test('daily puzzles use only the server bank and cycle without repeats', () => {
    expect(puzzleNumber('2026-11-10')).toBe(1);
    expect(puzzleNumber('2027-11-10')).toBe(366);
    expect(dateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    const seen = new Set<string>();
    const start = new Date(2026, 10, 10);
    for (let i = 0; i < ratedBank().length; i++) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const p = dailyPuzzle(dateKey(d));
      expect(dailyPuzzle(dateKey(d))).toEqual(p);
      expect(p.id.startsWith('rp-')).toBe(true);
      expect(result(p.board, p.player)).toBe(0);
      expect(correctMoves(p.kind, puzzleValues(p, p.board, p.player)).length).toBeGreaterThan(0);
      seen.add(p.id);
    }
    expect(seen.size).toBe(ratedBank().length);
    const first = dailyPuzzle('2026-11-12');
    expect(dailyPuzzle('2026-11-13', first.id).id).toBe(first.id);
  });
});

describe('튜토리얼', () => {
  const byId = Object.fromEntries(LESSONS.map((l) => [l.id, l]));
  const outcomes = (id: string) => {
    const l = byId[id];
    return legal(l.board, l.player).map((a) => l.check!(a, apply(l.board, l.player, a).last).ok);
  };

  test('모든 연습 판에서 성공과 실패가 모두 가능하다(정답이 있는 단계)', () => {
    for (const id of ['capture', 'loop']) {
      const o = outcomes(id);
      expect(o).toContain(true);
      expect(o).toContain(false);
    }
    for (const id of ['turn', 'limit']) expect(outcomes(id).every(Boolean)).toBe(true);
  });

  test('패스 단계는 초록이 둘 수 없고 게임이 끝나지 않은 상태', () => {
    const l = byId.pass;
    expect(legal(l.board, 1)).toEqual([PASS]);
    expect(result(l.board, 1)).toBe(0);
  });

  test('5칸 제한 단계는 줄 양 끝에 놓을 수 없다', () => {
    const l = byId.limit;
    const moves = legal(l.board, 1);
    expect(moves.length).toBeGreaterThan(0);
    // 모든 수는 줄의 위/아래로만 놓인다
    for (const a of moves) {
      const m = decode(a)!;
      expect(m.pr).not.toBe(m.r);
    }
  });
});
