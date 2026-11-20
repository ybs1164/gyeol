/**
 * P0: 얼린 정확 시험 세트를 만든다. 학습에는 절대 쓰지 않는다(8대칭 포함 키로 제외).
 * 표본: 2026-11 봇 대국(사람 대 봇과 같은 봇이 둔 수순). 모델 학습(2026-10-24 종료) 이후에 생성되어 리플레이에 없다.
 * 남은 타일 4~9장: 정확 승패. 4~7장: 정확 최종 타일 차이까지.
 *
 *   npx tsx tools/learning/build_exact_test_set.ts [--per 400] [--workers 7]
 * 결과: tools/learning/frozen/exact-test-v1.jsonl, exact-test-v1.manifest.json
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExactEndgame, TOTAL_TILES, apply, initial, legal, positionKey, result, tileCount, type Board, type Player } from '../../packages/core/src/index';

export const TEST_SET = 'exact-test-v1';
const RULE = 'facing-25-v1';
const SEED = 20261121;
const RANGE = [4, 9] as const;
const MARGIN_MAX_REMAINING = 7;
const NODE_LIMIT = 3_000_000;
const SOURCES = ['tools/calibration/cognition-v1/games.jsonl', 'tools/calibration/rating-distribution/20261115-162212/games-snapshot.jsonl'];
const OUT = 'tools/learning/frozen';
const self = fileURLToPath(import.meta.url);

interface Candidate { id: string; source: string; game: number; ply: number; remaining: number; player: Player; board: Board }
export interface ExactRow extends Candidate { outcome: -1 | 0 | 1; margin: number | null }

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function mulberry32(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** 대국마다 한 국면만, 남은 타일 구간마다 같은 수를 결정적으로 뽑는다. */
function sample(per: number): Candidate[] {
  const pools = new Map<number, Candidate[]>();
  const seen = new Set<string>();
  for (const source of SOURCES) {
    const games = readFileSync(source, 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s) as { n: number; moves: number[] });
    for (const g of games) {
      let board = initial(), player: Player = 1;
      for (let ply = 0; ply < g.moves.length; ply++) {
        if (!legal(board, player).includes(g.moves[ply])) throw new Error(`illegal move ${source}#${g.n} ply ${ply + 1}`);
        board = apply(board, player, g.moves[ply]).board; player = -player as Player;
        const remaining = TOTAL_TILES - tileCount(board);
        if (remaining < RANGE[0] || remaining > RANGE[1] || result(board, player)) continue;
        const key = positionKey(board, player);
        if (seen.has(key)) continue;
        seen.add(key);
        const list = pools.get(remaining) ?? pools.set(remaining, []).get(remaining)!;
        list.push({ id: key, source, game: g.n, ply: ply + 1, remaining, player, board });
      }
    }
  }
  const random = mulberry32(SEED), used = new Set<string>(), picked: Candidate[] = [];
  for (let r = RANGE[0]; r <= RANGE[1]; r++) {
    const pool = pools.get(r) ?? [];
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    let n = 0;
    for (const c of pool) {
      const game = `${c.source}#${c.game}`;
      if (used.has(game)) continue;
      used.add(game); picked.push(c);
      if (++n >= per) break;
    }
  }
  return picked;
}

function solve(c: Candidate): ExactRow | null {
  const solver = new ExactEndgame(NODE_LIMIT);
  try {
    // 둘 차례 기준 값 → 초록 기준
    if (c.remaining <= MARGIN_MAX_REMAINING) {
      const v = solver.value(c.board, c.player) * c.player;
      return { ...c, outcome: Math.sign(v) as -1 | 0 | 1, margin: v };
    }
    const v = solver.value(c.board, c.player, -1, 1) * c.player;
    return { ...c, outcome: Math.sign(v) as -1 | 0 | 1, margin: null };
  } catch (e) {
    if (e instanceof Error && e.message === 'Exact endgame node limit exceeded') return null;
    throw e;
  }
}

