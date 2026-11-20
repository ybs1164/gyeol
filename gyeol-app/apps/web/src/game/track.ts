import {
  CELLS, N, apply, dirOf, idx, type Applied, type Board, type MoveInfo, type Player,
} from '@gyeol/core';

/**
 * 화면용 국면. 타일마다 id를 붙여 중앙 정렬로 위치가 바뀌어도 같은 타일이 미끄러지듯 움직이고,
 * 회전은 가장 짧은 방향으로 돈다.
 */
export interface TileView {
  id: number;
  /** 화살표 누적 각도(도) */
  angle: number;
  /** 뒤집힌 횟수 — 바뀌면 뒤집기 애니메이션 재생 */
  flips: number;
}

export interface Position {
  board: Board;
  player: Player;
  /** 칸별 타일 정보(빈 칸은 null) */
  tiles: (TileView | null)[];
  last?: MoveInfo;
  /** 마지막으로 회전·배치한 수 — 패스해도 보드의 표시를 유지한다. */
  lastMove?: MoveInfo;
  action?: number;
  /** 이번 수에 뒤집힌 타일 id → 순서 */
  flipOrder: Map<number, number>;
  /** 이번 수에 놓인 타일 id */
  enteredId?: number;
  /** 화면에 애니메이션을 재생할지 (되돌리기 시 false) */
  animate: boolean;
  nextId: number;
  /** 새 판마다 바뀜 — 서로 다른 판의 타일이 같은 id로 이어지지 않게 */
  epoch: number;
  /** 이 국면까지 둔 수 (온라인 동기화용) */
  moves?: number;
}

let epochs = 0;

export function startPosition(board: Board, player: Player): Position {
  let nextId = 1;
  const tiles = board.map((v) => (v ? { id: nextId++, angle: dirOf(v) * 90, flips: 0 } : null));
  return { board, player, tiles, flipOrder: new Map(), animate: false, nextId, epoch: ++epochs };
}

const shortest = (from: number, to: number) => (((to - from) % 4) + 6) % 4 - 2; // -2..1

export function advance(pos: Position, action: number): Position {
  const applied: Applied = apply(pos.board, pos.player, action);
  const { board, last } = applied;
  const next = -pos.player as Player;
  if (last.pass) return { ...pos, player: next, last, action, flipOrder: new Map(), enteredId: undefined, animate: true };

  const [dr, dc] = last.shift;
  const tiles: (TileView | null)[] = new Array(CELLS).fill(null);
  for (let i = 0; i < CELLS; i++) {
    const t = pos.tiles[i];
    if (!t) continue;
    const r = Math.floor(i / N) + dr;
    const c = (i % N) + dc;
    tiles[idx(r, c)] = { ...t };
  }
  // 돌린 타일: 가장 짧은 방향으로 회전
  const [rr, rc] = last.rotated!;
  const rot = tiles[idx(rr, rc)]!;
  const oldDir = ((((rot.angle / 90) % 4) + 4) % 4);
  rot.angle += shortest(oldDir, dirOf(board[idx(rr, rc)])) * 90;
  // 놓은 타일
  const [pr, pc] = last.placed!;
  const id = pos.nextId;
  tiles[idx(pr, pc)] = { id, angle: dirOf(board[idx(pr, pc)]) * 90, flips: 0 };
  // 뒤집힌 타일
  const flipOrder = new Map<number, number>();
  last.flipped!.forEach(([fr, fc], k) => {
    const t = tiles[idx(fr, fc)]!;
    t.flips++;
    flipOrder.set(t.id, k);
  });
  return { ...pos, board, player: next, tiles, last, lastMove: last, action, flipOrder, enteredId: id, animate: true, nextId: id + 1 };
}
