/** Resume-safe, individually measured 1,000-bot calibration. Never publishes by default. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, canonical, initial, isLegal, legal, PASS, result, type Player } from '@gyeol/core';
import { cognitiveMove, COGNITION_VERSION, createCognitiveRoster, type CognitivePersona, type CognitiveDecision } from '@gyeol/ai';
import { loadBrainContext } from '../packages/server/src/brain';
import { cognitiveSchedule, type CognitiveGamePlan } from './cognitive-batch-lib';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const flag = (name: string) => process.argv.includes(`--${name}`);
if (flag('publish')) throw new Error('This batch writes candidate ratings only. Integrate the measured ratings and puzzle scale after reviewing completed validation.');
const out = resolve(root, arg('out', 'tools/calibration/cognition-v1'));
const rounds = Number(arg('rounds', '50')), validationRounds = Number(arg('validation-rounds', '10'));
const workers = Number(arg('workers', String(Math.max(1, Math.min(6, cpus().length - 2)))));
const limit = Number(arg('limit', '0'));
if (!Number.isInteger(workers) || workers < 1 || workers > 16 || !Number.isInteger(limit) || limit < 0 || limit % 2) throw new Error('Invalid worker count or limit');
mkdirSync(out, { recursive: true });
const path = (name: string) => join(out, name);
const atomic = (name: string, value: unknown) => { writeFileSync(path(`${name}.tmp`), JSON.stringify(value, null, 2) + '\n'); renameSync(path(`${name}.tmp`), path(name)); };
const gamesPath = path('games.jsonl');
const identities: { id: string; name: string }[] = JSON.parse(readFileSync(join(root, 'packages/server/src/bot-ratings.json'), 'utf8')).bots;
const roster: CognitivePersona[] = existsSync(path('roster.json')) ? JSON.parse(readFileSync(path('roster.json'), 'utf8')) : createCognitiveRoster(identities);
if (roster.length !== 1000 || roster.some((p, i) => p.cognition.skillPosition !== i / 999 || p.cognition.version !== COGNITION_VERSION)) throw new Error('Invalid cognitive roster');
const allPlanned = cognitiveSchedule(1000, rounds, validationRounds);
const planned = limit ? Array.from({ length: Math.min(Math.floor(limit / 2), allPlanned.length / 2) }, (_, i) => {
  const index = Math.floor(i * (allPlanned.length / 2) / Math.floor(limit / 2)) * 2;
  return [allPlanned[index], allPlanned[index + 1]];
}).flat().map((g, n) => ({ ...g, n })) : allPlanned;
const digest = createHash('sha256');
const sourceFiles = ['tools/calibrate_cognitive_bots.ts', 'tools/cognitive-batch-lib.ts', 'packages/server/src/brain.ts',
  'packages/core/src/rules.ts', 'packages/core/src/protocol.ts', 'packages/ai/src/cognitive-persona.ts',
  'packages/ai/src/cognition.ts', 'packages/ai/src/time-policy.ts', 'packages/ai/src/mcts.ts', 'packages/ai/src/predictor.ts', 'package-lock.json'];
for (const file of sourceFiles) digest.update(file).update(readFileSync(join(root, file)));
const modelHash = createHash('sha256').update(readFileSync(join(root, 'apps/web/public/model/model.onnx'))).digest('hex');
const fingerprint = digest.update(JSON.stringify({ roster, rounds, validationRounds, limit, modelHash, planned })).digest('hex');
if (existsSync(path('manifest.json'))) {
  if (JSON.parse(readFileSync(path('manifest.json'), 'utf8')).fingerprint !== fingerprint) throw new Error('Run inputs changed; choose a new --out directory');
} else {
  if (existsSync(gamesPath)) throw new Error('Games exist without manifest');
  atomic('roster.json', roster);
  atomic('schedule.json', planned);
  for (const file of sourceFiles) {
    const target = path(join('source', file)); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(join(root, file)));
  }
  atomic('manifest.json', { fingerprint, behaviorVersion: COGNITION_VERSION, modelHash, rounds, validationRounds, limit,
    plannedGames: planned.length, botCount: roster.length, createdAt: new Date().toISOString(), sourceFiles,
    clock: 'Deterministic logical thinking time, real ONNX computation; no wall-time waiting or load simulation',
    node: process.version, logicalProcessors: cpus().length, memoryBytes: totalmem() });
}

interface Played extends CognitiveGamePlan {
  winner: number; endReason: 'normal' | 'timeout'; moves: number[]; plies: number;
  clock: [number, number]; thinkingMs: number; ms: number; stages: [number, number, number, number];
  simulations: number; inferences: number;
}
const stageIndex = { A: 0, B: 1, C: 2, D: 3 } as const;
async function worker(index: number) {
  const brain = await loadBrainContext(join(root, 'apps/web/public'), 6000);
  const completed = new Set(readGames().map(g => g.n));
  for (const g of planned) {
    if (g.n % workers !== index || completed.has(g.n)) continue;
    const began = performance.now(), before = brain.stats.executions;
    let board = initial(), player: Player = 1;
    const moves: number[] = [];
    for (const action of g.opening) {
      if (!isLegal(board, player, action) || result(board, player)) throw new Error(`Illegal opening ${g.n}`);
      board = apply(board, player, action).board; moves.push(action); player = -player as Player;
    }
    const initialClock = g.mode === 'bullet' ? 60000 : g.mode === 'rapid' ? 300000 : 180000;
    const clock: [number, number] = [initialClock, initialClock];
    const stages: Played['stages'] = [0, 0, 0, 0];
    let winner = 0, endReason: Played['endReason'] = 'normal', simulations = 0, thinkingMs = 0;
    for (let ply = moves.length; ply < 100; ply++) {
      const end = result(board, player);
      if (end) { winner = Math.abs(end) < 0.5 ? 0 : Math.sign(end) * player; break; }
      const side = player === 1 ? 0 : 1;
      const persona = roster[player === 1 ? g.green : g.brown];
      let decision: CognitiveDecision;
      if (legal(board, player)[0] === PASS) {
        decision = { action: PASS, elapsedMs: 0, stage: 'A', candidates: 1, simulations: 0, reason: 'forced', weights: [1, 0, 0, 0] };
      } else decision = await cognitiveMove(canonical(board, player), persona.cognition, brain.predict, { mode: g.mode, leftMs: clock[side] });
      if (!isLegal(board, player, decision.action) || !Number.isFinite(decision.elapsedMs) || decision.elapsedMs < 0) throw new Error(`Invalid move ${g.n}`);
      stages[stageIndex[decision.stage]]++; simulations += decision.simulations;
      clock[side] -= decision.elapsedMs; thinkingMs += decision.elapsedMs;
      if (clock[side] <= 0) { winner = -player; endReason = 'timeout'; break; }
      board = apply(board, player, decision.action).board; moves.push(decision.action); player = -player as Player;
      if (ply === 99) throw new Error(`Game did not terminate ${g.n}`);
    }
    const game: Played = { ...g, winner, endReason, moves, plies: moves.length, clock, thinkingMs,
      ms: Math.round(performance.now() - began), stages, simulations, inferences: brain.stats.executions - before };
    process.stdout.write(JSON.stringify(game) + '\n');
  }
}

function validate(g: Played, seen: Set<number>) {
  const p = planned[g.n];
  if (!p || seen.has(g.n) || p.green !== g.green || p.brown !== g.brown || p.mode !== g.mode || p.split !== g.split ||
      p.openingSeed !== g.openingSeed || p.pair !== g.pair || JSON.stringify(p.opening) !== JSON.stringify(g.opening) ||
      ![-1, 0, 1].includes(g.winner) || !['normal', 'timeout'].includes(g.endReason) || !Array.isArray(g.moves) ||
      g.moves.length !== g.plies || g.plies < p.opening.length || g.plies >= 100 ||
      JSON.stringify(g.moves.slice(0, p.opening.length)) !== JSON.stringify(p.opening) ||
      !g.clock?.every(x => Number.isFinite(x)) || !Number.isFinite(g.ms) || g.ms < 0 ||
      !Number.isFinite(g.thinkingMs) || g.thinkingMs < 0 || !g.stages?.every(x => Number.isInteger(x) && x >= 0) ||
      !Number.isInteger(g.inferences) || g.inferences < 0 || !Number.isInteger(g.simulations) || g.simulations < 0) throw new Error(`Invalid/duplicate game ${g.n}`);
  let board = initial(), player: Player = 1;
  for (const action of g.moves) {
    if (!isLegal(board, player, action) || result(board, player)) throw new Error(`Illegal stored move ${g.n}`);
    board = apply(board, player, action).board; player = -player as Player;
  }
  const end = result(board, player), winner = Math.abs(end) < 0.5 ? 0 : Math.sign(end) * player;
  if (g.endReason === 'normal' && (!end || winner !== g.winner)) throw new Error(`Incorrect terminal result ${g.n}`);
  if (g.endReason === 'timeout' && (g.winner !== -player || Math.min(...g.clock) > 0)) throw new Error(`Incorrect timeout ${g.n}`);
  seen.add(g.n);
}

function readGames(): Played[] {
  if (!existsSync(gamesPath)) return [];
  const raw = readFileSync(gamesPath, 'utf8');
  // A partially written last line is not silently discarded: preserve it and fail for inspection.
  if (raw && !raw.endsWith('\n')) throw new Error('Incomplete final JSONL line; inspect before resuming');
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function fit(games: Played[]) {
  const ln = Math.log(10) / 400, ratings = roster.map(() => 0);
  let advantage = 0;
  let iterations = 0;
  for (; iterations < 2000; iterations++) {
    const grad = ratings.map(r => -r / 500 ** 2), hessian = ratings.map(() => 1 / 500 ** 2);
    let ga = -advantage / 500 ** 2, ha = 1 / 500 ** 2;
    for (const g of games) {
      const expected = 1 / (1 + Math.exp(-ln * (ratings[g.green] + advantage - ratings[g.brown])));
      const d = ln * ((g.winner + 1) / 2 - expected), h = ln * ln * expected * (1 - expected);
      grad[g.green] += d; grad[g.brown] -= d; hessian[g.green] += h; hessian[g.brown] += h; ga += d; ha += h;
    }
    let change = 0;
    for (let i = 0; i < ratings.length; i++) {
      const step = Math.max(-100, Math.min(100, 0.4 * grad[i] / hessian[i]));
      ratings[i] += step; change = Math.max(change, Math.abs(step));
    }
    const step = Math.max(-100, Math.min(100, 0.4 * ga / ha)); advantage += step;
    if (Math.max(change, Math.abs(step)) < 0.001) break;
  }
  if (iterations >= 2000) throw new Error('Rating optimizer did not converge');
  const info = ratings.map(() => 0);
  for (const g of games) {
    const e = 1 / (1 + Math.exp(-ln * (ratings[g.green] + advantage - ratings[g.brown])));
    const h = ln * ln * e * (1 - e); info[g.green] += h; info[g.brown] += h;
  }
  const mean = ratings.reduce((a, b) => a + b, 0) / ratings.length;
  return { ratings: ratings.map(r => r - mean + 1500),
    rd: info.map(i => i > 0 ? Math.max(60, 1 / Math.sqrt(i)) : 350), advantage, iterations };
}

function report(games: Played[]) {
  const train = games.filter(g => g.split === 'train'), held = games.filter(g => g.split === 'validation');
  const fitResult = fit(train);
  const counts = roster.map(() => ({ train: [0, 0], validation: [0, 0], wins: 0, losses: 0, draws: 0, opponents: new Set<number>() }));
  for (const g of games) {
    counts[g.green][g.split][0]++; counts[g.brown][g.split][1]++;
    if (g.split === 'train') {
      counts[g.green].opponents.add(g.brown); counts[g.brown].opponents.add(g.green);
      if (!g.winner) { counts[g.green].draws++; counts[g.brown].draws++; }
      else { counts[g.winner === 1 ? g.green : g.brown].wins++; counts[g.winner === 1 ? g.brown : g.green].losses++; }
    }
  }
  const bots = roster.map((p, i) => ({ ...p, skillRank: i + 1, rating: +fitResult.ratings[i].toFixed(2), rd: +fitResult.rd[i].toFixed(1),
    games: 0, wins: 0, losses: 0, draws: 0, ratingSource: 'individual-logical-clock-games',
    calibrationGames: counts[i].train[0] + counts[i].train[1], calibrationWins: counts[i].wins, calibrationLosses: counts[i].losses,
    calibrationDraws: counts[i].draws, validationGames: counts[i].validation[0] + counts[i].validation[1], distinctTrainingOpponents: counts[i].opponents.size }));
  const validationByMode = ['bullet', 'blitz', 'rapid'].map(mode => {
    const mine = held.filter(g => g.mode === mode);
    const broad = mine.filter(g => Math.abs(g.green - g.brown) >= 150);
    const strongerScore = broad.reduce((sum, g) => sum + (g.winner === 0 ? 0.5 : g.winner === (g.green > g.brown ? 1 : -1) ? 1 : 0), 0);
    let logLoss = 0, brier = 0;
    for (const g of mine) {
      const e = Math.max(1e-9, Math.min(1 - 1e-9, 1 / (1 + 10 ** ((fitResult.ratings[g.brown] - fitResult.ratings[g.green] - fitResult.advantage) / 400))));
      const observed = (g.winner + 1) / 2;
      logLoss -= observed * Math.log(e) + (1 - observed) * Math.log(1 - e); brier += (e - observed) ** 2;
    }
    // Report mirror pairs as clusters rather than treating the two colors as independent samples.
    const pairs = new Map<number, { sum: number; count: number }>();
    for (const g of broad) {
      const pair = pairs.get(g.pair) ?? { sum: 0, count: 0 };
      pair.sum += g.winner === 0 ? 0.5 : g.winner === (g.green > g.brown ? 1 : -1) ? 1 : 0; pair.count++; pairs.set(g.pair, pair);
    }
    const clusters = [...pairs.values()].map(x => x.sum / x.count), mean = clusters.reduce((a, b) => a + b, 0) / (clusters.length || 1);
    const variance = clusters.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, clusters.length - 1);
    const lower95 = Math.max(0, mean - 1.96 * Math.sqrt(variance / Math.max(1, clusters.length)));
    return { mode, games: mine.length, broadComparisonGames: broad.length, independentMirrorPairs: pairs.size,
      higherProfileScore: broad.length ? strongerScore / broad.length : null, lower95ClusterApprox: clusters.length > 1 ? lower95 : null,
      logLoss: mine.length ? logLoss / mine.length : null, brier: mine.length ? brier / mine.length : null,
      passed: broad.length >= 100 && strongerScore / broad.length >= 0.55 && lower95 > 0.5 };
  });
  const distribution = ['bronze', 'silver', 'gold', 'plat', 'dia', 'master'].map(tier => {
    const mine = bots.filter(b => b.cognition.targetTier === tier);
    return { targetTier: tier, count: mine.length, meanRating: mine.reduce((s, b) => s + b.rating, 0) / mine.length,
      ratingRange: [Math.min(...mine.map(b => b.rating)), Math.max(...mine.map(b => b.rating))] };
  });
  const full = !limit && games.length === planned.length && counts.every(c => c.train[0] === rounds && c.train[1] === rounds && c.validation[0] === validationRounds && c.validation[1] === validationRounds);
  const monotonicBands = distribution.every((b, i) => !i || b.meanRating > distribution[i - 1].meanRating);
  const stages = [0, 0, 0, 0]; for (const g of games) g.stages.forEach((v, i) => stages[i] += v);
  const summary = { behaviorVersion: COGNITION_VERSION, fingerprint, calibratedAt: new Date().toISOString(),
    measurement: 'Real ONNX, logical clocks; not a real-time server capacity or human-rating validation',
    games: games.length, trainGames: train.length, validationGames: held.length,
    perBot: counts.map((c, i) => ({ id: roster[i].id, train: c.train, validation: c.validation, distinctOpponents: c.opponents.size })),
    greenAdvantageElo: fitResult.advantage, iterations: fitResult.iterations, stages,
    timeouts: games.filter(g => g.endReason === 'timeout').length, totalInferences: games.reduce((s, g) => s + g.inferences, 0),
    distinctScheduledPairs: new Set(games.map(g => `${Math.min(g.green, g.brown)}:${Math.max(g.green, g.brown)}`)).size,
    distribution, validationByMode, complete: full, monotonicBands,
    logicalValidationPassed: full && monotonicBands && validationByMode.every(x => x.passed),
    uncertainty: 'RD is diagonal information approximation, minimum 60 Elo; pair-cluster normal lower bounds are approximate. Fine adjacent ordering is not guaranteed.' };
  atomic('report.json', summary);
  atomic('bot-ratings.candidate.json', { behaviorVersion: COGNITION_VERSION, calibratedAt: summary.calibratedAt,
    method: 'Individual regularized Bradley-Terry, balanced colors, diverse openings, logical clocks',
    modelSha256: modelHash, games: train.length, validationGames: held.length, profiles: [], rosterSize: bots.length,
    greenAdvantageElo: fitResult.advantage, bots });
  const headers = ['id', 'name', 'targetTier', 'skillPosition', 'replyStartMs', 'continuationStartMs', 'networkStartMs',
    'candidateWidth', 'workRate', 'simulationRate', 'rating', 'rd', 'calibrationGames', 'validationGames', 'distinctTrainingOpponents'];
  const rows = bots.map(b => [b.id, b.name, b.cognition.targetTier, b.cognition.skillPosition, ...b.cognition.startMs,
    b.cognition.candidateWidth, b.cognition.workRate, b.cognition.simulationRate, b.rating, b.rd, b.calibrationGames, b.validationGames, b.distinctTrainingOpponents]);
  writeFileSync(path('bots.csv'), '\ufeff' + [headers, ...rows].map(r => r.map(x => `"${String(x).replaceAll('"', '""')}"`).join(',')).join('\n') + '\n');
  atomic('progress.json', { state: summary.logicalValidationPassed ? 'complete-validated' : full ? 'complete-review-required' : 'pilot-complete',
    finished: games.length, planned: planned.length, updatedAt: new Date().toISOString(), report: path('report.json') });
  console.log(JSON.stringify({ games: games.length, full, stages, distribution, validationByMode, logicalValidationPassed: summary.logicalValidationPassed }, null, 2));
}

if (flag('worker')) {
  await worker(Number(arg('worker', '-1')));
} else {
  const played = readGames(), seen = new Set<number>();
  for (const game of played) validate(game, seen);
  if (flag('prepare')) {
    console.log(JSON.stringify({ out, fingerprint, roster: roster.length, games: planned.length, perBotTrain: rounds * 2, perBotValidation: validationRounds * 2 }));
  } else if (flag('fit-only') || played.length === planned.length) {
    if (played.length !== planned.length) throw new Error('Calibration incomplete');
    report(played);
  } else {
    const lock = path('run.lock');
    const lockFile = await import('node:fs').then(fs => fs.openSync(lock, 'wx'));
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const began = Date.now(), startCount = played.length;
    const children: ReturnType<typeof spawn>[] = [];
    const progress = (state: string) => {
      const elapsedSeconds = (Date.now() - began) / 1000, completedNow = played.length - startCount;
      atomic('progress.json', { state, pid: process.pid, workers, finished: played.length, planned: planned.length,
        elapsedSeconds, gamesPerMinute: completedNow / Math.max(1, elapsedSeconds) * 60,
        estimatedRemainingSeconds: completedNow ? (planned.length - played.length) * elapsedSeconds / completedNow : null,
        updatedAt: new Date().toISOString(), fingerprint });
    };
    const timer = setInterval(() => progress('running'), 10000);
    const stop = () => { for (const child of children) child.kill(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try {
      progress('running');
      console.log(`Cognition batch ${played.length}/${planned.length}, ${workers} workers, ${out}`);
      await Promise.all(Array.from({ length: workers }, (_, index) => new Promise<void>((done, fail) => {
        const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--worker', String(index),
          '--workers', String(workers), '--out', out, '--rounds', String(rounds), '--validation-rounds', String(validationRounds), '--limit', String(limit)],
          { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child);
        let buffer = '';
        child.stdout!.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          let nl;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
            if (!line.trim()) continue;
            try {
              const game: Played = JSON.parse(line); validate(game, seen);
              appendFileSync(gamesPath, JSON.stringify(game) + '\n'); played.push(game);
              if (played.length % 100 === 0) { progress('running'); console.log(`${played.length}/${planned.length}`); }
            } catch (error) { fail(error); }
          }
        });
        child.stderr!.on('data', chunk => { appendFileSync(path('workers.stderr.log'), chunk); });
        child.on('error', fail);
        child.on('close', code => code === 0 && !buffer.trim() ? done() : fail(new Error(`Worker ${index} exited ${code}; inspect workers.stderr.log`)));
      })));
      if (played.length !== planned.length) throw new Error('Missing games');
      clearInterval(timer); report(played);
    } catch (error) {
      stop(); progress('failed'); appendFileSync(path('errors.log'), String(error) + '\n'); throw error;
    } finally {
      clearInterval(timer); stop(); process.off('SIGINT', stop); process.off('SIGTERM', stop);
      const fs = await import('node:fs'); fs.closeSync(lockFile); fs.unlinkSync(lock);
    }
  }
}
