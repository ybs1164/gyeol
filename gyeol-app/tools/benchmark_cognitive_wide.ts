import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, canonical, initial, isLegal, legal, PASS, result, rng, type Player } from '@gyeol/core';
import { CALIBRATION_PERSONAS, personaMove, wideCognitiveMove, type WideCognitivePersona, type Persona } from '@gyeol/ai';
import { loadBrainContext } from '../packages/server/src/brain';
import { makeOpening } from './cognitive-batch-lib';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'tools/calibration/cognition-v2-wide/anchor-check');
const roster: WideCognitivePersona[] = JSON.parse(readFileSync(join(root, 'tools/calibration/cognition-v2-wide/roster.json'), 'utf8'));
const old = JSON.parse(readFileSync(join(root, 'packages/server/src/bot-ratings.json'), 'utf8')) as {
  activeProfileIds: string[]; profiles: { id: string; rating: number }[]; greenAdvantageElo: number;
};
const arg = (name: string, def: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? def : process.argv[i + 1]; };
const workers = Number(arg('workers', '2'));
if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw new Error('Invalid workers');
const representativeRatings = [974, 1300, 1500, 1600, 1750, 1900, 2207];
const representatives = representativeRatings.map(r => roster[Math.min(999, Math.ceil((r - 974) / 1233 * 999))]);
const anchors = old.activeProfileIds.map(id => ({ persona: CALIBRATION_PERSONAS.find(p => p.id === id)!, rating: old.profiles.find(p => p.id === id)!.rating }));
if (anchors.some(a => !a.persona)) throw new Error('Invalid legacy anchors');
interface Plan { n: number; representative: number; anchor: number; color: Player; seed: number; opening: number[] }
interface Game extends Plan { winner: number; moves: number[]; ms: number; clock: number; stages: number[] }
const planned: Plan[] = [];
for (let r = 0; r < representatives.length; r++) for (let a = 0; a < anchors.length; a++) for (let repeat = 0; repeat < 2; repeat++) {
  const seed = (0x94b02c83 ^ (r * 2654435761) ^ (a * 325321) ^ (repeat * 6567)) >>> 0;
  const opening = makeOpening(seed, repeat === 0 ? 2 : 6);
  for (const color of [1, -1] as Player[]) planned.push({ n: planned.length, representative: r, anchor: a, color, seed, opening });
}
mkdirSync(out, { recursive: true });
const path = (name: string) => join(out, name);
const atomic = (name: string, data: unknown) => { writeFileSync(path(`${name}.tmp`), JSON.stringify(data, null, 2) + '\n'); renameSync(path(`${name}.tmp`), path(name)); };
const hash = createHash('sha256').update(JSON.stringify({ representatives, anchors, planned }));
for (const file of ['tools/benchmark_cognitive_wide.ts', 'tools/cognitive-batch-lib.ts', 'packages/ai/src/cognition-wide.ts',
  'packages/ai/src/persona.ts', 'packages/ai/src/mcts.ts', 'packages/ai/src/predictor.ts', 'packages/core/src/rules.ts', 'apps/web/public/model/model.onnx']) hash.update(readFileSync(join(root, file)));
