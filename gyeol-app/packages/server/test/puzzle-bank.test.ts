import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uniqueProofProblem, type PuzzleBankFile } from '@gyeol/core';
import { createServer } from '../src/server';
import { assignRatings, mineGame, mineKeep, minePuzzles, readArchive } from '../src/puzzle-miner';
import { KEEP_PUZZLE_CRITERIA, apply, legal, keepPuzzleProblem, buildKeepPuzzle, bruteForceProblem, mistakeProblem, type RecordPuzzleData } from '@gyeol/core';

const fixture = JSON.parse(readFileSync(new URL('../../core/test/puzzle-bank.fixture.json', import.meta.url), 'utf8')) as PuzzleBankFile;
const archivePath = fileURLToPath(new URL('../../../tools/record-puzzles/source-games.json', import.meta.url));
const folders: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (folders.length) rmSync(folders.pop()!, { recursive: true, force: true });
});
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'gyeol-puzzles-')); folders.push(d); return d; };

/**
 * 상대의 직전 실수 기준(2026-11-25)으로 보관 기보 앞 81판을 훑었을 때 문제가 나온 대국들.
 * AI 자가대국은 종반 전에 승패가 갈려 수순 문제는 0개였고, 한 수 문제(종국 계산)만 이 대국들에서 나왔다.
 */
const MISTAKE_GAMES = ['game-0a0bfb654c86bbb5', 'game-ffe631586730e6a4'];
const archiveOf = (dir: string, ids: Set<string>) => {
  const archive = join(dir, 'archive.json');
  const raw = JSON.parse(readFileSync(archivePath, 'utf8'));
  writeFileSync(archive, JSON.stringify({ ...raw, games: raw.games.filter((g: { id: string }) => ids.has(g.id)) }));
  return archive;
};

describe('서버 퍼즐 생성기', () => {
  test('상대가 직전에 실수한 국면에서만 정답이 하나뿐인 문제를 발췌하고, 다시 실행하면 새 대국만 본다', async () => {
    const ids = new Set(MISTAKE_GAMES.slice(0, 1));
    const dir = temp();
    const archive = archiveOf(dir, ids);
    const first = await minePuzzles({ archive, state: join(dir, 'state') });
    expect(first.newGames).toBe(ids.size);
    expect(first.puzzles).toBeGreaterThan(0);
    const bank = JSON.parse(readFileSync(first.out, 'utf8')) as PuzzleBankFile;
    expect(bank.puzzles.length).toBe(first.puzzles);
    expect(bank.criteria.mistake).toBeTruthy();
    for (const p of bank.puzzles) {
      expect(uniqueProofProblem(p), p.id).toBeNull();
      expect(mistakeProblem(p), p.id).toBeNull();
      // 상대가 실수 전 판에서 그 수를 두면 문제 판이 된다
      expect(apply(p.mistake!.board, -p.player as 1 | -1, p.mistake!.action).board).toEqual(p.board);
    }
    const second = await minePuzzles({ archive, state: join(dir, 'state') });
    expect(second.newGames).toBe(0);
    expect(second.version).toBe(first.version);
  }, 300_000);
  test('기준이 바뀌어 다시 발췌하는 중에는 끝날 때까지 이전 은행을 그대로 둔다', async () => {
    const dir = temp();
    const archive = archiveOf(dir, new Set(MISTAKE_GAMES));
    const out = join(dir, 'state', 'bank.json');
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(out, 'previous');
    let clock = 0;
    // 시간 예산 1분, 대국 하나마다 2분이 지난 것처럼: 첫 대국만 보고 멈춘다
    const partial = await minePuzzles({ archive, state: join(dir, 'state'), budgetMinutes: 1, now: () => (clock += 60_000) });
    expect(partial.pendingGames).toBeGreaterThan(0);
    expect(partial.written).toBe(false);
    expect(readFileSync(out, 'utf8')).toBe('previous');
    const done = await minePuzzles({ archive, state: join(dir, 'state') });
    expect(done.pendingGames).toBe(0);
    expect(done.written).toBe(true);
  }, 300_000);
  test('정답이 하나뿐이어도 상대가 이미 지고 있던 국면이면 은행에 들어가지 않는다', () => {
    // 이전 기준에서 수순 문제가 나왔던 대국: 정답 하나짜리 국면이 있지만 상대는 그 전에 이미 졌다
    const game = readArchive(archivePath).find((g) => g.id === fixture.puzzles[0].source.gameId)!;
    const mined = mineGame(game, { nodeLimit: 2_000_000, verifyBudget: 3_000_000, maxRemaining: 6 });
    expect(mined.puzzles.length).toBe(0);
    expect(mined.rejected['opponent-already-lost']).toBeGreaterThan(0);
    expect((mined.rejected['not-unique'] ?? 0) + (mined.rejected['line-not-unique'] ?? 0)).toBeGreaterThan(0);
  }, 120_000);
  test('저장된 실수가 판과 맞지 않거나 실수가 아니면 문제를 버린다', async () => {
    const game = readArchive(archivePath).find((g) => g.id === MISTAKE_GAMES[0])!;
    const p = (await mineKeep(game, { exactNodes: 1_500_000, verifyBudget: 3_000_000 })).puzzles[0];
    expect(p.mistake).toBeTruthy();
    expect(uniqueProofProblem(p)).toBeNull();
    const m = p.mistake!;
    const opponent = -p.player as 1 | -1;
    const other = legal(m.board, opponent).find((a) => a !== m.action && apply(m.board, opponent, a).board.join(',') !== p.board.join(','))!;
    const broken = (mistake: object) => uniqueProofProblem({ ...p, mistake: { ...m, ...mistake } });
    expect(broken({ action: other })).toBe('mistake-board-mismatch');
    expect(broken({ before: -1 })).toBe('mistake-not-decisive');
    expect(broken({ best: m.action })).toBe('mistake-bad-alternative');
    expect(broken({ judge: 'ai', before: 0.6, after: 0.3 })).toBe('mistake-judge-mismatch');
    expect(mistakeProblem({ ...p, mistake: undefined })).toBe('missing-mistake');
    // AI 판정 문제의 실수는 상대 승률이 35%p 이상 떨어져야 한다
    const ai = { ...p, judge: 'ai' as const };
    expect(mistakeProblem(ai, { ...m, judge: 'ai', before: 0.6, after: 0.3 })).toBe('mistake-too-small');
    expect(mistakeProblem(ai, { ...m, judge: 'ai', before: 0.35, after: 0 })).toBe('mistake-too-small');
    expect(mistakeProblem(ai, { ...m, judge: 'ai', before: 0.7, after: 0.3 })).toBeNull();
  }, 120_000);
  test('점수는 8단계에 고르게 나뉜다', () => {
    const rated = assignRatings(fixture.puzzles);
    expect(new Set(rated.map((p) => p.rating)).size).toBe(rated.length);
    expect(Math.min(...rated.map((p) => p.rating))).toBeGreaterThanOrEqual(974);
  });
});

