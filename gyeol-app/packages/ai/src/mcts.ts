import { apply, legal, result, type Board } from '@gyeol/core';

/**
 * 신경망 추론 결과. priors[i] 는 legal(board, 1)[i] 의 확률(정규화 전), value 는 둘 차례 기준 -1..1.
 * 785칸 전체 대신 합법 수만 담아 메모리를 아낀다.
 */
export interface Prediction {
  priors: ArrayLike<number>;
  value: number;
}

/** 정규 보드(둘 차례 = +1) → Prediction */
export type Predict = (canonical: Board) => Promise<Prediction>;

interface Edge {
  a: number;
  p: number;
  n: number;
  q: number;
}

interface Node {
  n: number;
  value: number;
  edges: Edge[];
}

/** 같은 루트의 예산을 늘릴 때 이미 읽은 트리를 이어 쓴다. */
export interface SearchSession { tree: Map<string, Node>; simulations: number; boardKey?: string }
export const createSearchSession = (): SearchSession => ({ tree: new Map(), simulations: 0 });

export interface SearchOptions {
  cpuct?: number;
  random?: () => number;
  /** 이 시간(ms)이 지나면 시뮬레이션을 멈춘다 */
  deadline?: number;
  /** 긴 복기 탐색에서 취소 확인 및 이벤트 루프 양보 */
  checkpoint?: () => Promise<void>;
  session?: SearchSession;
  /** 그래프 경로에서는 수순 생성과 후보별 상세 결과를 생략한다. */
  details?: 'full' | 'root' | 'none';
}

export interface SearchCandidate {
  action: number;
  visits: number;
  prior: number;
  /** 미방문 수는 0점이 아니라 미평가 */
  value: number | null;
  pv: number[];
}

export interface SearchResult {
  action: number;
  visits: Map<number, number>;
  simulations: number;
  /** 루트 차례 기준, 추천 수를 선택했을 때의 가치. 탐색용 악수를 평균내지 않는다. */
  value: number;
  meanValue: number;
  candidates: SearchCandidate[];
}

/** AlphaZero MCTS (gyeol_ai/MCTS.py 와 같은 PUCT, cpuct 1.5). board 는 정규 보드. */
export async function search(board: Board, sims: number, predict: Predict, opts: SearchOptions = {}): Promise<SearchResult> {
  const ended = result(board, 1);
  const normalizedEnd = (r: number) => Math.abs(r) < 0.5 ? 0 : Math.sign(r);
  if (ended) return { action: legal(board, 1)[0], visits: new Map(), simulations: 0, value: normalizedEnd(ended), meanValue: normalizedEnd(ended), candidates: [] };
  if (!Number.isFinite(sims) || sims < 1) throw new Error('Search simulations must be positive');
  const cpuct = opts.cpuct ?? 1.5;
  const random = opts.random ?? Math.random;
  const session = opts.session ?? createSearchSession();
  const boardKey = board.join(',');
  if (session.boardKey && session.boardKey !== boardKey) throw new Error('Search session root mismatch');
  session.boardKey = boardKey;
  const tree = session.tree;

  async function visit(b: Board): Promise<number> {
    const end = result(b, 1);
    if (end) return -normalizedEnd(end);
    const key = b.join(',');
    let node = tree.get(key);
    if (!node) {
      const { priors, value } = await predict(b);
      if (!Number.isFinite(value) || value < -1 || value > 1) throw new Error(`Invalid AI value: ${value}`);
      const actions = legal(b, 1);
      if (priors.length !== actions.length) throw new Error('Invalid AI policy');
      let sum = 0;
      for (let i = 0; i < actions.length; i++) {
        if (!Number.isFinite(priors[i]) || priors[i] < 0) throw new Error('Invalid AI policy');
        sum += priors[i];
      }
      node = {
        n: 0,
        value,
        edges: actions.map((a, i) => ({ a, p: sum > 0 ? priors[i] / sum : 1 / actions.length, n: 0, q: 0 })),
      };
      tree.set(key, node);
      return -value;
    }
    let best = node.edges[0];
    let score = -Infinity;
    const sqrt = Math.sqrt(node.n);
    for (const e of node.edges) {
      const u = e.n ? e.q + (cpuct * e.p * sqrt) / (1 + e.n) : cpuct * e.p * Math.sqrt(node.n + 1e-8);
      if (u > score) {
        score = u;
        best = e;
      }
    }
    const next = apply(b, 1, best.a).board.map((v) => (v ? -v : 0));
    const v = await visit(next);
    best.q = (best.q * best.n + v) / (best.n + 1);
    best.n++;
    node.n++;
    return -v;
  }

  let done = session.simulations;
  for (; done < Math.floor(sims);) {
    if (done % 16 === 0) await opts.checkpoint?.();
    await visit(board);
    done++;
    session.simulations = done;
    if (opts.deadline && performance.now() > opts.deadline) break;
  }
  const root = tree.get(board.join(','))!;
  const visits = new Map(root.edges.map((e) => [e.a, e.n]));
  const max = Math.max(...root.edges.map((e) => e.n));
  const top = root.edges.filter((e) => e.n === max);
  const chosen = top[Math.floor(random() * top.length)];
  const line = (first: number): number[] => {
    const pv = [first];
    let b = apply(board, 1, first).board.map(v => v ? -v : 0);
    for (let depth = 1; depth < 5 && !result(b, 1); depth++) {
      const node = tree.get(b.join(','));
      const edge = node?.edges.filter(e => e.n > 0).sort((a, b) => b.n - a.n || a.a - b.a)[0];
      if (!edge) break;
      pv.push(edge.a);
      b = apply(b, 1, edge.a).board.map(v => v ? -v : 0);
    }
    return pv;
  };
  return {
    action: chosen.a,
    visits,
    simulations: done,
    value: chosen.n ? chosen.q : root.value,
    meanValue: root.n ? root.edges.reduce((sum, e) => sum + e.q * e.n, 0) / root.n : root.value,
    candidates: opts.details === 'none' ? [] : root.edges.map(e => ({ action: e.a, visits: e.n, prior: e.p, value: e.n ? e.q : null, pv: opts.details === 'root' ? [] : line(e.a) })),
  };
}
