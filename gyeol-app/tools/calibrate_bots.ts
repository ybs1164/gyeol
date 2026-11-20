/**
 * 기준 AI 12종 1,456판 보정 → 서로 다른 혼합 비율의 AI 1,000명 생성.
 *   npx tsx tools/calibrate_bots.ts [--workers 7] [--scale 1]      대국 + 레이팅 계산
 *   npx tsx tools/calibrate_bots.ts --fit-only                     저장된 대국 결과로 레이팅만 다시 계산
 *   npx tsx tools/calibrate_bots.ts --validate-roster              생성된 1,000명 전원 별도 대전 검증
 *
 * 대국 수: 실력이 가까운 봇끼리 많이 둔다 (차이 1단계 60판, 2단계 40판, 3단계 20판, 그 이상 6판). --scale 로 배수 조정.
 * 레이팅: 모든 대국을 한꺼번에 넣은 최대우도 Bradley–Terry(Elo 척도, 선공 이점 포함). 순서에 따라 값이 달라지는
 *   순차 갱신 대신 전체 결과에 가장 잘 맞는 값을 구한다. 불확실도(rd)는 표준오차.
 * 기준점: 봇 레이팅 평균 = 1500 (새로 온 사람의 시작 레이팅과 같은 중간 실력).
 * 결과: packages/server/src/bot-ratings.json, tools/calibration/roster-v2/ 및 roster-check/.
 * 매 판 원자료를 저장하고 재실행 시 완료한 판은 건너뛴다. 모델·설정이 달라지면 이어 실행하지 않는다.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { apply, canonical, initial, result, rng, type Player } from '@gyeol/core';
import { CALIBRATION_PERSONAS, createPersonas, personaMove, type Persona } from '@gyeol/ai';
import { loadBrain } from '../packages/server/src/brain';

const root = fileURLToPath(new URL('../', import.meta.url));
const CHECK_ROSTER = process.argv.includes('--validate-roster');
const PERSONAS: Persona[] = CHECK_ROSTER ? JSON.parse(readFileSync(`${root}packages/server/src/bot-ratings.json`, 'utf8')).bots : CALIBRATION_PERSONAS;
const OUT_DIR = `${root}tools/calibration/${CHECK_ROSTER ? 'roster-check' : 'roster-v2'}/`;
const GAMES_FILE = `${OUT_DIR}games.jsonl`;
const MANIFEST_FILE = `${OUT_DIR}manifest.json`;
const RATINGS_FILE = `${root}packages/server/src/bot-ratings.json`;
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};

interface Planned {
  n: number;
  green: number;
  brown: number;
  seed: number;
}
interface Played extends Planned {
  /** 1 초록 승, -1 갈색 승, 0 무승부 */
  winner: number;
  plies: number;
  ms: number;
}

function schedule(scale: number): Planned[] {
  if (CHECK_ROSTER) {
    if (PERSONAS.length !== 1000) throw new Error('Expected calibrated 1000-bot roster');
    return PERSONAS.map((_, i) => ({ n: i, green: i % 2 ? (i + 200) % 1000 : i,
      brown: i % 2 ? i : (i + 200) % 1000, seed: (0x71ab8403 ^ (i * 2654435761)) }));
  }
  const per = (d: number) => Math.round((d === 1 ? 60 : d === 2 ? 40 : d === 3 ? 20 : 6) * scale);
  const games: Planned[] = [];
  for (let i = 0; i < PERSONAS.length; i++)
    for (let j = i + 1; j < PERSONAS.length; j++)
      for (let k = 0; k < per(j - i); k++) {
        const [green, brown] = k % 2 ? [j, i] : [i, j];
        games.push({ n: games.length, green, brown, seed: 0x9e3779b9 ^ (games.length * 2654435761) });
      }
  return games;
}

