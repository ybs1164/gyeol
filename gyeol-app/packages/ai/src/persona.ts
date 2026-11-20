import { PASS, legal, type Board } from '@gyeol/core';
import { search, type Predict } from './mcts';

/**
 * 온라인 대국용 AI 플레이어(봇)의 성격.
 * 같은 학습 모델을 쓰고, "실수 확률"과 탐색량만 달리해서 실력을 나눈다.
 */
export interface Persona {
  id: string;
  /** 대국에 보이는 이름 (12자 이하) */
  name: string;
  /** 한 수마다 최선 대신 실수를 둘 확률 */
  mistake: number;
  /** 실수하지 않을 때 MCTS 시뮬레이션 수 (0 = 정책망의 첫 후보) */
  sims: number;
  /** 기준 AI를 매 수 확률적으로 선택한다. sims는 평균 탐색량. */
  blend?: { lower: string; upper: string; weight: number };
}

/** 초급부터 MCTS 512회까지 실제 대전으로 실력을 측정할 기준 AI 12종. */
export const CALIBRATION_PERSONAS: Persona[] = [
  { id: 'anchor-01', name: '첫걸음', mistake: 0.99, sims: 0 },
  { id: 'anchor-02', name: '풀잎', mistake: 0.90, sims: 0 },
  { id: 'anchor-03', name: '아침', mistake: 0.75, sims: 0 },
  { id: 'anchor-04', name: '새싹', mistake: 0.55, sims: 0 },
  { id: 'anchor-05', name: '이슬', mistake: 0.35, sims: 0 },
  { id: 'anchor-06', name: '바람', mistake: 0.15, sims: 0 },
  { id: 'anchor-07', name: '돌담', mistake: 0.18, sims: 8 },
  { id: 'anchor-08', name: '솔숲', mistake: 0.10, sims: 16 },
  { id: 'anchor-09', name: '너울', mistake: 0.06, sims: 32 },
  { id: 'anchor-10', name: '노을', mistake: 0.03, sims: 64 },
  { id: 'anchor-11', name: '벼리', mistake: 0.01, sims: 128 },
  { id: 'anchor-12', name: '한결', mistake: 0, sims: 512 },
];

export const BOT_COUNT = 1000;
const NAMES = ['새싹', '이슬', '바람', '물결', '돌담', '솔숲', '너울', '노을', '벼리', '한결'];

/** 서로 다른 혼합 비율로 1,000명을 만든다. 평균 탐색량이 같은 봇도 실수 확률이 다르다. */
export function createPersonas(anchors: Persona[] = CALIBRATION_PERSONAS, count = BOT_COUNT, anchorRatings?: number[]): Persona[] {
  if (anchors.length < 2 || !Number.isInteger(count) || count < 2) throw new Error('기준 AI와 봇 수는 2 이상이어야 합니다');
  const points = anchorRatings ?? anchors.map((_, i) => i);
  if (points.length !== anchors.length || points.some((p, i) => !Number.isFinite(p) || (i > 0 && p <= points[i - 1]))) {
    throw new Error('기준 레이팅은 실측 실력 순서로 증가해야 합니다');
  }
  // 기존 10명의 ID·이름과 상대적 순서를 유지하고 새 AI들을 사이에 넣는다.
  const legacySlots = count >= 100 ? [3, 4, 5, 5.5, 6, 7, 8, 9, 10, 11].map((p) => Math.round((p / 11) * (count - 1))) : [];
  return Array.from({ length: count }, (_, i) => {
    const target = points[0] + (i / (count - 1)) * (points[points.length - 1] - points[0]);
    let lo = 0;
    while (lo < anchors.length - 2 && target > points[lo + 1]) lo++;
    const weight = (target - points[lo]) / (points[lo + 1] - points[lo]);
    const a = anchors[lo];
    const b = anchors[lo + 1];
    const legacy = legacySlots.indexOf(i);
    const serial = legacy >= 0 ? legacy + 1 : 11 + i - legacySlots.filter((p) => p < i).length;
    return {
      id: `bot-${String(serial).padStart(2, '0')}`,
      name: legacy >= 0 ? NAMES[legacy] : NAMES[(serial - 11) % NAMES.length] + String(Math.floor((serial - 11) / NAMES.length) + 2).padStart(2, '0'),
      mistake: a.mistake * (1 - weight) + b.mistake * weight,
      sims: a.sims * (1 - weight) + b.sims * weight,
      blend: { lower: a.id, upper: b.id, weight },
    };
  });
}

export const PERSONAS = createPersonas();
const ANCHORS = new Map(CALIBRATION_PERSONAS.map((p) => [p.id, p]));

function sample(weights: number[], random: () => number): number {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return Math.floor(random() * weights.length);
  let draw = random() * total;
  for (let i = 0; i < weights.length; i++) if ((draw -= weights[i]) < 0) return i;
  return weights.length - 1;
}

/**
 * 정규 보드(둘 차례 = +1)에서 봇의 수.
 * - 실수: 정책망의 최선 수를 뺀 나머지에서, 정책을 넓게 편 분포(온도 3)로 뽑는다.
 *   아무 수나 두는 것보다 사람이 할 법한 실수에 가깝다.
 * - 실수가 아니면: sims > 0 이면 MCTS, 아니면 정책을 좁게 편 분포(온도 0.25)로 뽑아 늘 같은 수만 두지 않게 한다.
 */
export async function personaMove(board: Board, persona: Persona, predict: Predict, random: () => number = Math.random): Promise<number> {
  if (persona.blend) {
    const { lower, upper, weight } = persona.blend;
    const picked = ANCHORS.get(random() < weight ? upper : lower);
    if (!picked) throw new Error('알 수 없는 기준 AI');
    return personaMove(board, picked, predict, random);
  }
  const moves = legal(board, 1);
  if (moves.length === 1) return moves[0];
  if (moves[0] === PASS) return PASS;
  const { priors } = await predict(board);
  const p = Array.from(moves, (_, i) => Math.max(priors[i], 0));
  let best = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;

  if (random() < persona.mistake) {
    const w = p.map((x, i) => (i === best ? 0 : Math.pow(x, 1 / 3)));
    return moves[sample(w, random)];
  }
  if (persona.sims > 0) return (await search(board, persona.sims, predict, { random })).action;
  return moves[sample(p.map((x) => Math.pow(x, 4)), random)];
}
