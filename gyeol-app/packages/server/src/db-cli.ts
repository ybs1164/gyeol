import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseEngine } from './database';
import { backupDatabase, importJson, readSource, restoreCheck, verifyDatabase } from './db-tools';
import { exportTrainingPositions } from './training-export';
import { minePuzzles } from './puzzle-miner';

const [command, ...args] = process.argv.slice(2);
function option(name: string, required = true) {
  const at = args.indexOf(`--${name}`), value = at >= 0 ? args[at + 1] : undefined;
  if ((!value || value.startsWith('--')) && required) throw new Error(`--${name} is required`);
  return value && !value.startsWith('--') ? value : undefined;
}
const many = (name: string) => args.flatMap((a, i) => a === `--${name}` && args[i + 1] && !args[i + 1].startsWith('--') ? [args[i + 1]] : []);
const count = (name: string) => { const v = option(name, false); if (v === undefined) return undefined; const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`); return n; };
let engine: DatabaseEngine | undefined;
try {
  let report: unknown;
  if (command === 'import-json') report = importJson(option('source')!, option('db')!);
  else if (command === 'restore-check') report = restoreCheck(option('source')!);
  // 운영 DB를 읽기 전용으로 열어 학습 국면을 내보낸다(docs/continuous-learning-plan.md ①)
  else if (command === 'export-training') report = exportTrainingPositions({
    db: resolve(option('db')!), out: resolve(option('out')!), exclude: many('exclude'),
    playerCap: count('player-cap'), minPlies: count('min-plies'), maxGames: count('max-games'),
  });
  // 기보에서 정답이 하나뿐인 퍼즐을 발췌해 서버가 내려줄 은행을 만든다(운영 DB는 읽기 전용)
  else if (command === 'mine-puzzles') {
    const db = option('db', false), archive = option('archive', false);
    if (!db && !archive) throw new Error('--db or --archive is required');
    report = minePuzzles({
      db: db && resolve(db), archive: archive && resolve(archive), state: resolve(option('state')!),
      out: option('out', false) && resolve(option('out', false)!), budgetMinutes: count('budget-minutes'), maxRemaining: count('max-remaining'),
      log: (line) => console.error(line),
    });
  }
  else {
    const file = resolve(option('db')!);
    if (command === 'migrate' && !existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true }); closeSync(openSync(file, 'wx', 0o600));
    }
    engine = new DatabaseEngine(file);
    switch (command) {
      case 'migrate': report = engine.health(); break;
      case 'verify': {
        const source = option('source', false); report = verifyDatabase(engine, source ? readSource(source).data : undefined); break;
      }
      case 'backup': {
        const destination = await backupDatabase(engine, option('output')!);
        report = { ...restoreCheck(destination), destination }; break;
      }
      default: throw new Error('Use migrate, import-json, verify, backup, restore-check, export-training, or mine-puzzles');
    }
  }
  const reportFile = option('report', false);
  if (reportFile) writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`DB operation failed: ${(error as Error).message}`); process.exitCode = 1;
} finally { engine?.close(); }
