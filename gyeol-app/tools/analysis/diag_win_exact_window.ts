/** 승패만 필요할 때 좁은 창 탐색이 얼마나 빨라지는지 잰다. npx tsx tools/analysis/diag_win_exact_window.ts */
import { replayAnalysis } from '../../packages/ai/src/index';
import { ExactEndgame, TOTAL_TILES, tileCount } from '../../packages/core/src/index';

const moves = [389,368,392,378,390,408,301,289,310,298,414,426,542,538,358,478,647,624,589,631,515,496,784,465];
const positions = replayAnalysis(moves);
const shared = new ExactEndgame(20_000_000);
for (let i = 18; i >= 8; i--) {
  const pos = positions[i];
  const solver = new ExactEndgame(20_000_000);
  const t = performance.now();
  try {
    const v = solver.value(pos.board, pos.player, -1, 1);
    const t2 = performance.now(); const before = shared.nodes; const vs = shared.value(pos.board, pos.player, -1, 1);
    console.log(`pos ${i} remaining ${TOTAL_TILES - tileCount(pos.board)} sign ${Math.sign(v) * pos.player > 0 ? 'GREEN' : Math.sign(v) * pos.player < 0 ? 'BROWN' : 'draw?'} (v=${v}) fresh ${solver.nodes} nodes ${Math.round(t2 - t)}ms | shared-table +${shared.nodes - before} nodes ${Math.round(performance.now() - t2)}ms sign ${Math.sign(vs) === Math.sign(v)}`);
  } catch (e) { console.log(`pos ${i}: ${(e as Error).message} after ${Math.round(performance.now() - t)}ms`); break; }
}