const fingerprint = hash.digest('hex');
if (existsSync(path('manifest.json'))) {
  if (JSON.parse(readFileSync(path('manifest.json'), 'utf8')).fingerprint !== fingerprint) throw new Error('Benchmark inputs changed');
} else atomic('manifest.json', { fingerprint, planned: planned.length, representatives, anchors, clock: 'Logical 3-minute clock for new AI; original legacy anchor behavior is unchanged' });
const readGames = (): Game[] => existsSync(path('games.jsonl')) ? readFileSync(path('games.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
function validate(g: Game, seen: Set<number>) {
  const p = planned[g.n];
  if (!p || seen.has(g.n) || JSON.stringify(p) !== JSON.stringify({ n: g.n, representative: g.representative, anchor: g.anchor,
    color: g.color, seed: g.seed, opening: g.opening }) || ![-1, 0, 1].includes(g.winner) || g.moves.length < g.opening.length) throw new Error('Invalid benchmark game');
  let board = initial(), player: Player = 1;
  for (const action of g.moves) {
    if (!isLegal(board, player, action) || result(board, player)) throw new Error('Invalid benchmark move');
    board = apply(board, player, action).board; player = -player as Player;
  }
  const end = result(board, player), winner = Math.abs(end) < .5 ? 0 : Math.sign(end) * player;
  if (!end || winner !== g.winner) throw new Error('Invalid benchmark result');
  seen.add(g.n);
}
async function worker(k: number) {
  const brain = await loadBrainContext(join(root, 'apps/web/public'), 12000);
  const done = new Set(readGames().map(g => g.n));
  for (const p of planned) {
    if (p.n % workers !== k || done.has(p.n)) continue;
    const began = performance.now(), random = rng(p.seed);
    let board = initial(), player: Player = 1, clock = 180000;
    const moves = [...p.opening], stages = [0, 0, 0, 0];
    for (const a of p.opening) { board = apply(board, player, a).board; player = -player as Player; }
    let winner = 0;
    for (; moves.length < 100;) {
      const end = result(board, player);
      if (end) { winner = Math.abs(end) < .5 ? 0 : Math.sign(end) * player; break; }
      let action: number;
      if (legal(board, player)[0] === PASS) action = PASS;
      else if (player === p.color) {
        const d = await wideCognitiveMove(canonical(board, player), representatives[p.representative].cognition, brain.predict, { leftMs: clock });
        action = d.action; clock -= d.elapsedMs; stages['ABCD'.indexOf(d.stage)]++;
        if (clock <= 0) throw new Error('Wide profile exhausted logical clock');
      } else action = await personaMove(canonical(board, player), anchors[p.anchor].persona as Persona, brain.predict, random);
      if (!isLegal(board, player, action)) throw new Error('Illegal benchmark action');
      board = apply(board, player, action).board; moves.push(action); player = -player as Player;
    }
    if (moves.length >= 100) throw new Error('Benchmark did not terminate');
    process.stdout.write(JSON.stringify({ ...p, winner, moves, clock, stages, ms: Math.round(performance.now() - began) } satisfies Game) + '\n');
  }
}
function report(games: Game[]) {
  const ratings = representatives.map(() => 1500), ln = Math.log(10) / 400;
  let colorEffect = old.greenAdvantageElo;
  for (let iter = 0; iter < 2000; iter++) {
    const grad = ratings.map(r => -(r - 1500) / 1000 ** 2), info = ratings.map(() => 1 / 1000 ** 2);
    let ga = -(colorEffect - old.greenAdvantageElo) / 200 ** 2, ha = 1 / 200 ** 2;
    for (const g of games) {
      const e = 1 / (1 + Math.exp(-ln * (ratings[g.representative] - anchors[g.anchor].rating + g.color * colorEffect)));
      const score = g.winner === 0 ? .5 : g.winner === g.color ? 1 : 0;
      const d = ln * (score - e), h = ln * ln * e * (1 - e);
      grad[g.representative] += d; info[g.representative] += h; ga += g.color * d; ha += h;
    }
    let change = 0;
    ratings.forEach((_, i) => { const step = Math.max(-100, Math.min(100, .4 * grad[i] / info[i])); ratings[i] += step; change = Math.max(change, Math.abs(step)); });
    const step = Math.max(-100, Math.min(100, .4 * ga / ha)); colorEffect += step;
    if (Math.max(change, Math.abs(step)) < .001) break;
    if (iter === 1999) throw new Error('Anchor fit did not converge');
  }
  const profiles = representatives.map((p, i) => {
    const mine = games.filter(g => g.representative === i), wins = mine.filter(g => g.winner === g.color).length;
    return { id: p.id, targetRating: p.cognition.targetRating, targetTier: p.cognition.targetTier,
      games: mine.length, wins, draws: mine.filter(g => !g.winner).length, estimatedAnchorRating: ratings[i] };
  });
  const span = ratings.at(-1)! - ratings[0];
  const complete = games.length === planned.length;
  const passed = complete && span >= 700 && ratings.at(-1)! > ratings[0] && profiles.every(p => p.games === 32);
  atomic('report.json', { fingerprint, complete, passed, games: games.length, profiles, endpointSpan: span, colorEffect,
    method: 'Ratings of new profiles fitted against the fixed, previously measured 8 legacy anchors; approximate and affected by anchor uncertainty',
    gate: 'Complete 224 games, 32 games per representative, endpoint span at least 700 Elo; does not certify exact target ratings or 1,000 independent orderings' });
  atomic('progress.json', { state: passed ? 'complete-validated' : complete ? 'complete-review-required' : 'incomplete', finished: games.length, planned: planned.length });
  console.log(JSON.stringify({ passed, span, profiles }, null, 2));
}
if (process.argv.includes('--worker')) await worker(Number(arg('worker', '-1')));
else {
  const games = readGames(), seen = new Set<number>(); for (const g of games) validate(g, seen);
  if (games.length === planned.length) report(games);
  else {
    const lock = openSync(path('run.lock'), 'wx'); writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    const children: ReturnType<typeof spawn>[] = [];
    const began = Date.now();
    const progress = (state: string) => atomic('progress.json', { state, pid: process.pid, workers, finished: games.length,
      planned: planned.length, elapsedSeconds: (Date.now() - began) / 1000, updatedAt: new Date().toISOString() });
    const timer = setInterval(() => progress('running'), 10000);
    try {
      progress('running');
      await Promise.all(Array.from({ length: workers }, (_, k) => new Promise<void>((done, fail) => {
        const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--worker', String(k), '--workers', String(workers)],
          { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child); let buffer = '';
        child.stdout!.on('data', chunk => {
          buffer += String(chunk); let nl;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); if (!line.trim()) continue;
            try { const g = JSON.parse(line) as Game; validate(g, seen); appendFileSync(path('games.jsonl'), JSON.stringify(g) + '\n'); games.push(g); progress('running'); }
            catch (e) { fail(e); }
          }
        });
        child.stderr!.on('data', c => appendFileSync(path('workers.stderr.log'), c));
        child.on('error', fail); child.on('close', code => code === 0 && !buffer.trim() ? done() : fail(new Error(`Anchor worker ${k}: ${code}`)));
      })));
      if (games.length !== planned.length) throw new Error('Missing anchor games');
      clearInterval(timer); report(games);
    } catch (e) { progress('failed'); throw e; }
    finally { clearInterval(timer); for (const c of children) c.kill(); closeSync(lock); unlinkSync(path('run.lock')); }
  }
}
