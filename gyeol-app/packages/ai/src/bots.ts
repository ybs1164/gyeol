import { PASS, legal, type Board } from '@gyeol/core';
import { search, type Predict } from './mcts';

export type Level = 'easy' | 'normal' | 'hard' | 'master';

export interface LevelInfo {
  id: Level;
  name: string;
  description: string;
  /** MCTS 시뮬레이션 수 (0 = 탐색 없이 정책만) */
  sims: number;
  /** 최대 생각 시간(ms) */
  budget: number;
}

export const LEVELS: LevelInfo[] = [
  { id: 'easy', name: '입문', description: '규칙을 익히는 상대', sims: 0, budget: 0 },
  { id: 'normal', name: '보통', description: '가볍게 한 판', sims: 32, budget: 3000 },
  { id: 'hard', name: '어려움', description: '수를 깊게 읽음', sims: 200, budget: 6000 },
  { id: 'master', name: '최강', description: '학습된 AI의 전력', sims: 800, budget: 12000 },
];

export const levelInfo = (id: Level) => LEVELS.find((l) => l.id === id)!;

function sample(weights: number[], random: () => number): number {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return Math.floor(random() * weights.length);
  let draw = random() * total;
  for (let i = 0; i < weights.length; i++) if ((draw -= weights[i]) < 0) return i;
  return weights.length - 1;
}

/** 정규 보드(둘 차례 = +1)에서 난이도에 맞는 수를 고른다. */
export async function chooseMove(board: Board, level: Level, predict: Predict, random: () => number = Math.random): Promise<number> {
  const moves = legal(board, 1);
  if (moves.length === 1) return moves[0];
  if (moves[0] === PASS) return PASS;
  const info = levelInfo(level);
  if (info.sims === 0) {
    // 입문: 3번 중 1번은 아무 수, 나머지는 정책에서 넓게(온도 2) 뽑는다
    if (random() < 0.35) return moves[Math.floor(random() * moves.length)];
    const { priors } = await predict(board);
    return moves[sample(moves.map((_, i) => Math.pow(Math.max(priors[i], 0), 0.5)), random)];
  }
  const deadline = performance.now() + info.budget;
  return (await search(board, info.sims, predict, { random, deadline })).action;
}
