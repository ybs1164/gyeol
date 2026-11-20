import { expect, test } from 'vitest';
import { ratingWindow, weekDelta } from '../src/lib/rating-history';

const day = 86_400_000;
const now = 100 * day;

test('잘린 300개 기록만으로 주간 변화를 추정하지 않는다', () => {
  const points = Array.from({ length: 300 }, (_, i) => ({ at: now - day + i, rating: 1800 }));
  expect(weekDelta(points, 1800, false, now)).toBeNull();
  expect(ratingWindow(points, 7, now).every((p) => p.rating === 1800)).toBe(true);
  expect(ratingWindow(points, 7, now)[0].at).toBe(points[0].at);
});

test('새 계정은 실제 시작값에서, 오래된 계정은 기간 직전 기록에서 변화를 계산한다', () => {
  expect(weekDelta([{ at: now - day, rating: 1500 }, { at: now, rating: 1600 }], 1600, true, now)).toBe(100);
  const points = [{ at: now - 8 * day, rating: 1700 }, { at: now - day, rating: 1800 }];
  expect(weekDelta(points, 1800, false, now)).toBe(100);
  expect(ratingWindow(points, 7, now)).toEqual([
    { at: now - 7 * day, rating: 1700 }, { at: now - day, rating: 1800 }, { at: now, rating: 1800 },
  ]);
});

test('대국이 없는 기간은 마지막 점수로 이어지고 기록이 없으면 값을 만들지 않는다', () => {
  expect(ratingWindow([{ at: now - 20 * day, rating: 1650 }], 7, now)).toEqual([
    { at: now - 7 * day, rating: 1650 }, { at: now, rating: 1650 },
  ]);
  expect(ratingWindow([], 30, now)).toEqual([]);
  expect(weekDelta([], 1500, false, now)).toBeNull();
});
