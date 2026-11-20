/** 격리한 임시 Chrome 프로필로 실제 클릭·응수·재풀이·오늘의 기록을 확인한다. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { ratedBank, ratedPuzzle, puzzleValues, correctMoves, bestReply, apply, result, decode, dailyPuzzle, dateKey, type RatedPuzzle, type Player } from '../packages/core/src/index';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'gyeol-record-ui-'));
const child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket: WebSocket | undefined;
let id = 0;
const pending = new Map<number, { done: (v: any) => void; fail: (e: Error) => void }>();
const errors: string[] = [];
const call = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((done, fail) => {
  const n = ++id;
  const timer = setTimeout(() => { pending.delete(n); fail(new Error(`CDP timeout ${method}`)); }, 15000);
  pending.set(n, { done: (v) => { clearTimeout(timer); done(v); }, fail: (e) => { clearTimeout(timer); fail(e); } });
  socket!.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const evaluate = async (session: string, expression: string) => {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const wait = async (session: string, expression: string) => {
  const start = Date.now();
  while (Date.now() - start < 15000) { if (await evaluate(session, `Boolean(${expression})`)) return; await sleep(80); }
  throw new Error('UI timeout: ' + expression + '\n' + await evaluate(session, 'document.body.innerText'));
};
const boardExpression = `(()=>{const b=Array(49).fill(0); for(const e of document.querySelectorAll('.tile[data-cell]')) {const a=parseFloat(e.querySelector('.body').style.getPropertyValue('--a'));const d=((Math.round(a/90)%4)+4)%4;b[+e.dataset.cell]=(e.classList.contains('g')?1:-1)*(d+1);}return b;})()`;
const click = async (session: string, selector: string) => {
  await wait(session, `!!document.querySelector(${JSON.stringify(selector)})`);
  await evaluate(session, `document.querySelector(${JSON.stringify(selector)}).click()`);
};
const play = async (session: string, action: number) => {
  if (action === 784) {
    await evaluate(session, `Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='차례 넘기기').click()`);
    return;
  }
  const m = decode(action)!;
  await click(session, `.tile.selectable[data-cell="${m.r * 7 + m.c}"]`);
  await click(session, `.chev-btn[data-dir="${m.newDir}"]`);
  await click(session, `button.target[data-cell="${m.pr * 7 + m.pc}"]`);
};
async function open(puzzle: RatedPuzzle, daily = false) {
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call('Runtime.enable', {}, s);
  await call('Page.enable', {}, s);
  await call('Emulation.setDeviceMetricsOverride', { width: 430, height: 1000, deviceScaleFactor: 1, mobile: true }, s);
  const profile = { scaleVersion: 2, bankVersion: 3, seededFromGame: false, rating: puzzle.rating, peak: puzzle.rating,
    played: 0, solved: 0, streak: 0, bestStreak: 0, history: [], seen: [], current: daily ? null : puzzle.id };
  const source = `if(!sessionStorage.getItem('ui-test-initialized')) {
    localStorage.clear();
    localStorage.setItem('gyeol:settings',${JSON.stringify(JSON.stringify({ nickname: 'PuzzleCheck', lang: 'ko', sound: false, vibrate: false, server: '127.0.0.1:1' }))});
    localStorage.setItem('gyeol:puzzle-rating',${JSON.stringify(JSON.stringify(profile))});
    localStorage.setItem('gyeol:puzzles',${JSON.stringify(JSON.stringify({ [dateKey()]: { attempts: [5, 7], solved: true } }))});
    sessionStorage.setItem('ui-test-initialized','1');
  }`;
  await call('Page.addScriptToEvaluateOnNewDocument', { source }, s);
  await call('Page.navigate', { url: 'http://localhost:8787/#/' + (daily ? 'puzzle' : 'solve') }, s);
  await wait(s, `document.querySelectorAll('.tile[data-cell]').length===${puzzle.board.filter(Boolean).length}`);
  await wait(s, `!document.querySelector('.splash')`);
  assert.deepEqual(await evaluate(s, boardExpression), puzzle.board);
  const body = await evaluate(s, 'document.body.innerText');
  assert.ok(!body.includes('장을 뒤집으세요') && !body.includes('출처:'));
  assert.ok(!['우세 만들기', '역전', '승리 굳히기'].some((text) => body.includes(text)));
  assert.equal(await evaluate(s, `!!document.querySelector('details, p.text')`), false);
  return { s, targetId };
}
async function finish(s: string, p: RatedPuzzle) {
  let board = p.board, turn = p.player, turns = 0;
  while (!result(board, turn)) {
    assert.equal(turn, p.player);
    await wait(s, `document.querySelector('.tile.selectable') || Array.from(document.querySelectorAll('button')).some(e=>e.textContent==='차례 넘기기')`);
    const winning = correctMoves(p.kind, puzzleValues(p, board, turn));
    const action = turns === 0 && winning.includes(p.source.playedMove) ? p.source.playedMove : winning[0];
    await play(s, action);
    turns++;
    board = apply(board, turn, action).board; turn = -turn as Player;
    if (!result(board, turn)) { board = apply(board, turn, bestReply(p, board, turn)).board; turn = -turn as Player; }
    await wait(s, `JSON.stringify(${boardExpression})===${JSON.stringify(JSON.stringify(board))} && (document.querySelector('.tile.selectable') || document.querySelector('.rated-result') || Array.from(document.querySelectorAll('button')).some(e=>e.textContent==='차례 넘기기'))`);
  }
  assert.equal(result(board, p.player), 1);
  await wait(s, `!!document.querySelector('.rated-result.ok')`);
  return turns;
}

try {
  const endpoint = await new Promise<string>((done, fail) => {
    let log = '';
    const timer = setTimeout(() => fail(new Error('Chrome startup timeout: ' + log)), 15000);
    child.stderr!.on('data', (v) => { log += v; const m = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); done(m[1]); } });
    child.on('error', fail);
  });
  socket = new WebSocket(endpoint);
  await once(socket, 'open');
  socket.on('message', raw => {
    const m = JSON.parse(String(raw));
    if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.fail(new Error(m.error.message)) : p.done(m.result); } }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  });
  const puzzles = ratedBank().map((e) => ratedPuzzle(e.id)!);
  const p = puzzles.find((p) => p.plies >= 3 && [...puzzleValues(p, p.board, p.player)].some(([a, v]) => v <= 0 && !result(apply(p.board, p.player, a).board, -p.player as Player)))!;
  assert.ok(p);
  const first = await open(p);
  const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, first.s);
  writeFileSync('tools/record-puzzles/ui-record-puzzle.png', Buffer.from(shot.data, 'base64'));
  const wrong = [...puzzleValues(p, p.board, p.player)].find(([a, v]) => v <= 0 && !result(apply(p.board, p.player, a).board, -p.player as Player))![0];
  await play(first.s, wrong);
  await wait(first.s, `!!document.querySelector('.rated-result.no')`);
  const afterFailure = await evaluate(first.s, `JSON.parse(localStorage.getItem('gyeol:puzzle-rating'))`);
  assert.equal(afterFailure.played, 1); assert.equal(afterFailure.solved, 0);
  await evaluate(first.s, `Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='다시 풀기').click()`);
  const replayTurns = await finish(first.s, p);
  const afterReplay = await evaluate(first.s, `JSON.parse(localStorage.getItem('gyeol:puzzle-rating'))`);
  assert.equal(afterReplay.played, 1); assert.equal(afterReplay.rating, afterFailure.rating);
  await call('Target.closeTarget', { targetId: first.targetId });
  const second = await open(p);
  const winningTurns = await finish(second.s, p);
  const scored = await evaluate(second.s, `JSON.parse(localStorage.getItem('gyeol:puzzle-rating'))`);
  assert.equal(scored.played, 1); assert.equal(scored.solved, 1); assert.ok(scored.rating > p.rating);
  await call('Target.closeTarget', { targetId: second.targetId });
  const today = dailyPuzzle(dateKey());
  const third = await open(today, true);
  await finish(third.s, today);
  const daily = await evaluate(third.s, `JSON.parse(localStorage.getItem('gyeol:record-daily-puzzles'))`);
  assert.equal(daily[dateKey()].solved, true); assert.deepEqual(daily[dateKey()].attempts, [1]);
  assert.equal(daily[dateKey()].puzzleId, today.id);
  assert.equal(await evaluate(third.s, `JSON.parse(localStorage.getItem('gyeol:puzzle-rating')).played`), 0);
  await call('Page.reload', {}, third.s);
  await wait(third.s, `document.body.innerText.includes('오늘의 실전 문제를 이미 풀었습니다')`);
  assert.equal(await evaluate(third.s, `JSON.parse(localStorage.getItem('gyeol:puzzles'))[${JSON.stringify(dateKey())}].solved`), true);
  assert.deepEqual(errors, []);
  const report = { passed: true, cases: ['wrong move and strongest reply', 'winning replay has no duplicate points', 'first-try win updates puzzle rating', 'daily full-game win and pinned resume', 'legacy daily record preserved'], replayTurns, winningTurns, runtimeErrors: errors };
  writeFileSync('tools/record-puzzles/ui-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  if (socket?.readyState === WebSocket.OPEN) { await call('Browser.close').catch(() => undefined); socket.close(); }
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), sleep(5000)]);
  if (child.exitCode === null) child.kill();
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep) && basename(dir).startsWith('gyeol-record-ui-'));
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
