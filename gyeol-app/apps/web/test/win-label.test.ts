import { expect, test } from 'vitest';
import { forcedWinLabel, type WinDistancePoint } from '../src/lib/win-label';

test('확정 승리의 수를 관점에 맞춰 표시하고 추정 100%와 종국은 구분한다', () => {
  const point: WinDistancePoint = { status: 'exact', source: 'proven', provenOutcome: 1, forcedWinPlies: 3, winDistanceKind: 'exact' };
  expect(forcedWinLabel(point, 1)).toBe('3수 내 승리');
  expect(forcedWinLabel(point, -1)).toBe('3수 내 패배');
  expect(forcedWinLabel({ ...point, winDistanceKind: 'upper-bound', forcedWinPlies: 5 }, 1)).toBe('5수 내 승리');
  for (const change of [{ status: 'estimated' as const }, { source: 'search' as const }, { source: 'terminal' as const }, { provenOutcome: 0 as const }, { forcedWinPlies: 0 }, { forcedWinPlies: undefined }, { winDistanceKind: undefined }]) {
    expect(forcedWinLabel({ ...point, ...change }, 1)).toBeNull();
  }
});
