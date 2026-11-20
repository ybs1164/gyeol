import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { legal, replay, type OnlineGame, type ServerMsg } from '@gyeol/core';

const port = Number(process.argv[2] ?? 8787);
const base = `http://127.0.0.1:${port}`;
const response = await fetch(base);
assert.equal(response.status, 200);
assert((await response.text()).includes('id="root"'));
const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
let humanId = '', gameId = '', botName = '', lastSubmitted = -1;
const began = Date.now();
let last: OnlineGame | undefined;
try {
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Live cognitive play timed out')), 60000);
    const reject = (error: Error) => { clearTimeout(timer); fail(error); };
    socket.on('error', reject);
    socket.on('open', () => socket.send(JSON.stringify({ t: 'hello' })));
    socket.on('message', raw => {
      try {
        const message = JSON.parse(String(raw)) as ServerMsg;
        if (message.t === 'error') throw new Error(`Server error: ${message.code}`);
        if (message.t === 'welcome') {
          humanId = message.me.id;
          socket.send(JSON.stringify({ t: 'name', name: '체험연결확인' }));
          socket.send(JSON.stringify({ t: 'queue', mode: 'blitz' }));
        }
        if (message.t !== 'game') return;
        const g = message.game;
        if (!g.ranked) return;
        last = g; gameId = g.id;
        const human = g.green?.id === humanId ? 1 : -1;
        const bot = human === 1 ? g.brown : g.green;
        assert(bot?.bot); botName = bot.name;
        if (g.status === 'finished') { clearTimeout(timer); done(); return; }
        const position = replay(g.moves), ply = g.moves.length;
        if (ply >= 4) {
          socket.send(JSON.stringify({ t: 'resign', id: g.id }));
        } else if (position.player === human && lastSubmitted !== ply) {
          lastSubmitted = ply;
          socket.send(JSON.stringify({ t: 'move', id: g.id, ply, action: legal(position.board, position.player)[0] }));
        }
      } catch (error) { reject(error as Error); }
    });
  });
  assert(last && last.moves.length >= 4 && last.endReason === 'resign');
  const report = { checkedAt: new Date().toISOString(), http: response.status,
    actualOnnx: true, actualClock: true, engine: process.argv.includes('--wide') ? 'cognition-v2-wide' : 'cognition-v1', gameId, botName, plies: last.moves.length,
    durationMs: Date.now() - began, result: 'passed' };
  const directory = process.argv.includes('--wide') ? 'cognition-v2-wide' : 'cognition-v1';
  writeFileSync(fileURLToPath(new URL(`./calibration/${directory}/play-preview-check.json`, import.meta.url)), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { socket.close(); }
