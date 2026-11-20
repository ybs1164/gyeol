/**
 * 온라인 대국 확인용 상대 봇: 매칭에 들어가 첫 합법 수만 둔다.
 *   npx tsx tools/online_bot.ts [모드=blitz] [한 수 지연 ms=1500] [서버=ws://localhost:8787/ws]
 */
import WebSocket from 'ws';
import { legal, replay, type ClientMsg, type OnlineGame, type ServerMsg, type TimeMode } from '@gyeol/core';

const mode = (process.argv[2] ?? 'blitz') as TimeMode;
const delay = Number(process.argv[3] ?? 1500);
const url = process.argv[4] ?? 'ws://localhost:8787/ws';

const ws = new WebSocket(url);
const send = (m: ClientMsg) => ws.send(JSON.stringify(m));
let meId = '';
const pending = new Set<string>();

ws.on('open', () => send({ t: 'hello' }));
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMsg;
  if (msg.t === 'welcome') {
    meId = msg.me.id;
    send({ t: 'name', name: '연습봇' });
    send({ t: 'queue', mode });
    console.log(`매칭 대기: ${mode}`);
  }
  if (msg.t === 'game') think(msg.game);
});

function think(g: OnlineGame) {
  if (g.status === 'finished') {
    console.log(`끝: 승자 ${g.winner} (${g.endReason})`);
    ws.close();
    return;
  }
  if (g.status !== 'active') return;
  const { board, player } = replay(g.moves);
  const mine = (player === 1 ? g.green : g.brown)?.id === meId;
  const key = `${g.id}:${g.moves.length}`;
  if (!mine || pending.has(key)) return;
  pending.add(key);
  setTimeout(() => send({ t: 'move', id: g.id, ply: g.moves.length, action: legal(board, player)[0] }), delay);
}
