import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  canonical, legal, replay, validName, isTimeMode,
  type Board, type ClientMsg, type ErrorCode, type OnlineGame, type PublicPlayer, type ServerMsg, type TimeMode,
} from '@gyeol/core';
import { personaMove, cognitiveMove, wideCognitiveMove, cognitiveTimeBudget, type CognitivePersona, type WideCognitivePersona, type Persona, type Predict, type Prediction } from '@gyeol/ai';
import { selectBot } from './bot-match';
import { Store, type GameRecord, type PlayerRecord } from './store';
import { calibratedOpponent, effectiveRating } from './rating-policy';
import type { Change } from './database';
import { hasModel, loadBrain } from './brain';
import botRatings from './bot-ratings.json';

export interface ServerOptions {
  port?: number;
  host?: string;
  /** SQLite path; null uses an isolated in-memory database. */
  dbPath?: string | null;
  createDatabase?: boolean;
  /** Deployment gate: blocks client commands until package/data checks complete. */
  maintenance?: () => boolean;
  /** 빌드된 웹 앱 폴더 (있으면 같은 주소로 제공) */
  staticDir?: string | null;
  /** 시간 모드별 시간 바꾸기 (테스트용). 1분·3분·5분은 한 판 시간, 1일은 한 수 시간 */
  modeMs?: Partial<Record<TimeMode, number>>;
  /** 시간 초과 검사 주기 */
  tickMs?: number;
  /**
   * AI 플레이어(봇): 학습 모델 폴더(ort/, model/model.onnx 가 있는 곳). 없거나 null 이면 봇을 쓰지 않는다.
   * 랭크전 매칭에서 사람 상대를 botWaitMs 동안 못 찾으면 레이팅이 가까운 봇과 맞춘다.
   */
  aiDir?: string | null;
  /** 모델 대신 쓸 추론기 (테스트용). 주면 aiDir 없이도 봇을 쓴다 */
  brain?: () => Promise<Predict>;
  /** 봇으로 넘어가기 전 기다리는 시간 (기본 8초) */
  botWaitMs?: number;
  /** 봇이 한 수에 쓰는 시간 [최소, 최대] ms. 없으면 시간 모드에 맞춰 정한다 (테스트용) */
  botThinkMs?: [number, number];
  /** Isolated calibration/scheduler tests can supply cognitive profiles without publishing ratings. */
  botProfiles?: (CognitivePersona | WideCognitivePersona)[];
  /** 한 네트워크의 신규 계정 생성 한도. 기존 토큰 재접속에는 적용하지 않는다 */
  accountLimit?: { count: number; windowMs: number };
}

/** 봇이 한 수에 쓰는 시간 (사람처럼 보이도록 조금씩 다르게). 남은 시계의 10%를 넘기지 않는다 */
const BOT_THINK: Record<TimeMode, [number, number]> = {
  bullet: [500, 1800],
  blitz: [1000, 4000],
  rapid: [1500, 6000],
  daily: [2000, 8000],
};
const BOT_RATING = new Map(botRatings.bots.map((b) => [b.id, b]));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain',
};

