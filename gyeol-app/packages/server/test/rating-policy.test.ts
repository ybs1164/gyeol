import { expect, test } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type PlayerRecord, type GameRecord } from '../src/legacy-store';
import { DEFAULT_RATING, withInactivity } from '../src/glicko';
import { ratingRestriction, REPEAT_WINDOW_MS } from '../src/rating-policy';

test('휴면 RD는 경과 일수만 반영하고 조회로 누적하거나 350을 초과하지 않는다', () => {
  const now = 500 * 86_400_000;
  const p = { rating: 1800, rd: 40, vol: 0.06 };
  const aged = withInactivity(p, now - 365 * 86_400_000, now);
  expect(aged.rd).toBeCloseTo(Math.sqrt(40 ** 2 + 365 * (173.7178 * .06) ** 2));
  expect(withInactivity(p, now, now).rd).toBe(40);
  expect(withInactivity(p, now + 100, now).rd).toBe(40);
  expect(withInactivity(p, 0, 10000 * 86_400_000).rd).toBe(350);
  expect(p.rd).toBe(40);
});

test('반복 제한은 색·시간 모드를 넘어서 적용되고 24시간 후 풀린다', () => {
  const now = 100 * 86_400_000;
  const g = { id: 'current', greenId: 'a', brownId: 'b', ranked: true, status: 'finished', endReason: 'normal', moves: Array(20).fill(0), updatedAt: now } as GameRecord;
  const games = [
    { ...g, id: '1', mode: 'bullet', updatedAt: now - 1000 },
    { ...g, id: '2', mode: 'daily', greenId: 'b', brownId: 'a', updatedAt: now - 500 },
    g,
  ] as GameRecord[];
  expect(ratingRestriction(g, games, true, now)).toBe('repeat');
  expect(ratingRestriction(g, games, true, now + REPEAT_WINDOW_MS + 1)).toBeUndefined();
  expect(ratingRestriction(g, games, false, now)).toBeUndefined(); // AI는 고정 기준점
  expect(ratingRestriction({ ...g, endReason: 'timeout', moves: [] }, [], true, now)).toBe('early');
});

test('기존 파일의 점수·계정은 보존하고 잘린 기록을 전체 이력으로 오인하지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gyeol-rating-migration-'));
  const file = join(dir, 'db.json');
  const base: PlayerRecord = { id: 'a', token: 'secret', name: 'test', ...DEFAULT_RATING,
    ranked: 301, wins: 151, losses: 150, createdAt: 1, seenAt: 999,
    history: Array.from({ length: 300 }, (_, i) => ({ at: 10 + i, rating: i === 0 ? 2000 : 1700 })) };
  writeFileSync(file, JSON.stringify({ version: 1, players: { a: base }, games: {} }));
  const store = new Store(file);
  expect(JSON.parse(readFileSync(`${file}.before-rating-v2.bak`, 'utf8')).players.a).toEqual(base);
  const p = store.playerByToken('secret')!;
  expect(p.id).toBe('a');
  expect(p.rating).toBe(base.rating);
  expect(p.rated).toBe(301);
  expect(p.history).toHaveLength(300);
  expect(p.historyComplete).toBe(false);
  expect(p.ratingAt).toBe(309);
  expect(p.peakRating).toBe(2000);
  store.flush();
  expect(new Store(file).data.players.a).toEqual(p);
  expect(JSON.parse(readFileSync(`${file}.before-rating-v2.bak`, 'utf8')).players.a).toEqual(base);
});

test('이력이 완전한 기존 계정은 실제 시작점 하나를 추가하고 재시작해도 중복하지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gyeol-rating-origin-'));
  const file = join(dir, 'db.json');
  const base: PlayerRecord = { id: 'a', token: 't', name: 'a', ...DEFAULT_RATING, rating: 1662,
    ranked: 1, wins: 1, losses: 0, createdAt: 1, seenAt: 20, history: [{ at: 10, rating: 1662 }] };
  writeFileSync(file, JSON.stringify({ version: 1, players: { a: base }, games: {} }));
  const store = new Store(file);
  expect(store.data.players.a.historyComplete).toBe(true);
  expect(store.data.players.a.history).toEqual([{ at: 1, rating: 1500 }, { at: 10, rating: 1662 }]);
  store.flush();
  expect(new Store(file).data.players.a.history).toHaveLength(2);
});
