/**
 * P3 파일럿 전용: 봇 대국에서 P1과 같은 형식의 국면 파일을 만든다(서버 DB가 아직 작아서).
 * 얼린 시험 세트가 뽑힌 대국은 통째로 빼고, 시험 세트 국면(대칭 포함)도 뺀다.
 *   npx tsx tools/learning/pilot_positions.ts --out <폴더> [--exact 30000] [--proven 1500] [--search 3000]
 * exact: 남은 타일 ≤6, proven: 7~9, search: ≥10 에서 각각 뽑을 국면 수.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TOTAL_TILES, apply, initial, legal, PASS, result, symmetryKey, tileCount, type Board, type Player } from '../../packages/core/src/index';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const out = resolve(arg('--out', ''));
const quota = { exact: Number(arg('--exact', '30000')), proven: Number(arg('--proven', '1500')), search: Number(arg('--search', '3000')) };
const SEED = 20261122;
const digest = (k: string) => createHash('sha256').update(k).digest('hex').slice(0, 16);
const tierOf = (r: number) => (r <= 6 ? 'exact' : r <= 9 ? 'proven' : 'search') as keyof typeof quota;

const manifest = JSON.parse(readFileSync('tools/learning/frozen/exact-test-v1.manifest.json', 'utf8'));
const frozen = readFileSync(manifest.file.path, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { source: string; game: number; board: Board; player: Player });
const testGames = new Set(frozen.map(f => `${f.source}#${f.game}`));
const testKeys = new Set(frozen.map(f => digest(symmetryKey(f.board, f.player))));

let s = SEED;
const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
const games: { source: string; n: number; moves: number[] }[] = [];
for (const { path } of manifest.sources as { path: string }[]) {
  for (const line of readFileSync(path, 'utf8').split('\n')) if (line) { const g = JSON.parse(line); games.push({ source: path, n: g.n, moves: g.moves }); }
}
for (let i = games.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [games[i], games[j]] = [games[j], games[i]]; }

const picked: Record<string, string[]> = { exact: [], proven: [], search: [] };
const seen = new Set<string>();
let skippedGames = 0, skippedKeys = 0;
for (const g of games) {
  if (Object.entries(quota).every(([t, q]) => picked[t].length >= q)) break;
  if (testGames.has(`${g.source}#${g.n}`)) { skippedGames++; continue; }
  let board = initial(), player: Player = 1;
  for (const a of g.moves) {
    const remaining = TOTAL_TILES - tileCount(board), tier = tierOf(remaining);
    const moves = legal(board, player);
    // 대국마다 구간당 한 국면 정도만(이웃 국면 상관을 줄인다)
    if (picked[tier].length < quota[tier] && !(moves.length === 1 && moves[0] === PASS) && rand() < 0.35) {
      const key = digest(symmetryKey(board, player));
      if (testKeys.has(key)) skippedKeys++;
      else if (!seen.has(key)) { seen.add(key); picked[tier].push(JSON.stringify({ board, player, remaining })); }
    }
    board = apply(board, player, a).board; player = -player as Player;
    if (result(board, player)) break;
  }
}
mkdirSync(out, { recursive: true });
const lines = [...picked.exact, ...picked.proven, ...picked.search];
writeFileSync(join(out, 'positions-000001-pilot.jsonl'), lines.join('\n') + '\n');
console.log(JSON.stringify({ written: lines.length, exact: picked.exact.length, proven: picked.proven.length, search: picked.search.length, skippedTestGames: skippedGames, skippedTestKeys: skippedKeys }));
