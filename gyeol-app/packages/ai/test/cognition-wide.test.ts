import { expect, test, vi } from 'vitest';
import { apply, initial, legal, type Board } from '@gyeol/core';
import { createWideRoster, wideCognitiveMove, wideCognitiveProfile, type Predict } from '../src';

const fake: Predict = async b => ({ value: 0, priors: legal(b, 1).map((_, i) => i === legal(b, 1).length - 1 ? 1 : 0) });
test('넓은 범위의 1,000명은 기존 점수·티어 경계와 연속적인 행동 차이를 갖는다', () => {
  const roster = createWideRoster(Array.from({ length: 1000 }, (_, i) => ({ id: String(i), name: `AI${i}` })));
  expect(roster[0].cognition.targetRating).toBe(974);
  expect(roster.at(-1)!.cognition.targetRating).toBe(2207);
  expect(new Set(roster.map(p => JSON.stringify(p.cognition))).size).toBe(1000);
  expect(['bronze', 'silver', 'gold', 'plat', 'dia', 'master'].map(t => roster.filter(p => p.cognition.targetTier === t).length))
    .toEqual([265, 162, 81, 121, 122, 249]);
});
test('최하위는 실제로 후보 일부만 보고 깊은 모델 판단 없이 착수한다', async () => {
  const predict = vi.fn(fake);
  const d = await wideCognitiveMove(initial(), wideCognitiveProfile(0), predict);
  expect(predict).not.toHaveBeenCalled(); expect(d.stage).toBe('A');
  expect(d.candidates).toBeLessThan(legal(initial(), 1).length);
  expect(d.elapsedMs).toBeLessThanOrEqual(1200); expect(legal(initial(), 1)).toContain(d.action);
});
test('최상위는 초기 국소 후보 밖의 수까지 학습 탐색으로 검토한다', async () => {
  const predict = vi.fn(fake), profile = wideCognitiveProfile(1);
  const board: Board = apply(initial(), 1, legal(initial(), 1)[0]).board.map(x => -x);
  const d = await wideCognitiveMove(board, profile, predict);
  expect(d.stage).toBe('D'); expect(d.simulations).toBeGreaterThan(512);
  expect(d.candidates).toBe(legal(board, 1).length); expect(predict).toHaveBeenCalled();
  expect(d.action).toBe(legal(board, 1).at(-1));
});
test('동일한 입력·시간은 같은 선택이고 시간 부족·취소에는 모델을 새로 호출하지 않는다', async () => {
  const profile = wideCognitiveProfile(.5), predict = vi.fn(fake);
  const a = await wideCognitiveMove(initial(), profile, predict, { budgetMs: 500 });
  const b = await wideCognitiveMove(initial(), profile, predict, { budgetMs: 500 });
  expect(a).toEqual(b); expect(predict).not.toHaveBeenCalled();
  const signal = AbortSignal.abort();
  const c = await wideCognitiveMove(initial(), profile, predict, { leftMs: 1, signal });
  expect(c.elapsedMs).toBeLessThanOrEqual(1); expect(predict).not.toHaveBeenCalled();
});
