/** 승률 그래프가 둘 차례에 따라 톱니처럼 흔들리는지 평가 방식별로 잰다. npx tsx tools/analysis/diag_win_zigzag.ts [games] [sims] */
import { readFileSync } from 'node:fs';
import { search, replayAnalysis } from '../../packages/ai/src/index';
import { canonical, result, type Player } from '../../packages/core/src/index';
import { loadBrainContext } from '../../packages/server/src/brain';

const count = Number(process.argv[2] ?? 20), sims = Number(process.argv[3] ?? 128);
const master = { id: 'master-vs-master', moves: [389,368,392,378,390,408,301,289,310,298,414,426,542,538,358,478,647,624,589,631,515,496,784,465], initial: undefined as number[] | undefined, initialPlayer: 1 as Player };
const source = JSON.parse(readFileSync('tools/record-puzzles/source-games.json', 'utf8')) as { games: { id: string; moves: number[]; initial: number[]; initialPlayer: Player }[] };
const games = [master, ...source.games.slice(0, count)];
const brain = await loadBrainContext('apps/web/public', 50_000);
type Kind = 'network' | 'rootMean' | 'rootQ';
const kinds: Kind[] = ['network', 'rootMean', 'rootQ'];
const agg = Object.fromEntries(kinds.map(k => [k, { bias: 0, rough: 0, n: 0 }])) as Record<Kind, { bias: number; rough: number; n: number }>;
for (const game of games) {
  const positions = replayAnalysis(game.moves, game.initial ? { board: game.initial, player: game.initialPlayer } : undefined);
  const green: Record<Kind, (number | null)[]> = { network: [], rootMean: [], rootQ: [] };
  for (const pos of positions) {
    if (result(pos.board, pos.player)) { for (const k of kinds) green[k].push(null); continue; }
    const b = canonical(pos.board, pos.player);
    const toGreen = (v: number) => pos.player === 1 ? (v + 1) / 2 : (1 - v) / 2;
    green.network.push(toGreen((await brain.predict(b)).value));
    const root = await search(b, sims, brain.predict, { details: 'none', random: () => 0 });
    green.rootMean.push(toGreen(root.meanValue)); green.rootQ.push(toGreen(root.value));
  }
  for (const k of kinds) {
    const g = green[k];
    for (let i = 1; i < g.length - 1; i++) {
      if (g[i] === null || g[i - 1] === null || g[i + 1] === null) continue;
      const dev = g[i]! - (g[i - 1]! + g[i + 1]!) / 2;
      // 양수: 둘 차례인 쪽을 이웃 국면보다 낙관. 음수: 비관.
      agg[k].bias += (positions[i].player === 1 ? 1 : -1) * dev; agg[k].rough += Math.abs(dev); agg[k].n++;
    }
  }
  if (game === master) for (const k of kinds) console.log(k.padEnd(9), green[k].map(v => v === null ? ' -- ' : v.toFixed(2)).join(' '));
}
console.log(`\n${games.length} games, ${sims} sims. bias = mover-signed deviation from neighbours (negative = mover underestimated); rough = mean |deviation|`);
for (const k of kinds) console.log(k.padEnd(9), 'bias', (agg[k].bias / agg[k].n).toFixed(3), ' rough', (agg[k].rough / agg[k].n).toFixed(3), ' n', agg[k].n);
await brain.dispose();
