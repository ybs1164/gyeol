import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  LESSONS, PASS, NotationError, apply, formatCell, formatMove, formatPosition, formatRecord, initial,
  legal, parseCell, parsePosition, parseRecord, recenter, resolveMoveCandidates, result, type Board, type Player,
} from '../src';

const start = 'GYEOL-P/1;rules=facing-25-v1;turn=lower;board=......./......./......./..rL.../......./......./.......';
const first = 'GYEOL-P/1;rules=facing-25-v1;turn=upper;board=......./......./...d.../..rU.../......./......./.......';
const example = `GYEOL-R/1\nstart=${start}\nmoves=D4u D3U D5d\nactions=384 272 502`;
function rejects(run: () => unknown, code: string, ply?: number) {
  try { run(); expect.fail('Expected rejection'); }
  catch (e) { expect(e).toBeInstanceOf(NotationError); expect(e).toMatchObject({ code, ply }); }
}

describe('notation positions', () => {
  test('one cell per letter, case, turn, and exact coordinates', () => {
    expect(formatPosition({ board: initial(), player: 1 })).toBe(start);
    expect(parsePosition(start)).toEqual({ board: initial(), player: 1, ruleVersion: 'facing-25-v1' });
    expect(formatPosition({ board: apply(initial(), 1, 384).board, player: -1 })).toBe(first);
    const spaced = start.replace('board=', 'board=\n').replace('..rL...', '. . r L . . .').replaceAll('/.......', '/\n.......');
    expect(formatPosition(parsePosition(spaced))).toBe(start);
    const [header, board] = start.split('board=');
    expect(formatPosition(parsePosition(header + 'board=' + board.replaceAll('/', '\n')))).toBe(start);
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) expect(parseCell(formatCell(r, c))).toEqual([r, c]);
  });
  test('invalid boards, versions, duplicates and missing fields are rejected', () => {
    rejects(() => parsePosition(start.replace('..rL...', '..rL..')), 'board');
    rejects(() => parsePosition(start.replace('..rL...', '..rX...')), 'board');
    rejects(() => parsePosition(start.replace('..rL...', 'rL.....')), 'center');
    rejects(() => parsePosition(start.replace('..rL...', 'r.....L')), 'board');
    rejects(() => parsePosition(start.replace('..rL...', '.......')), 'board');
    rejects(() => parsePosition(start.replace('/1;', '/2;')), 'format');
    rejects(() => parsePosition(start.replace('facing-25-v1', 'unknown')), 'rules');
    rejects(() => parsePosition(start + ';turn=upper'), 'fields');
    rejects(() => parsePosition(start.replace(';turn=lower', '')), 'fields');
    rejects(() => parsePosition(start.replace('turn=lower', 'turn=1')), 'turn');
    rejects(() => parseCell('a4'), 'coordinate');
    rejects(() => formatCell(7, 0), 'coordinate');
    const sparse = new Array<number>(49); sparse[23] = 2; sparse[24] = -4;
    rejects(() => formatPosition({ board: sparse, player: 1 }), 'board');
  });
});

