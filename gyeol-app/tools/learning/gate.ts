/**
 * P4: 후보 모델의 자동 관문. 모든 항목을 통과해야 배포 후보가 된다(배포는 사람이 보고서를 보고 승인).
 *   npx tsx tools/learning/gate.ts --candidate <후보 model.onnx> --out <보고서 폴더>
 *     [--baseline apps/web/public/model/model.onnx] [--arena-max 600] [--arena-sims 64] [--seed 1]
 * 결과: <out>/gate.json, <out>/report.md. 통과하면 종료 코드 0, 아니면 2.
 *
 * 기준은 실행 전에 고정한다(CRITERIA). 결과를 보고 바꾸지 않는다. 바꾸려면 GATE_VERSION 을 올리고 문서에 남긴다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { search } from '../../packages/ai/src/index';
import { PASS, apply, canonical, initial, legal, result, type Board, type Player } from '../../packages/core/src/index';
import { loadModel, scoreModel, type LoadedModel, type ScoreReport } from './lib';
import { fastVsDeep, referenceGames } from './reference-games';

/**
 * 2: 빠른 분석 비교를 시간 예산 없이(노드 한도만) 잰다. v1 은 정확 탐색의 1.5초 벽시계 예산 때문에
 *    CPU 부하에 따라 같은 모델의 일치율이 68.5~70.1%로 달라졌다. 기준(임계값)은 바꾸지 않았다.
 */
export const GATE_VERSION = 2;
/** 정밀 분석 기준(tools/analysis/standard-vs-deep/deep-*.json)을 만든 모델. 기준 모델이 바뀌면 기준을 다시 만든다. */
const REFERENCE_MODEL = '26e68559dd6a1631';
const CRITERIA = {
  /** 신경망 단독: 시험 세트 Brier 가 기준 모델보다 낮다 */
  networkBrier: 'candidate < baseline',
  /** 신경망 단독: 승패 적중률이 기준 모델 이상 */
  networkAccuracy: 'candidate >= baseline',
  /** 64회 탐색: Brier 가 기준 모델보다 0.005 넘게 나빠지지 않는다 */
  searchBrier: 'candidate <= baseline + 0.005',
  /** 타일 차이 출력: 평균 오차가 기준 모델의 승률 환산(expectedMargin, 64회 탐색)보다 작다 */
  marginHead: 'candidate head MAE < baseline search marginMae',
  /** 빠른 분석(일반 분석)이 기준 모델의 정밀 분석과 최선수 판정이 일치하는 비율이 기준 모델 이상(−0.5%p 허용) */
  fastVsDeep: 'candidate bestAgreement >= baseline - 0.5',
  /** 대국 강도: SPRT H0 Elo −50, H1 Elo 0, α=β=0.05. H1 채택(50 Elo 넘게 약하지 않음)이어야 통과. 판정 못 하면 실패. 같은 실력이면 평균 약 290판에서 통과 */
  strength: 'SPRT accepts H1',
  /** 추론 시간 1.2배 이하, 파일 3MB 이하, 정책·가치 출력 유지 */
  safety: 'infer <= 1.2x, size <= 3MB',
} as const;

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(name);
  if (i > 0) return process.argv[i + 1];
  if (fallback === undefined) throw new Error(`${name} is required`);
  return fallback;
};

