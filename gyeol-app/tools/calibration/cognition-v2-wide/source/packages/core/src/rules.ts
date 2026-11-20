/**
 * 결(GYEOL) 규칙 엔진 — gyeol_ai/facing/rules.py 및 gyeol/GyeolLogic.py 와 1:1 대응.
 *
 * 보드: 길이 49 배열(7x7). 0 = 빈 칸, owner * (dir + 1) = 타일.
 *   owner: +1 초록(선공) / -1 갈색, dir: 0 북 · 1 동 · 2 남 · 3 서
 * 판은 떠다니는 형태라서 매 수마다 타일 묶음을 7x7 중앙으로 다시 옮긴다.
 *
 * 행동(785개, 학습 모델과 동일한 인코딩):
 *   action = (cell * 4 + newDir) * 4 + side,  PASS = 784
 *   cell: 돌릴 상대 타일 칸, newDir: 돌린 뒤 방향, side: 돌린 타일 기준 놓을 칸 방향.
 *   새 타일은 항상 돌린 타일을 바라본다 → placeDir = (side + 2) % 4.
 */

export const N = 7;
export const CELLS = N * N;
export const LIMIT = 5;
export const TOTAL_TILES = 25;
export const PASS = CELLS * 16;
export const ACTION_SIZE = PASS + 1;

export type Board = number[];
export type Player = 1 | -1;
export type Dir = 0 | 1 | 2 | 3;
export type Cell = [number, number];

export const DIRS: ReadonlyArray<Cell> = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
];

export interface Move {
  /** 돌릴 상대 타일 */
  r: number;
  c: number;
  newDir: Dir;
  /** 놓을 칸 */
  pr: number;
  pc: number;
  /** 놓을 타일의 방향 (항상 돌린 타일을 향함) */
  placeDir: Dir;
  /** 돌린 타일 기준 놓을 칸의 방향 */
  side: Dir;
}

export interface MoveInfo {
  pass?: true;
  /** 중앙 정렬 후 좌표 */
  rotated?: Cell;
  placed?: Cell;
  flipped?: Cell[];
  /** 중앙 정렬로 모든 타일이 이동한 양 [dr, dc] */
  shift: Cell;
}

export interface Applied {
  board: Board;
  last: MoveInfo;
}

export const idx = (r: number, c: number) => r * N + c;
export const rowOf = (i: number) => Math.floor(i / N);
export const colOf = (i: number) => i % N;
export const owner = (v: number): 0 | Player => (v === 0 ? 0 : v > 0 ? 1 : -1);
export const dirOf = (v: number): Dir => (Math.abs(v) - 1) as Dir;
export const tile = (p: Player, d: Dir) => p * (d + 1);
const inside = (r: number, c: number) => r >= 0 && r < N && c >= 0 && c < N;

export function initial(): Board {
  const b = new Array<number>(CELLS).fill(0);
  b[idx(3, 2)] = tile(1, 1); // 초록 →
  b[idx(3, 3)] = tile(-1, 3); // 갈색 ←  (서로 마주봄)
  return b;
}

export function encode(cell: number, newDir: number, side: number): number {
  return (cell * 4 + newDir) * 4 + side;
}

export function decode(a: number): Move | null {
  if (a === PASS) return null;
  const side = (a % 4) as Dir;
  const newDir = (Math.floor(a / 4) % 4) as Dir;
  const cell = Math.floor(a / 16);
  const r = rowOf(cell);
  const c = colOf(cell);
  return {
    r,
    c,
    newDir,
    side,
    pr: r + DIRS[side][0],
    pc: c + DIRS[side][1],
    placeDir: ((side + 2) % 4) as Dir,
  };
}

export function tileCount(b: Board): number {
  let n = 0;
  for (const v of b) if (v) n++;
  return n;
}

export function bounds(b: Board): [number, number, number, number] {
  let r0 = N, r1 = -1, c0 = N, c1 = -1;
  for (let i = 0; i < CELLS; i++) {
    if (!b[i]) continue;
    const r = rowOf(i), c = colOf(i);
    if (r < r0) r0 = r;
    if (r > r1) r1 = r;
    if (c < c0) c0 = c;
    if (c > c1) c1 = c;
  }
  return [r0, r1, c0, c1];
}

/** 빈 칸이면서 놓아도 전체 범위가 5x5를 넘지 않는 칸인가 */
export function canPlaceAt(b: Board, r: number, c: number, box = bounds(b)): boolean {
  if (!inside(r, c) || b[idx(r, c)] !== 0) return false;
  const [r0, r1, c0, c1] = box;
  return Math.max(r1, r) - Math.min(r0, r) < LIMIT && Math.max(c1, c) - Math.min(c0, c) < LIMIT;
}

/** 합법 수 목록(오름차순). 둘 수 없으면 [PASS]. */
export function legal(b: Board, p: Player): number[] {
  const box = bounds(b);
  const out: number[] = [];
  for (let i = 0; i < CELLS; i++) {
    const v = b[i];
    if (v * p >= 0) continue; // 상대 타일만
    const r = rowOf(i), c = colOf(i), cur = dirOf(v);
    for (let nd = 0; nd < 4; nd++) {
      if (nd === cur) continue;
      for (let side = 0; side < 4; side++) {
        if (canPlaceAt(b, r + DIRS[side][0], c + DIRS[side][1], box)) out.push(encode(i, nd, side));
      }
    }
  }
  return out.length ? out : [PASS];
}