// ---------- 일꾼: 맡은 대국을 두고 한 줄씩 JSON 으로 출력 ----------
async function worker(k: number, of: number, scale: number) {
  const completed = new Set(readGames().map((g) => g.n));
  const predict = await loadBrain(`${root}apps/web/public/`);
  for (const g of schedule(scale)) {
    if (g.n % of !== k || completed.has(g.n)) continue;
    const t0 = performance.now();
    const random = rng(g.seed);
    let board = initial();
    let p: Player = 1;
    let plies = 0;
    let end = 0;
    for (; plies < 300; plies++) {
      end = result(board, p);
      if (end) break;
      const persona = PERSONAS[p === 1 ? g.green : g.brown];
      board = apply(board, p, await personaMove(canonical(board, p), persona, predict, random)).board;
      p = -p as Player;
    }
    // result 는 둘 차례(p) 기준: 1 승, -1 패, 그 밖(무승부)은 작은 값
    const winner = end > 0.5 ? p : end < -0.5 ? -p : 0;
    process.stdout.write(JSON.stringify({ ...g, winner, plies, ms: Math.round(performance.now() - t0) } satisfies Played) + '\n');
  }
}

// ---------- 레이팅 계산 ----------
const LN10_400 = Math.log(10) / 400;

function fit(games: Played[]) {
  const n = PERSONAS.length;
  const r = new Array<number>(n).fill(0);
  let adv = 0; // 선공 이점 (Elo)
  // 뉴턴법에 가까운 단순 경사 상승. 아주 약한 사전분포(평균 0, 표준편차 1000)로 전승·전패에도 값이 발산하지 않게 한다.
  for (let it = 0; it < 20_000; it++) {
    const grad = new Array<number>(n).fill(0);
    const hess = new Array<number>(n).fill(1 / 1000 ** 2);
    let gAdv = -adv / 1000 ** 2;
    let hAdv = 1 / 1000 ** 2;
    for (let i = 0; i < n; i++) grad[i] -= r[i] / 1000 ** 2;
    for (const g of games) {
      const s = g.winner === 1 ? 1 : g.winner === -1 ? 0 : 0.5;
      const e = 1 / (1 + Math.pow(10, -(r[g.green] + adv - r[g.brown]) / 400));
      const d = LN10_400 * (s - e);
      const h = LN10_400 ** 2 * e * (1 - e);
      grad[g.green] += d;
      grad[g.brown] -= d;
      hess[g.green] += h;
      hess[g.brown] += h;
      gAdv += d;
      hAdv += h;
    }
    let move = 0;
    for (let i = 0; i < n; i++) {
      const step = grad[i] / hess[i];
      r[i] += 0.5 * step;
      move = Math.max(move, Math.abs(step));
    }
    const advStep = gAdv / hAdv;
    adv += 0.5 * advStep;
    if (Math.max(move, Math.abs(advStep)) < 1e-6) break;
  }
  // 평균을 1500 에 맞춘다
  const mean = r.reduce((a, x) => a + x, 0) / n;
  const rating = r.map((x) => x - mean + 1500);
  // 표준오차: 피셔 정보의 역수 (대각 근사)
  const info = new Array<number>(n).fill(0);
  for (const g of games) {
    const e = 1 / (1 + Math.pow(10, -(r[g.green] + adv - r[g.brown]) / 400));
    const h = LN10_400 ** 2 * e * (1 - e);
    info[g.green] += h;
    info[g.brown] += h;
  }
  const se = info.map((x) => 1 / Math.sqrt(x));
  return { rating, se, adv };
}

