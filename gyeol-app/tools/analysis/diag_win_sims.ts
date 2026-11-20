/** 한 대국의 승률 그래프가 탐색 횟수에 따라 얼마나 흔들리는지 잰다. npx tsx tools/analysis/diag_win_sims.ts */
import { search, replayAnalysis } from '../../packages/ai/src/index';
import { canonical, result } from '../../packages/core/src/index';
import { loadBrainContext } from '../../packages/server/src/brain';

const moves = [389,368,392,378,390,408,301,289,310,298,414,426,542,538,358,478,647,624,589,631,515,496,784,465];
const positions = replayAnalysis(moves).slice(0, 18); // 18수 뒤로는 앱에서 종국 증명으로 대체된다
const brain = await loadBrainContext('apps/web/public', 200_000);
const stat = (g: number[]) => {
  let bias = 0, rough = 0, n = 0;
  for (let i = 1; i < g.length - 1; i++) { const dev = g[i] - (g[i - 1] + g[i + 1]) / 2; bias += (positions[i].player === 1 ? 1 : -1) * dev; rough += Math.abs(dev); n++; }
  return `bias ${(bias / n).toFixed(3)} rough ${(rough / n).toFixed(3)}`;
};
for (const sims of [128, 512, 2048]) {
  const mean: number[] = [], q: number[] = [];
  for (const pos of positions) {
    if (result(pos.board, pos.player)) break;
    const toGreen = (v: number) => pos.player === 1 ? (v + 1) / 2 : (1 - v) / 2;
    const root = await search(canonical(pos.board, pos.player), sims, brain.predict, { details: 'none', random: () => 0 });
    mean.push(toGreen(root.meanValue)); q.push(toGreen(root.value));
  }
  console.log(`sims ${String(sims).padStart(4)} mean ${stat(mean)} | ${mean.map(v => v.toFixed(2)).join(' ')}`);
  console.log(`          q    ${stat(q)} | ${q.map(v => v.toFixed(2)).join(' ')}`);
}
await brain.dispose();
