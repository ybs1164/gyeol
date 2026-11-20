import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ExactEndgame, canonical, legal, type Board, type Player } from '@gyeol/core';
import { labelPosition, type Predict } from '../src';

interface Frozen { board: Board; player: Player; remaining: number; outcome: number; margin: number | null }
const frozen = readFileSync(new URL('../../../tools/learning/frozen/exact-test-v1.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l) as Frozen);
// 균등 사전확률, 가치 0.1: 탐색 단계의 형식만 본다
const uniform: Predict = async board => ({ priors: legal(board, 1).map(() => 1), value: 0.1 });
const pick = (r: number, n: number) => frozen.filter(x => x.remaining === r).slice(0, n);
const policySum = (p: [number, number][]) => p.reduce((s, [, v]) => s + v, 0);

describe('학습 라벨', () => {
  test('정확 단계: 차이·승패가 얼린 정답과 같고, 정책은 values()로 구한 최선 수 집합과 같다', async () => {
    for (const x of [...pick(4, 6), ...pick(5, 6), ...pick(6, 4)]) {
      const label = await labelPosition(x.board, x.player, uniform, { model: 'test', sims: 4 });
      expect(label.tier).toBe('exact');
      // 얼린 세트는 초록 기준, 라벨은 둘 차례 기준
      expect(label.margin).toBe(x.margin! * x.player);
      expect(label.value).toBe(x.outcome * x.player);
      const values = new ExactEndgame(50_000_000).values(canonical(x.board, x.player), 1);
      const best = Math.max(...values.map(([, v]) => v));
      expect(label.policy.map(([a]) => a)).toEqual(values.filter(([, v]) => v === best).map(([a]) => a).sort((a, b) => a - b));
      expect(policySum(label.policy)).toBeCloseTo(1, 4);
      expect(label.search).toBeNull();
    }
  }, 120_000);

  test('증명 단계: 승패는 정확하고 정책은 탐색 방문 분포다. 7장 이하는 차이도 정확하다', async () => {
    for (const x of [...pick(7, 3), ...pick(8, 3)]) {
      const label = await labelPosition(x.board, x.player, uniform, { model: 'test', sims: 32 });
      expect(label.tier).toBe('proven');
      expect(label.value).toBe(x.outcome * x.player);
      if (x.remaining <= 7) expect(label.margin).toBe(x.margin! * x.player); else expect(label.margin).toBeNull();
      expect(policySum(label.policy)).toBeCloseTo(1, 4);
      const moves = legal(label.board, 1);
      expect(label.policy.every(([a]) => moves.includes(a))).toBe(true);
      expect(label.search).toMatchObject({ sims: 32, model: 'test' });
    }
  }, 120_000);

  test('탐색 단계와, 정확 탐색이 한도를 넘으면 다음 단계로 내려간다', async () => {
    const early = await labelPosition(frozen[0].board, frozen[0].player, uniform, { model: 'm1', sims: 16, exactMaxRemaining: 0, provenMaxRemaining: 0 });
    expect(early.tier).toBe('search');
    expect(early.margin).toBeNull();
    expect(early.value).toBe(early.search!.q);
    expect(policySum(early.policy)).toBeCloseTo(1, 4);
    const x = pick(6, 1)[0];
    const capped = await labelPosition(x.board, x.player, uniform, { model: 'm1', sims: 16, nodeLimit: 50 });
    expect(capped.tier).toBe('search');
  });

  test('보드는 둘 차례 기준이고 같은 입력이면 같은 라벨이다', async () => {
    const x = pick(9, 1)[0];
    const a = await labelPosition(x.board, x.player, uniform, { model: 'm', sims: 24 });
    const b = await labelPosition(x.board, x.player, uniform, { model: 'm', sims: 24 });
    expect(a).toEqual(b);
    expect(a.board).toEqual(canonical(x.board, x.player));
  });

  test('종국 국면(25장)은 라벨을 만들지 않는다', async () => {
    const end = Array(49).fill(0);
    for (let r = 1; r <= 5; r++) for (let c = 1; c <= 5; c++) end[r * 7 + c] = (r + c) % 2 ? 1 : -2;
    await expect(labelPosition(end, 1, uniform, { model: 'm' })).rejects.toThrow('Terminal');
  });
});
