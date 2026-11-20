import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { PASS, gameOver, legal, replay, type ClientMsg, type OnlineGame, type ServerMsg } from '@gyeol/core';
import { createServer } from '../src/server';
import { Store } from '../src/store';
import { update, DEFAULT_RATING } from '../src/glicko';
import botRatings from '../src/bot-ratings.json';
import { createCognitiveRoster, createWideRoster } from '@gyeol/ai';

/** 가짜 모델: 모든 수를 같은 확률로. 서버의 봇 흐름(매칭·착수·레이팅)만 검사한다 (실제 모델은 tools/calibrate_bots.ts 로 확인) */
const fakeBrain = async () => async (b: number[]) => ({ priors: legal(b, 1).map(() => 1), value: 0 });

// 마지막 착수 뒤 선공만 둘 곳이 없고, 후공은 한 수 더 둘 수 있는 실제 기보.
const FORCED_PASS_MOVES = [386, 258, 374, 271, 267, 240, 256, 149, 297, 511, 491, 399, 371, 501, 486, 300, 181, 607, 522, 637, 640, 405];

type Srv = ReturnType<typeof createServer>;
const servers: Srv[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function start(opts: Parameters<typeof createServer>[0] = {}) {
  const s = createServer({ port: 0, host: '127.0.0.1', dbPath: null, createDatabase: true, ...opts });
  servers.push(s);
  return { s, port: await s.listen() };
}

/** 테스트용 클라이언트: 받은 메시지를 쌓아 두고 조건에 맞는 메시지를 기다린다 */
async function client(port: number, token?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox: ServerMsg[] = [];
  const waiters: { pred: (m: ServerMsg) => boolean; done: (m: ServerMsg) => void }[] = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as ServerMsg;
    const w = waiters.findIndex((x) => x.pred(m));
    if (w >= 0) waiters.splice(w, 1)[0].done(m);
    else inbox.push(m);
  });
  await new Promise((r) => ws.on('open', r));
  const next = <T extends ServerMsg>(pred: (m: ServerMsg) => boolean): Promise<T> => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0] as T);
    return new Promise((done, fail) => {
      waiters.push({ pred, done: done as (m: ServerMsg) => void });
      setTimeout(() => fail(new Error('timeout')), 4000);
    });
  };
  const send = (m: ClientMsg) => ws.send(JSON.stringify(m));
  send({ t: 'hello', token });
  const welcome = await next<Extract<ServerMsg, { t: 'welcome' }>>((m) => m.t === 'welcome');
  const game = (pred: (g: OnlineGame) => boolean = () => true) =>
    next<Extract<ServerMsg, { t: 'game' }>>((m) => m.t === 'game' && pred(m.game)).then((m) => m.game);
  return { ws, send, next, game, me: welcome.me, token: welcome.token };
}

/** 두 사람이 첫 합법 수만 두며 끝까지 진행 */
async function playOut(a: Awaited<ReturnType<typeof client>>, b: Awaited<ReturnType<typeof client>>, g: OnlineGame) {
  const byColor = { 1: g.green!.id === a.me.id ? a : b, [-1]: g.green!.id === a.me.id ? b : a };
  while (g.status === 'active') {
    const { board, player } = replay(g.moves);
    const c = byColor[player];
    const ply = g.moves.length;
    c.send({ t: 'move', id: g.id, ply, action: legal(board, player)[0] });
    g = await c.game((x) => x.moves.length > ply);
  }
  return g;
}

async function playPlies(a: Awaited<ReturnType<typeof client>>, b: Awaited<ReturnType<typeof client>>, g: OnlineGame, n = 6) {
  for (let i = 0; i < n; i++) {
    const { board, player } = replay(g.moves);
    const c = (player === 1 ? g.green!.id : g.brown!.id) === a.me.id ? a : b;
    const ply = g.moves.length;
    c.send({ t: 'move', id: g.id, ply, action: legal(board, player)[0] });
    g = await a.game((x) => x.id === g.id && x.moves.length > ply);
  }
  return g;
}

