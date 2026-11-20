import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ExactEndgame, positionKey } from '../packages/core/src/endgame';
import { apply, isLegal, legal, margin, result, tileCount, type Board, type Player } from '../packages/core/src/rules';

const data = JSON.parse(readFileSync('tools/record-puzzles/source-games.json', 'utf8')) as {
  schema: number;
  games: { id: string; source: string; sourceIndex: string | number; initial: Board; initialPlayer: Player; moves: number[]; winner: number; margin: number; openingProof?: { prefix: number[] } }[];
};
if (data.schema !== 2) throw new Error('Export and validate recorded games first');
const puzzles: unknown[] = [];
const seen = new Set<string>();
const skipped: Record<string, number> = {};
const reject = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };

function symmetryKey(board: Board, player: Player): string {
  let best = '~';
  const dirs = [[-1, 0], [0, 1], [1, 0], [0, -1]];
  for (const flip of [false, true]) for (let k = 0; k < 4; k++) {
    const placed: [number, number, number][] = [];
    board.forEach((v, i) => {
      if (!v) return;
      let r = Math.floor(i / 7), c = i % 7;
      let [dr, dc] = dirs[Math.abs(v) - 1];
      if (flip) { c = 6 - c; dc = -dc; }
      for (let j = 0; j < k; j++) { [r, c] = [6 - c, r]; [dr, dc] = [-dc, dr]; }
      placed.push([r, c, Math.sign(v) * (dirs.findIndex(([a, b]) => a === dr && b === dc) + 1)]);
    });
    const rs = placed.map(([r]) => r), cs = placed.map(([, c]) => c);
    const r0 = Math.min(...rs), c0 = Math.min(...cs);
    const sr = Math.floor((7 - (Math.max(...rs) - r0 + 1)) / 2) - r0;
    const sc = Math.floor((7 - (Math.max(...cs) - c0 + 1)) / 2) - c0;
    const out = new Array<number>(49).fill(0);
    for (const [r, c, v] of placed) out[(r + sr) * 7 + c + sc] = v;
    const key = positionKey(out, player);
    if (key < best) best = key;
  }
  return best;
}

for (let gi = 0; gi < data.games.length; gi++) {
  const game = data.games[gi];
  let board = game.initial.slice(), player: Player = game.initialPlayer;
  const positions: { board: Board; player: Player; ply: number }[] = [];
  for (let ply = 0; ply < game.moves.length; ply++) {
    if (!isLegal(board, player, game.moves[ply]) || result(board, player)) throw new Error(`Bad source replay: ${game.id}/${ply}`);
    positions.push({ board, player, ply });
    board = apply(board, player, game.moves[ply]).board;
    player = -player as Player;
  }
  if (Math.sign(result(board, 1)) !== game.winner || margin(board) !== game.margin) throw new Error('Source result mismatch');
  for (const pos of positions.reverse()) {
    const { board: b, player: p, ply } = pos;
    const remaining = 25 - tileCount(b);
    if (remaining < 1 || remaining > 5 || game.winner !== p || margin(b) * p > 5) continue;
    if (legal(b, p).length < 4 || legal(b, p)[0] === 784) continue;
    const key = symmetryKey(b, p);
    if (seen.has(key)) { reject('symmetric-duplicate'); continue; }
    const solver = new ExactEndgame(500_000);
    try {
      const values = solver.values(b, p);
      const wins = values.filter(([, v]) => v > 0);
      if (!wins.some(([a]) => a === game.moves[ply])) { reject('recorded-move-not-winning'); continue; }
      if (!wins.length || wins.length > 6 || wins.length > values.length / 2 || Math.max(...wins.map(([, v]) => v)) < 5) { reject('not-clear-or-not-selective'); continue; }
      const proof = new Map<string, [number, number][]>();
      const walked = new Set<string>();
      let maxPlies = 0;
      const visit = (state: Board, turn: Player, depth: number) => {
        maxPlies = Math.max(maxPlies, depth);
        if (result(state, turn)) return;
        const key = positionKey(state, turn);
        const walkKey = `${turn === p}:${key}`;
        if (walked.has(walkKey)) return;
        walked.add(walkKey);
        if (proof.size > 180) throw new Error('Proof too large');
        const values = solver.values(state, turn);
        proof.set(key, values);
        if (turn === p) {
          for (const [a, value] of values) {
            const child = apply(state, turn, a).board;
            if (value > 0) visit(child, -turn as Player, depth + 1);
            else if (!result(child, -turn as Player)) proof.set(positionKey(child, -turn as Player), solver.values(child, -turn as Player));
          }
        } else {
          const best = Math.max(...values.map(([, v]) => v));
          const action = values.find(([, v]) => v === best)![0];
          visit(apply(state, turn, action).board, -turn as Player, depth + 1);
        }
      };
      visit(b, p, 0);
      const current = margin(b) * p;
      const kind = current < -2 ? 'turnaround' : current < 3 && Math.min(...wins.map(([, v]) => v)) >= 5 ? 'advantage' : 'win';
      const raw = 2 * remaining + Math.log2(values.length / wins.length) + 0.4 * Math.log2(1 + solver.nodes) + (current < 0 ? 0.4 : 0);
      const puzzle = {
        id: 'rp-' + createHash('sha256').update(key).digest('hex').slice(0, 16), kind, board: b, player: p,
        plies: maxPlies, target: Math.max(...wins.map(([, v]) => v)), raw,
        source: { gameId: game.id, type: game.source === 'online-record' ? 'online' : 'ai', reference: `${game.source}/${game.sourceIndex}`, ply, moveNumber: (game.openingProof?.prefix.length ?? 0) + ply + 1, playedMove: game.moves[ply] },
        proof: [...proof], solverNodes: solver.nodes, guaranteedMargin: Math.min(...wins.map(([, v]) => v)),
      };
      if (JSON.stringify(puzzle).length > 80_000) { reject('large-proof'); continue; }
      seen.add(key);
      puzzles.push(puzzle);
    } catch (error) {
      if (error instanceof Error && ['Exact endgame node limit exceeded', 'Proof too large'].includes(error.message)) reject(error.message);
      else throw error;
    }
  }
  if ((gi + 1) % 25 === 0) console.log(`${gi + 1}/${data.games.length} games; ${puzzles.length} certified candidates`);
}
writeFileSync('tools/record-puzzles/candidates.json', JSON.stringify(puzzles));
writeFileSync('tools/record-puzzles/mining-report.json', JSON.stringify({ sourceGames: data.games.length, candidates: puzzles.length, maxRemaining: 5, skipped }, null, 2));
console.log(JSON.stringify({ sourceGames: data.games.length, candidates: puzzles.length, skipped }));
