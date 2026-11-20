import { expect, test } from 'vitest';
import { PUZZLE_SCALE } from '@gyeol/core';
import ratings from '../src/bot-ratings.json';

test('퍼즐 단계의 기준점은 현재 AI 보정 결과와 일치한다', () => {
  const anchors = ratings.activeProfileIds.map((id) => ratings.profiles.find((p) => p.id === id)!.rating);
  expect(PUZZLE_SCALE.stageFloors).toEqual(anchors);
  expect(PUZZLE_SCALE.aiMin).toBe(ratings.bots[0].rating);
  expect(PUZZLE_SCALE.aiMax).toBe(ratings.bots.at(-1)!.rating);
  expect(PUZZLE_SCALE.sourceCalibratedAt).toBe(ratings.calibratedAt);
});