async function rankedGame(a: Awaited<ReturnType<typeof client>>, b: Awaited<ReturnType<typeof client>>) {
  a.send({ t: 'queue', mode: 'daily' });
  await a.next((m) => m.t === 'queued');
  b.send({ t: 'queue', mode: 'daily' });
  return a.game((g) => g.ranked && g.status === 'active' && g.moves.length === 0);
}

describe('Glicko-2', () => {
  test('이기면 오르고 지면 내려가며, 불확실도는 줄어든다', () => {
    const w = update(DEFAULT_RATING, DEFAULT_RATING, 1);
    const l = update(DEFAULT_RATING, DEFAULT_RATING, 0);
    expect(w.rating).toBeGreaterThan(1600);
    expect(l.rating).toBeLessThan(1400);
    expect(w.rating - 1500).toBeCloseTo(1500 - l.rating, 6);
    expect(w.rd).toBeLessThan(350);
    const strong = { rating: 1900, rd: 60, vol: 0.06 };
    expect(update(strong, DEFAULT_RATING, 1).rating - 1900).toBeLessThan(5); // 약한 상대를 이기면 조금만 오름
  });
});

describe('온라인 서버', () => {
  test('접속하지 않은 상대의 강제 패스도 자동 기록하고, 시계를 차감하지 않고 다음 착수를 받는다', async () => {
    const { s, port } = await start();
    const a = await client(port), b = await client(port);
    a.send({ t: 'create', color: 'green' });
    const room = await a.game();
    b.send({ t: 'join', code: room.code! });
    let g = await b.game((x) => x.status === 'active');
    for (const action of FORCED_PASS_MOVES.slice(0, -1)) {
      const { player } = replay(g.moves);
      const c = player === 1 ? a : b;
      const ply = g.moves.length;
      c.send({ t: 'move', id: g.id, ply, action });
      g = await c.game((x) => x.id === g.id && x.moves.length > ply);
    }
    a.ws.close();
    await new Promise((done) => a.ws.once('close', done));
    await s.store.call('patchGame', g.id, { clock: { green: 5000, brown: 5000 }, turnStartedAt: Date.now() - 50 });
    b.send({ t: 'move', id: g.id, ply: g.moves.length, action: FORCED_PASS_MOVES.at(-1)! });
    g = await b.game((x) => x.moves.length === FORCED_PASS_MOVES.length + 1);
    expect(g.moves).toEqual([...FORCED_PASS_MOVES, PASS]);
    expect(g.status).toBe('active');
    expect(g.clock!.green).toBe(5000);
    expect(g.clock!.brown).toBeLessThan(5000);
    const passed = replay(g.moves);
    expect(passed.board).toEqual(replay(FORCED_PASS_MOVES).board);
    expect(passed.player).toBe(-1);
    expect(legal(passed.board, passed.player)[0]).not.toBe(PASS);
    b.send({ t: 'move', id: g.id, ply: g.moves.length, action: legal(passed.board, passed.player)[0] });
    const end = await b.game((x) => x.status === 'finished');
    expect(gameOver(end.moves)).toBe(end.winner);
    expect(end.moves.filter((a) => a === PASS)).toHaveLength(1);
  });

  test('재시작하면 수동 패스를 기다리던 기보를 한 번만 자동으로 넘긴다', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'gyeol-pass-')), 'data.sqlite');
    const { s, port } = await start({ dbPath });
    const a = await client(port), b = await client(port);
    a.send({ t: 'create', color: 'green' });
    const room = await a.game();
    b.send({ t: 'join', code: room.code! });
    await b.game((x) => x.status === 'active');
    await s.store.call('patchGame', room.id, { moves: [...FORCED_PASS_MOVES] });
    await servers.pop()!.close();
    for (let i = 0; i < 2; i++) {
      const { s: restored } = await start({ dbPath });
      expect((await restored.store.call('game', room.id))!.moves).toEqual([...FORCED_PASS_MOVES, PASS]);
      await servers.pop()!.close();
    }
  });

  test('친구 초대 코드로 한 판을 끝까지 두고, 같은 토큰으로 다시 접속한다', async () => {
    const { port } = await start();
    const a = await client(port);
    const b = await client(port);
    a.send({ t: 'create', color: 'green' });
    const room = await a.game();
    expect(room.status).toBe('waiting');
    expect(room.code).toMatch(/^[A-Z2-9]{5}$/);

    b.send({ t: 'join', code: room.code!.toLowerCase() });
    const started = await b.game((g) => g.status === 'active');
    expect(started.green!.id).toBe(a.me.id);
    expect(started.brown!.id).toBe(b.me.id);
    expect(started.online).toEqual({ green: true, brown: true });

    // 차례가 아닌 사람, 오래된 ply, 불법 수는 거부
    b.send({ t: 'move', id: room.id, ply: 0, action: legal(replay([]).board, 1)[0] });
    expect((await b.next((m) => m.t === 'error')) as unknown).toEqual({ t: 'error', code: 'not_your_turn' });
    a.send({ t: 'move', id: room.id, ply: 3, action: 0 });
    expect(await a.next((m) => m.t === 'error')).toEqual({ t: 'error', code: 'stale' });
    a.send({ t: 'move', id: room.id, ply: 0, action: 5 });
    expect(await a.next((m) => m.t === 'error')).toEqual({ t: 'error', code: 'illegal' });

    const end = await playOut(a, b, started);
    expect(end.status).toBe('finished');
    expect(end.ratingChange).toBeNull(); // 친선전은 레이팅 변화 없음

    a.ws.close();
    const again = await client(port, a.token);
    expect(again.me.id).toBe(a.me.id);
    again.send({ t: 'games' });
    const list = await again.next<Extract<ServerMsg, { t: 'games' }>>((m) => m.t === 'games');
    expect(list.games[0].id).toBe(room.id);
  });

  test('랭크전 매칭 → 기권 → 레이팅 반영, 순위표', async () => {
    const { s, port } = await start();
    const a = await client(port);
    const b = await client(port);
    await s.store.call('patchPlayer', a.me.id, { ranked: 5, rated: 5, rd: 100 });
    a.send({ t: 'queue', mode: 'blitz' });
    await a.next((m) => m.t === 'queued');
    b.send({ t: 'queue', mode: 'blitz' });
    const g = await a.game((x) => x.ranked);
    expect(g.status).toBe('active');
    expect(g.mode).toBe('blitz');
    expect(g.clock).toEqual({ green: 180_000, brown: 180_000 });
    await playPlies(a, b, g);
    a.send({ t: 'resign', id: g.id });
    const end = await b.game((x) => x.status === 'finished');
    expect(end.endReason).toBe('resign');
    const aIsGreen = g.green!.id === a.me.id;
    expect(end.winner).toBe(aIsGreen ? -1 : 1);
    const delta = end.ratingChange!;
    expect(aIsGreen ? delta.green : delta.brown).toBeLessThan(0);
    expect(aIsGreen ? delta.brown : delta.green).toBeGreaterThan(0);

    b.send({ t: 'leaderboard' });
    const lb = await b.next<Extract<ServerMsg, { t: 'leaderboard' }>>((m) => m.t === 'leaderboard');
    expect(lb.players.map((p) => p.id)).toEqual([a.me.id]); // 신규 b는 1판만 평가됨
    expect((await s.store.call('player', b.me.id, true))!.rated).toBe(1);

    b.send({ t: 'history' });
    const h = await b.next<Extract<ServerMsg, { t: 'history' }>>((m) => m.t === 'history');
    expect(h.points).toHaveLength(2);
    expect(h.points[0].rating).toBe(1500);
    expect(h.points[1].rating).toBeGreaterThan(1500);
    expect(h.summary?.complete).toBe(true);
  });

  test('새 계정 10개의 0수 기권승으로 점수·불확실도·배치 진행을 얻지 못한다', async () => {
    const { s, port } = await start({ accountLimit: { count: 20, windowMs: 3_600_000 } });
    const a = await client(port);
    for (let i = 0; i < 10; i++) {
      const b = await client(port);
      const g = await rankedGame(a, b);
      b.send({ t: 'resign', id: g.id });
      const end = await a.game((x) => x.id === g.id && x.status === 'finished');
      expect(end.ratingRestriction).toEqual({ green: 'early', brown: 'early' });
      const winner = (await s.store.call('player', a.me.id, true))!;
      const loser = (await s.store.call('player', b.me.id, true))!;
      expect(winner.rating).toBe(1500);
      expect(winner.rd).toBe(350);
      expect(winner.rated).toBe(0);
      expect(loser.rating).toBeLessThan(1500); // 즉시 기권해도 패배를 피하지 못함
      expect(loser.rated).toBe(0);
    }
    expect((await s.store.call('player', a.me.id, true))!.ranked).toBe(10);
    a.send({ t: 'leaderboard' });
    const lb = await a.next<Extract<ServerMsg, { t: 'leaderboard' }>>((m) => m.t === 'leaderboard');
    expect(lb.players).toEqual([]);
  });

  test('동일 상대 24시간 내 세 번째 대국은 승점·배치가 제한되고 손실은 유지된다', async () => {
    const { s, port } = await start();
    const a = await client(port), b = await client(port);
    await s.store.call('patchPlayer', a.me.id, { ranked: 5, rated: 5 });
    await s.store.call('patchPlayer', b.me.id, { ranked: 5, rated: 5 });
    let before = 1500;
    for (let i = 0; i < 3; i++) {
      const g = await rankedGame(a, b);
      await playPlies(a, b, g);
      b.send({ t: 'resign', id: g.id });
      const end = await a.game((x) => x.id === g.id && x.status === 'finished');
      const winner = (await s.store.call('player', a.me.id, true))!;
      if (i < 2) {
        expect(end.ratingRestriction).toBeUndefined();
        expect(winner.rating).toBeGreaterThan(before);
      } else {
        expect(end.ratingRestriction).toEqual({ green: 'repeat', brown: 'repeat' });
        expect(winner.rating).toBe(before);
        const delta = g.green!.id === b.me.id ? end.ratingChange!.green : end.ratingChange!.brown;
        expect(delta).toBeLessThan(0);
      }
      before = winner.rating;
    }
    expect((await s.store.call('player', a.me.id, true))!.rated).toBe(7);
    expect((await s.store.call('player', b.me.id, true))!.rated).toBe(7);
  });

  test('순위표는 정상 평가 5판과 현재 RD를 확인한다', async () => {
    const { s, port } = await start();
    const a = await client(port), b = await client(port), c = await client(port);
    const now = Date.now();
    await s.store.call('patchPlayer', a.me.id, { ranked: 20, rated: 4, rd: 40, rating: 2200, ratingAt: now });
    await s.store.call('patchPlayer', b.me.id, { ranked: 5, rated: 5, rd: 100, rating: 1800, ratingAt: now });
    await s.store.call('patchPlayer', c.me.id, { ranked: 30, rated: 30, rd: 40, rating: 2100, ratingAt: now - 365 * 86_400_000 });
    b.send({ t: 'leaderboard' });
    const lb = await b.next<Extract<ServerMsg, { t: 'leaderboard' }>>((m) => m.t === 'leaderboard');
    expect(lb.players.map((p) => p.id)).toEqual([b.me.id]);
    const returned = await client(port, c.token);
    expect(returned.me.rd).toBeGreaterThan(150);
    expect((await s.store.call('player', c.me.id, true))!.rd).toBe(40); // 조회는 저장 RD를 변경하지 않음
    const again = await client(port, c.token);
    expect(again.me.rd).toBe(returned.me.rd);
  });

  test('6수 이상 두거나 정상 완주해도 신규 계정끼리 승점과 배치를 만들지 못한다', async () => {
    const { s, port } = await start();
    const a = await client(port), b = await client(port);
    const g = await rankedGame(a, b);
    const end = await playOut(a, b, g);
    expect(end.endReason).toBe('normal');
    expect(end.moves.length).toBeGreaterThan(6);
    expect(end.ratingRestriction).toEqual({ green: 'provisional', brown: 'provisional' });
    const winnerId = end.winner === 1 ? end.green!.id : end.brown!.id;
    const loserId = end.winner === 1 ? end.brown!.id : end.green!.id;
    expect((await s.store.call('player', winnerId, true))!.rating).toBe(1500);
    expect((await s.store.call('player', loserId, true))!.rating).toBeLessThan(1500);
    expect((await s.store.call('player', a.me.id, true))!.rated).toBe(0);
    expect((await s.store.call('player', b.me.id, true))!.rated).toBe(0);
  });

  test('300판 뒤에도 기록과 최고점을 보존하고 표시 증감을 일치시킨다', async () => {
    const { s, port } = await start();
    const a = await client(port), b = await client(port);
    await s.store.call('patchPlayer', b.me.id, { ranked: 5, rated: 5 });
    let p = (await s.store.call('player', a.me.id, true))!;
    p = await s.store.call('patchPlayer', p.id, { rating: 1500.49, peakRating: 2500, lowestRating: 1200, historyComplete: false,
      history: Array.from({ length: 300 }, (_, i) => ({ at: Date.now() - 1000 + i, rating: i === 0 ? 2500 : 1500 })) });
    const g = await rankedGame(a, b);
    await playPlies(a, b, g);
    b.send({ t: 'resign', id: g.id });
    const end = await a.game((x) => x.id === g.id && x.status === 'finished');
    const isGreen = end.green!.id === a.me.id;
    p = (await s.store.call('player', p.id, true))!;
    expect((isGreen ? end.ratingChange!.green : end.ratingChange!.brown)).toBe(Math.round(p.rating) - 1500);
    a.send({ t: 'history' });
    const h = await a.next<Extract<ServerMsg, { t: 'history' }>>((m) => m.t === 'history');
    expect(h.points).toHaveLength(301);
    expect(h.points[0].rating).toBe(2500);
    expect(h.summary).toEqual({ peak: 2500, lowest: 1200, complete: false });
    const ranked = p.ranked;
    a.send({ t: 'resign', id: g.id });
    expect(await a.next((m) => m.t === 'error')).toEqual({ t: 'error', code: 'finished' });
    expect(p.ranked).toBe(ranked);
  });

  test('복귀 후 첫 대국은 휴면 RD로 계산하고 마지막 평가 시각을 갱신한다', async () => {
    const { s, port } = await start();
    const a = await client(port), b = await client(port);
    const now = Date.now();
    const p = (await s.store.call('player', a.me.id, true))!, opp = (await s.store.call('player', b.me.id, true))!;
    Object.assign(p, await s.store.call('patchPlayer', p.id, { ranked: 5, rated: 5, rd: 40, ratingAt: now - 365 * 86_400_000 }));
    Object.assign(opp, await s.store.call('patchPlayer', opp.id, { ranked: 5, rated: 5, rd: 100, ratingAt: now }));
    const expected = update({ ...p, rd: Math.sqrt(40 ** 2 + 365 * (173.7178 * p.vol) ** 2) }, opp, 1);
    const g = await rankedGame(a, b);
    await playPlies(a, b, g);
    b.send({ t: 'resign', id: g.id });
    await a.game((x) => x.id === g.id && x.status === 'finished');
    Object.assign(p, (await s.store.call('player', p.id))!);
    expect(p.rating).toBeCloseTo(expected.rating, 5);
    expect(p.rd).toBeCloseTo(expected.rd, 5);
    expect(p.ratingAt).toBeGreaterThanOrEqual(now);
    const returned = await client(port, a.token);
    expect(returned.me.rd).toBe(Math.round(p.rd));
  });

  test('신규 계정 생성만 제한하며 기존 토큰 재접속과 중복 hello를 구분한다', async () => {
    const { s, port } = await start({ accountLimit: { count: 2, windowMs: 3_600_000 } });
    const a = await client(port);
    await client(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const response = new Promise<ServerMsg>((done) => ws.once('message', (raw) => done(JSON.parse(String(raw)))));
    await new Promise((done) => ws.once('open', done));
    ws.send(JSON.stringify({ t: 'hello' }));
    expect(await response).toEqual({ t: 'error', code: 'rate_limited' });
    const returned = await client(port, a.token);
    expect(returned.me.id).toBe(a.me.id);
    returned.send({ t: 'hello' });
    expect(await returned.next((m) => m.t === 'error')).toEqual({ t: 'error', code: 'bad_request' });
    expect((await s.store.call('players'))).toHaveLength(2);
  });

  test('다른 시간 모드끼리는 매칭되지 않는다', async () => {
    const { port } = await start();
    const a = await client(port);
    const b = await client(port);
    const c = await client(port);
    a.send({ t: 'queue', mode: 'bullet' });
    await a.next((m) => m.t === 'queued');
    b.send({ t: 'queue', mode: 'daily' });
    await b.next((m) => m.t === 'queued');
    c.send({ t: 'queue', mode: 'daily' });
    const g = await c.game((x) => x.ranked);
    expect(g.mode).toBe('daily');
    expect(g.turnLimitMs).toBe(86_400_000);
    expect(g.clock).toBeNull();
    expect([g.green!.id, g.brown!.id].sort()).toEqual([b.me.id, c.me.id].sort());
  });

  test('시계 모드: 둔 시간만큼 줄고, 다 쓰면 시간패', async () => {
    const { port } = await start({ modeMs: { bullet: 600 }, tickMs: 30 });
    const a = await client(port);
    const b = await client(port);
    a.send({ t: 'queue', mode: 'bullet' });
    b.send({ t: 'queue', mode: 'bullet' });
    const g = await a.game((x) => x.ranked);
    const first = g.green!.id === a.me.id ? a : b;
    await new Promise((r) => setTimeout(r, 120));
    first.send({ t: 'move', id: g.id, ply: 0, action: legal(replay([]).board, 1)[0] });
    const after = await first.game((x) => x.moves.length === 1);
    expect(after.clock!.green).toBeLessThan(600);
    expect(after.clock!.brown).toBe(600);
    const end = await a.game((x) => x.status === 'finished');
    expect(end.endReason).toBe('timeout');
    expect(end.winner).toBe(1); // 갈색(후공)이 두지 않음
  });

  test('1일 모드도 한 수 제한 시간이 지나면 시간패', async () => {
    const { port } = await start({ modeMs: { daily: 300 }, tickMs: 50 });
    const a = await client(port);
    const b = await client(port);
    a.send({ t: 'queue', mode: 'daily' });
    b.send({ t: 'queue', mode: 'daily' });
    const end = await a.game((x) => x.status === 'finished');
    expect(end.endReason).toBe('timeout');
    expect(end.winner).toBe(-1); // 초록(선공)이 두지 않음
  });

  test('이름 변경 검사와 저장 파일', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gyeol-'));
    const file = join(dir, 'db.sqlite');
    const { s, port } = await start({ dbPath: file });
    const a = await client(port);
    a.send({ t: 'name', name: '' });
    expect(await a.next((m) => m.t === 'error')).toEqual({ t: 'error', code: 'bad_name' });
    a.send({ t: 'name', name: '  바둑이  ' });
    const me = await a.next<Extract<ServerMsg, { t: 'me' }>>((m) => m.t === 'me');
    expect(me.me.name).toBe('바둑이');
    await s.close();
    servers.pop();
    const reopened = new Store(file);
    const saved = await reopened.call('snapshot');
    await reopened.close();
    expect(saved.players[a.me.id].name).toBe('바둑이');
  });
});

