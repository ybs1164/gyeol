/** Keep the measured baseline intact, then run the frozen wider cohort after its anchor gate. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'tools/calibration/cognition-v2-wide');
const read = (file: string) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
const state = (value: object) => {
  const target = join(out, 'campaign.json');
  writeFileSync(`${target}.tmp`, JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString(), ...value }, null, 2) + '\n');
  renameSync(`${target}.tmp`, target);
};
const previous = read(join(out, 'campaign.json'));
if (previous?.pid && previous.pid !== process.pid && !['complete', 'failed', 'review-required'].includes(previous.state)) {
  try { process.kill(previous.pid, 0); throw new Error(`Campaign ${previous.pid} already running`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
for (;;) {
  const baseline = read(join(root, 'tools/calibration/cognition-v1/progress.json'));
  const anchor = read(join(out, 'anchor-check/progress.json'));
  const report = read(join(out, 'anchor-check/report.json'));
  if (anchor?.state === 'failed' || report?.complete && !report.passed) {
    state({ state: 'review-required', reason: 'Wide profiles did not pass the independent anchor range gate', anchor });
    process.exitCode = 1;
    break;
  }
  if (baseline?.finished === baseline?.planned && report?.passed) {
    state({ state: 'running', baselineGames: baseline.finished, anchorGames: report.games, workers: 6, planned: 60000 });
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'tools/calibrate_cognitive_bots_v2.ts'),
      '--workers', '6', '--out', out, '--rounds', '50', '--validation-rounds', '10'],
      { cwd: root, windowsHide: true, stdio: 'inherit' });
    const code = await new Promise<number | null>((done, fail) => { child.on('error', fail); child.on('close', done); });
    const progress = read(join(out, 'progress.json'));
    state({ state: code === 0 ? 'complete' : 'failed', exitCode: code, progress });
    process.exitCode = code ?? 1;
    break;
  }
  state({ state: 'waiting-for-baseline-and-anchor-check', baselineFinished: baseline?.finished ?? 0,
    baselinePlanned: baseline?.planned ?? 60000, anchorFinished: anchor?.finished ?? 0,
    anchorPlanned: anchor?.planned ?? 224, next: '60,000 wide-profile games; 100 fitting and 20 validation games per bot' });
  await new Promise(done => setTimeout(done, 30000));
}
