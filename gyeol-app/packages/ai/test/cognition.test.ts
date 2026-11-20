import { describe, expect, test, vi } from 'vitest';
import { initial, legal, apply, PASS, TOTAL_TILES, type Board } from '@gyeol/core';
import { cognitiveMove, cognitiveProfile, cognitiveTimeBudget, createCognitiveRoster, type Predict } from '../src';

const fake: Predict = async b => ({ value: 0, priors: legal(b, 1).map(() => 1) });
describe('시간 기반 AI', () => {
  test('1,000개 프로필의 지연·속도가 연속적으로 분포하고 양 끝의 범위를 유지한다', () => {
    const roster = createCognitiveRoster(Array.from({ length: 1000 }, (_, i) => ({ id: `bot-${i}`, name: `봇${i}` })));
    expect(new Set(roster.map(p => JSON.stringify(p.cognition))).size).toBe(1000);
    expect(roster[0].cognition.startMs).toEqual([2400, 5500, 9000]);
    expect(roster.at(-1)!.cognition.startMs).toEqual([250, 550, 1000]);
    for (let i = 1; i < roster.length; i++) {
      expect(roster[i].cognition.startMs[0]).toBeLessThan(roster[i - 1].cognition.startMs[0]);
      expect(roster[i].cognition.workRate).toBeGreaterThan(roster[i - 1].cognition.workRate);
    }
  });
  test('신경망 공개 전에는 모델을 호출하지 않고 결과가 모델 내용에 의존하지 않는다', async () => {
    const hidden = vi.fn(fake), other = vi.fn(async (b: Board) => ({ value: 1, priors: legal(b, 1).map((_, i) => i + 1) }));
    const opts = { budgetMs: 500, leftMs: 180000 };
    const a = await cognitiveMove(initial(), cognitiveProfile(0.5), hidden, opts);
    const b = await cognitiveMove(initial(), cognitiveProfile(0.5), other, opts);
    expect(a).toEqual(b); expect(hidden).not.toHaveBeenCalled(); expect(other).not.toHaveBeenCalled();
    expect(a.elapsedMs).toBeLessThanOrEqual(500);
  });
  test('같은 국면과 예산의 착수가 재현되고 공개된 사고 시간은 단조 증가한다', async () => {
    let board = initial();
    for (let ply = 0; ply < 8; ply++) board = apply(board, 1, legal(board, 1)[ply % legal(board, 1).length]).board.map(x => -x);
    const checkpoints: number[] = [];
    const profile = cognitiveProfile(1);
    const a = await cognitiveMove(board, profile, fake, { budgetMs: 4000,
      checkpoint: async d => { checkpoints.push(d.elapsedMs); } });
    const b = await cognitiveMove(board, profile, fake, { budgetMs: 4000 });
    expect(a).toEqual(b); expect(legal(board, 1)).toContain(a.action);
    expect(a.stage).not.toBe('A');
    expect(checkpoints).toEqual([...checkpoints].sort((x, y) => x - y));
    expect(a.elapsedMs).toBeLessThanOrEqual(4000);
  });
  test('거의 소진된 시계와 이미 지난 계산 마감에서도 합법 기본 후보를 반환한다', async () => {
    const hidden = vi.fn(fake);
    for (const leftMs of [0, 1, 50]) {
      const d = await cognitiveMove(initial(), cognitiveProfile(1), hidden, { leftMs, deadline: 0 });
      expect(legal(initial(), 1)).toContain(d.action);
      expect(d.elapsedMs).toBeLessThanOrEqual(leftMs);
    }
    expect(hidden).not.toHaveBeenCalled();
    expect(cognitiveTimeBudget(initial(), 'bullet', 1).hardMs).toBe(0.75);
  });
  test('강제 패스는 깊은 모델 판단을 실행하지 않는다', async () => {
    const board = Array.from({ length: 49 }, (_, i) => i < TOTAL_TILES ? 1 : 0);
    const hidden = vi.fn(fake);
    const d = await cognitiveMove(board, cognitiveProfile(1), hidden);
    expect(d.action).toBe(PASS); expect(d.reason).toBe('forced'); expect(hidden).not.toHaveBeenCalled();
  });
});
