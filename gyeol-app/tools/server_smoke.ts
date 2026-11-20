/** Real HTTP/WebSocket and optional ONNX checks against an isolated/test server. */
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { legal, replay, type ClientMsg, type ServerMsg, type OnlineGame } from '@gyeol/core';

const url = new URL(process.argv[2] ?? 'http://127.0.0.1:8787');
const ai = process.argv.includes('--ai');
const sockets: WebSocket[] = [];
const deadline = setTimeout(() => { console.error('Smoke check timed out (180 seconds).'); process.exit(1); }, 180_000);
async function client(token?: string) {
  const ws = new WebSocket(new URL('/ws', url).href.replace(/^http/, 'ws'));
  sockets.push(ws);
  const inbox: ServerMsg[] = [];
  let notify = () => {};
  let failure: Error | undefined;
  ws.on('error', (e) => { failure = e; notify(); });
  ws.on('message', (raw) => { inbox.push(JSON.parse(String(raw))); notify(); });
  const next = async (pred: (m: ServerMsg) => boolean): Promise<ServerMsg> => {
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      if (failure) throw failure;
      const error = inbox.find((m) => m.t === 'error');
      if (error) throw new Error(JSON.stringify(error));
      const index = inbox.findIndex(pred);
      if (index >= 0) return inbox.splice(index, 1)[0];
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        notify = () => { clearTimeout(timer); resolve(); };
      });
    }
    throw new Error('Timed out waiting for server message');
  };
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const send = (m: ClientMsg) => ws.send(JSON.stringify(m));
  send({ t: 'hello', token });
  const welcome = await next((m) => m.t === 'welcome');
  assert(welcome.t === 'welcome');
  const game = async (pred: (g: OnlineGame) => boolean = () => true) => {
    const msg = await next((m) => m.t === 'game' && pred(m.game));
    assert(msg.t === 'game');
    return msg.game;
  };
  return { ws, send, game, me: welcome.me, token: welcome.token };
}
try {
  for (const path of ['/health', '/', '/model/model.onnx', '/ort/ort.wasm.min.mjs', '/ort/ort-wasm-simd-threaded.wasm']) {
    const r = await fetch(new URL(path, url), { signal: AbortSignal.timeout(10_000) });
    assert.equal(r.status, 200, path);
    if (path === '/health') assert.equal((await r.json()).ok, true);
    if (!r.bodyUsed) await r.body?.cancel();
  }
  const a = await client();
  const b = await client();
  a.send({ t: 'create', color: 'green' });
  const room = await a.game();
  assert(room.code);
  b.send({ t: 'join', code: room.code });
  let g = await b.game((x) => x.status === 'active');
  while (g.status === 'active') {
    const { board, player } = replay(g.moves);
    const c = (player === 1 ? g.green : g.brown)!.id === a.me.id ? a : b;
    const ply = g.moves.length;
    c.send({ t: 'move', id: g.id, ply, action: legal(board, player)[0] });
    g = await c.game((x) => x.id === g.id && x.moves.length > ply);
  }
  assert.equal(g.endReason, 'normal');
  a.ws.terminate();
  const again = await client(a.token);
  assert.equal(again.me.id, a.me.id);
  again.send({ t: 'open', id: g.id });
  assert.equal((await again.game((x) => x.id === g.id)).status, 'finished');
  console.log('PASS: HTTP assets, friend game to completion, token reconnect, saved game lookup');
  if (ai) {
    const c = await client();
    c.send({ t: 'queue', mode: 'daily' });
    let botGame = await c.game((x) => x.ranked && x.status === 'active');
    const mine = botGame.green!.id === c.me.id ? 1 : -1;
    assert.equal((mine === 1 ? botGame.brown : botGame.green)!.bot, true, 'Run this check without other players queued');
    const started = Date.now();
    while (botGame.status === 'active' && botGame.moves.length < 4) {
      const { board, player } = replay(botGame.moves);
      const ply = botGame.moves.length;
      if (player === mine) c.send({ t: 'move', id: botGame.id, ply, action: legal(board, player)[0] });
      botGame = await c.game((x) => x.id === botGame.id && (x.moves.length > ply || x.status === 'finished'));
    }
    assert(botGame.moves.length >= 4 && botGame.status === 'active', 'AI did not make legal replies');
    c.send({ t: 'resign', id: botGame.id });
    assert.equal((await c.game((x) => x.id === botGame.id && x.status === 'finished')).endReason, 'resign');
    console.log(`PASS: real AI matching and replies (${Date.now() - started}ms for four plies)`);
  }
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  for (const ws of sockets) ws.terminate();
}
