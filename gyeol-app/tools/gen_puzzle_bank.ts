/**
 * 개발용: 서버와 같은 생성기로 보관 기보(와 있으면 로컬 DB)에서 정답이 하나뿐인 퍼즐 은행을 만든다.
 * 운영 은행은 서버의 gyeol-puzzles.timer 가 /var/lib/gyeol/puzzles/bank.json 에 만든다.
 *   npm run puzzles                      → packages/server/data/puzzles/bank.json (npm run server 가 /api/puzzles 로 제공)
 *   npm run puzzles -- --db <sqlite>     → 로컬 온라인 대국도 원본에 포함
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { minePuzzles } from '../packages/server/src/puzzle-miner';
import { syncPuzzleScale } from './puzzle_scale';

const root = fileURLToPath(new URL('../', import.meta.url));
const at = process.argv.indexOf('--db');
const db = at > 0 ? process.argv[at + 1] : `${root}packages/server/data/gyeol.sqlite`;
syncPuzzleScale();
const report = minePuzzles({
  archive: `${root}tools/record-puzzles/source-games.json`, db: existsSync(db) ? db : undefined,
  state: `${root}packages/server/data/puzzles`, budgetMinutes: 600, log: (line) => console.error(line),
});
console.log(JSON.stringify(report, null, 2));
