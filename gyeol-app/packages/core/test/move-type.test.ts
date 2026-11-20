import { describe, expect, test } from 'vitest';
import { CELLS, PASS, apply, encode, idx, initial, legal, maxCapture, moveType, result, tile, type Board, type Player } from '../src';

describe('수 평가 타입', () => {
  test('뒤집고 상대의 반격이 더 작으면 공격이다', () => {
    const board: Board = new Array(CELLS).fill(0);
    board[idx(3, 1)] = tile(1, 0);  // 내 타일
    board[idx(3, 2)] = tile(-1, 0); // 상대 타일
    // 상대는 내 타일을 자기 타일 쪽으로 돌려 한 장을 뒤집을 수 있다.
    expect(maxCapture(board, -1)).toBe(1);
    // 상대 타일을 내 타일 쪽(서)으로 돌리고 동쪽에 놓으면 그 타일을 뒤집는다. 상대 타일이 남지 않아 반격이 없다.
    expect(moveType(board, 1, encode(idx(3, 2), 3, 1))).toEqual({ type: 'attack', flips: 1, threatBefore: 1, threatAfter: 0 });
    expect(moveType(board, 1, PASS)).toEqual({ type: null, flips: 0, threatBefore: 0, threatAfter: 0 });
  });

  test('모든 수의 타입은 뒤집은 장수와 상대의 기회 변화로만 정해지고, 세 타입이 실제로 나온다', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const seen = new Set<string>();
    for (let game = 0; game < 30; game++) {
      let board = initial(), player: Player = 1;
      while (!result(board, player)) {
        const options = legal(board, player);
        for (const action of options) {
          const info = moveType(board, player, action);
          if (action === PASS) { expect(info.type).toBeNull(); continue; }
          const next = apply(board, player, action);
          expect(info.flips).toBe(next.last.flipped!.length);
          expect(info.threatBefore).toBe(maxCapture(board, -player as Player));
          expect(info.threatAfter).toBe(maxCapture(next.board, -player as Player));
          if (info.type === 'attack') expect(info.flips > info.threatAfter && info.flips >= 1).toBe(true);
          if (info.type === 'defense') expect(info.threatAfter < info.threatBefore && !(info.flips > info.threatAfter)).toBe(true);
          if (info.type === 'gift') expect(info.threatAfter > info.threatBefore && info.threatAfter > info.flips).toBe(true);
          if (info.type === null) expect(info.threatAfter >= info.flips || info.flips === 0).toBe(true);
          seen.add(String(info.type));
        }
        const action = options[Math.floor(random() * options.length)];
        board = apply(board, player, action).board; player = -player as Player;
      }
    }
    expect([...seen].sort()).toEqual(['attack', 'defense', 'gift', 'null']);
  });
});
