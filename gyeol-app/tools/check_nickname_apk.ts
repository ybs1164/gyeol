/** Validate nickname layout and the default connection in a browser or debug APK. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../packages/server/src/server';

const native = process.argv.includes('--native');
const output = 'tools/apk-validation'; mkdirSync(output, { recursive: true });
const report: any = { checkedAt: new Date().toISOString(), native, layouts: [], connections: [], errors: [] };
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
let chrome: ReturnType<typeof spawn> | undefined, server: ReturnType<typeof createServer> | undefined, profile: string | undefined;
let socket: WebSocket | undefined, id = 0, sessionId: string | undefined;
const adb = join(process.env.LOCALAPPDATA!, 'Android/Sdk/platform-tools/adb.exe');
const shell = (...args: string[]) => execFileSync(adb, ['-s', 'emulator-5580', 'shell', ...args], { windowsHide: true, encoding: 'utf8' }).trim();
let networkSettings: { wifi: string; airplane: string } | undefined;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => {
  const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(new Error(`Timeout ${method}`)); }, 30000);
  pending.set(n, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
  socket!.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const run = async (expression: string) => {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const wait = async (expression: string, ms = 30000) => {
  const start = Date.now(); while (Date.now() - start < ms) { if (await run(`Boolean(${expression})`)) return; await pause(150); }
  throw new Error(`UI timeout: ${expression}`);
};
const capture = async (name: string) => {
  const r = await call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(output, `${native ? 'android' : 'web'}-${name}.png`), Buffer.from(r.data, 'base64'));
};
const measure = async (name: string) => {
  const m = await run(`(() => { const i=document.querySelector('input.input'), s=getComputedStyle(i), r=i.getBoundingClientRect(); return {height:r.height,width:r.width,fontWeight:s.fontWeight,outline:s.outlineStyle,border:s.borderTopWidth,shadow:s.boxShadow,overflow:document.documentElement.scrollWidth>innerWidth,visible:r.top>=0&&r.bottom<=innerHeight}; })()`);
  report.layouts.push({ name, ...m });
  assert.equal(m.height, 48, name); assert.equal(m.fontWeight, '400'); assert.equal(m.outline, 'none'); assert(!m.overflow); assert(m.visible);
  await capture(name);
};
try {
  let endpoint: string, address = '';
  if (native) {
    const targets = await (await fetch('http://127.0.0.1:9333/json')).json() as any[];
    assert(targets.length); endpoint = targets.find(t => t.type === 'page')!.webSocketDebuggerUrl;
  } else {
    server = createServer({ port: 0, host: '127.0.0.1', dbPath: null, staticDir: join(process.cwd(), 'apps/web/dist') });
    address = `http://127.0.0.1:${await server.listen()}`;
    profile = mkdtempSync(join(tmpdir(), 'gyeol-input-'));
    chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    endpoint = await new Promise<string>((resolve, reject) => {
      let log = ''; const timer = setTimeout(() => reject(new Error('Chrome startup')), 30000);
      chrome!.stderr!.on('data', b => { log += b; const m = log.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
      chrome!.once('error', reject);
    });
  }
  socket = new WebSocket(endpoint);
  socket.on('message', raw => {
    const m = JSON.parse(String(raw)), job = pending.get(m.id);
    if (job) { pending.delete(m.id); m.error ? job.reject(new Error(m.error.message)) : job.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') report.errors.push(m.params.exceptionDetails.text);
    if (m.method === 'Network.webSocketCreated') report.connections.push({ id: m.params.requestId, url: m.params.url, welcome: false });
    if (m.method === 'Network.webSocketFrameReceived') {
      try { const p = JSON.parse(m.params.response.payloadData); if (p.t === 'welcome') { const c = report.connections.find((c: any) => c.id === m.params.requestId); if (c) c.welcome = true; } } catch {}
    }
  });
  await once(socket, 'open');
  if (!native) {
    const t = await call('Target.createTarget', { url: 'about:blank' });
    sessionId = (await call('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  }
  await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable');
  if (native) {
    // The dedicated emulator keeps its login token when this check is repeated.
    await run(`localStorage.setItem('gyeol:settings',JSON.stringify({...JSON.parse(localStorage.getItem('gyeol:settings')||'{}'),nickname:''}))`);
    await call('Page.reload');
  } else await call('Page.navigate', { url: address });
  await wait(`document.querySelector('form.screen input.input') && !document.querySelector('.splash')`);
  report.platform = await run(`({native:!!window.Capacitor?.isNativePlatform?.(),origin:location.origin,server:JSON.parse(localStorage.getItem('gyeol:settings')||'{}').server||''})`);
  assert.equal(report.platform.native, native); assert.equal(report.platform.server, '');
  const sizes = native ? [null] : [{width:390,height:844}, {width:390,height:420}, {width:1440,height:1000}];
  for (const size of sizes) {
    if (size) await call('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: size.width < 600 });
    await run(`document.querySelector('input.input').focus()`); await pause(200);
    await measure(`onboarding-${size ? `${size.width}x${size.height}` : 'device'}`);
  }
  await call('Input.insertText', { text: native ? 'ApkCheck' : 'WebCheck' });
  await run(`document.querySelector('form.screen').requestSubmit()`);
  await wait(`document.querySelector('.profile .who small')?.textContent.includes('1500')`, 45000);
  assert(report.connections.some((c: any) => c.welcome), 'Server authentication');
  if (native) assert(report.connections.some((c: any) => c.url === 'wss://gyeol.146.56.189.166.sslip.io/ws' && c.welcome));
  await capture('connected');
  for (const size of sizes) {
    if (size) await call('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: size.width < 600 });
    await run(`document.querySelector('.profile').click()`);
    await wait(`document.querySelector('.popup input.input')`); await measure(`rename-${size ? `${size.width}x${size.height}` : 'device'}`);
    await call('Input.insertText', { text: '2' });
    await run(`document.querySelector('.popup form').requestSubmit()`);
    await wait(`!document.querySelector('.popup')`);
  }
  report.savedName = await run(`JSON.parse(localStorage.getItem('gyeol:settings')).nickname`);
  if (native) {
    networkSettings = { wifi: shell('settings','get','global','wifi_on'), airplane: shell('settings','get','global','airplane_mode_on') };
    shell('cmd','connectivity','airplane-mode','enable'); shell('svc','wifi','disable'); await pause(2000);
    report.externalFetchWhileOffline = await run(`fetch('https://gyeol.146.56.189.166.sslip.io/health',{cache:'no-store',signal:AbortSignal.timeout(5000)}).then(()=>true,()=>false)`);
    assert.equal(report.externalFetchWhileOffline, false);
  }
  await run(`location.hash='#/ai'`); await wait(`document.querySelector('.choices.inline')`);
  await run(`document.querySelectorAll('.choices.inline .choice')[1].click()`);
  await wait(`document.querySelectorAll('.choices.inline .choice')[1].getAttribute('aria-pressed')==='true'`);
  await run(`document.querySelector('.screen > button.primary').click()`);
  await wait(`document.querySelectorAll('.tile').length === 3`, 60000);
  report[native ? 'offlineAiFirstMove' : 'aiFirstMove'] = true;
  await run(`location.hash='#/puzzle'`); await wait(`document.querySelectorAll('.tile').length > 2`);
  report[native ? 'offlinePuzzle' : 'puzzleTiles'] = await run(`document.querySelectorAll('.tile').length`);
  await capture('offline-puzzle'); assert.equal(report.errors.length, 0);
  console.log(JSON.stringify(report, null, 2));
} catch (e) { report.failure = String(e); console.error(e); process.exitCode = 1; }
finally {
  writeFileSync(join(output, native ? 'android-report.json' : 'web-report.json'), JSON.stringify(report, null, 2) + '\n');
  if (networkSettings) {
    try { shell('cmd','connectivity','airplane-mode',networkSettings.airplane === '1' ? 'enable' : 'disable'); shell('svc','wifi',networkSettings.wifi === '1' ? 'enable' : 'disable'); }
    catch (error) { console.error('Could not restore emulator network:', error); process.exitCode = 1; }
  }
  if (!native && socket?.readyState === WebSocket.OPEN) await call('Browser.close').catch(() => {});
  socket?.terminate(); chrome?.kill(); await server?.close();
  if (profile) { await pause(1000); try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
}
