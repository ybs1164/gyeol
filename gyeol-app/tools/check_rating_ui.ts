/** 빌드된 웹을 임시 메모리 서버·격리 Chrome으로 검사한다. 실제 사용자 파일은 열지 않는다. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createServer } from '../packages/server/src/server';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'tools/rating-validation');
const profile = mkdtempSync(join(tmpdir(), 'gyeol-rating-ui-'));
const server = createServer({ port: 0, host: '127.0.0.1', dbPath: null, staticDir: join(root, 'apps/web/dist') });
const port = await server.listen();
const now = Date.now();
await server.store.call('seedPlayer', { id: 'rating-check', token: 'rating-check-token', name: 'RatingCheck', rating: 1800, rd: 80, vol: .06,
  ranked: 350, rated: 5, wins: 200, losses: 150, createdAt: now - 30 * 86_400_000, seenAt: now, ratingAt: now,
  historyComplete: false, peakRating: 2500, lowestRating: 1200,
  history: Array.from({ length: 300 }, (_, i) => ({ at: now - 86_400_000 + i, rating: 1800 })) });
await server.store.call('seedPlayer', { id: 'opponent-check', token: 'opponent-check-token', name: 'OpponentCheck', rating: 1338, rd: 290, vol: .06,
  ranked: 1, rated: 0, wins: 0, losses: 1, createdAt: now, seenAt: now });
await server.store.call('seedGame', {
  id: 'early-check', code: null, ranked: true, mode: 'daily', greenId: 'rating-check', brownId: 'opponent-check', moves: [],
  status: 'finished', winner: 1, endReason: 'resign', turnLimitMs: 86_400_000, clock: null, turnStartedAt: now,
  createdAt: now, updatedAt: now, ratingChange: { green: 0, brown: -162 }, ratingRestriction: { green: 'early', brown: 'early' },
});

const chrome = spawn(process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket: WebSocket | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void }>();
const errors: string[] = [];
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const call = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((done, fail) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timeout: ${method}`)); }, 15_000);
  pending.set(id, { resolve: (v) => { clearTimeout(timer); done(v); }, reject: (e) => { clearTimeout(timer); fail(e); } });
  socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

try {
  const endpoint = await new Promise<string>((done, fail) => {
    let log = '';
    const timer = setTimeout(() => fail(new Error('Chrome startup timeout')), 15_000);
    chrome.once('error', (e) => { clearTimeout(timer); fail(e); });
    chrome.stderr!.on('data', (data) => {
      log += String(data);
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); done(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(message.params.exceptionDetails));
    const task = pending.get(message.id);
    if (task) { pending.delete(message.id); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); }
  });
  await once(socket, 'open');
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call('Runtime.enable', {}, sessionId);
  await call('Page.enable', {}, sessionId);
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
  const evaluate = async (expression: string) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async (expression: string) => {
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await pause(80);
    }
    throw new Error('UI timeout: ' + expression + '\n' + await evaluate('document.body.innerText'));
  };
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    if (!localStorage.getItem('gyeol:settings')) localStorage.setItem('gyeol:settings', JSON.stringify({nickname:'RatingCheck',lang:'ko',sound:false,vibrate:false}));
    localStorage.setItem('gyeol:token:ws://127.0.0.1:${port}/ws','rating-check-token');
  ` }, sessionId);
  await call('Page.navigate', { url: `http://127.0.0.1:${port}/#/rating` }, sessionId);
  await wait(`document.querySelector('.rating-hero > div:last-child > b')?.textContent === '1800'`);
  await wait(`document.querySelector('.stats.three')?.textContent.includes('2500')`);
  await wait(`!document.querySelector('.splash')`);
  const stats = await evaluate(`Array.from(document.querySelectorAll('.rating-page .stats.three b')).map(e=>e.textContent)`);
  assert.deepEqual(stats, ['2500', '1200', '–']);
  assert(await evaluate(`document.body.innerText.includes('보관된 기록') && document.body.innerText.includes('기록된 최고')`));
  const chartValues = await evaluate(`document.querySelector('.chart polyline').getAttribute('points').split(' ').map(p=>Number(p.split(',')[1]))`);
  assert.equal(new Set(chartValues).size, 1, '잘린 기록에서 1500점 상승선을 만들면 안 됨');
  assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'), '모바일 가로 넘침');
  mkdirSync(output, { recursive: true });
  const capture = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  writeFileSync(join(output, 'rating-mobile.png'), Buffer.from(capture.data, 'base64'));
  await evaluate(`location.hash='#/g/early-check'`);
  await wait(`document.querySelector('.result-pop .sub')?.textContent.includes('초반 종료')`);
  assert(await evaluate(`document.querySelector('.result-pop .delta .nums')?.textContent.includes('1800')`));
  await evaluate(`localStorage.setItem('gyeol:settings',JSON.stringify({nickname:'RatingCheck',lang:'en',sound:false,vibrate:false})); location.hash='#/rating'; location.reload()`);
  await wait(`document.body.innerText.includes('Recorded best') && document.body.innerText.includes('Saved history')`);
  assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
  assert.deepEqual(errors, []);
  const report = { checkedAt: new Date().toISOString(), passed: true, viewport: [390, 844], languages: ['ko', 'en'],
    checks: ['truncated-history-week-unknown', 'retained-peak-and-lowest', 'flat-chart-without-invented-baseline', 'restriction-result-message', 'mobile-layout'], errors };
  writeFileSync(join(output, 'ui-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  const exited = chrome.exitCode === null ? once(chrome, 'exit').catch(() => undefined) : Promise.resolve();
  if (socket?.readyState === WebSocket.OPEN) await call('Browser.close').catch(() => undefined);
  socket?.terminate();
  await Promise.race([exited, pause(3000)]);
  if (chrome.exitCode === null) chrome.kill();
  await server.close();
  const target = resolve(profile);
  if (dirname(target) === resolve(tmpdir()) && basename(target).startsWith('gyeol-rating-ui-')) {
    try { rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (error) { console.warn('Chrome temporary profile cleanup:', error); }
  }
}
