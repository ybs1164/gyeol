import { CELLS, PASS, decode, idx, recenter, tile, type Board, type Dir, type MoveInfo, type Player } from './rules';

/**
 * 텍스트 보드 → Board. 토큰: G^ G> Gv G< B^ B> Bv B< 또는 '.'
 * 행 길이는 같아야 하며, 결과는 7x7 중앙에 놓인다.
 */
export function parseBoard(rows: string[]): Board {
  const b = new Array<number>(CELLS).fill(0);
  const dirs: Record<string, Dir> = { '^': 0, '>': 1, v: 2, '<': 3 };
  rows.forEach((row, r) => {
    row.trim().split(/\s+/).forEach((t, c) => {
      if (t === '.') return;
      const p: Player = t[0] === 'G' ? 1 : -1;
      const d = dirs[t[1]];
      if ((t[0] !== 'G' && t[0] !== 'B') || d === undefined) throw new Error(`잘못된 토큰: ${t}`);
      b[idx(r + 1, c + 1)] = tile(p, d);
    });
  });
  return recenter(b).board;
}

export interface LessonCheck {
  ok: boolean;
  /** 안내 문구 키 (화면에서 번역) */
  key: string;
}

/** 제목·설명 문구는 화면의 번역 사전에서 lesson.<id>.title / lesson.<id>.text 로 찾는다 */
export interface Lesson {
  id: string;
  board: Board;
  player: Player;
  /** 'info' 는 보기만, 'move' 는 직접 두기 */
  kind: 'info' | 'move';
  check?: (action: number, info: MoveInfo) => LessonCheck;
}

export const LESSONS: Lesson[] = [
  {
    id: 'goal',
    kind: 'info',
    player: 1,
    board: parseBoard([
      'G< B^ G< B^ G<',
      'G^ G< Bv Gv B<',
      'B> G^ G> B< Gv',
      'G< B^ B^ G^ G>',
      'G> Gv G^ B< G^',
    ]),
  },
  {
    id: 'turn',
    kind: 'move',
    player: 1,
    board: parseBoard(['G> B<']),
    check: () => ({ ok: true, key: 'check.turn.ok' }),
  },
  {
    id: 'capture',
    kind: 'move',
    player: 1,
    board: parseBoard(['.  .  Gv', '.  Bv B^', '.  G< .']),
    check: (_a, info) => {
      const n = info.flipped?.length ?? 0;
      return n >= 2 ? { ok: true, key: 'check.capture.ok' } : { ok: false, key: n ? 'check.capture.one' : 'check.capture.none' };
    },
  },
  {
    id: 'loop',
    kind: 'move',
    player: 1,
    board: parseBoard(['G> B^']),
    check: (a) => {
      const m = decode(a);
      return m && m.newDir === m.side
        ? { ok: true, key: 'check.loop.ok' }
        : { ok: false, key: 'check.loop.no' };
    },
  },
  {
    id: 'limit',
    kind: 'move',
    player: 1,
    board: parseBoard(['G^ B> Gv B^ Bv']),
    check: () => ({ ok: true, key: 'check.limit.ok' }),
  },
  {
    id: 'pass',
    kind: 'move',
    player: 1,
    board: parseBoard([
      'G< B^ Bv G^ .',
      'Bv B^ G< Bv G^',
      'G> Gv B^ G^ Bv',
      'G^ Bv Bv G^ B^',
      '.  G< B< B^ G>',
    ]),
    check: (a) =>
      a === PASS
        ? { ok: true, key: 'check.pass.ok' }
        : { ok: false, key: 'check.pass.no' },
  },
];
