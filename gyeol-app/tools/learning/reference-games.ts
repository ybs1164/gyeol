/** 관문의 빠른 분석 비교에 쓰는 기준 대국 8판(tools/bench_standard_vs_deep.ts 와 같은 목록). */
import { existsSync, readFileSync } from 'node:fs';
import { analyzeGameGrades, gameReport, type GameAnalysis } from '../../packages/ai/src/index';
import type { LoadedModel } from './lib';
import type { Player } from '../../packages/core/src/index';

export type RefGame = { id: string; moves: number[]; start?: { board: number[]; player: Player } };
export function referenceGameList(): RefGame[] {
  const source = JSON.parse(readFileSync('tools/record-puzzles/source-games.json', 'utf8')) as { games: { id: string; moves: number[]; initial: number[]; initialPlayer: Player }[] };
  return [
    { id: 'master-vs-master', moves: [389, 368, 392, 378, 390, 408, 301, 289, 310, 298, 414, 426, 542, 538, 358, 478, 647, 624, 589, 631, 515, 496, 784, 465] },
    ...source.games.slice(0, 7).map(g => ({ id: g.id, moves: g.moves, start: { board: g.initial, player: g.initialPlayer } })),
  ];
}

/** 저장된 정밀 분석 기준(기본: 현재 배포 모델 26e68559로 만든 tools/analysis/standard-vs-deep-5bcbf837. 이전 모델 9ec913ce 기준은 standard-vs-deep). */
export function referenceGames(dir = 'tools/analysis/standard-vs-deep-5bcbf837'): { game: RefGame; deep: GameAnalysis }[] {
  const games = referenceGameList();
  return games.map(game => {
    const file = `${dir}/deep-${game.id}.json`;
    if (!existsSync(file)) throw new Error(`Missing deep reference ${file}`);
    return { game, deep: (JSON.parse(readFileSync(file, 'utf8')) as { analysis: GameAnalysis }).analysis };
  });
}
export async function fastVsDeep(model: LoadedModel, refs: ReturnType<typeof referenceGames>) {
  let moves = 0, agree = 0, lossGap = 0, accGap = 0, sides = 0, ms = 0;
  for (const { game, deep } of refs) {
    model.clearCache();
    const t = performance.now();
    // 벽시계 예산을 끄고 노드 한도(일반 분석과 같은 100만)로만 푼다: CPU 속도·부하와 무관하게 같은 결과
    const fast = await analyzeGameGrades(game.moves, model.predict, { start: game.start, mode: 'standard', exactMs: Number.POSITIVE_INFINITY });
    ms += performance.now() - t;
    fast.moves.forEach((m, i) => {
      const d = deep.moves[i];
      if (!m || !d || m.forced || d.forced) return;
      moves++; lossGap += Math.abs(m.lossPoints - d.lossPoints);
      if (m.bestActions.includes(m.played) === d.bestActions.includes(d.played)) agree++;
    });
    for (const p of [1, -1] as const) {
      const x = gameReport(fast, p).accuracy, y = gameReport(deep, p).accuracy;
      if (x !== null && y !== null) { accGap += Math.abs(x - y); sides++; }
    }
  }
  return { games: refs.length, moves, bestAgreement: +(100 * agree / moves).toFixed(1), accuracyGap: +(accGap / sides).toFixed(1), meanLossGap: +(lossGap / moves).toFixed(1), secondsPerGame: +(ms / refs.length / 1000).toFixed(1) };
}