export function createServer(opts: ServerOptions = {}) {
  const store = new Store(opts.dbPath ?? null, opts.createDatabase ?? false);
  let serial: Promise<unknown> = Promise.resolve();
  const enqueue = (task: () => Promise<unknown>) => {
    const next = serial.then(task);
    serial = next.catch(error => console.error('Server command failed', (error as Error).message));
    return next;
  };
  const sockets = new Map<string, Set<WebSocket>>(); // playerId → 연결들
  const who = new WeakMap<WebSocket, string>();
  const addresses = new WeakMap<WebSocket, string>();
  const registrations = new Map<string, number[]>();
  const accountLimit = opts.accountLimit ?? { count: 10, windowMs: 60 * 60 * 1000 };
  if (!Number.isInteger(accountLimit.count) || accountLimit.count < 1 || !Number.isFinite(accountLimit.windowMs) || accountLimit.windowMs <= 0) {
    throw new Error('accountLimit must have a positive integer count and positive windowMs');
  }
  /** 매칭 대기열: 같은 시간 모드끼리만 맞춘다 */
  let queue: { pid: string; mode: TimeMode; at: number }[] = [];
  const modeOf = (g: GameRecord): TimeMode => g.mode ?? (g.ranked ? 'blitz' : 'daily');

  // ---------- 보조 ----------
  const pub = (p: PlayerRecord | undefined | null): PublicPlayer | null =>
    p
      ? { id: p.id, name: p.name, rating: Math.round(p.rating), rd: Math.round(effectiveRating(p).rd), ranked: p.ranked, rated: p.rated ?? p.ranked, wins: p.wins, losses: p.losses, ...(p.bot ? { bot: true } : {}) }
      : null;
  const isOnline = (pid: string | null) => !!pid && (bots.has(pid) || (sockets.get(pid)?.size ?? 0) > 0);

  // ---------- AI 플레이어 ----------
  const aiDir = opts.aiDir ?? null;
  const botsOn = !!opts.brain || (!!aiDir && hasModel(aiDir));
  if (aiDir && !botsOn) console.warn(`AI 플레이어 꺼짐: ${aiDir} 에 ort/ 또는 model/model.onnx 가 없습니다`);
  /** 봇 playerId → 성격 */
  const bots = new Map<string, Persona | CognitivePersona | WideCognitivePersona>();
  const botPool: { id: string; rating: number }[] = [];
  type QueuedPredict = (board: Board, signal?: AbortSignal) => Promise<Prediction>;
  let brain: Promise<QueuedPredict> | null = null;
  /** 모델은 봇이 처음 둘 때 불러온다. 한 세션을 여러 대국이 나눠 쓰므로 추론은 한 번에 하나씩 */
  const getBrain = () => {
    brain ??= (opts.brain ? opts.brain() : loadBrain(aiDir!)).then((raw): QueuedPredict => {
      let chain: Promise<unknown> = Promise.resolve();
      return (b, signal) => {
        const next = chain.then(() => {
          if (signal?.aborted) throw new Error('Cognitive job cancelled in queue');
          return raw(b);
        });
        chain = next.catch(() => undefined);
        return next;
      };
    });
    brain.catch(() => (brain = null));
    return brain;
  };
  const thinking = new Set<string>();
  const cognitiveJobs = new Map<string, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>();
  let closing = false;
  const recentOpponents = new Map<string, string[]>();

  /** 레이팅이 가까울수록 뽑힐 확률이 높다 (같은 상대만 계속 나오지 않게 조금 섞는다) */
  function pickBot(pid: string, rating: number): string {
    const recent = recentOpponents.get(pid) ?? [];
    const picked = selectBot(botPool, rating, recent);
    recentOpponents.set(pid, [...recent, picked].slice(-5));
    return picked;
  }

  /** 봇 차례면 생각해서 둔다 */
  function driveBot(g: GameRecord) {
    if (closing || !botsOn || g.status !== 'active') return;
    const { board, player } = replay(g.moves);
    const pid = player === 1 ? g.greenId : g.brownId;
    const persona = pid ? bots.get(pid) : undefined;
    if (!pid || !persona) return;
    const ply = g.moves.length;
    const key = `${g.id}:${ply}`;
    if (thinking.has(key)) return;
    thinking.add(key);
    const started = Date.now();
    if ('cognition' in persona) {
      const controller = new AbortController();
      const left = Math.max(0, timeLeft(g, started) ?? 86400000);
      const budget = cognitiveTimeBudget(board, modeOf(g), left);
      // Test overrides accelerate the logical clock as well as the visible delay.
      const speed = opts.botThinkMs?.[1] === 0 ? 0 : 1;
      const actualBudget = speed ? Math.max(0, budget.hardMs) : 1000;
      const began = performance.now();
      let action = legal(board, player)[0];
      const submit = () => {
        const job = cognitiveJobs.get(key);
        if (!job) return;
        clearTimeout(job.timer); controller.abort(); cognitiveJobs.delete(key); thinking.delete(key);
        if (!closing) void enqueue(async () => {
          const cur = await store.call('game', g.id);
          if (!closing && cur?.status === 'active' && cur.moves.length === ply && cur.revision === g.revision) await playMove(cur, pid, ply, action);
        }).catch(() => undefined);
      };
      const timer = setTimeout(submit, actualBudget);
      cognitiveJobs.set(key, { controller, timer });
      const runDecision = (predict: Predict) => persona.cognition.version === 'cognition-v2-wide'
        ? wideCognitiveMove(canonical(board, player), persona.cognition, predict, decisionOptions)
        : cognitiveMove(canonical(board, player), persona.cognition, predict, decisionOptions);
      const decisionOptions = {
        mode: modeOf(g), leftMs: left, signal: controller.signal, deadline: began + actualBudget,
        checkpoint: async (decision: import('@gyeol/ai').CognitiveDecision) => {
          const wait = decision.elapsedMs * speed - (performance.now() - began);
          if (wait > 0 && !controller.signal.aborted) await new Promise<void>(done => {
            const finishWait = () => { clearTimeout(waitTimer); controller.signal.removeEventListener('abort', finishWait); done(); };
            const waitTimer = setTimeout(finishWait, wait);
            controller.signal.addEventListener('abort', finishWait, { once: true });
          });
          if (!controller.signal.aborted) action = decision.action;
        },
      };
      void runDecision(async b => {
        const brain = await getBrain();
        if (controller.signal.aborted) throw new Error('Cognitive job cancelled');
        return brain(b, controller.signal);
      }).then(submit).catch(error => { if (!controller.signal.aborted) { console.error('봇 오류', error); submit(); } });
      return;
    }
    const [lo, hi] = opts.botThinkMs ?? BOT_THINK[modeOf(g)];
    let delay = lo + Math.random() * (hi - lo);
    const left = timeLeft(g, started);
    if (left !== null) delay = Math.min(delay, left * 0.1);
    (async () => {
      const action = await personaMove(canonical(board, player), persona, await getBrain());
      const wait = delay - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (!closing) await enqueue(async () => {
        const cur = await store.call('game', g.id);
        if (!closing && cur?.status === 'active' && cur.moves.length === ply && cur.revision === g.revision) await playMove(cur, pid, ply, action);
      });
    })()
      .catch((e) => console.error('봇 오류', e))
      .finally(() => thinking.delete(key));
  }

  const view = async (g: GameRecord): Promise<OnlineGame> => ({
    id: g.id,
    code: g.code,
    ranked: g.ranked,
    mode: modeOf(g),
    green: pub(g.greenId ? await store.call('player', g.greenId) : null),
    brown: pub(g.brownId ? await store.call('player', g.brownId) : null),
    moves: g.moves,
    status: g.status,
    winner: g.winner,
    endReason: g.endReason,
    turnLimitMs: g.turnLimitMs,
    clock: g.clock ?? null,
    turnStartedAt: g.turnStartedAt,
    now: Date.now(),
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    ratingChange: g.ratingChange,
    ...(g.ratingRestriction ? { ratingRestriction: g.ratingRestriction } : {}),
    online: { green: isOnline(g.greenId), brown: isOnline(g.brownId) },
  });

  const send = (ws: WebSocket, msg: ServerMsg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const sendTo = (pid: string | null, msg: ServerMsg) => {
    if (pid) for (const ws of sockets.get(pid) ?? []) send(ws, msg);
  };
  const broadcast = async (g: GameRecord) => {
    const msg: ServerMsg = { t: 'game', game: await view(g) };
    sendTo(g.greenId, msg);
    if (g.brownId !== g.greenId) sendTo(g.brownId, msg);
  };
  async function publish(change: Change) {
    const g = change.game;
    if (!g) return;
    if (g.status === 'finished') {
      for (const [key, job] of cognitiveJobs) if (key.startsWith(`${g.id}:`)) {
        clearTimeout(job.timer); job.controller.abort(); cognitiveJobs.delete(key); thinking.delete(key);
      }
    }
    for (const p of change.players ?? []) sendTo(p.id, { t: 'me', me: pub(p)! });
    await broadcast(g);
    driveBot(g);
  }

  async function newGame(greenId: string | null, brownId: string | null, ranked: boolean, mode: TimeMode) {
    return store.call('createGame', greenId, brownId, ranked, mode, opts.modeMs?.[mode]);
  }
  async function startRanked(a: string, b: string, mode: TimeMode) {
    const [green, brown] = randomInt(2) ? [a, b] : [b, a];
    const g = await newGame(green, brown, true, mode);
    queue = queue.filter(q => q.pid !== a && q.pid !== b);
    await publish({ game: g });
  }
  async function matchBots(now: number) {
    if (!botsOn) return;
    for (const q of [...queue]) {
      if (!queue.some(x => x.pid === q.pid)) continue;
      if (now - q.at >= (opts.botWaitMs ?? 8000) && isOnline(q.pid)) {
        const p = await store.call('player', q.pid);
        if (p) await startRanked(q.pid, pickBot(q.pid, p.rating), q.mode);
      }
    }
  }
  async function tryMatch(mode: TimeMode) {
    queue = queue.filter(q => isOnline(q.pid));
    for (;;) {
      const same = queue.filter(q => q.mode === mode);
      if (same.length < 2) return;
      const players = new Map(await Promise.all(same.map(async q => [q.pid, (await store.call('player', q.pid))!] as const)));
      const a = same[0].pid, ra = players.get(a)!.rating;
      const candidates = same.slice(1).filter(q => !botsOn || calibratedOpponent(players.get(a)!) || calibratedOpponent(players.get(q.pid)!));
      if (!candidates.length) return;
      candidates.sort((x,y) => Math.abs(players.get(x.pid)!.rating-ra)-Math.abs(players.get(y.pid)!.rating-ra));
      await startRanked(a, candidates[0].pid, mode);
    }
  }
  function timeLeft(g: GameRecord, now: number) {
    if (g.clock) return g.clock[replay(g.moves).player === 1 ? 'green' : 'brown'] - (now - g.turnStartedAt);
    return g.turnLimitMs ? g.turnLimitMs - (now - g.turnStartedAt) : null;
  }
  async function playMove(g: GameRecord, pid: string, ply: number, action: number): Promise<ErrorCode | undefined> {
    const change = await store.call('applyMove', g.id, pid, ply, action, g.revision);
    await publish(change); return change.error;
  }
  async function myGames(pid: string) { return Promise.all((await store.call('playerGames', pid)).map(view)); }

  async function handle(ws: WebSocket, msg: ClientMsg) {
    const err = (code: ErrorCode) => send(ws, { t: 'error', code });
    if (opts.maintenance?.()) return err('maintenance');
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return err('bad_request');
    if (msg.t === 'hello') {
      if (who.has(ws) || (msg.token !== undefined && typeof msg.token !== 'string')) return err('bad_request');
      const existing = msg.token ? await store.call('tokenPlayer', msg.token) : undefined;
      if (!existing) {
        const now = Date.now(), address = addresses.get(ws) ?? 'unknown';
        const recent = (registrations.get(address) ?? []).filter(at => at > now - accountLimit.windowMs);
        if (recent.length >= accountLimit.count) { err('rate_limited'); ws.close(1008, 'Account creation limit'); return; }
        registrations.set(address, [...recent, now]);
      }
      const { player: p, token } = await store.call('authenticate', msg.token);
      if (ws.readyState !== ws.OPEN) return;
      who.set(ws, p.id);
      if (!sockets.has(p.id)) sockets.set(p.id, new Set());
      sockets.get(p.id)!.add(ws);
      send(ws, { t: 'welcome', token, me: pub(p)! });
      for (const g of await store.call('ongoingGames', p.id)) await broadcast(g);
      return;
    }
    const pid = who.get(ws); if (!pid) return err('hello_first');
    switch (msg.t) {
      case 'name': {
        if (typeof msg.name !== 'string' || !validName(msg.name)) return err('bad_name');
        const me = await store.call('patchPlayer', pid, { name: msg.name.trim() });
        return sendTo(pid, { t: 'me', me: pub(me)! });
      }
      case 'create': {
        if (!['green','brown','random'].includes(msg.color)) return err('bad_request');
        const color = msg.color === 'random' ? (randomInt(2) ? 'green' : 'brown') : msg.color;
        const mode = isTimeMode(msg.mode) ? msg.mode : 'daily';
        const g = await newGame(color === 'green' ? pid : null, color === 'brown' ? pid : null, false, mode);
        return send(ws, { t: 'game', game: await view(g) });
      }
      case 'join': {
        const change = await store.call('joinGame', String(msg.code ?? '').trim().toUpperCase(), pid);
        if (change.error) return err(change.error);
        return publish(change);
      }
      case 'open': {
        if (typeof msg.id !== 'string') return err('bad_request');
        const g = await store.call('game', msg.id); if (!g) return err('not_found');
        return send(ws, { t: 'game', game: await view(g) });
      }
      case 'move': {
        if (typeof msg.id !== 'string') return err('bad_request');
        const change = await store.call('applyMove', msg.id, pid, msg.ply, msg.action);
        if (change.error) return err(change.error);
        return publish(change);
      }
      case 'resign': {
        if (typeof msg.id !== 'string') return err('bad_request');
        const change = await store.call('finishGame', msg.id, pid, 'resign');
        if (change.error) return err(change.error);
        if (change.removed) return send(ws, { t: 'games', games: await myGames(pid) });
        return publish(change);
      }
      case 'queue': {
        const mode = isTimeMode(msg.mode) ? msg.mode : 'blitz';
        const at = queue.find(q => q.pid === pid && q.mode === mode)?.at ?? Date.now();
        queue = [...queue.filter(q => q.pid !== pid), { pid, mode, at }];
        send(ws, { t: 'queued', size: queue.filter(q => q.mode === mode).length, mode });
        return tryMatch(mode);
      }
      case 'unqueue': queue = queue.filter(q => q.pid !== pid); return send(ws, { t: 'unqueued' });
      case 'history': {
        const me = (await store.call('player', pid))!;
        return send(ws, { t: 'history', points: await store.call('history', pid), summary: {
          peak: me.peakRating ?? Math.round(me.rating), lowest: me.lowestRating ?? Math.round(me.rating), complete: me.historyComplete ?? false,
        } });
      }
      case 'games': return send(ws, { t: 'games', games: await myGames(pid) });
      case 'leaderboard': return send(ws, { t: 'leaderboard', players: (await store.call('leaderboard')).map(p => pub(p)!) });
      default: return err('bad_request');
    }
  }

  const ready = (async () => {
    await store.ready;
    if (botsOn) {
      const profiles = opts.botProfiles ?? botRatings.bots as (Persona | CognitivePersona | WideCognitivePersona)[];
      const seeded = await store.call('syncBots', profiles.map(p => {
        const cal = BOT_RATING.get(p.id);
        return { id: p.id, name: p.name, rating: cal?.rating ?? 1500, rd: cal?.rd ?? 350 };
      }), botRatings.bots.length === 1000);
      for (const p of profiles) bots.set(p.id, p);
      for (const p of seeded) botPool.push({ id: p.id, rating: p.rating });
    }
    for (const g of await store.call('recover')) driveBot(g);
  })();
  void ready.catch(() => undefined);
  let ticking = false;
  const ticker = setInterval(() => {
    if (closing || ticking) return;
    ticking = true;
    void enqueue(async () => {
      await ready;
      const now = Date.now();
      for (const [address, times] of registrations) if (times.at(-1)! <= now - accountLimit.windowMs) registrations.delete(address);
      for (const g of await store.call('dueGames', now)) await publish(await store.call('finishGame', g.id, null, 'timeout'));
      await matchBots(now);
    }).catch(() => undefined).finally(() => { ticking = false; });
  }, opts.tickMs ?? 1000);

  // ---------- HTTP (정적 파일) ----------
  const root = opts.staticDir ? resolve(opts.staticDir) : null;
  async function serveStatic(req: IncomingMessage, res: ServerResponse) {
    if (req.url === '/health') {
      try {
        await ready; const health = await store.call('health');
        res.writeHead(health.ok ? 200 : 503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ...health, maintenance: opts.maintenance?.() ?? false }));
      } catch { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false })); }
    }
    if (!root) {
      res.writeHead(404);
      return res.end();
    }
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = normalize(join(root, path));
    if (!file.startsWith(root + sep) && file !== root) {
      res.writeHead(403);
      return res.end();
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    const immutable = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      'content-type': type,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
  }

  const http = createHttp((req,res) => { void serveStatic(req,res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 4096 });
  wss.on('connection', (ws, req) => {
    // 프록시 헤더는 클라이언트가 위조할 수 있으므로 직접 연결 주소만 사용한다.
    addresses.set(ws, req.socket.remoteAddress ?? 'unknown');
    ws.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send(ws, { t: 'error', code: 'bad_request' });
      }
      if (!closing) void enqueue(async () => { if (ws.readyState === ws.OPEN) await handle(ws, msg); }).catch(() => {
        send(ws, { t: 'error', code: 'storage_unavailable' });
      });
    });
    ws.on('close', () => {
      if (closing) return;
      void enqueue(async () => {
        const pid = who.get(ws); if (!pid) return;
        sockets.get(pid)?.delete(ws);
        if (!isOnline(pid)) {
          queue = queue.filter(q => q.pid !== pid);
          for (const g of await store.call('ongoingGames', pid)) await broadcast(g);
        }
      }).catch(() => undefined);
    });
  });

  return {
    store,
    get botCount() { return bots.size; },
    async listen(): Promise<number> {
      await ready;
      return new Promise((done, fail) => {
        http.once('error', fail);
        http.listen(opts.port ?? 8787, opts.host ?? '0.0.0.0', () => {
          const addr = http.address();
          done(typeof addr === 'object' && addr ? addr.port : opts.port ?? 8787);
        });
      });
    },
    async close() {
      closing = true;
      for (const job of cognitiveJobs.values()) { clearTimeout(job.timer); job.controller.abort(); }
      cognitiveJobs.clear();
      clearInterval(ticker);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
      await serial;
      await ready.catch(() => undefined);
      await store.close();
    },
  };
}
