import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { legal, replay, type OnlineGame, type ServerMsg } from '@gyeol/core';
import { DatabaseEngine } from '../src/database';
import { Store } from '../src/store';
import { backupDatabase, importJson, readSource, restoreCheck, verifyDatabase } from '../src/db-tools';
import type { PlayerRecord } from '../src/models';
import { createServer } from '../src/server';

const dirs: string[] = [], stores: Store[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } }
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function dir() { const d = mkdtempSync(join(tmpdir(), 'gyeol-sqlite-test-')); dirs.push(d); return d; }
function fixture(id: string): PlayerRecord {
  return { id, token: `private-token-${id}`, name: id, rating: 1500, rd: 100, vol: .06, ranked: 5, rated: 5,
    wins: 3, losses: 2, createdAt: 1000, seenAt: 2000, ratingAt: Date.now(), historyComplete: false,
    history: [{ at: 1500, rating: 1510 }], peakRating: 1600, lowestRating: 1400 };
}
async function setup(path: string | null = null) {
  const store = new Store(path, true); stores.push(store);
  await store.call('seedPlayer', fixture('a')); await store.call('seedPlayer', fixture('b'));
  const game = await store.call('createGame', 'a', 'b', true, 'daily');
  return { store, game };
}

test('JSON import preserves identity, exact rating and incomplete history without storing plaintext tokens', () => {
  const folder = dir(), source = join(folder, 'source.json'), target = join(folder, 'data.sqlite');
  const p = fixture('a'); p.rating = 1500.493472; p.historyComplete = false;
  writeFileSync(source, JSON.stringify({ version: 1, players: { a: p }, games: {} }));
  const original = readFileSync(source);
  expect(importJson(source, target)).toMatchObject({ ok: true, players: 1, games: 0, history: 1, incompleteHistories: 1 });
  expect(readFileSync(source)).toEqual(original);
  const engine = new DatabaseEngine(target);
  try {
    expect(engine.tokenPlayer(p.token)?.rating).toBe(p.rating);
    expect(engine.player('a', true)?.history).toEqual(p.history);
    expect(verifyDatabase(engine, readSource(source).data).ok).toBe(true);
    expect(() => importJson(source, target)).toThrow('Destination must not exist');
    expect(() => engine.importData(readSource(source).data, createHash('sha256').update(original).digest('hex'))).toThrow('already imported');
  } finally { engine.close(); }
  expect(readFileSync(target).includes(Buffer.from(p.token))).toBe(false);
});

test('failed import leaves no destination and preserves the source; foreign keys reject orphan games', () => {
  const folder = dir(), source = join(folder, 'bad.json'), target = join(folder, 'data.sqlite');
  writeFileSync(source, JSON.stringify({ version: 1, players: { a: fixture('a'), b: fixture('b') }, games: {
    invalid: { id: 'invalid', code: null, ranked: true, greenId: 'missing', brownId: 'b', moves: [], status: 'active',
      winner: null, endReason: null, turnLimitMs: 1000, turnStartedAt: 2000, createdAt: 2000, updatedAt: 2000, ratingChange: null },
  } }));
  const bytes = readFileSync(source);
  expect(() => importJson(source, target)).toThrow();
  expect(existsSync(target)).toBe(false); expect(readFileSync(source)).toEqual(bytes);
});

test('move retries and stale bot revisions cannot append a second action', async () => {
  const { store, game } = await setup();
  const action = legal(replay([]).board, 1)[0];
  const [first, retry] = await Promise.all([store.call('applyMove', game.id, 'a', 0, action, game.revision), store.call('applyMove', game.id, 'a', 0, action, game.revision)]);
  expect(first.game?.moves).toEqual([action]); expect(retry.error).toBe('stale');
  expect((await store.call('game', game.id))?.moves).toEqual([action]);
});

test('competing connections settle a game once and read current ratings for a shared player', async () => {
  const file = join(dir(), 'data.sqlite'), { store, game } = await setup(file);
  const second = new Store(file); stores.push(second); await second.ready;
  const [a,b] = await Promise.all([store.call('finishGame', game.id, 'a', 'resign'), second.call('finishGame', game.id, 'b', 'resign')]);
  expect([a,b].filter(r => r.game?.status === 'finished')).toHaveLength(1);
  expect([a,b].filter(r => r.error === 'finished')).toHaveLength(1);
  expect((await store.call('player', 'a'))?.ranked).toBe(6);
  expect((await store.call('player', 'b'))?.ranked).toBe(6);
  const other = await store.call('createGame', 'a', 'b', true, 'daily');
  await second.call('finishGame', other.id, 'a', 'resign');
  expect((await store.call('player', 'a'))?.ranked).toBe(7);
});

test('failure during rating update rolls back game, both players and all events', async () => {
  const file = join(dir(), 'data.sqlite'), { store, game } = await setup(file);
  const before = await store.call('snapshot');
  const injector = new DatabaseEngine(file);
  injector.db.exec("CREATE TRIGGER fail_rating BEFORE UPDATE ON player_ratings WHEN NEW.player_id='b' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  injector.close();
  await expect(store.call('finishGame', game.id, 'a', 'resign')).rejects.toThrow('injected failure');
  expect((await store.call('health')).ok).toBe(false);
  expect(await store.call('snapshot')).toEqual(before);
  const cleanup = new DatabaseEngine(file); cleanup.db.exec('DROP TRIGGER fail_rating'); cleanup.close();
  expect((await store.call('finishGame', game.id, 'a', 'resign')).game?.status).toBe('finished');
  expect((await store.call('health')).ok).toBe(true);
});

test('deployment maintenance blocks account creation while health remains inspectable', async () => {
  let maintenance = true;
  const server = createServer({ port: 0, host: '127.0.0.1', maintenance: () => maintenance });
  let ws: WebSocket | undefined;
  try {
    const port = await server.listen();
    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toMatchObject({ ok: true, maintenance: true, players: 0 });
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); await once(ws,'open');
    let message = once(ws,'message'); ws.send(JSON.stringify({t:'hello'}));
    expect(JSON.parse(String((await message)[0]))).toEqual({t:'error',code:'maintenance'});
    expect((await server.store.call('health')).players).toBe(0);
    maintenance = false;
    message = once(ws,'message'); ws.send(JSON.stringify({t:'hello'}));
    expect(JSON.parse(String((await message)[0])).t).toBe('welcome');
  } finally { ws?.terminate(); await server.close(); }
});