describe('한 수 문제(유리함을 지키는 단 하나의 수)', () => {
  test('종국 계산으로 승리를 지키는 수가 하나뿐인 국면을 찾고, 전수 탐색과 일치한다', async () => {
    const games = readArchive(archivePath);
    const found: RecordPuzzleData[] = [];
    for (const game of games.filter((g) => MISTAKE_GAMES.includes(g.id))) {
      const mined = await mineKeep(game, { exactNodes: 1_500_000, verifyBudget: 3_000_000 });
      found.push(...mined.puzzles);
    }
    expect(found.length).toBeGreaterThan(0);
    for (const p of found) {
      expect(p.format).toBe('move');
      expect(p.judge).toBe('exact');
      expect(p.mistake?.judge).toBe('exact');
      expect(keepPuzzleProblem(p), p.id).toBeNull();
      const wins = p.proof[0][1].filter(([, v]) => v > 0).map(([a]) => apply(p.board, p.player, a).board.join(','));
      expect(new Set(wins).size).toBe(1);
      const remaining = 25 - p.board.filter(Boolean).length;
      if (remaining <= 6) expect(bruteForceProblem(p)).toBeNull();
    }
  }, 120_000);
  test('AI 판정은 불리해지지 않는(승률 50% 이상) 수가 하나뿐이고 경계에서 분명히 갈릴 때만 낸다', () => {
    const p = fixture.puzzles.find((q) => q.format === 'move')!;
    const actions = legal(p.board, p.player);
    const boards = actions.map((a) => apply(p.board, p.player, a).board.join(','));
    // 바로 끝나지 않는 수(종국 계산의 정답)를 정답 후보로 쓴다
    const target2 = boards[p.proof[0][1].findIndex(([, v]) => v > 0)];
    const evals = (top: number, rival: number) => new Map(actions.map((a, i) => [a, boards[i] === target2 ? top : rival]));
    const source = p.source;
    const make = (top: number, rival: number) => buildKeepPuzzle(p.board, p.player, { id: p.id, judge: 'ai', evals: evals(top, rival), source, raw: 10, model: 'test' });
    const ok = buildKeepPuzzle(p.board, p.player, { id: p.id, judge: 'ai', evals: new Map(actions.map((a, i) => [a, boards[i] === target2 ? 0.7 : 0.4])), source, raw: 10, model: 'test' });
    expect(typeof ok).not.toBe('string');
    if (typeof ok !== 'string') { expect(keepPuzzleProblem(ok)).toBeNull(); expect(ok.model).toBe('test'); }
    // 이기던 판을 지키는 수든, 겨우 비등하게 버티는 수든 50% 이상이면 정답이다. 그런 수가 둘이면 퍼즐이 아니다
    expect(make(0.9, 0.55)).toBe('not-unique');
    expect(make(0.7, 0.5)).toBe('not-unique');
    expect(typeof make(0.53, 0.4)).not.toBe('string');
    // 경계에서 탐색 오차만큼 가까우면 내지 않는다
    expect(make(0.51, 0.3)).toBe('unclear');
    expect(make(0.8, 0.49)).toBe('unclear');
    expect(make(0.45, 0.3)).toBe('no-win');
    expect(KEEP_PUZZLE_CRITERIA.notWorse).toBe(0.5);
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