export function hasMove(b: Board, p: Player): boolean {
  return legal(b, p)[0] !== PASS;
}

/**
 * (pr, pc)에 막 놓인 p 타일에서 시작하는 먹기 경로.
 * 놓은 타일이 바라보는 상대 타일부터 화살표를 따라가 시작 타일이 아닌 내 타일에 닿으면
 * 지나온 상대 타일을 모두 뒤집는다. 빈 칸/판 밖/시작 타일/순환이면 실패(빈 배열).
 */
export function capturePath(b: Board, pr: number, pc: number, p: Player): Cell[] {
  let d = dirOf(b[idx(pr, pc)]);
  let r = pr + DIRS[d][0];
  let c = pc + DIRS[d][1];
  const path: Cell[] = [];
  const seen = new Set<number>();
  for (;;) {
    if (!inside(r, c) || b[idx(r, c)] === 0) return [];
    const v = b[idx(r, c)];
    if (owner(v) === p) return r === pr && c === pc ? [] : path;
    if (seen.has(idx(r, c))) return [];
    seen.add(idx(r, c));
    path.push([r, c]);
    d = dirOf(v);
    r += DIRS[d][0];
    c += DIRS[d][1];
  }
}

/** 타일 묶음을 중앙으로 옮긴다. 이동량도 함께 반환. */
export function recenter(b: Board): { board: Board; shift: Cell } {
  const [r0, r1, c0, c1] = bounds(b);
  if (r1 < 0) return { board: b.slice(), shift: [0, 0] };
  const dr = Math.floor((N - (r1 - r0 + 1)) / 2) - r0;
  const dc = Math.floor((N - (c1 - c0 + 1)) / 2) - c0;
  if (!dr && !dc) return { board: b.slice(), shift: [0, 0] };
  const out = new Array<number>(CELLS).fill(0);
  for (let i = 0; i < CELLS; i++) if (b[i]) out[idx(rowOf(i) + dr, colOf(i) + dc)] = b[i];
  return { board: out, shift: [dr, dc] };
}

/** 돌리기 → 놓기 → 먹기 → 중앙 정렬. 원본 불변. 합법성은 검사하지 않는다(isLegal 사용). */
export function apply(board: Board, p: Player, a: number): Applied {
  const m = decode(a);
  if (!m) return { board: board.slice(), last: { pass: true, shift: [0, 0] } };
  const b = board.slice();
  b[idx(m.r, m.c)] = tile(-p as Player, m.newDir);
  b[idx(m.pr, m.pc)] = tile(p, m.placeDir);
  const flipped = capturePath(b, m.pr, m.pc, p);
  for (const [fr, fc] of flipped) b[idx(fr, fc)] = -b[idx(fr, fc)];
  const { board: out, shift } = recenter(b);
  const [dr, dc] = shift;
  return {
    board: out,
    last: {
      rotated: [m.r + dr, m.c + dc],
      placed: [m.pr + dr, m.pc + dc],
      flipped: flipped.map(([r, c]) => [r + dr, c + dc] as Cell),
      shift,
    },
  };
}

export function isLegal(b: Board, p: Player, a: number): boolean {
  return legal(b, p).includes(a);
}

/** 합법성 검사 후 적용 */
export function play(b: Board, p: Player, a: number): Applied {
  if (!isLegal(b, p, a)) throw new Error('둘 수 없는 수입니다.');
  return apply(b, p, a);
}

/** 초록 − 갈색 */
export function margin(b: Board): number {
  let s = 0;
  for (const v of b) s += Math.sign(v);
  return s;
}

export function counts(b: Board): { green: number; brown: number } {
  let green = 0, brown = 0;
  for (const v of b) {
    if (v > 0) green++;
    else if (v < 0) brown++;
  }
  return { green, brown };
}

/** 끝나지 않았으면 0, 끝났으면 p 기준 1 / -1 / 1e-4(무승부). Python game_result 와 동일. */
export function result(b: Board, p: Player): number {
  const full = tileCount(b) >= TOTAL_TILES;
  if (!full && (hasMove(b, p) || hasMove(b, -p as Player))) return 0;
  const s = margin(b) * p;
  return s > 0 ? 1 : s < 0 ? -1 : 1e-4;
}

export type Winner = Player | 0;

/** 끝났으면 승자(무승부 0), 진행 중이면 null */
export function winner(b: Board, p: Player): Winner | null {
  const r = result(b, p);
  if (r === 0) return null;
  if (r > 0.5) return p;
  if (r < -0.5) return -p as Player;
  return 0;
}

/** 플레이어 관점(+1이 자신)으로 바꾼 보드 */
export function canonical(b: Board, p: Player): Board {
  return p === 1 ? b.slice() : b.map((v) => (v ? -v : 0));
}
