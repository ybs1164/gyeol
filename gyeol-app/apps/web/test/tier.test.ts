import { expect, test } from 'vitest';
import { tierOf } from '../src/lib/tier';

test('새 사람은 배치 중이고 추정 실력이 정해진 AI는 대전 전적 없이도 티어를 표시한다', () => {
  expect(tierOf(1500, 0)).toBe('place');
  expect(tierOf(1500, 0, true)).toBe('gold');
  expect(tierOf(1900, 0, true)).toBe('master');
});
