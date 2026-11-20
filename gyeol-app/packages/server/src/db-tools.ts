import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseEngine, validateMoves } from './database';
import { initializeRatingRecord, type Data } from './models';

export function readSource(path: string) {
  const bytes = readFileSync(path);
  return { data: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) as Data,
    hash: createHash('sha256').update(bytes).digest('hex') };
}

export function verifyDatabase(engine: DatabaseEngine, source?: Data) {
  return engine.db.transaction(() => {
    const check = engine.integrity();
    if (JSON.stringify(check.integrity) !== '[{"integrity_check":"ok"}]' || check.foreignKeys.length) throw new Error('Database integrity check failed');
    const saved = engine.snapshot();
    for (const g of Object.values(saved.games)) validateMoves(g.moves);
    if (source) {
      if (source.version !== 1 || !source.players || !source.games) throw new Error('Unsupported source');
      if (Object.keys(source.players).length !== Object.keys(saved.players).length || Object.keys(source.games).length !== Object.keys(saved.games).length) throw new Error('Source/database counts differ');
      for (const [id, original] of Object.entries(source.players)) {
        const expected = structuredClone(original); initializeRatingRecord(expected);
        const p = saved.players[id]; if (!p) throw new Error('Missing player');
        for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
          if (key === 'token') { if (engine.tokenPlayer(expected.token)?.id !== id) throw new Error('Token verification failed'); }
          else if (expected[key] !== undefined && !isDeepStrictEqual(expected[key], p[key])) throw new Error(`Player field mismatch: ${key}`);
        }
      }
      for (const [id, expected] of Object.entries(source.games)) {
        const g = saved.games[id]; if (!g) throw new Error('Missing game');
        for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
          if (expected[key] !== undefined && !isDeepStrictEqual(expected[key], g[key])) throw new Error(`Game field mismatch: ${key}`);
        }
      }
    }
    return { ok: true, players: Object.keys(saved.players).length, games: Object.keys(saved.games).length,
      moves: Object.values(saved.games).reduce((sum, g) => sum + g.moves.length, 0),
      history: Object.values(saved.players).reduce((sum, p) => sum + (p.history?.length ?? 0), 0),
      incompleteHistories: Object.values(saved.players).filter(p => !p.bot && !p.historyComplete).length };
  })();
}

function reserve(path: string) { mkdirSync(dirname(path), { recursive: true }); closeSync(openSync(path, 'wx', 0o600)); }

/** Never overwrites a DB or mutates the JSON. Only a fully verified staging DB is promoted. */
export function importJson(source: string, destination: string) {
  const target = resolve(destination);
  if (resolve(source) === target || existsSync(target)) throw new Error('Destination must not exist');
  const input = readSource(source);
  const staging = `${target}.import-${process.pid}-${Date.now()}`;
  reserve(staging);
  let engine: DatabaseEngine | undefined;
  try {
    engine = new DatabaseEngine(staging);
    engine.importData(structuredClone(input.data), input.hash);
    const report = verifyDatabase(engine, input.data);
    engine.db.pragma('wal_checkpoint(TRUNCATE)'); engine.close(); engine = undefined;
    // Reserve destination exclusively: refuse competing imports rather than replace data.
    reserve(target);
    try { renameSync(staging, target); } catch (error) { rmSync(target); throw error; }
    return { ...report, sourceSha256: input.hash, destination: target };
  } finally {
    engine?.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(staging + suffix, { force: true });
  }
}

export async function backupDatabase(engine: DatabaseEngine, destination: string) {
  const target = resolve(destination); reserve(target);
  try { await engine.backup(target); }
  catch (error) { rmSync(target, { force: true }); throw error; }
  return target;
}

export function restoreCheck(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'gyeol-restore-'));
  const file = join(dir, 'restore.sqlite');
  // This input must be an independent completed backup, never a live WAL DB file.
  writeFileSync(file, readFileSync(source), { mode: 0o600 });
  let engine: DatabaseEngine | undefined;
  try { engine = new DatabaseEngine(file); return verifyDatabase(engine); }
  finally { engine?.close(); rmSync(dir, { recursive: true, force: true }); }
}
