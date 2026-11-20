import { describe, expect, test } from 'vitest';
import { apply, canonical, initial, legal, result, rng, type Player } from '@gyeol/core';
import { LEVELS, chooseMove, search, type Predict } from '../src';

const uniform: Predict = async (b) => ({ priors: new Array(legal(b, 1).length).fill(1), value: 0 });

describe('AI', () => {
  test('모든 난이도가 끝까지 합법 수만 둔다', async () => {
    for (const level of LEVELS) {
      const random = rng(7);
      let b = initial();
      let p: Player = 1;
      let turns = 0;
      while (!result(b, p)) {
        const a = await chooseMove(canonical(b, p), level.id === 'master' ? 'normal' : level.id, uniform, random);
        expect(legal(b, p)).toContain(a);
        b = apply(b, p, a).board;
        p = -p as Player;
        expect(++turns).toBeLessThan(60);
      }
    }
  });

  test('MCTS는 한 수로 이기는 수를 찾는다', async () => {
    // 가치망이 쓸모없어도(0) 종료 국면은 정확히 평가된다: 24장 놓인 판에서 마지막 수로 승부가 갈림
    const random = rng(3);
    let found = 0;
    for (let trial = 0; trial < 40 && found < 5; trial++) {
      let b = initial();
      let p: Player = 1;
      while (!result(b, p) && b.filter(Boolean).length < 24) {
        const moves = legal(b, p);
        b = apply(b, p, moves[Math.floor(random() * moves.length)]).board;
        p = -p as Player;
      }
      if (result(b, p) || b.filter(Boolean).length !== 24) continue;
      const c = canonical(b, p);
      const moves = legal(c, 1);
      const wins = moves.filter((a) => result(apply(c, 1, a).board, -1) === -1);
      if (!wins.length || wins.length === moves.length) continue;
      const { action } = await search(c, moves.length * 3, uniform, { random });
      expect(wins).toContain(action);
      found++;
    }
    expect(found).toBeGreaterThan(0);
  });
});
