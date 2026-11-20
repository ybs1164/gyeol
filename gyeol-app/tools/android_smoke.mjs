/**
 * 안드로이드 앱(디버그 APK) 안의 WebView를 DevTools 프로토콜로 조작해 핵심 기능을 확인한다.
 *   adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
 *   node tools/android_smoke.mjs [서버주소(기기에서 본 주소, 예: 10.0.2.2:8787)]
 */
import WebSocket from 'ws';

const server = process.argv[2] ?? '';
const targets = await (await fetch('http://localhost:9333/json')).json();
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let id = 0;
const pending = new Map();
const errors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
  else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
});
const cmd = (method, params = {}) =>
  new Promise((r) => {
    const n = ++id;
    pending.set(n, r);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const run = async (expr) => {
  const res = await cmd('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'eval error');
  return res.result?.result?.value;
};
await cmd('Runtime.enable');

const helpers = `
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = (s) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(s));
  const until = async (f, ms = 30000) => { const t = performance.now(); while (performance.now() - t < ms) { const v = f(); if (v) return v; await w(100); } return null; };
`;
const out = {};

out.native = await run(`return !!window.Capacitor?.isNativePlatform?.()`);

// 1) AI 대국: 갈색으로 시작해 AI(보통)가 첫 수를 두는지, 시간
out.ai = await run(`${helpers}
  location.hash = '/ai'; await w(400);
  btn('보통').click(); await w(100);
  btn('갈색').click(); await w(100);
  btn('시작').click();
  const t0 = performance.now();
  const ok = await until(() => document.querySelectorAll('.tile').length === 3, 60000);
  return { firstMoveMs: Math.round(performance.now() - t0), ok: !!ok, status: document.querySelector('.status')?.textContent };
`);

// 2) 최강 AI 한 수 시간 (내가 한 수 둔 뒤 AI 응답)
out.master = await run(`${helpers}
  location.hash = '/ai'; await w(400);
  btn('최강').click(); await w(100);
  btn('초록').click(); await w(100);
  btn('시작').click(); await w(500);
  document.querySelector('.tile.selectable').click(); await w(80);
  if (!document.querySelector('button.target')) { document.querySelector('.chev').click(); await w(80); }
  document.querySelector('button.target').click();
  const t0 = performance.now();
  const ok = await until(() => document.querySelectorAll('.tile').length === 4, 60000);
  return { replyMs: Math.round(performance.now() - t0), ok: !!ok };
`);

// 3) 메모리 (WebView 메인 스레드)
out.memory = await run(`return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + 'MB used / ' + Math.round(performance.memory.jsHeapSizeLimit / 1048576) + 'MB limit' : 'n/a'`);

// 4) 퍼즐·튜토리얼 화면 렌더
out.puzzle = await run(`${helpers} location.hash = '/puzzle'; await w(500); return document.querySelectorAll('.tile').length`);
out.learn = await run(`${helpers} location.hash = '/learn'; await w(500); return document.querySelector('.topbar h2')?.textContent`);

// 5) 온라인: 서버 주소 설정 후 접속
if (server)
  out.online = await run(`${helpers}
    const s = JSON.parse(localStorage.getItem('gyeol:settings') || '{}'); s.server = ${JSON.stringify(server)};
    localStorage.setItem('gyeol:settings', JSON.stringify(s));
    location.hash = '/online'; location.reload();
  `).catch(() => 'reloading');
if (server) {
  await new Promise((r) => setTimeout(r, 6000));
  out.online = await run(`${helpers}
    location.hash = '/online';
    const me = await until(() => document.querySelector('.me-line b')?.textContent, 15000);
    return { connected: !!me, name: me };
  `);
}

// 6) 뒤로 가기용 해시 기록
out.errors = errors;
console.log(JSON.stringify(out, null, 2));
ws.close();
