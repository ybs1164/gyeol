import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legal, replay, transformBoard } from '@gyeol/core';
import { DatabaseEngine } from '../src/database';
import { exportTrainingPositions, type TrainingPosition } from '../src/training-export';
import type { PlayerRecord } from '../src/models';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function dir() { const d = mkdtempSync(join(tmpdir(), 'gyeol-export-test-')); dirs.push(d); return d; }
function person(id: string, bot = false): PlayerRecord {
  return { id, token: `private-token-${id}`, name: `name-${id}`, rating: 1500, rd: 100, vol: .06, ranked: 5, rated: 5,
    wins: 0, losses: 0, createdAt: 1000, seenAt: 2000, ratingAt: 1000, historyComplete: true, history: [], ...(bot ? { bot: true, botRosterVersion: 2 } : {}) };
}
/** 결정적인 수순으로 끝까지 둔다. pick 은 합법 수 목록에서 고른다. */
function play(engine: DatabaseEngine, green: string, brown: string, pick: (moves: number[], ply: number) => number, resignAt?: number) {
  const id = engine.createGame(green, brown, false, 'daily').id;
  for (let guard = 0; guard < 200; guard++) {
    const g = engine.game(id)!;
    if (g.status === 'finished') return id;
    const { board, player } = replay(g.moves);
    const pid = player === 1 ? green : brown;
    if (resignAt !== undefined && g.moves.length >= resignAt) { engine.finishGame(id, pid, 'resign'); return id; }
    const change = engine.applyMove(id, pid, g.moves.length, pick(legal(board, player), g.moves.length), g.revision);
    if (change.error) throw new Error(change.error);
  }
  throw new Error('game did not finish');
}
const first = (moves: number[]) => moves[0];
const varied = (seed: number) => (moves: number[], ply: number) => moves[(seed * 31 + ply * 7) % moves.length];
const read = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as TrainingPosition);

function setup() {
  const folder = dir(), db = join(folder, 'gyeol.sqlite'), out = join(folder, 'export'), exclude = join(folder, 'frozen.jsonl');
  const engine = new DatabaseEngine(db, true);
  for (const p of [person('alice'), person('bob'), person('robot', true)]) engine.seedPlayer(p);
  writeFileSync(exclude, '');
  return { folder, db, out, exclude, engine };
}

test('끝난 대국의 국면만 식별자 없이 내보내고, 다시 실행하면 새 대국만 읽는다', () => {
  const { db, out, exclude, engine } = setup();
  play(engine, 'alice', 'robot', varied(1));
  play(engine, 'bob', 'alice', varied(2));
  engine.createGame('alice', 'bob', false, 'daily'); // 진행 중인 대국은 제외
  engine.close();
  const before = createHash('sha256').update(readFileSync(db)).digest('hex');

  const report = exportTrainingPositions({ db, out, exclude: [exclude] });
  expect(report.games).toMatchObject({ read: 2, exported: 2, invalid: 0 });
  expect(report.positions.written).toBeGreaterThan(20);
  expect(createHash('sha256').update(readFileSync(db)).digest('hex')).toBe(before); // 운영 DB는 바뀌지 않는다

  const text = readFileSync(report.file!, 'utf8');
  for (const secret of ['alice', 'bob', 'robot', 'private-token', 'name-']) expect(text).not.toContain(secret);
  const rows = read(report.file!);
  expect(rows.every(r => r.rule === 'facing-25-v1' && r.board.length === 49 && legal(r.board, r.player).length > 0)).toBe(true);
  expect(rows.some(r => r.mover === 'bot' && r.opponent === 'human')).toBe(true);
  expect(rows.some(r => r.mover === 'human' && r.opponent === 'human')).toBe(true);
  expect(rows.every(r => !('winner' in r))).toBe(true);

  expect(exportTrainingPositions({ db, out, exclude: [exclude] })).toMatchObject({ file: null, games: { read: 0 }, positions: { written: 0 } });
  const again = new DatabaseEngine(db);
  play(again, 'bob', 'robot', varied(3)); again.close();
  const next = exportTrainingPositions({ db, out, exclude: [exclude] });
  expect(next.games).toMatchObject({ read: 1, exported: 1 });
  expect(next.totals).toMatchObject({ runs: 3, games: 3 });
});

test('같은 국면은 대칭을 포함해 한 번만, 얼린 시험 세트 국면은 내보내지 않는다', () => {
  const { db, out, exclude, engine } = setup();
  const g1 = play(engine, 'alice', 'bob', first);
  play(engine, 'bob', 'alice', first); // 같은 수순
  const moves = engine.game(g1)!.moves;
  engine.close();
  // 시험 세트에 5수째 국면을 대칭으로 돌려 넣는다
  const { board, player } = replay(moves.slice(0, 5));
  writeFileSync(exclude, JSON.stringify({ board: transformBoard(board, 5), player }) + '\n');

  const report = exportTrainingPositions({ db, out, exclude: [exclude] });
  expect(report.positions.testSet).toBe(2); // 두 대국 모두 그 국면을 지난다
  expect(report.positions.duplicate).toBeGreaterThanOrEqual(moves.length - 2);
  const rows = read(report.file!);
  const keys = rows.map(r => r.board.map(v => v * r.player).join(','));
  expect(new Set(keys).size).toBe(rows.length);
  expect(rows.some(r => r.ply === 6)).toBe(false);
});

test('사람별 상한은 사람에게만 적용하고, 짧은 대국은 버린다', () => {
  const { db, out, exclude, engine } = setup();
  play(engine, 'alice', 'robot', varied(4));
  play(engine, 'robot', 'alice', varied(5));
  play(engine, 'bob', 'alice', varied(6), 2); // 2수에서 기권
  engine.close();
  const report = exportTrainingPositions({ db, out, exclude: [exclude], playerCap: 3 });
  expect(report.games.short).toBe(1);
  const rows = read(report.file!);
  expect(rows.filter(r => r.mover === 'human')).toHaveLength(3);
  expect(rows.filter(r => r.mover === 'bot').length).toBeGreaterThan(3);
  expect(report.positions.playerCap).toBeGreaterThan(0);
  const state = JSON.parse(readFileSync(join(out, 'state.json'), 'utf8'));
  expect(JSON.stringify(state)).not.toContain('alice');
});

test('시험 세트 제외 없이는 실행하지 않는다', () => {
  const { db, out, engine } = setup(); engine.close();
  expect(() => exportTrainingPositions({ db, out, exclude: [] })).toThrow('--exclude');
});
