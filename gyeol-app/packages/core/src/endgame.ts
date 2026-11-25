import { LIMIT, PASS, TOTAL_TILES, apply, bounds, legal, margin, result, tileCount, type Board, type Player } from './rules';

/** 둘 차례를 +1로 바꾼 좌표 키. 행동 번호는 원래 좌표와 같다. */
export function positionKey(board: Board, player: Player): string {
  return board.map((v) => String(v * player + 5)).join('');
}

/** 휴리스틱 잎 평가 없이 실제 종국 타일 차이만 반환한다. 한도 초과는 검증 실패로 처리한다. */
export class ExactEndgame {
  nodes = 0;
  private exact = new Map<string, number>();
  private winDistances = new Map<string, number | null>();
  constructor(private limit = 1_000_000) {}

  value(board: Board, player: Player, alpha = -26, beta = 26): number {
    const work = this.solve(board, player, alpha, beta);
    let step = work.next();
    while (!step.done) step = work.next();
    return step.value;
  }

  private *solve(board: Board, player: Player, alpha: number, beta: number): Generator<void, number> {
    if (++this.nodes > this.limit) throw new Error('Exact endgame node limit exceeded');
    if (this.nodes % 256 === 0) yield;
    if (result(board, player)) return margin(board) * player;
    const key = positionKey(board, player);
    const cached = this.exact.get(key);
    if (cached !== undefined) return cached;
    const originalAlpha = alpha;
    let best = -26;
    const children = legal(board, player).map((a) => ({ a, board: apply(board, player, a).board }));
    children.sort((a, b) => player * (margin(b.board) - margin(a.board)) || a.a - b.a);
    for (const child of children) {
      best = Math.max(best, -(yield* this.solve(child.board, -player as Player, -beta, -alpha)));
      alpha = Math.max(alpha, best);
      if (alpha >= beta) return best;
    }
    // 컷오프 값은 정확한 값처럼 재사용하지 않는다.
    if (best > originalAlpha && best < beta) this.exact.set(key, best);
    return best;
  }

  values(board: Board, player: Player): [number, number][] {
    return legal(board, player).map((a) => [a, -this.value(apply(board, player, a).board, -player as Player)]);
  }

  /** 동기 퍼즐 생성기와 같은 탐색. 작은 청크마다 취소/시간 한도를 확인한다. */
  async valueAsync(board: Board, player: Player, checkpoint: () => Promise<void>): Promise<number> {
    await checkpoint();
    const work = this.solve(board, player, -26, 26);
    let step = work.next();
    while (!step.done) { await checkpoint(); step = work.next(); }
    return step.value;
  }

  /**
   * 둘 차례 기준 승패만: 1 승, 0 무, -1 패. 타일 차이 대신 (-1, 1) 창으로 찾아 같은 국면을 훨씬 적은 노드로 증명한다.
   * 창 밖으로 벗어난 값도 부호는 정확하고, 창 안의 0은 정확한 무승부다.
   */
  async outcomeAsync(board: Board, player: Player, checkpoint: () => Promise<void>): Promise<-1 | 0 | 1> {
    await checkpoint();
    const work = this.solve(board, player, -1, 1);
    let step = work.next();
    while (!step.done) { await checkpoint(); step = work.next(); }
    return Math.sign(step.value) as -1 | 0 | 1;
  }

  /** 승자는 승리를 유지하며 가장 빨리 끝내고, 패자는 모든 합법 응수로 최대한 지연한다. 양쪽 착수를 각각 1수로 세고, 패스는 세지 않는다. */
  private *distance(board: Board, player: Player, winningPlayer: Player): Generator<void, number | null> {
    if (++this.nodes > this.limit) throw new Error('Exact endgame node limit exceeded');
    if (this.nodes % 256 === 0) yield;
    const end = result(board, player);
    if (end) return Math.abs(end) > 0.5 && Math.sign(end) * player === winningPlayer ? 0 : null;
    const position = positionKey(board, player);
    const key = `${winningPlayer * player}:${position}`;
    const cached = this.winDistances.get(key);
    if (cached !== undefined) return cached;
    const known = this.exact.get(position);
    if (known !== undefined && Math.sign(known) * player !== winningPlayer) {
      this.winDistances.set(key, null);
      return null;
    }
    const winningTurn = player === winningPlayer;
    let distance = winningTurn ? Infinity : 0;
    // 유효한 5×5 국면은 남은 타일 수보다 적은 착수로 종국에 도달하지 않는다.
    const [r0, r1, c0, c1] = bounds(board);
    const remaining = TOTAL_TILES - tileCount(board);
    const minimum = tileCount(board) > 0 && r1 - r0 < LIMIT && c1 - c0 < LIMIT ? remaining : 1;
    for (const action of legal(board, player)) {
      const child = yield* this.distance(apply(board, player, action).board, -player as Player, winningPlayer);
      const step = action === PASS ? 0 : 1;
      if (winningTurn) {
        if (child !== null) distance = Math.min(distance, child + step);
        if (distance === minimum) break;
      } else {
        if (child === null) { this.winDistances.set(key, null); return null; }
        distance = Math.max(distance, child + step);
      }
    }
    const value = Number.isFinite(distance) ? distance : null;
    this.winDistances.set(key, value);
    return value;
  }

  /** 상대가 최대한 버텨도 이기는 최소 착수 수(패스 제외). 승리를 강제할 수 없으면 null. */
  async winDistanceAsync(board: Board, player: Player, winningPlayer: Player, checkpoint: () => Promise<void>): Promise<number | null> {
    await checkpoint();
    const work = this.distance(board, player, winningPlayer);
    let step = work.next();
    while (!step.done) { await checkpoint(); step = work.next(); }
    return step.value;
  }

  /** 후보마다 둔 사람 기준 승패(1 승, 0 무, -1 패)만. 타일 차이 대신 (-1, 1) 창이라 valuesAsync 보다 훨씬 가볍다. */
  async outcomesAsync(board: Board, player: Player, checkpoint: () => Promise<void>): Promise<[number, -1 | 0 | 1][]> {
    const out: [number, -1 | 0 | 1][] = [];
    for (const a of legal(board, player)) {
      await checkpoint();
      const work = this.solve(apply(board, player, a).board, -player as Player, -1, 1);
      let step = work.next();
      while (!step.done) { await checkpoint(); step = work.next(); }
      out.push([a, (Math.sign(-step.value) || 0) as -1 | 0 | 1]);
    }
    return out;
  }

  /** 후보별 수 평가가 필요한 상세 복기에만 사용한다. */
  async valuesAsync(board: Board, player: Player, checkpoint: () => Promise<void>): Promise<[number, number][]> {
    const out: [number, number][] = [];
    for (const a of legal(board, player)) {
      await checkpoint();
      const work = this.solve(apply(board, player, a).board, -player as Player, -26, 26);
      let step = work.next();
      while (!step.done) { await checkpoint(); step = work.next(); }
      out.push([a, -step.value]);
    }
    return out;
  }
}
