/** 실제 저장 기보 → 재현 → 후보 추출 → 독립 전수 검증 → 배포용 은행. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publishRecordPuzzles } from './publish_record_puzzles';

const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv.includes('--publish-only')) {
  for (const [program, args] of [
    ['python', ['tools/export_recorded_games.py']],
    [process.execPath, ['--import', 'tsx', 'tools/mine_record_puzzles.ts']],
    [process.execPath, ['--import', 'tsx', 'tools/verify_record_puzzles.ts']],
    [process.execPath, ['--import', 'tsx', 'tools/verify_record_rules.ts']],
  ] as [string, string[]][]) {
    const result = spawnSync(program, args, { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`Puzzle verification failed: ${args.join(' ')}`);
  }
}
publishRecordPuzzles();