// ---- 정밀 분석 대비 빠른 분석 ----
// ---- 대국 강도 ----
function openings(count: number, seed: number): number[][] {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
  const out: number[][] = [], seen = new Set<string>();
  while (out.length < count) {
    const length = 2 + Math.floor(rand() * 7); // 2~8수
    let board = initial(), player: Player = 1;
    const moves: number[] = [];
    for (let i = 0; i < length && !result(board, player); i++) {
      const options = legal(board, player);
      const a = options[Math.floor(rand() * options.length)];
      moves.push(a); board = apply(board, player, a).board; player = -player as Player;
    }
    const key = board.join(',') + player;
    if (!result(board, player) && !seen.has(key)) { seen.add(key); out.push(moves); }
  }
  return out;
}
/** 후보 점수(승 1, 무 0.5, 패 0) */
async function play(opening: number[], candidateColor: Player, candidate: LoadedModel, baseline: LoadedModel, sims: number): Promise<number> {
  let board: Board = initial(), player: Player = 1;
  for (const a of opening) { board = apply(board, player, a).board; player = -player as Player; }
  for (let ply = 0; ply < 200; ply++) {
    const end = result(board, player);
    if (end) {
      const winner = Math.abs(end) < 0.5 ? 0 : Math.sign(end) * player;
      return winner === 0 ? 0.5 : winner === candidateColor ? 1 : 0;
    }
    const options = legal(board, player);
    const brain = player === candidateColor ? candidate : baseline;
    const action = options.length === 1 ? options[0] : (await search(canonical(board, player), sims, brain.predict, { details: 'none', random: () => 0 })).action;
    if (action !== PASS && !options.includes(action)) throw new Error('Illegal arena move');
    board = apply(board, player, action).board; player = -player as Player;
  }
  throw new Error('Arena game did not finish');
}
const eloScore = (elo: number) => 1 / (1 + 10 ** (-elo / 400));
/** 일반화 SPRT(정규 근사) 로그 우도비 */
function llr(scores: number[], elo0: number, elo1: number) {
  const n = scores.length;
  if (n < 2) return 0;
  const m = scores.reduce((a, b) => a + b, 0) / n;
  const variance = scores.reduce((a, x) => a + (x - m) ** 2, 0) / n;
  if (variance <= 0) return 0;
  const s0 = eloScore(elo0), s1 = eloScore(elo1);
  return n * (s1 - s0) * (2 * m - s0 - s1) / (2 * variance);
}
async function arena(candidate: LoadedModel, baseline: LoadedModel, { max, sims, seed, log }: { max: number; sims: number; seed: number; log: (s: string) => void }) {
  const alpha = 0.05, beta = 0.05, lower = Math.log(beta / (1 - alpha)), upper = Math.log((1 - beta) / alpha);
  const scores: number[] = [];
  let decision: 'H1' | 'H0' | 'inconclusive' = 'inconclusive', value = 0;
  for (const opening of openings(Math.ceil(max / 2), seed)) {
    // 같은 시작 국면을 색을 바꿔 두 번 둔다
    scores.push(await play(opening, 1, candidate, baseline, sims), await play(opening, -1, candidate, baseline, sims));
    value = llr(scores, -50, 0);
    if (scores.length % 20 === 0) log(`  arena ${scores.length} games, score ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(3)}, LLR ${value.toFixed(2)}`);
    if (value >= upper) { decision = 'H1'; break; }
    if (value <= lower) { decision = 'H0'; break; }
  }
  const score = scores.reduce((a, b) => a + b, 0) / scores.length;
  return { games: scores.length, score: +score.toFixed(4), wins: scores.filter(x => x === 1).length, draws: scores.filter(x => x === 0.5).length, losses: scores.filter(x => x === 0).length, llr: +value.toFixed(3), bounds: [+lower.toFixed(3), +upper.toFixed(3)], decision, sims };
}

// ---- 추론 시간 ----
async function inferenceMs(model: LoadedModel, boards: Board[]) {
  model.clearCache();
  const t = performance.now();
  for (const b of boards) await model.predict(b);
  return (performance.now() - t) / boards.length;
}

// ---- 실행 ----
async function main() {
  const candidatePath = resolve(arg('--candidate')), baselinePath = resolve(arg('--baseline', 'apps/web/public/model/model.onnx'));
  const out = resolve(arg('--out'));
  const arenaMax = Number(arg('--arena-max', '600')), arenaSims = Number(arg('--arena-sims', '64')), seed = Number(arg('--seed', '1'));
  mkdirSync(out, { recursive: true });
  const started = Date.now();
  const log = (s: string) => console.log(s);
  const [candidate, baseline] = [await loadModel(candidatePath), await loadModel(baselinePath)];
  if (candidate.sha === baseline.sha) log('note: candidate and baseline are the same file (self-check run)');

  log('1/4 exact test set');
  const score = { candidate: (await scoreModel(candidatePath, { log })).report, baseline: (await scoreModel(baselinePath, { log })).report };
  log('2/4 fast analysis vs deep references');
  const refs = referenceGames();
  const deep = { candidate: await fastVsDeep(candidate, refs), baseline: await fastVsDeep(baseline, refs), referenceModel: REFERENCE_MODEL, referencesMatchBaseline: baseline.sha.startsWith(REFERENCE_MODEL) };
  log('3/4 arena');
  const strength = await arena(candidate, baseline, { max: arenaMax, sims: arenaSims, seed, log });
  log('4/4 safety');
  const frozen = readFileSync('tools/learning/frozen/exact-test-v1.jsonl', 'utf8').trim().split('\n').slice(0, 1000).map(l => { const r = JSON.parse(l); return canonical(r.board, r.player); });
  const infer = { candidate: await inferenceMs(candidate, frozen), baseline: await inferenceMs(baseline, frozen) };
  const sample = await candidate.predict(frozen[0]);
  await candidate.dispose(); await baseline.dispose();

  const net = (r: ScoreReport) => r.network.all, srch = (r: ScoreReport) => r.search.all;
  const checks = {
    networkBrier: { pass: net(score.candidate).brier < net(score.baseline).brier, candidate: net(score.candidate).brier, baseline: net(score.baseline).brier },
    networkAccuracy: { pass: net(score.candidate).accuracy >= net(score.baseline).accuracy, candidate: net(score.candidate).accuracy, baseline: net(score.baseline).accuracy },
    searchBrier: { pass: srch(score.candidate).brier <= srch(score.baseline).brier + 0.005, candidate: srch(score.candidate).brier, baseline: srch(score.baseline).brier },
    marginHead: { pass: net(score.candidate).marginHeadMae != null && net(score.candidate).marginHeadMae! < srch(score.baseline).marginMae!, candidate: net(score.candidate).marginHeadMae ?? null, baseline: srch(score.baseline).marginMae },
    fastVsDeep: { pass: deep.referencesMatchBaseline && deep.candidate.bestAgreement >= deep.baseline.bestAgreement - 0.5, candidate: deep.candidate.bestAgreement, baseline: deep.baseline.bestAgreement, referencesMatchBaseline: deep.referencesMatchBaseline },
    strength: { pass: strength.decision === 'H1', candidate: strength.score, baseline: 1 - strength.score, decision: strength.decision, games: strength.games },
    safety: { pass: infer.candidate <= 1.2 * infer.baseline && candidate.bytes <= 3_000_000 && Number.isFinite(sample.value) && sample.priors.length > 0, candidate: +infer.candidate.toFixed(3), baseline: +infer.baseline.toFixed(3), bytes: candidate.bytes },
  };
  const pass = Object.values(checks).every(c => c.pass);
  const gate = {
    version: GATE_VERSION, pass, created: new Date().toISOString(), minutes: +((Date.now() - started) / 60000).toFixed(1),
    candidate: { path: candidatePath.replaceAll('\\', '/'), sha256: candidate.sha }, baseline: { path: baselinePath.replaceAll('\\', '/'), sha256: baseline.sha },
    criteria: CRITERIA, checks, details: { score, deep, strength, inferenceMs: infer },
  };
  writeFileSync(join(out, 'gate.json'), JSON.stringify(gate, null, 2) + '\n');
  writeFileSync(join(out, 'report.md'), reportMarkdown(gate));
  log(`${pass ? 'PASS' : 'FAIL'} — ${Object.entries(checks).map(([k, c]) => `${k} ${c.pass ? 'ok' : 'x'}`).join(', ')}`);
  log(`wrote ${join(out, 'report.md')}`);
  process.exitCode = pass ? 0 : 2;
}

