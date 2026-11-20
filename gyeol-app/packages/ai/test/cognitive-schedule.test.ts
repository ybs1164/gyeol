import { expect, test } from 'vitest';
import { initial, isLegal, apply } from '@gyeol/core';
import { cognitiveSchedule } from '../../../tools/cognitive-batch-lib';

test('배치는 모든 AI에 같은 수의 선후공과 별도 검증 대국을 배정한다', () => {
  const schedule = cognitiveSchedule(1000, 2, 1);
  expect(schedule).toHaveLength(3000);
  const counts = Array.from({ length: 1000 }, () => ({ train: [0, 0], validation: [0, 0] }));
  for (let i = 0; i < schedule.length; i += 2) {
    const [a, b] = [schedule[i], schedule[i + 1]];
    expect(a.green).toBe(b.brown); expect(a.brown).toBe(b.green); expect(a.opening).toEqual(b.opening);
    let board = initial(), player: 1 | -1 = 1;
    for (const action of a.opening) {
      expect(isLegal(board, player, action)).toBe(true);
      board = apply(board, player, action).board; player = -player as 1 | -1;
    }
  }
  for (const g of schedule) { counts[g.green][g.split][0]++; counts[g.brown][g.split][1]++; }
  expect(counts.every(c => c.train[0] === 2 && c.train[1] === 2 && c.validation[0] === 1 && c.validation[1] === 1)).toBe(true);
  expect(cognitiveSchedule(1000, 2, 1)).toEqual(schedule);
});

test('검증 모드마다 충분한 넓은 실력 구간 대진이 있고 기본 대국과 시작 조건이 겹치지 않는다', () => {
  const schedule = cognitiveSchedule(1000, 1, 10);
  const keys = new Set<string>();
  for (let i = 0; i < schedule.length; i += 2) {
    const g = schedule[i], key = `${g.mode}:${Math.min(g.green, g.brown)}:${Math.max(g.green, g.brown)}:${g.opening.join(',')}`;
    expect(keys.has(key)).toBe(false); keys.add(key);
  }
  for (const mode of ['bullet', 'blitz', 'rapid']) expect(schedule.filter(g =>
    g.split === 'validation' && g.mode === mode && Math.abs(g.green - g.brown) >= 150).length).toBeGreaterThanOrEqual(100);
});
