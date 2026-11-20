/** 대국 후반 국면의 실제 승패를 종국 탐색으로 확인한다. npx tsx tools/analysis/diag_win_exact.ts */
import { replayAnalysis } from '../../packages/ai/src/index';
import { ExactEndgame, TOTAL_TILES, tileCount, result } from '../../packages/core/src/index';

const moves = [389,368,392,378,390,408,301,289,310,298,414,426,542,538,358,478,647,624,589,631,515,496,784,465];
const positions = replayAnalysis(moves);
for (let i = positions.length - 1; i >= 0; i--) {
  const pos = positions[i];
  const remaining = TOTAL_TILES - tileCount(pos.board);
  if (result(pos.board, pos.player)) { console.log(i, 'terminal'); continue; }
  const solver = new ExactEndgame(50_000_000);
  const t = performance.now();
  try {
    const margin = solver.value(pos.board, pos.player);
    const green = Math.sign(margin) * pos.player;
    console.log(`pos ${i} remaining ${remaining} toMove ${pos.player === 1 ? 'green' : 'brown'} margin(toMove) ${margin} -> ${green > 0 ? 'GREEN wins' : green < 0 ? 'BROWN wins' : 'draw'} nodes ${solver.nodes} ${Math.round(performance.now() - t)}ms`);
  } catch (e) { console.log(`pos ${i} remaining ${remaining}: ${(e as Error).message} after ${Math.round(performance.now() - t)}ms`); break; }
}
