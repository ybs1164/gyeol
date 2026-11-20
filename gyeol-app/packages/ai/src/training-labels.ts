/**
 * P2: 학습 국면의 정답(라벨)을 만든다. 사람 대국의 승패는 쓰지 않는다.
 *
 * 남은 타일 수에 따라 세 단계로 만든다. 정확 탐색이 노드 한도를 넘으면 다음 단계로 내려간다.
 * - exact  (≤ exactMaxRemaining): 정확한 최종 타일 차이, 가치 = 승패, 정책 = 최선 차이를 내는 수 전부에 균등
 * - proven (≤ provenMaxRemaining): 정확한 승패(가치), 정책 = 깊은 탐색 방문 분포, 차이는 marginMaxRemaining 이하에서만
 * - search (그 외): 깊은 탐색. 가치 = 추천 수의 Q, 정책 = 방문 분포
 *
 * 모든 값은 둘 차례 기준(정규 보드, 둘 차례 = +1)이다. 행동 번호는 원래 보드와 같다.
 */
import { ExactEndgame, PASS, TOTAL_TILES, canonical, legal, apply, result, tileCount, type Board, type Player } from '@gyeol/core';
import { search, type Predict } from './mcts';

export const TRAINING_LABEL_VERSION = 1;
export type LabelTier = 'exact' | 'proven' | 'search';
export interface TrainingLabel {
  v: number;
  tier: LabelTier;
  /** 정규 보드(둘 차례 = +1) */
  board: Board;
  remaining: number;
  /** 둘 차례 기준 -1..1. exact/proven 은 -1·0·1 */
  value: number;
  /** 둘 차례 기준 최종 타일 차이(정확할 때만) */
  margin: number | null;
  /** [행동, 확률], 행동 오름차순, 합 1 */
  policy: [number, number][];
  /** 탐색을 쓴 단계의 탐색 정보. 정확 단계는 null */
  search: { sims: number; q: number; mean: number; model: string } | null;
}
export interface LabelOptions {
  /** 깊은 탐색을 만든 모델 버전(라벨이 낡았는지 판단하는 데 쓴다) */
  model: string;
  sims?: number;
  exactMaxRemaining?: number;
  provenMaxRemaining?: number;
  marginMaxRemaining?: number;
  nodeLimit?: number;
}
export const LABEL_DEFAULTS = { sims: 800, exactMaxRemaining: 6, provenMaxRemaining: 9, marginMaxRemaining: 7, nodeLimit: 3_000_000 } as const;

const limitExceeded = (e: unknown) => e instanceof Error && e.message === 'Exact endgame node limit exceeded';
const round = (v: number) => Math.round(v * 1e6) / 1e6;

export async function labelPosition(board: Board, player: Player, predict: Predict, options: LabelOptions): Promise<TrainingLabel> {
  const o = { ...LABEL_DEFAULTS, ...options };
  const canon = canonical(board, player);
  if (result(canon, 1)) throw new Error('Terminal positions have no training label');
  const remaining = TOTAL_TILES - tileCount(canon);
  const moves = legal(canon, 1);
  const base = { v: TRAINING_LABEL_VERSION, board: canon, remaining };

  if (remaining <= o.exactMaxRemaining) {
    try {
      const solver = new ExactEndgame(o.nodeLimit);
      const best = solver.value(canon, 1);
      // 자식 값 c = -value(child). c >= best 인지 null window(-best, -best+1)로 확인한다(정수 값).
      const optimal = moves.filter(a => -solver.value(apply(canon, 1, a).board, -1, -best, -best + 1) >= best);
      if (!optimal.length) throw new Error('Inconsistent exact solve: no optimal move');
      return { ...base, tier: 'exact', value: Math.sign(best), margin: best, policy: optimal.map(a => [a, round(1 / optimal.length)]), search: null };
    } catch (e) { if (!limitExceeded(e)) throw e; }
  }

  let outcome: number | null = null, margin: number | null = null;
  if (remaining <= o.provenMaxRemaining) {
    const solver = new ExactEndgame(o.nodeLimit);
    try { outcome = Math.sign(solver.value(canon, 1, -1, 1)); } catch (e) { if (!limitExceeded(e)) throw e; }
    if (outcome !== null && remaining <= o.marginMaxRemaining) {
      try { margin = new ExactEndgame(o.nodeLimit).value(canon, 1); } catch (e) { if (!limitExceeded(e)) throw e; }
    }
  }

  const root = await search(canon, o.sims, predict, { details: 'none', random: () => 0 });
  const total = [...root.visits.values()].reduce((a, b) => a + b, 0);
  const policy: [number, number][] = moves.length === 1 ? [[moves[0], 1]]
    : [...root.visits].filter(([, n]) => n > 0).sort((a, b) => a[0] - b[0]).map(([a, n]) => [a, round(n / total)]);
  if (!policy.length || policy.some(([a]) => a !== PASS && !moves.includes(a))) throw new Error('Search returned no legal policy');
  const info = { sims: root.simulations, q: round(root.value), mean: round(root.meanValue), model: o.model };
  return outcome !== null
    ? { ...base, tier: 'proven', value: outcome, margin, policy, search: info }
    : { ...base, tier: 'search', value: round(root.value), margin: null, policy, search: info };
}
