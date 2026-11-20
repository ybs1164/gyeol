import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DIRS, PASS, apply, bounds, counts, decode, idx, initial, legal, play, result, winner, type Board, type Player,
} from '../src';

interface Fixture {
  board: Board;
  player: Player;
  moves: number[];
  action: number;
  after: Board;
  last: { pass?: true; rotated?: number[]; placed?: number[]; flipped?: number[][] };
  result: number;
}

const fixtures: Fixture[] = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));

describe('Python 규칙과 일치', () => {
  test(`${fixtures.length}개 전이가 모두 같다`, () => {
    expect(fixtures.length).toBeGreaterThan(500);
    for (const f of fixtures) {
      expect(legal(f.board, f.player)).toEqual(f.moves);
      const { board, last } = apply(f.board, f.player, f.action);
      expect(board).toEqual(f.after);
      if (f.last.pass) expect(last.pass).toBe(true);
      else {
        expect(last.rotated).toEqual(f.last.rotated);
        expect(last.placed).toEqual(f.last.placed);
        expect(last.flipped).toEqual(f.last.flipped);
      }
      const r = result(board, -f.player as Player);
      expect(r).toBeCloseTo(f.result, 8);
    }
  });
});

describe('규칙', () => {
  test('첫 수는 9가지이고, 새 타일은 항상 돌린 타일을 향한다', () => {
    for (const p of [1, -1] as Player[]) {
      const b = initial();
      const moves = legal(b, p);
      expect(moves).toHaveLength(9);
      for (const a of moves) {
        const m = decode(a)!;
        expect(m.pr + DIRS[m.placeDir][0]).toBe(m.r);
        expect(m.pc + DIRS[m.placeDir][1]).toBe(m.c);
        expect(m.newDir).not.toBe(Math.abs(b[idx(m.r, m.c)]) - 1);
      }
    }
  });

  test('먹기는 화살표를 따라가고, 출발 타일로 돌아오면 실패', () => {
    const b = new Array(49).fill(0);
    b[idx(3, 2)] = 2; // 초록 →
    b[idx(3, 3)] = -1; // 갈색 ↑
    const find = (r: number, c: number, nd: number, pr: number, pc: number) =>
      legal(b, 1).find((a) => {
        const m = decode(a)!;
        return m.r === r && m.c === c && m.newDir === nd && m.pr === pr && m.pc === pc;
      })!;
    const capture = apply(b, 1, find(3, 3, 3, 3, 4));
    expect(capture.last.flipped).toEqual([capture.last.rotated]);
    expect(counts(capture.board).green).toBe(3);
    const loop = apply(b, 1, find(3, 3, 1, 3, 4));
    expect(loop.last.flipped).toEqual([]);
  });

  test('무작위 대국은 5x5를 넘지 않고 끝까지 진행된다', () => {
    for (let g = 0; g < 30; g++) {
      let b = initial();
      let p: Player = 1;
      let turns = 0;
      while (!result(b, p)) {
        const moves = legal(b, p);
        b = play(b, p, moves[(g * 17 + turns * 7) % moves.length]).board;
        const [r0, r1, c0, c1] = bounds(b);
        expect(r1 - r0).toBeLessThan(5);
        expect(c1 - c0).toBeLessThan(5);
        p = -p as Player;
        expect(++turns).toBeLessThan(60);
      }
      const { green, brown } = counts(b);
      expect(winner(b, p)).toBe(Math.sign(green - brown));
    }
  });

  test('둘 수 없으면 PASS, 불법 수는 거부', () => {
    const b = initial().map((v) => Math.abs(v));
    expect(legal(b, 1)).toEqual([PASS]);
    expect(() => play(initial(), 1, legal(initial(), -1)[0])).toThrow();
  });
});
