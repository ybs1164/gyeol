/** Production UI checks in an isolated Chrome profile. Run preview on port 5181 first. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { LESSONS, PASS, apply, initial, legal, recenter, type Player } from '../packages/core/src/index';
import type { GameRecord } from '../apps/web/src/lib/storage';

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'gyeol-notation-ui-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket: WebSocket | undefined;
let sequence = 0;
const pending = new Map<number, { done: (value: any) => void; fail: (error: Error) => void }>();
const errors: string[] = [];
const call = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((done, fail) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timeout: ${method}`)); }, 15000);
  pending.set(id, { done: v => { clearTimeout(timer); done(v); }, fail: e => { clearTimeout(timer); fail(e); } });
  socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const evaluate = async (session: string, expression: string) => {
  const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? JSON.stringify(response.exceptionDetails));
  return response.result.value;
};
const wait = async (session: string, expression: string) => {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await evaluate(session, `Boolean(document.body && (${expression}))`)) return;
    await pause(80);
  }
  throw new Error(`UI timeout: ${expression}\n${await evaluate(session, 'document.body.innerText')}`);
};
const click = async (session: string, label: string) => {
  const query = `Array.from(document.querySelectorAll('button')).find(e => e.textContent === ${JSON.stringify(label)} && !e.disabled)`;
  await wait(session, query); await evaluate(session, `${query}.click()`);
};
const boardExpression = `(()=>{const b=Array(49).fill(0);const root=Array.from(document.querySelectorAll('.board')).at(-1);for(const e of root.querySelectorAll('.tile[data-cell]:not(.ghost)')){const a=parseFloat(e.querySelector('.body').style.getPropertyValue('--a'));const d=((Math.round(a/90)%4)+4)%4;b[+e.dataset.cell]=(e.classList.contains('g')?1:-1)*(d+1);}return b;})()`;

const moves = [384, 272, 502];
const positions = [initial()]; let player: Player = 1;
for (const action of moves) { positions.push(apply(positions.at(-1)!, player, action).board); player = -player as Player; }
const record: GameRecord = { id: 'compact-three', mode: 'local', date: Date.now(), moves, winner: 1, me: null, endReason: 'resign' };
let brownBoard = initial(); let brownPlayer: Player = -1;
const brownMoves: number[] = [];
for (let i = 0; i < 3; i++) { const action = legal(brownBoard, brownPlayer)[0]; brownMoves.push(action); brownBoard = apply(brownBoard, brownPlayer, action).board; brownPlayer = -brownPlayer as Player; }
const brownRecord: GameRecord = { ...record, id: 'compact-brown-first', initialPlayer: -1, moves: brownMoves };
const passBoard = recenter(LESSONS.find(l => l.id === 'pass')!.board).board;
const passRecord: GameRecord = { ...record, id: 'compact-pass', initialBoard: passBoard, moves: [PASS] };
try {
  const endpoint = await new Promise<string>((done, fail) => {
    let log = '';
    const timer = setTimeout(() => fail(new Error('Chrome startup timeout: ' + log)), 15000);
    chrome.stderr!.on('data', value => { log += value; const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); done(match[1]); } });
    chrome.on('error', fail);
  });
  socket = new WebSocket(endpoint); await once(socket, 'open');
  socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    if (message.id) {
      const request = pending.get(message.id);
      if (request) { pending.delete(message.id); message.error ? request.fail(new Error(message.error.message)) : request.done(message.result); }
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call('Runtime.enable', {}, s); await call('Page.enable', {}, s);
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    if (!sessionStorage.getItem('compact-ui-init')) {
      localStorage.setItem('gyeol:settings',${JSON.stringify(JSON.stringify({ nickname: 'CompactCheck', lang: 'ko', sound: false, vibrate: false, coordinates: true }))});
      localStorage.setItem('gyeol:records',${JSON.stringify(JSON.stringify([record, brownRecord, passRecord]))});
      sessionStorage.setItem('compact-ui-init','1');
    }
  ` }, s);
  let navigation = 0;
  const navigate = async (hash: string) => {
    await call('Page.navigate', { url: `http://127.0.0.1:5181/?compact-check=${++navigation}#/` + hash }, s);
    await wait(s, `!document.querySelector('.splash') && !!document.querySelector('.app')`);
    if (hash.startsWith('replay/') || hash === 'local') await wait(s, `!!document.querySelector('.board')`);
  };
  const labels = `Array.from(document.querySelectorAll('.move-table tbody tr')).map(row => Array.from(row.cells).map(cell => cell.textContent.trim()))`;
  const absent = async () => {
    assert.equal(await evaluate(s, `!!document.querySelector('.notation-tools,.notation-form,.notation-screen')`), false);
    assert.equal(await evaluate(s, `Array.from(document.querySelectorAll('button')).some(e => /\uBB38\uC790\uC5F4\uB85C \uC5F4\uAE30|\uBC30\uCE58 \uBCF5\uC0AC|\uC218\uC21C \uBCF5\uC0AC/.test(e.textContent))`), false);
  };
  mkdirSync('tools/notation', { recursive: true });
  const measurements: object[] = [];
  for (const width of [390, 1360]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 }, s);
    await navigate('replay/compact-three');
    await wait(s, `document.querySelectorAll('.move-table tbody tr').length === 2`);
    await absent();
    assert.deepEqual(await evaluate(s, labels), [['1.D4u', '1.D3U'], ['2.D5d', '']]);
    assert.equal(await evaluate(s, `document.querySelector('.move-log').querySelectorAll('.chip,.who,.what').length`), 0);
    assert.equal(await evaluate(s, `Array.from(document.querySelectorAll('.move-table tr')).some(e => /\uB4A4\uC9D1/.test(e.textContent))`), false);
    const heights = await evaluate(s, `Array.from(document.querySelectorAll('.move-table tbody tr')).map(e=>e.getBoundingClientRect().height)`);
    assert.ok(heights.every((h: number) => h <= 26), JSON.stringify(heights));
    measurements.push({ width, rowHeights: heights });
    await evaluate(s, `document.querySelector('.move-notation[data-ply="3"]').click()`);
    assert.deepEqual(await evaluate(s, boardExpression), positions[2]);
    await click(s, '\uC218 \uB450\uAE30');
    assert.deepEqual(await evaluate(s, boardExpression), positions[3]);
    assert.equal(await evaluate(s, `document.documentElement.scrollWidth <= innerWidth + 1`), true);
    await pause(350);
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: width < 600 }, s);
    writeFileSync(`tools/notation/ui-${width < 600 ? 'mobile' : 'desktop'}.png`, Buffer.from(shot.data, 'base64'));
  }
  await navigate('replay/compact-brown-first');
  const brownLabels = await evaluate(s, labels);
  assert.ok(brownLabels[0][0].startsWith('1.') && brownLabels[0][1].startsWith('1.'));
  assert.equal(brownLabels[1][0], ''); assert.ok(brownLabels[1][1].startsWith('2.'));
  await navigate('replay/compact-pass');
  assert.deepEqual(await evaluate(s, labels), [['1.pass', '']]);
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true }, s);
  await navigate('local'); await absent();
  await evaluate(s, `document.querySelector('.tile[data-cell="24"]').click()`);
  await evaluate(s, `document.querySelector('.chev-btn[data-dir="0"]').click()`);
  await evaluate(s, `document.querySelector('button.target[data-cell="17"]').click()`);
  await wait(s, `!!document.querySelector('.mobile-moves .move-notation')`);
  await evaluate(s, `document.querySelector('.mobile-moves').open = true`);
  assert.deepEqual(await evaluate(s, labels), [['1.D4u', '']]);
  await evaluate(s, `document.querySelector('.move-notation').click()`);
  assert.deepEqual(await evaluate(s, boardExpression), initial());
  await click(s, '\uC218 \uB450\uAE30'); await click(s, '\uB2EB\uAE30');
  for (const route of ['', 'me', 'notation']) { await navigate(route); await absent(); }
  assert.deepEqual(errors, []);
  const report = { passed: true, runtimeErrors: errors, measurements, cases: [
    'two equal columns and independent 1/1/2 numbering', 'no team colors or flipped-count text', 'row height at most 26px',
    'before/after replay selection', 'brown-first and pass numbering', 'compact mobile local-game preview',
    'import/copy UI and route removed', 'mobile and desktop have no horizontal overflow',
  ] };
  writeFileSync('tools/notation/ui-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally {
  if (socket?.readyState === WebSocket.OPEN) { await call('Browser.close').catch(() => undefined); socket.close(); }
  if (chrome.exitCode === null) await Promise.race([once(chrome, 'exit'), pause(5000)]);
  if (chrome.exitCode === null) chrome.kill();
  assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep) && basename(profile).startsWith('gyeol-notation-ui-'));
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
