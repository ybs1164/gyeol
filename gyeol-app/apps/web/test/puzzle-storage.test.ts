import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PUZZLE_SCALE, migratePuzzleRating, ratedBank } from '@gyeol/core';
import { puzzleLog, puzzleRating } from '../src/lib/storage';

let saved: Map<string, string>;
beforeEach(() => {
  saved = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

test('기존 점수·최고점·그래프는 한 번만 변환하고 전적·푼 ID·진행 중 문제는 보존한다', () => {
  const old = { rating: 1150, peak: 1650, history: [600, 900, 1150], played: 20, solved: 12, streak: 2, bestStreak: 5, seen: ['f12', 'r2'], current: 'e3' };
  saved.set('gyeol:puzzle-rating', JSON.stringify(old));
  const next = puzzleRating.get();
  expect(next.rating).toBe(1483);
  expect(next.peak).toBe(1753);
  expect(next.history).toEqual(old.history.map(migratePuzzleRating));
  expect(next.played).toBe(20);
  expect(next.solved).toBe(12);
  expect(next.seen).toEqual(old.seen);
  expect(next.current).toBeNull();
  expect(next.retiredCurrent).toBe('e3');
  expect(puzzleRating.get()).toEqual(next);
  expect(JSON.parse(saved.get('gyeol:puzzle-rating-v1-backup')!)).toEqual(old);
  expect(puzzleRating.seedFromGame(2200, 30)).toEqual(next);
});

test('새 기록은 배치가 끝난 대국 점수로 한 번만 시작한다', () => {
  expect(puzzleRating.seedFromGame(1500, 0).rating).toBe(PUZZLE_SCALE.start);
  expect(puzzleRating.seedFromGame(1800, 5).rating).toBe(1800);
  expect(puzzleRating.seedFromGame(2200, 30).rating).toBe(1800);
  expect(puzzleRating.get().played).toBe(0);
});

test('풀던 문제가 있으면 첫 시작 점수를 중간에 바꾸지 않는다', () => {
  puzzleRating.set({ current: ratedBank()[0].id });
  expect(puzzleRating.seedFromGame(2200, 30).rating).toBe(PUZZLE_SCALE.start);
});

test('같은 문제의 두 번째 풀이로 점수·전적을 중복 올릴 수 없다', () => {
  const first = puzzleRating.record(ratedBank()[0].id, true, 20);
  const replay = puzzleRating.record(ratedBank()[0].id, true, 999);
  expect(replay).toEqual(first);
  expect(replay.played).toBe(1);
  expect(replay.solved).toBe(1);
});

test('이전 장수 목표는 퇴역시키되 이미 변환한 점수·전적은 다시 바꾸지 않는다', () => {
  const old = { scaleVersion: 2, bankVersion: 2, rating: 1700, peak: 1800, history: [1600, 1700], played: 10, solved: 8, current: 'f123', seen: ['f12'] };
  saved.set('gyeol:puzzle-rating', JSON.stringify(old));
  const next = puzzleRating.get();
  expect(next.rating).toBe(1700);
  expect(next.history).toEqual(old.history);
  expect(next.played).toBe(10);
  expect(next.seen).toEqual(old.seen);
  expect(next.current).toBeNull();
  expect(next.retiredCurrent).toBe('f123');
  expect(next.bankVersion).toBe(3);
  expect(JSON.parse(saved.get('gyeol:puzzle-rating-v2-bank-backup')!)).toEqual(old);
  expect(puzzleRating.get()).toEqual(next);
});

test('오늘의 새 승리 문제를 이전 장수 풀이와 혼동하지 않고 과거 연속 기록은 보존한다', () => {
  const legacy = { '2026-11-12': { attempts: [2, 3], solved: true } };
  saved.set('gyeol:puzzles', JSON.stringify(legacy));
  expect(puzzleLog.get('2026-11-12').solved).toBe(false);
  expect(puzzleLog.all()['2026-11-12'].solved).toBe(true);
  puzzleLog.set('2026-11-12', { attempts: [0], solved: false, puzzleId: ratedBank()[0].id });
  expect(puzzleLog.get('2026-11-12').attempts).toEqual([0]);
  expect(JSON.parse(saved.get('gyeol:puzzles')!)).toEqual(legacy);
  expect(puzzleLog.all()['2026-11-12'].solved).toBe(true);
});