describe('AI 플레이어', () => {
  test('넓은 실력 프로필로 등록한 1,000명도 기존 표시 범위에서 끝까지 합법 착수한다', async () => {
    const { s, port } = await start({ brain: fakeBrain, botProfiles: createWideRoster(botRatings.bots),
      botWaitMs: 0, botThinkMs: [0, 0], tickMs: 20 });
    const bots = (await s.store.call('players')).filter(p => p.bot);
    expect(Math.min(...bots.map(p => p.rating))).toBe(974);
    expect(Math.max(...bots.map(p => p.rating))).toBe(2207);
    const a = await client(port);
    a.send({ t: 'queue', mode: 'blitz' });
    let g = await a.game(x => x.ranked);
    const color = g.green!.id === a.me.id ? 1 : -1;
    while (g.status === 'active') {
      const { board, player } = replay(g.moves), ply = g.moves.length;
      if (player === color) a.send({ t: 'move', id: g.id, ply, action: legal(board, player)[0] });
      g = await a.game(x => x.id === g.id && (x.moves.length > ply || x.status === 'finished'));
    }
    expect(g.endReason).toBe('normal');
  });

  test('새 인식 프로필로 끝까지 합법 착수하고 기권·종료 뒤 예약 착수는 중단한다', async () => {
    const { s, port } = await start({ brain: fakeBrain, botProfiles: createCognitiveRoster(botRatings.bots),
      botWaitMs: 0, botThinkMs: [0, 0], tickMs: 20 });
    const a = await client(port);
    a.send({ t: 'queue', mode: 'blitz' });
    let g = await a.game(x => x.ranked);
    const color = g.green!.id === a.me.id ? 1 : -1;
    while (g.status === 'active') {
      const { board, player } = replay(g.moves), ply = g.moves.length;
      if (player === color) a.send({ t: 'move', id: g.id, ply, action: legal(board, player)[0] });
      g = await a.game(x => x.id === g.id && (x.moves.length > ply || x.status === 'finished'));
    }
    expect(g.endReason).toBe('normal');
    const count = (await s.store.call('game', g.id))!.moves.length;
    await new Promise(r => setTimeout(r, 50));
    expect((await s.store.call('game', g.id))!.moves.length).toBe(count);
  });

  test('추론이 멈춰도 하드 마감에 마지막 공개 후보를 제출한다', async () => {
    const profiles = createCognitiveRoster(botRatings.bots).map(p => ({ ...p,
      cognition: { ...p.cognition, startMs: [0, 0, 0] as [number, number, number], rampMs: [1, 1, 1] as [number, number, number],
        workRate: 1000, minimumThinkMs: 0, skillPosition: 1 } }));
    const { port } = await start({ brain: async () => async () => new Promise(() => {}),
      botProfiles: profiles, botWaitMs: 0, botThinkMs: [0, 0], tickMs: 20 });
    const a = await client(port);
    a.send({ t: 'queue', mode: 'blitz' });
    const g = await a.game(x => x.ranked), color = g.green!.id === a.me.id ? 1 : -1;
    if (color === 1) a.send({ t: 'move', id: g.id, ply: 0, action: legal(replay([]).board, 1)[0] });
    const after = await a.game(x => x.id === g.id && x.moves.length >= (color === 1 ? 2 : 1));
    expect(after.status).toBe('active');
    a.send({ t: 'resign', id: g.id });
    const end = await a.game(x => x.id === g.id && x.status === 'finished');
    expect(end.endReason).toBe('resign');
  });

  test('1,000명 전원이 고유한 행동 설정과 추정 레이팅으로 등록되고 전적은 부풀리지 않는다', async () => {
    const { s, port } = await start({ brain: fakeBrain });
    const bots = (await s.store.call('players')).filter((p) => p.bot);
    expect(s.botCount).toBe(1000);
    expect(bots).toHaveLength(1000);
    const signatures = botRatings.bots.map((p: { cognition?: unknown; mistake?: number; sims?: number }) =>
      p.cognition ? JSON.stringify(p.cognition) : `${p.mistake}:${p.sims}`);
    expect(new Set(signatures).size).toBe(1000);
    expect(new Set(botRatings.bots.map((p) => p.rating)).size).toBe(1000);
    for (const p of bots) {
      expect(p.ranked).toBe(0);
      expect(p.wins).toBe(0);
      expect(p.losses).toBe(0);
    }
    const a = await client(port);
    a.send({ t: 'leaderboard' });
    const lb = await a.next<Extract<ServerMsg, { t: 'leaderboard' }>>((m) => m.t === 'leaderboard');
    expect(lb.players).toHaveLength(0);
  });

  test('사람 상대가 없으면 봇과 매칭되고, 봇이 끝까지 두며, 사람 레이팅만 움직인다', async () => {
    const { s, port } = await start({ brain: fakeBrain, botWaitMs: 200, botThinkMs: [0, 0], tickMs: 50 });
    const a = await client(port);
    a.send({ t: 'queue', mode: 'blitz' });
    let g = await a.game((x) => x.ranked);
    const color = g.green!.id === a.me.id ? 1 : -1;
    const bot = color === 1 ? g.brown! : g.green!;
    expect(bot.bot).toBe(true);
    expect(g.online).toEqual({ green: true, brown: true });
    const cal = botRatings.bots.find((b) => b.id === bot.id)!;
    expect(bot.rating).toBe(Math.round(cal.rating));
    while (g.status === 'active') {
      const { board, player } = replay(g.moves);
      const ply = g.moves.length;
      if (player === color) a.send({ t: 'move', id: g.id, ply, action: legal(board, player)[0] });
      g = await a.game((x) => x.id === g.id && (x.moves.length > ply || x.status === 'finished'));
    }
    expect(g.endReason).toBe('normal');
    const mine = color === 1 ? g.ratingChange!.green : g.ratingChange!.brown;
    const theirs = color === 1 ? g.ratingChange!.brown : g.ratingChange!.green;
    expect(theirs).toBe(0);
    if (g.winner) expect(Math.sign(mine)).toBe(g.winner === color ? 1 : -1);
    expect((await s.store.call('player', bot.id, true))!.rating).toBe(cal.rating);
    expect((await s.store.call('player', a.me.id, true))!.ranked).toBe(1);
    expect((await s.store.call('player', a.me.id, true))!.rated).toBe(1);
  });

  test('사람 둘이 기다리면 봇보다 사람끼리 먼저 맞춘다', async () => {
    const { s, port } = await start({ brain: fakeBrain, botWaitMs: 2000, botThinkMs: [0, 0], tickMs: 50 });
    const a = await client(port);
    const b = await client(port);
    await s.store.call('patchPlayer', a.me.id, { ranked: 5, rated: 5 });
    a.send({ t: 'queue', mode: 'blitz' });
    b.send({ t: 'queue', mode: 'blitz' });
    const g = await a.game((x) => x.ranked);
    expect(g.green!.bot).toBeUndefined();
    expect(g.brown!.bot).toBeUndefined();
  });

  test('모델이 없으면 봇 없이 계속 기다린다', async () => {
    const { s, port } = await start({ aiDir: tmpdir(), botWaitMs: 50, tickMs: 20 });
    const a = await client(port);
    a.send({ t: 'queue', mode: 'blitz' });
    await a.next((m) => m.t === 'queued');
    await new Promise((r) => setTimeout(r, 300));
    expect(Object.keys((await s.store.call('snapshot')).games)).toHaveLength(0);
  });

  test('신규 계정 둘은 서로 점수를 만들지 않고 각각 AI로 배치를 시작한다', async () => {
    const { port } = await start({ brain: fakeBrain, botWaitMs: 100, botThinkMs: [0, 0], tickMs: 20 });
    const a = await client(port), b = await client(port);
    a.send({ t: 'queue', mode: 'daily' });
    b.send({ t: 'queue', mode: 'daily' });
    const ga = await a.game((g) => g.ranked);
    const gb = await b.game((g) => g.ranked);
    expect(ga.id).not.toBe(gb.id);
    expect([ga.green, ga.brown].some((p) => p?.bot)).toBe(true);
    expect([gb.green, gb.brown].some((p) => p?.bot)).toBe(true);
  });
});
