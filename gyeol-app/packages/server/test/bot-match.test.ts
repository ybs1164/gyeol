import { describe, expect, test } from 'vitest';
import { selectBot } from '../src/bot-match';

const pool = Array.from({ length: 1000 }, (_, i) => ({ id: `bot-${i}`, rating: 500 + i * 2 }));

describe('1,000명 AI 매칭', () => {
  test('적정 범위에서 고르고 최근 상대는 피한다', () => {
    const recent: string[] = [];
    for (let i = 0; i < 20; i++) {
      const picked = selectBot(pool, 1500, recent, () => 0.5);
      expect(recent).not.toContain(picked);
      expect(Math.abs(pool.find((p) => p.id === picked)!.rating - 1500)).toBeLessThanOrEqual(100);
      recent.push(picked);
    }
  });
  test('범위를 벗어나도 가중치 언더플로로 전체 무작위 매칭이 되지 않는다', () => {
    expect(selectBot(pool, -10000, [], () => 0.5)).toBe(pool[0].id);
    expect(selectBot(pool, 10000, [], () => 0.5)).toBe(pool.at(-1)!.id);
  });
  test('근처 상대가 모두 최근 상대여도 매칭할 수 있다', () => {
    expect(selectBot(pool.slice(0, 2), 500, ['bot-0', 'bot-1'], () => 0)).toBe('bot-0');
  });
});
