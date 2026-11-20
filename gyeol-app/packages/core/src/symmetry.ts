import { CELLS, DIRS, N, recenter, type Board, type Player } from './rules';
import { positionKey } from './endgame';

/**
 * 판의 8가지 대칭(회전 4 × 좌우 반전 2). gyeol_ai/gyeol/GyeolLogic.py 의 SYMMETRIES 와 같은 순서·같은 변환이다.
 * 학습 확대(augmentation)와 달리 여기서는 변환 뒤 중앙 정렬까지 한다. 같은 국면이 같은 키를 갖게 하기 위해서다.
 */
const SYMMETRIES: { cells: Int8Array; dirs: Int8Array }[] = [];
for (const flip of [false, true]) {
  for (let k = 0; k < 4; k++) {
    const cells = new Int8Array(CELLS), dirs = new Int8Array(4);
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      let rr = r, cc = flip ? N - 1 - c : c;
      for (let i = 0; i < k; i++) [rr, cc] = [N - 1 - cc, rr]; // 반시계 90°
      cells[r * N + c] = rr * N + cc;
    }
    DIRS.forEach(([dr, dc], d) => {
      let vr = dr, vc = flip ? -dc : dc;
      for (let i = 0; i < k; i++) [vr, vc] = [-vc, vr];
      dirs[d] = DIRS.findIndex(([a, b]) => a === vr && b === vc);
    });
    SYMMETRIES.push({ cells, dirs });
  }
}

/** sym 번째 대칭으로 옮긴 뒤 중앙 정렬한 판(0 = 그대로). */
export function transformBoard(board: Board, sym: number): Board {
  const { cells, dirs } = SYMMETRIES[sym];
  const out = new Array<number>(CELLS).fill(0);
  for (let i = 0; i < CELLS; i++) {
    const v = board[i];
    if (v) out[cells[i]] = Math.sign(v) * (dirs[Math.abs(v) - 1] + 1);
  }
  return recenter(out).board;
}

/** 8가지 대칭을 하나로 묶는 키: 둘 차례 기준 키(positionKey) 중 가장 작은 것. */
export function symmetryKey(board: Board, player: Player): string {
  let best = '';
  for (let s = 0; s < SYMMETRIES.length; s++) {
    const key = positionKey(transformBoard(board, s), player);
    if (!best || key < best) best = key;
  }
  return best;
}
