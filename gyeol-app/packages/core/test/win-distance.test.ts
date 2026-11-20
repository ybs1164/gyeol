import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ExactEndgame, PASS, apply, legal, result, tileCount, type Board, type Player, type RecordPuzzleData } from '../src';

const puzzles = JSON.parse(readFileSync(new URL('../../../tools/record-puzzles/verified.json', import.meta.url), 'utf8')) as RecordPuzzleData[];

/** 가지치기·정확 평가 캐시 없이 모든 상대 응수를 검사하는 별도 거리 오라클. */
function oracle(board: Board, player: Player, winningPlayer: Player, memo = new Map<string, number | null>()): number | null {
  const key = `${player}:${winningPlayer}:${board.join(',')}`;
  if (memo.has(key)) return memo.get(key)!;
  const end = result(board, player);
  if (end) return Math.abs(end) > 0.5 && Math.sign(end) * player === winningPlayer ? 0 : null;
  const replies = legal(board, player).map(a => oracle(apply(board, player, a).board, -player as Player, winningPlayer, memo));
  const value = player === winningPlayer
    ? replies.some(n => n !== null) ? Math.min(...replies.filter((n): n is number => n !== null)) + 1 : null
    : replies.every((n): n is number => n !== null) ? Math.max(...replies) + 1 : null;
  memo.set(key, value);
  return value;
}

describe('증명된 승리까지의 수', () => {
  test('승자는 최단, 패자는 최대 지연하는 거리가 독립 전수 검사와 일치한다', async () => {
    for (const p of puzzles.filter(p => tileCount(p.board) === 23).slice(0, 12)) {
      const solver = new ExactEndgame(1_000_000);
      const winningPlayer = Math.sign(solver.value(p.board, p.player)) * p.player as Player;
      const expected = oracle(p.board, p.player, winningPlayer);
      const found = await solver.winDistanceAsync(p.board, p.player, winningPlayer, async () => {});
      expect(found).toBe(expected);
      expect(found).toBeGreaterThanOrEqual(25 - tileCount(p.board));
      expect(found).toBeLessThanOrEqual(2 * (25 - tileCount(p.board)));
      expect(await solver.winDistanceAsync(p.board, p.player, -winningPlayer as Player, async () => {})).toBeNull();
    }
  });

  test('강제 패스도 한 수로 세고 색을 바꾸어도 같은 거리를 반환한다', async () => {
    const [key] = puzzles.flatMap(p => p.proof).find(([, values]) => values.length === 1 && values[0][0] === PASS)!;
    const board = [...key].map(v => Number(v) - 5);
    const solver = new ExactEndgame();
    const winningPlayer = Math.sign(solver.value(board, 1)) as Player;
    const expected = oracle(board, 1, winningPlayer);
    expect(await solver.winDistanceAsync(board, 1, winningPlayer, async () => {})).toBe(expected);
    expect(expected).toBeGreaterThan(25 - tileCount(board));
    const after = apply(board, 1, PASS).board;
    const next = await solver.winDistanceAsync(after, -1, winningPlayer, async () => {});
    expect(expected).toBe(next! + 1);
    expect(await solver.winDistanceAsync(board.map(v => -v), -1, -winningPlayer as Player, async () => {})).toBe(expected);
  });

  test('이미 끝난 승리는 0수이며 무승부와 패배는 강제 승리로 바꾸지 않는다', async () => {
    const board = Array(49).fill(0);
    for (let r = 1; r <= 5; r++) for (let c = 1; c <= 5; c++) board[r * 7 + c] = 1;
    const solver = new ExactEndgame();
    expect(await solver.winDistanceAsync(board, 1, 1, async () => {})).toBe(0);
    expect(await solver.winDistanceAsync(board, 1, -1, async () => {})).toBeNull();
    expect(await solver.winDistanceAsync(Array(49).fill(0), 1, 1, async () => {})).toBeNull();
  });

  test('취소와 공통 노드 한도를 지킨다', async () => {
    const p = puzzles.find(p => tileCount(p.board) === 23)!;
    await expect(new ExactEndgame().winDistanceAsync(p.board, p.player, p.player, async () => { throw new Error('cancel'); })).rejects.toThrow('cancel');
    await expect(new ExactEndgame(0).winDistanceAsync(p.board, p.player, p.player, async () => {})).rejects.toThrow('node limit');
  });
});
