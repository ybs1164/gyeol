import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uniqueProofProblem, type PuzzleBankFile } from '@gyeol/core';
import { createServer } from '../src/server';
import { assignRatings, mineGame, minePuzzles, readArchive } from '../src/puzzle-miner';

const fixture = JSON.parse(readFileSync(new URL('../../core/test/puzzle-bank.fixture.json', import.meta.url), 'utf8')) as PuzzleBankFile;
const archivePath = fileURLToPath(new URL('../../../tools/record-puzzles/source-games.json', import.meta.url));
const folders: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (folders.length) rmSync(folders.pop()!, { recursive: true, force: true });
});
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'gyeol-puzzles-')); folders.push(d); return d; };

describe('서버 퍼즐 생성기', () => {
  test('보관 기보에서 정답이 하나뿐인 국면만 발췌하고, 다시 실행하면 새 대국만 본다', () => {
    const games = readArchive(archivePath);
    const ids = new Set(fixture.puzzles.slice(0, 2).map((p) => p.source.gameId));
    const picked = games.filter((g) => ids.has(g.id));
    expect(picked.length).toBe(ids.size);
    const dir = temp();
    const archive = join(dir, 'archive.json');
    const raw = JSON.parse(readFileSync(archivePath, 'utf8'));
    writeFileSync(archive, JSON.stringify({ ...raw, games: raw.games.filter((g: { id: string }) => ids.has(g.id)) }));
    const first = minePuzzles({ archive, state: join(dir, 'state') });
    expect(first.newGames).toBe(ids.size);
    expect(first.puzzles).toBeGreaterThanOrEqual(ids.size);
    const bank = JSON.parse(readFileSync(first.out, 'utf8')) as PuzzleBankFile;
    expect(bank.puzzles.length).toBe(first.puzzles);
    for (const p of bank.puzzles) expect(uniqueProofProblem(p), p.id).toBeNull();
    for (const p of fixture.puzzles.slice(0, 2)) expect(bank.puzzles.map((q) => q.id)).toContain(p.id);
    const second = minePuzzles({ archive, state: join(dir, 'state') });
    expect(second.newGames).toBe(0);
    expect(second.version).toBe(first.version);
  });
  test('정답이 둘 이상인 국면이나 한 수로 끝나는 국면은 은행에 들어가지 않는다', () => {
    const games = readArchive(archivePath);
    const game = games.find((g) => g.id === fixture.puzzles[0].source.gameId)!;
    const mined = mineGame(game, { nodeLimit: 2_000_000, verifyBudget: 3_000_000, maxRemaining: 6 });
    expect(mined.puzzles.length).toBeGreaterThan(0);
    // 같은 대국의 다른 후반 국면은 대부분 정답이 여럿이거나 바로 끝나서 탈락한다
    expect((mined.rejected['not-unique'] ?? 0) + (mined.rejected['immediate-finish'] ?? 0) + (mined.rejected['line-not-unique'] ?? 0)).toBeGreaterThan(0);
  });
  test('점수는 8단계에 고르게 나뉜다', () => {
    const rated = assignRatings(fixture.puzzles);
    expect(new Set(rated.map((p) => p.rating)).size).toBe(rated.length);
    expect(Math.min(...rated.map((p) => p.rating))).toBeGreaterThanOrEqual(974);
  });
});

describe('GET /api/puzzles', () => {
  test('은행을 CORS·ETag와 함께 내려주고, 바뀌지 않았으면 304', async () => {
    const dir = temp();
    const file = join(dir, 'bank.json');
    writeFileSync(file, JSON.stringify(fixture));
    const s = createServer({ port: 0, host: '127.0.0.1', dbPath: null, createDatabase: true, puzzleBank: file });
    servers.push(s);
    const port = await s.listen();
    const res = await fetch(`http://127.0.0.1:${port}/api/puzzles`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await res.json()) as PuzzleBankFile;
    expect(body.version).toBe(fixture.version);
    expect(body.puzzles.length).toBe(fixture.puzzles.length);
    const again = await fetch(`http://127.0.0.1:${port}/api/puzzles`, { headers: { 'if-none-match': res.headers.get('etag')! } });
    expect(again.status).toBe(304);
    // 정답이 하나라는 조건을 어긴 문제는 서버가 내보내지 않는다
    const broken = structuredClone(fixture);
    const root = broken.puzzles[0].proof[0][1];
    for (const v of root) v[1] = 3;
    writeFileSync(file, JSON.stringify(broken));
    const filtered = (await (await fetch(`http://127.0.0.1:${port}/api/puzzles`)).json()) as PuzzleBankFile;
    expect(filtered.puzzles.length).toBe(fixture.puzzles.length - 1);
  });
  test('은행이 아직 없으면 503', async () => {
    const s = createServer({ port: 0, host: '127.0.0.1', dbPath: null, createDatabase: true, puzzleBank: join(temp(), 'missing.json') });
    servers.push(s);
    const port = await s.listen();
    const res = await fetch(`http://127.0.0.1:${port}/api/puzzles`);
    expect(res.status).toBe(503);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
