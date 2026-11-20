import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseEngine } from './database';
import { backupDatabase, importJson, readSource, restoreCheck, verifyDatabase } from './db-tools';

const [command, ...args] = process.argv.slice(2);
function option(name: string, required = true) {
  const at = args.indexOf(`--${name}`), value = at >= 0 ? args[at + 1] : undefined;
  if ((!value || value.startsWith('--')) && required) throw new Error(`--${name} is required`);
  return value && !value.startsWith('--') ? value : undefined;
}
let engine: DatabaseEngine | undefined;
try {
  let report: unknown;
  if (command === 'import-json') report = importJson(option('source')!, option('db')!);
  else if (command === 'restore-check') report = restoreCheck(option('source')!);
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
      default: throw new Error('Use migrate, import-json, verify, backup, or restore-check');
    }
  }
  const reportFile = option('report', false);
  if (reportFile) writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`DB operation failed: ${(error as Error).message}`); process.exitCode = 1;
} finally { engine?.close(); }