test('timeout wins a race against a late move and records no late action', async () => {
  const { store } = await setup();
  const g = await store.call('createGame', 'a', 'b', true, 'bullet', 10);
  await new Promise(done => setTimeout(done, 25));
  const action = legal(replay([]).board, 1)[0];
  const [move, timeout] = await Promise.all([store.call('applyMove', g.id, 'a', 0, action), store.call('finishGame', g.id, null, 'timeout')]);
  expect(move.game).toMatchObject({ status: 'finished', endReason: 'timeout', moves: [], winner: -1 });
  expect(timeout.error).toBe('finished');
});

test('WAL online backup restores independently and refuses overwriting another backup', async () => {
  const folder = dir(), engine = new DatabaseEngine(join(folder, 'live.sqlite'), true);
  try {
    engine.seedPlayer(fixture('a')); engine.seedPlayer(fixture('b'));
    const game = engine.createGame('a','b',false,'daily');
    engine.applyMove(game.id,'a',0,legal(replay([]).board,1)[0]);
    const file = await backupDatabase(engine, join(folder, 'backup.sqlite'));
    expect(restoreCheck(file)).toMatchObject({ ok: true, players: 2, games: 1, moves: 1 });
    await expect(backupDatabase(engine,file)).rejects.toThrow();
    engine.finishGame(game.id,'a','resign');
    expect(restoreCheck(file).moves).toBe(1);
  } finally { engine.close(); }
});

test('missing DB and changed migration checksum fail startup instead of opening an empty account store', async () => {
  const file = join(dir(), 'missing.sqlite');
  const missing = new Store(file); stores.push(missing);
  await expect(missing.ready).rejects.toThrow(); expect(existsSync(file)).toBe(false);
  const engine = new DatabaseEngine(file,true);
  engine.db.prepare('UPDATE schema_migrations SET checksum=?').run('changed'); engine.close();
  expect(() => new DatabaseEngine(file)).toThrow('modified database migration');
});

test('an acknowledged move survives killing the server process without graceful shutdown', async () => {
  const file = join(dir(),'crash.sqlite'); new DatabaseEngine(file,true).close();
  const child = spawn(process.execPath, ['--import','tsx',resolve('packages/server/src/main.ts')], {
    env: { ...process.env, DB_PATH: file, STORAGE: 'sqlite', DATA: '', PORT: '0', HOST: '127.0.0.1', AI_DIR: 'off' },
    stdio: ['ignore','pipe','pipe'], windowsHide: true,
  });
  children.push(child);
  const port = await new Promise<number>((done, fail) => {
    let output = '';
    const timer = setTimeout(() => fail(new Error('Child startup timed out')), 15000);
    child.stdout!.on('data', chunk => { output += String(chunk); const match = output.match(/localhost:(\d+)/); if (match) { clearTimeout(timer); done(Number(match[1])); } });
    child.once('exit', () => { clearTimeout(timer); fail(new Error('Child exited before startup')); });
    child.once('error', fail);
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`), inbox: ServerMsg[] = [];
  const waiters: { pred: (m: ServerMsg) => boolean; done: (m: ServerMsg) => void }[] = [];
  ws.on('message', raw => { const m = JSON.parse(String(raw)) as ServerMsg; const i = waiters.findIndex(w => w.pred(m)); if (i >= 0) waiters.splice(i,1)[0].done(m); else inbox.push(m); });
  const next = (pred: (m: ServerMsg) => boolean) => {
    const at = inbox.findIndex(pred); if (at >= 0) return Promise.resolve(inbox.splice(at,1)[0]);
    return new Promise<ServerMsg>(done => waiters.push({pred,done}));
  };
  await once(ws,'open'); ws.send(JSON.stringify({ t: 'hello' }));
  await next(m => m.t === 'welcome'); ws.send(JSON.stringify({ t: 'create', color: 'green' }));
  const room = await next(m => m.t === 'game'); if (room.t !== 'game') throw new Error('Missing room');
  // A second client joins to start the game.
  const opponent = new WebSocket(`ws://127.0.0.1:${port}/ws`); await once(opponent,'open');
  opponent.send(JSON.stringify({ t: 'hello' })); await once(opponent,'message');
  opponent.send(JSON.stringify({ t: 'join', code: room.game.code }));
  await next(m => m.t === 'game' && m.game.status === 'active');
  const action = legal(replay([]).board,1)[0]; ws.send(JSON.stringify({ t: 'move', id: room.game.id, ply: 0, action }));
  const acknowledged = await next(m => m.t === 'game' && m.game.moves.length === 1);
  expect((acknowledged as { game: OnlineGame }).game.moves).toEqual([action]);
  const exited = once(child,'exit'); child.kill('SIGKILL'); await exited; ws.terminate(); opponent.terminate();
  const reopened = new Store(file); stores.push(reopened);
  expect((await reopened.call('game',room.game.id))?.moves).toEqual([action]);
  expect((await reopened.call('health')).ok).toBe(true);
});
