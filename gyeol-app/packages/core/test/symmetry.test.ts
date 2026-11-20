import { describe, expect, test } from 'vitest';
import { apply, counts, initial, legal, result, symmetryKey, transformBoard, type Board, type Player } from '../src';

/** 결정적으로 무작위 수순을 두며 국면을 모은다. */
function positions(seed: number, games = 30): { board: Board; player: Player }[] {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
  const out: { board: Board; player: Player }[] = [];
  for (let g = 0; g < games; g++) {
    let board = initial(), player: Player = 1;
    while (!result(board, player)) {
      out.push({ board, player });
      const moves = legal(board, player);
      board = apply(board, player, moves[Math.floor(rand() * moves.length)]).board;
      player = -player as Player;
    }
  }
  return out;
}

describe('판 대칭', () => {
  const sample = positions(7);
  test('0번 대칭은 판을 바꾸지 않는다', () => {
    for (const { board } of sample) expect(transformBoard(board, 0)).toEqual(board);
  });
  test('대칭으로 옮겨도 합법 수 개수·타일 수·종국 여부가 같다', () => {
    for (const { board, player } of sample.slice(0, 300)) for (let s = 0; s < 8; s++) {
      const t = transformBoard(board, s);
      expect(legal(t, player).length).toBe(legal(board, player).length);
      expect(counts(t)).toEqual(counts(board));
      expect(result(t, player)).toBe(result(board, player));
    }
  });
  test('대칭 키는 8가지 대칭과 색·차례 맞바꿈에서 모두 같다(신경망이 보는 둘 차례 기준 판)', () => {
    for (const { board, player } of sample.slice(0, 300)) {
      const key = symmetryKey(board, player);
      for (let s = 0; s < 8; s++) expect(symmetryKey(transformBoard(board, s), player)).toBe(key);
      expect(symmetryKey(board.map(v => -v), -player as Player)).toBe(key);
    }
  });
  test('서로 다른 국면은 대부분 다른 키를 갖는다', () => {
    const keys = new Set(sample.map(p => symmetryKey(p.board, p.player)));
    const exact = new Set(sample.map(p => p.board.map(v => v * p.player).join(',')));
    expect(keys.size).toBeLessThanOrEqual(exact.size);
    expect(keys.size).toBeGreaterThan(exact.size * 0.8);
  });
  test('대칭은 착수와 순서를 바꿔도 같은 결과를 낸다', () => {
    // 대칭 판에서 둔 모든 합법 수의 결과 키 집합이 원래 판의 것과 같아야 한다(방향 변환 검증).
    for (const { board, player } of sample.slice(0, 60)) {
      const next = (b: Board) => new Set(legal(b, player).map(a => symmetryKey(apply(b, player, a).board, -player as Player)));
      for (let s = 1; s < 8; s++) expect(next(transformBoard(board, s))).toEqual(next(board));
    }
  });
});