describe('short moves and lossless records', () => {
  test('placement direction is distinct from rotation; no arbitrary inference', () => {
    expect(resolveMoveCandidates(initial(), 1, 'D4u')).toEqual([384, 388, 392]);
    for (const action of [384, 388, 392]) expect(formatMove(initial(), 1, action)).toBe('D4u');
    expect(new Set([384, 388, 392].map(a => JSON.stringify(apply(initial(), 1, a).board))).size).toBe(3);
    expect(formatRecord({ moves: [384, 272, 502] })).toBe(example);
    expect(parseRecord(example).moves).toEqual([384, 272, 502]);
    rejects(() => resolveMoveCandidates(initial(), 1, 'D4U'), 'case');
    rejects(() => resolveMoveCandidates(initial(), 1, 'D4x'), 'move');
    rejects(() => resolveMoveCandidates(initial(), 1, 'C4u'), 'illegal');
    rejects(() => resolveMoveCandidates(initial(), 1, 'D4l'), 'illegal');
    rejects(() => resolveMoveCandidates(initial(), 1, 'pass'), 'illegal');
  });
  test('case-aware pass and arbitrary initial board round-trip', () => {
    const lesson = LESSONS.find(l => l.id === 'pass')!;
    const board = recenter(lesson.board).board;
    expect(formatMove(board, 1, PASS)).toBe('pass');
    expect(resolveMoveCandidates(board, 1, 'pass')).toEqual([PASS]);
    const reversed = board.map(v => -v);
    expect(formatMove(reversed, -1, PASS)).toBe('PASS');
    expect(resolveMoveCandidates(reversed, -1, 'PASS')).toEqual([PASS]);
    const record = { initialBoard: board, initialPlayer: 1 as Player, moves: [PASS] };
    const parsed = parseRecord(formatRecord(record));
    expect(parsed).toMatchObject(record);
    expect(parseRecord(formatRecord({ moves: [] })).moves).toEqual([]);
  });
  test('mismatched or illegal records fail at the correct move', () => {
    rejects(() => parseRecord(example.replace('D3U', 'D3u')), 'mismatch', 2);
    rejects(() => parseRecord(example.replace('384 272 502', '384 272')), 'mismatch');
    rejects(() => parseRecord(example.replace('384 272 502', '384 999 502')), 'action', 2);
    rejects(() => parseRecord(example.replace('384 272 502', '384 NaN 502')), 'action', 2);
    rejects(() => parseRecord(example.replace('384 272 502', '384 784 502')), 'illegal', 2);
    rejects(() => parseRecord(example + '\nactions=384'), 'fields');
    rejects(() => parseRecord(example.replace('\nactions=384 272 502', '')), 'fields');
    rejects(() => parseRecord('x'.repeat(16_385)), 'length');
  });
  test('Python fixture positions keep owners, directions, holes and all legal move candidates', () => {
    const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8')) as { board: Board; player: Player }[];
    for (const f of fixtures) {
      // Fixtures include a few manually positioned, non-centered boards; transport rejects these explicitly.
      const board = recenter(f.board).board;
      if (board.filter(Boolean).length < 2) continue;
      expect(parsePosition(formatPosition({ board, player: f.player })).board).toEqual(board);
      if (result(board, f.player)) continue;
      const seen = new Map<string, number[]>();
      for (const a of legal(board, f.player)) {
        const label = formatMove(board, f.player, a);
        const list = seen.get(label) ?? []; list.push(a); seen.set(label, list);
      }
      for (const [label, actions] of seen) expect(resolveMoveCandidates(board, f.player, label)).toEqual(actions);
    }
  });
  test('complete games replay identically and reject moves after terminal positions', () => {
    for (let g = 0; g < 12; g++) {
      let board = initial(), player: Player = g % 2 ? -1 : 1;
      const initialPlayer = player;
      const moves: number[] = [];
      while (!result(board, player)) {
        const choices = legal(board, player);
        const action = choices[(g * 17 + moves.length * 7) % choices.length];
        board = apply(board, player, action).board; player = -player as Player; moves.push(action);
        expect(moves.length).toBeLessThan(64);
      }
      const parsed = parseRecord(formatRecord({ moves, initialPlayer }));
      expect(parsed.moves).toEqual(moves);
      let restored = parsed.initialBoard, turn = parsed.initialPlayer;
      for (const a of parsed.moves) { restored = apply(restored, turn, a).board; turn = -turn as Player; }
      expect(restored).toEqual(board); expect(turn).toBe(player);
      rejects(() => resolveMoveCandidates(board, player, player === 1 ? 'pass' : 'PASS'), 'terminal');
      rejects(() => formatRecord({ initialPlayer, moves: [...moves, PASS] }), 'terminal', moves.length + 1);
    }
  });
});
