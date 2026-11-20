import { describe, expect, test } from 'vitest';
import { initial, legal, rng, type Board } from '@gyeol/core';
import { BOT_COUNT, CALIBRATION_PERSONAS, PERSONAS, createPersonas, personaMove, type Predict } from '../src';

/** 첫 합법 수에 확률을 몰아주는 가짜 모델 */
const peaked: Predict = async (b: Board) => ({ priors: legal(b, 1).map((_, i) => (i === 0 ? 0.9 : 0.1 / 20)), value: 0 });

describe('봇 성격', () => {
  test('id·이름이 겹치지 않고, 약한 순서로 실수가 줄거나 탐색이 늘어난다', () => {
    expect(PERSONAS).toHaveLength(BOT_COUNT);
    expect(BOT_COUNT).toBe(1000);
    expect(new Set(PERSONAS.map((p) => p.id)).size).toBe(PERSONAS.length);
    expect(new Set(PERSONAS.map((p) => p.name)).size).toBe(PERSONAS.length);
    expect(new Set(PERSONAS.map((p) => `${p.mistake}:${p.sims}`)).size).toBe(BOT_COUNT);
    expect(PERSONAS.every((p) => p.name.length <= 12)).toBe(true);
    expect(PERSONAS.find((p) => p.id === 'bot-10')!.name).toBe('한결');
    expect(PERSONAS.at(-1)!.id).toBe('bot-10');
    for (let i = 1; i < PERSONAS.length; i++) {
      const [a, b] = [PERSONAS[i - 1], PERSONAS[i]];
      expect(b.sims > a.sims || (b.sims === a.sims && b.mistake < a.mistake)).toBe(true);
    }
  });

  test('실측 순서의 기준점을 사용하고 양 끝의 실력을 그대로 유지한다', () => {
    const anchors = CALIBRATION_PERSONAS.filter((_, i) => [0, 3, 7, 11].includes(i));
    const roster = createPersonas(anchors);
    expect(roster[0].blend).toEqual({ lower: anchors[0].id, upper: anchors[1].id, weight: 0 });
    expect(roster.at(-1)!.blend).toEqual({ lower: anchors[2].id, upper: anchors[3].id, weight: 1 });
    expect(roster.at(-1)!.sims).toBe(512);
  });

  test('혼합 비율이 실제 착수에 반영되고 모든 수가 합법이다', async () => {
    const board = initial();
    const moves = legal(board, 1);
    const [weak, strong] = [CALIBRATION_PERSONAS[0], CALIBRATION_PERSONAS[5]];
    const random = rng(892);
    const hits = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      for (let i = 0; i < 200; i++) {
        const a = await personaMove(board, {
          id: 'mix', name: 'mix', mistake: 0, sims: 0,
          blend: { lower: weak.id, upper: strong.id, weight: k / 2 },
        }, peaked, random);
        expect(moves).toContain(a);
        if (a === moves[0]) hits[k]++;
      }
    }
    expect(hits[0]).toBeLessThan(10);
    expect(hits[1]).toBeGreaterThan(60);
    expect(hits[1]).toBeLessThan(130);
    expect(hits[2]).toBeGreaterThan(150);
  });

  test('측정된 레이팅 간격이 달라도 개별 AI의 목표 점수 간격을 고르게 만든다', () => {
    const anchors = CALIBRATION_PERSONAS.slice(0, 3);
    const ratings = [500, 600, 1500];
    const roster = createPersonas(anchors, 1000, ratings);
    const interpolated = roster.map((p) => {
      const { lower, upper, weight } = p.blend!;
      const a = anchors.findIndex((p) => p.id === lower);
      const b = anchors.findIndex((p) => p.id === upper);
      return ratings[a] * (1 - weight) + ratings[b] * weight;
    });
    for (let i = 1; i < interpolated.length; i++) expect(interpolated[i] - interpolated[i - 1]).toBeCloseTo(1000 / 999, 8);
    expect(() => createPersonas(anchors, 1000, [600, 500, 1500])).toThrow();
  });

  test('실수 확률 1이면 최선 수를 두지 않고, 0이면 (탐색 없이) 거의 늘 최선 수를 둔다', async () => {
    const board = initial();
    const best = legal(board, 1)[0];
    const random = rng(7);
    for (let i = 0; i < 50; i++) {
      const a = await personaMove(board, { id: 'x', name: 'x', mistake: 1, sims: 0 }, peaked, random);
      expect(a).not.toBe(best);
      expect(legal(board, 1)).toContain(a);
    }
    let hits = 0;
    for (let i = 0; i < 50; i++) if ((await personaMove(board, { id: 'y', name: 'y', mistake: 0, sims: 0 }, peaked, random)) === best) hits++;
    expect(hits).toBeGreaterThan(45);
  });
});