const shardArg = process.argv.indexOf('--shard');
if (shardArg > 0) {
  const [i, n] = process.argv[shardArg + 1].split('/').map(Number);
  const candidates = readFileSync(join(OUT, `${TEST_SET}.candidates.jsonl`), 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s) as Candidate);
  const rows: string[] = [], failed: string[] = [];
  candidates.forEach((c, k) => { if (k % n !== i) return; const row = solve(c); if (row) rows.push(JSON.stringify(row)); else failed.push(c.id); });
  writeFileSync(join(OUT, `.shard-${i}.jsonl`), rows.join('\n') + (rows.length ? '\n' : ''));
  writeFileSync(join(OUT, `.shard-${i}.failed.json`), JSON.stringify(failed));
} else {
  const per = Number(arg('--per', '400')), workers = Number(arg('--workers', '7'));
  mkdirSync(OUT, { recursive: true });
  if (existsSync(join(OUT, `${TEST_SET}.jsonl`))) throw new Error(`${TEST_SET} already exists. A frozen set is never rebuilt; bump the version instead.`);
  const started = Date.now();
  const candidates = sample(per);
  writeFileSync(join(OUT, `${TEST_SET}.candidates.jsonl`), candidates.map(c => JSON.stringify(c)).join('\n') + '\n');
  console.log(`sampled ${candidates.length} positions; solving with ${workers} workers`);
  await Promise.all(Array.from({ length: workers }, (_, i) => new Promise<void>((done, fail) => {
    const child = spawn(process.execPath, [...process.execArgv, self, '--shard', `${i}/${workers}`], { stdio: 'inherit' });
    child.on('exit', code => code === 0 ? done() : fail(new Error(`shard ${i} exited ${code}`)));
  })));
  const byId = new Map<string, ExactRow>(), failed = new Set<string>();
  for (let i = 0; i < workers; i++) {
    for (const line of readFileSync(join(OUT, `.shard-${i}.jsonl`), 'utf8').split('\n').filter(Boolean)) { const row = JSON.parse(line) as ExactRow; byId.set(row.id, row); }
    for (const id of JSON.parse(readFileSync(join(OUT, `.shard-${i}.failed.json`), 'utf8')) as string[]) failed.add(id);
    rmSync(join(OUT, `.shard-${i}.jsonl`)); rmSync(join(OUT, `.shard-${i}.failed.json`));
  }
  const rows = candidates.map(c => byId.get(c.id)).filter((r): r is ExactRow => !!r);
  const file = join(OUT, `${TEST_SET}.jsonl`);
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  rmSync(join(OUT, `${TEST_SET}.candidates.jsonl`));
  const counts: Record<number, { sampled: number; solved: number; failed: number; margin: number; greenWins: number; draws: number }> = {};
  for (const c of candidates) { const k = counts[c.remaining] ??= { sampled: 0, solved: 0, failed: 0, margin: 0, greenWins: 0, draws: 0 }; k.sampled++; if (failed.has(c.id)) k.failed++; }
  for (const r of rows) { const k = counts[r.remaining]; k.solved++; if (r.margin !== null) k.margin++; if (r.outcome === 1) k.greenWins++; if (r.outcome === 0) k.draws++; }
  writeFileSync(join(OUT, `${TEST_SET}.manifest.json`), JSON.stringify({
    version: TEST_SET, rule: RULE, created: new Date().toISOString(), seed: SEED, perRemaining: per,
    remainingRange: RANGE, marginMaxRemaining: MARGIN_MAX_REMAINING, nodeLimit: NODE_LIMIT,
    labels: 'outcome/margin are from green’s view (green − brown) with best play by both sides',
    exclusion: 'Never train on these positions. Exclude all 8 board symmetries of each id (positionKey: side to move = +1).',
    bias: 'Positions whose exact solve exceeded nodeLimit are dropped; see failed counts.',
    sources: SOURCES.map(path => ({ path, sha256: sha256(path) })),
    file: { path: file.replaceAll('\\', '/'), rows: rows.length, sha256: sha256(file) },
    counts, seconds: Math.round((Date.now() - started) / 1000),
  }, null, 2) + '\n');
  console.log(`wrote ${rows.length} rows (${failed.size} failed) in ${Math.round((Date.now() - started) / 1000)}s`);
}
