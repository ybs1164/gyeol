/** Run the production preview on port 5181 before this check. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import WebSocket from 'ws';
import { apply, decode, idx, initial, legal, type Player } from '../packages/core/src/index';

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'gyeol-motion-ui-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
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
    if (await evaluate(session, `Boolean(${expression})`)) return;
    await pause(50);
  }
  throw new Error(`UI timeout: ${expression}`);
};

// Find a legal sequence ending in a capture, then play it through the real board UI.
const moves: number[] = [];
let board = initial(), player: Player = 1;
for (let i = 0; i < 25; i++) {
  const actions = legal(board, player);
  const action = actions.find(a => apply(board, player, a).last.flipped?.length) ?? actions[0];
  const next = apply(board, player, action);
  moves.push(action);
  if (next.last.flipped?.length) break;
  board = next.board; player = -player as Player;
}
assert.ok(apply(board, player, moves.at(-1)!).last.flipped?.length);

try {
  const endpoint = await new Promise<string>((done, fail) => {
    let log = '';
    const timer = setTimeout(() => fail(new Error('Chrome startup timeout: ' + log)), 15000);
    chrome.stderr!.on('data', value => {
      log += value;
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); done(match[1]); }
    });
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
    localStorage.setItem('gyeol:settings', JSON.stringify({ nickname: 'MotionCheck', lang: 'ko', sound: false, vibrate: false }));
  ` }, s);
  const results: object[] = [];
  for (const width of [390, 1360]) for (const motion of ['reduce', 'no-preference']) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 }, s);
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] }, s);
    await call('Page.navigate', { url: `http://127.0.0.1:5181/?motion=${width}-${motion}#/local` }, s);
    await wait(s, `document.querySelector('.board') && !document.querySelector('.splash')`);
    // Both loader selectors share the motion policy; isolated fixtures avoid network-dependent matching.
    const loaders = await evaluate(s, `(() => {
      const host = document.createElement('div');
      host.innerHTML = '<svg class="spin3d"><g class="spin-rot"><rect width="100" height="100" /></g></svg><span class="spin"></span>';
      document.body.appendChild(host);
      return [...host.querySelectorAll('.spin-rot,.spin')].map(e => ({ name: getComputedStyle(e).animationName, duration: getComputedStyle(e).animationDuration }));
    })()`);
    if (motion === 'reduce') assert.ok(loaders.every((x: any) => x.name === 'none'), JSON.stringify(loaders));
    else assert.deepEqual(loaders, [{ name: 'turn', duration: '3.2s' }, { name: 'spin', duration: '0.8s' }]);

    for (const [index, action] of moves.entries()) {
      const m = decode(action)!;
      await evaluate(s, `document.querySelector('.tile[data-cell="${idx(m.r, m.c)}"]').click()`);
      await wait(s, `document.querySelector('.chev-btn[data-dir="${m.newDir}"]')`);
      await evaluate(s, `document.querySelector('.chev-btn[data-dir="${m.newDir}"]').click()`);
      await wait(s, `document.querySelector('button.target[data-cell="${idx(m.pr, m.pc)}"]')`);
      await evaluate(s, `document.querySelector('button.target[data-cell="${idx(m.pr, m.pc)}"]').click()`);
      await wait(s, `document.querySelectorAll('.tile').length === ${index + 3}`);
    }
    const flip = await evaluate(s, `(() => {
      const body = document.querySelector('.body.flip'), face = body.querySelector('.face');
      const shape = body.getAnimations().find(a => a.animationName === 'flip-x');
      const color = face.getAnimations().find(a => a.animationName === 'flip-color');
      shape.pause(); color.pause();
      const delay = Number(shape.effect.getTiming().delay);
      const sample = t => { shape.currentTime = delay + t; color.currentTime = delay + t; return { transform: getComputedStyle(body).transform, color: getComputedStyle(face).color }; };
      return { duration: shape.effect.getTiming().duration, colorDuration: color.effect.getTiming().duration, samples: [sample(0), sample(180), sample(360)] };
    })()`);
    assert.equal(flip.duration, 360); assert.equal(flip.colorDuration, 360);
    assert.notEqual(flip.samples[0].transform, flip.samples[1].transform);
    assert.equal(flip.samples[0].transform, flip.samples[2].transform);
    assert.notEqual(flip.samples[0].color, flip.samples[2].color, JSON.stringify({ width, motion, flip }));
    results.push({ width, motion, loaders, flip });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, moves, results }));
} finally {
  if (socket?.readyState === WebSocket.OPEN) { await call('Browser.close').catch(() => undefined); socket.close(); }
  if (chrome.exitCode === null) await Promise.race([once(chrome, 'exit'), pause(5000)]);
  if (chrome.exitCode === null) chrome.kill();
  assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep) && basename(profile).startsWith('gyeol-motion-ui-'));
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