function report(games: Played[]) {
  if (CHECK_ROSTER) return reportRoster(games);
  const { rating, se, adv } = fit(games);
  const profiles = PERSONAS.map((p, i) => {
    const mine = games.filter((g) => g.green === i || g.brown === i);
    const won = (g: Played) => (g.green === i ? g.winner === 1 : g.winner === -1);
    const lost = (g: Played) => (g.green === i ? g.winner === -1 : g.winner === 1);
    return {
      id: p.id,
      name: p.name,
      mistake: p.mistake,
      sims: p.sims,
      rating: Math.round(rating[i]),
      /** 서버에서 쓰는 Glicko rd. 봇은 실력이 고정이라 표준오차를 그대로 쓰되 40 아래로는 내리지 않는다 */
      rd: Math.max(40, Math.round(se[i])),
      games: mine.length,
      wins: mine.filter(won).length,
      losses: mine.filter(lost).length,
      draws: mine.length - mine.filter(won).length - mine.filter(lost).length,
    };
  });
  // Keep only empirically separated anchor points. Individual ratings are interpolated estimates.
  const sorted = [...profiles].sort((a, b) => a.rating - b.rating);
  const active = [sorted[0]];
  for (const p of sorted.slice(1)) {
    if (p.rating - active[active.length - 1].rating >= Math.max(100, 1.96 * Math.hypot(p.rd, active[active.length - 1].rd))) active.push(p);
  }
  const strongest = sorted[sorted.length - 1];
  if (active[active.length - 1].id !== strongest.id) {
    while (active.length > 1 && strongest.rating - active[active.length - 1].rating < Math.max(100, 1.96 * Math.hypot(strongest.rd, active[active.length - 1].rd))) active.pop();
    active.push(strongest);
  }
  const anchors = active.map((p) => PERSONAS.find((a) => a.id === p.id)!);
  const roster = createPersonas(anchors, 1000, active.map((p) => p.rating));
  const bots = roster.map((p, i) => {
    const { lower, upper, weight } = p.blend!;
    const a = profiles.find((p) => p.id === lower)!;
    const b = profiles.find((p) => p.id === upper)!;
    return { ...p, skillRank: i + 1, rating: +(a.rating * (1 - weight) + b.rating * weight).toFixed(2),
      rd: Math.max(80, a.rd, b.rd), games: 0, wins: 0, losses: 0, draws: 0,
      ratingSource: 'interpolated' as const };
  });
  const greenWins = games.filter((g) => g.winner === 1).length;
  const out = {
    calibratedAt: new Date().toISOString(),
    method: 'Regularized Bradley-Terry anchors; per-move mixtures with interpolated individual ratings',
    profiles,
    activeProfileIds: active.map((p) => p.id),
    rosterSize: bots.length,
    estimatedRatingStep: (bots[bots.length - 1].rating - bots[0].rating) / (bots.length - 1),
    modelSha256: createHash('sha256').update(readFileSync(`${root}apps/web/public/model/model.onnx`)).digest('hex'),
    games: games.length,
    greenWinRate: +(greenWins / games.length).toFixed(3),
    greenAdvantageElo: Math.round(adv),
    avgPlies: +(games.reduce((a, g) => a + g.plies, 0) / games.length).toFixed(1),
    bots,
  };
  writeFileSync(RATINGS_FILE, JSON.stringify(out, null, 2) + '\n');
  const rows = [
    ['skillRank', 'id', 'name', 'estimatedRating', 'rd', 'mistakeProbability', 'expectedSimulations', 'lowerAnchor', 'upperAnchor', 'upperMix', 'ratingSource'],
    ...bots.map((b) => [b.skillRank, b.id, b.name, b.rating, b.rd, b.mistake, b.sims, b.blend!.lower, b.blend!.upper, b.blend!.weight, b.ratingSource]),
  ];
  writeFileSync(`${OUT_DIR}bots.csv`, '\ufeff' + rows.map((row) => row.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\n') + '\n');

  // 표: 봇별 레이팅과 맞대결 승률
  console.log(`\n대국 ${games.length}판 · 선공 승률 ${(out.greenWinRate * 100).toFixed(1)}% (선공 이점 ${out.greenAdvantageElo} Elo) · 평균 ${out.avgPlies}수`);
  console.log('봇       실수   탐색  레이팅  ±rd   전적');
  for (const b of profiles)
    console.log(
      `${b.id} ${b.name.padEnd(3, '　')} ${(b.mistake * 100).toFixed(0).padStart(3)}% ${String(b.sims).padStart(5)} ${String(b.rating).padStart(6)} ${String(b.rd).padStart(5)}   ${b.wins}승 ${b.losses}패${b.draws ? ` ${b.draws}무` : ''}`,
    );
  console.log('\n이웃 단계 맞대결 (강한 쪽 승률)');
  for (let i = 0; i + 1 < PERSONAS.length; i++) {
    const vs = games.filter((g) => (g.green === i && g.brown === i + 1) || (g.green === i + 1 && g.brown === i));
    const strong = vs.filter((g) => (g.green === i + 1 ? g.winner === 1 : g.winner === -1)).length;
    console.log(`  ${PERSONAS[i + 1].name} vs ${PERSONAS[i].name}: ${strong}/${vs.length} (${((strong / vs.length) * 100).toFixed(0)}%)`);
  }
  console.log(`\n저장: ${RATINGS_FILE}`);
}

// ---------- 실행 ----------
function reportRoster(games: Played[]) {
  const bands = Array.from({ length: 4 }, (_, band) => {
    const mine = games.filter((g) => Math.abs(g.green - g.brown) === 200 && Math.floor(Math.min(g.green, g.brown) / 200) === band);
    const wins = mine.filter((g) => g.winner === (g.green > g.brown ? 1 : -1)).length;
    const draws = mine.filter((g) => g.winner === 0).length;
    const score = (wins + draws / 2) / mine.length;
    const z2 = 1.96 ** 2;
    const lower95 = (score + z2 / (2 * mine.length) - 1.96 * Math.sqrt(score * (1 - score) / mine.length + z2 / (4 * mine.length ** 2))) / (1 + z2 / mine.length);
    return { lowerRanks: [band * 200 + 1, (band + 1) * 200], higherBy: 200,
      games: mine.length, wins, draws, score, lower95, passed: score >= 0.60 && lower95 > 0.5 };
  });
  const result = { checkedAt: new Date().toISOString(), games: games.length, distinctBots: new Set(games.flatMap((g) => [g.green, g.brown])).size,
    perBotGames: 2, method: 'Held-out games between individual per-move mixtures, 200 roster positions apart; colors balanced per bot',
    bands, passed: bands.every((b) => b.passed) };
  writeFileSync(`${OUT_DIR}report.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) throw new Error('Some strength bands did not meet the validation target');
}

function readGames(): Played[] {
  if (!existsSync(GAMES_FILE)) return [];
  return readFileSync(GAMES_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const scale = Number(arg('scale', '1'));
if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid scale');
const planned = schedule(scale);
const fingerprint = createHash('sha256').update(JSON.stringify({ profiles: PERSONAS, scale }))
  .update(readFileSync(`${root}apps/web/public/model/model.onnx`))
  .update(readFileSync(`${root}packages/ai/src/persona.ts`)).digest('hex');
mkdirSync(OUT_DIR, { recursive: true });
if (existsSync(MANIFEST_FILE)) {
  if (JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')).fingerprint !== fingerprint)
    throw new Error('Calibration inputs changed: archive roster-v2 before starting a new run');
} else {
  if (readGames().length) throw new Error('Games exist without manifest');
  writeFileSync(MANIFEST_FILE, JSON.stringify({ fingerprint, scale, profiles: PERSONAS, games: planned.length }, null, 2));
}
const played = readGames();
const seen = new Set<number>();
for (const g of played) {
  const p = planned[g.n];
  if (!p || seen.has(g.n) || p.green !== g.green || p.brown !== g.brown || p.seed !== g.seed ||
    ![-1, 0, 1].includes(g.winner) || !Number.isInteger(g.plies) || g.plies < 1 || g.plies >= 300)
    throw new Error(`Invalid or duplicate game ${g.n}`);
  seen.add(g.n);
}
if (process.argv[2] === '--worker') {
  await worker(Number(process.argv[3]), Number(process.argv[4]), scale);
} else if (process.argv.includes('--fit-only')) {
  if (played.length !== planned.length) throw new Error('Calibration is incomplete');
  report(played);
} else {
  const workers = Number(arg('workers', '7'));
  if (!Number.isInteger(workers) || workers < 1 || workers > 32) throw new Error('Invalid workers');
  const t0 = Date.now();
  console.log(`Anchors ${PERSONAS.length}; games ${played.length}/${planned.length}; workers ${workers}`);
  const children: ReturnType<typeof spawn>[] = [];
  try {
    await Promise.all(Array.from({ length: workers }, (_, k) => new Promise<void>((done, fail) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--worker', String(k), String(workers), '--scale', String(scale), ...(CHECK_ROSTER ? ['--validate-roster'] : [])], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
      children.push(child);
      let buf = '';
      child.stdout!.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          try {
            const g: Played = JSON.parse(line);
            if (seen.has(g.n)) throw new Error(`Duplicate game ${g.n}`);
            seen.add(g.n);
            played.push(g);
            appendFileSync(GAMES_FILE, JSON.stringify(g) + '\n');
            if (played.length % 25 === 0 || played.length === planned.length)
              console.log(`${played.length}/${planned.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
          } catch (error) { fail(error); }
        }
      });
      child.on('error', fail);
      child.on('close', (code) => code === 0 ? done() : fail(new Error(`Worker ${k}: ${code}`)));
    })));
    if (played.length !== planned.length) throw new Error('Missing games');
    report(played.sort((a, b) => a.n - b.n));
  } catch (error) {
    for (const child of children) child.kill();
    throw error;
  }
}