const NAMES: Record<keyof typeof CRITERIA, string> = {
  networkBrier: '신경망 단독 Brier(낮을수록 좋음)', networkAccuracy: '신경망 단독 승패 적중률', searchBrier: '64회 탐색 Brier',
  marginHead: '타일 차이 평균 오차(장)', fastVsDeep: '빠른 분석의 정밀 분석 일치율(%)', strength: '대국 강도(후보 점수)', safety: '추론 시간(ms)',
};
function reportMarkdown(g: { pass: boolean; created: string; minutes: number; candidate: { sha256: string }; baseline: { sha256: string }; checks: Record<string, { pass: boolean; candidate: unknown; baseline: unknown }>; details: { strength: { games: number; wins: number; draws: number; losses: number; decision: string }; score: { candidate: ScoreReport; baseline: ScoreReport } } }) {
  const rows = Object.entries(g.checks).map(([k, c]) => `| ${NAMES[k as keyof typeof CRITERIA]} | ${c.candidate} | ${c.baseline} | \`${CRITERIA[k as keyof typeof CRITERIA]}\` | ${c.pass ? '✅' : '❌'} |`);
  const s = g.details.strength, rem = (r: ScoreReport) => r.network.byRemaining;
  const byR = Object.keys(rem(g.details.score.candidate)).map(r => `| ${r} | ${(rem(g.details.score.candidate)[r].brier ?? 0).toFixed(3)} | ${(rem(g.details.score.baseline)[r].brier ?? 0).toFixed(3)} | ${((rem(g.details.score.candidate)[r].accuracy ?? 0) * 100).toFixed(1)}% | ${((rem(g.details.score.baseline)[r].accuracy ?? 0) * 100).toFixed(1)}% |`);
  return `# 모델 관문 보고서

- 결과: **${g.pass ? '통과 — 배포 승인 대기' : '실패 — 현 모델 유지'}**
- 후보 \`${g.candidate.sha256.slice(0, 16)}\` / 기준 \`${g.baseline.sha256.slice(0, 16)}\` · ${g.created} · ${g.minutes}분
- 관문 버전 ${GATE_VERSION}. 기준은 실행 전에 고정했다.

| 항목 | 후보 | 기준 모델 | 기준 | 판정 |
|---|---|---|---|---|
${rows.join('\n')}

대국: ${s.games}판(같은 시작 국면을 색을 바꿔 두 번), 후보 ${s.wins}승 ${s.draws}무 ${s.losses}패, SPRT ${s.decision}.

### 남은 타일별 신경망 단독

| 남은 타일 | Brier 후보 | Brier 기준 | 적중 후보 | 적중 기준 |
|---|---|---|---|---|
${byR.join('\n')}

### 승인 후 배포 전에 할 일

- [ ] 새 모델로 승률 보정 계수와 \`MARGIN_PER_VALUE\`를 다시 맞추거나, 타일 차이 출력을 화면에 쓰도록 바꾼다
- [ ] 봇 레이팅 재보정(\`tools/calibrate_bots.ts\`)
- [ ] \`MODEL_VERSION\` 변경, 웹·APK·서버 모델 교체, 이전 모델 파일 보관
- [ ] 새 기준 모델로 정밀 분석 기준(\`tools/analysis/standard-vs-deep\`)과 이 관문의 \`REFERENCE_MODEL\`을 다시 만든다
`;
}

await main();
