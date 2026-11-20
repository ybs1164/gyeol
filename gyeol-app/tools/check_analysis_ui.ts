/** 실제 프로덕션 빌드를 격리한 Chrome에서 검사한다. node --import tsx tools/check_analysis_ui.ts */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { ExactEndgame, PASS, apply, legal, result, winner, type Player, type RecordPuzzleData } from '../packages/core/src/index';
import type { GameRecord } from '../apps/web/src/lib/storage';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'gyeol-analysis-ui-'));
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
  pending.set(n, { done: v => { clearTimeout(timer); done(v); }, fail: e => { clearTimeout(timer); fail(e); } });
  socket!.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const evaluate = async (s: string, expression: string) => {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, s);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const wait = async (s: string, expression: string, timeout = 120000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(s, `Boolean(document.body && (${expression}))`)) return; await sleep(100); }
  throw new Error('UI timeout: ' + expression + '\n' + await evaluate(s, 'document.body.innerText'));
};
const clickText = async (s: string, text: string) => {
  const query = `Array.from(document.querySelectorAll('button')).find(e=>(e.textContent===${JSON.stringify(text)} || e.getAttribute('aria-label')===${JSON.stringify(text)}) && !e.disabled)`;
  await wait(s, query); await evaluate(s, `${query}.click()`);
};
const boardExpression = `(()=>{const b=Array(49).fill(0); for(const e of document.querySelectorAll('.tile[data-cell]:not(.ghost)')) {const a=parseFloat(e.querySelector('.body').style.getPropertyValue('--a'));const d=((Math.round(a/90)%4)+4)%4;b[+e.dataset.cell]=(e.classList.contains('g')?1:-1)*(d+1);}return b;})()`;
const checkGradePlacement = async (s: string) => {
  const geometry = await evaluate(s, `(()=>{
    const badge=document.querySelector('.board .tile-grade .move-grade');
    const tile=badge.closest('.tile,.target.ghost');
    const b=badge.getBoundingClientRect(), t=tile.getBoundingClientRect();
    const svg=badge.querySelector('svg.grade-icon'), i=svg.getBoundingClientRect();
    return {
      cornerX:Math.abs(b.x+b.width/2-t.right), cornerY:Math.abs(b.y+b.height/2-t.top),
      centerX:Math.abs(i.x+i.width/2-b.x-b.width/2), centerY:Math.abs(i.y+i.height/2-b.y-b.height/2),
      round:Math.abs(b.width-b.height), vector:!!svg.querySelector('path,circle')&&!svg.querySelector('text'),
      noExtraMarker:!badge.querySelector('.grade-provisional')&&!badge.textContent.includes('~')
    };
  })()`);
  assert.ok(geometry.cornerX <= 3 && geometry.cornerY <= 3, JSON.stringify(geometry));
  assert.ok(geometry.centerX < 0.6 && geometry.centerY < 0.6 && geometry.round < 0.6, JSON.stringify(geometry));
  assert.ok(geometry.vector && geometry.noExtraMarker, JSON.stringify(geometry));
};
const gradePalettes: Record<string, unknown> = {};
const checkGradeColors = async (s: string, theme: string) => {
  const palette = await evaluate(s, `Array.from(document.querySelectorAll('.grade-rules .move-grade')).map(e=>({
    grade:e.dataset.grade, color:getComputedStyle(e).color, background:getComputedStyle(e).backgroundColor,
    named:!!e.querySelector('.grade-name')?.textContent, opacity:getComputedStyle(e).opacity
  }))`);
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => {
      const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  assert.equal(palette.length, 7);
  assert.equal(new Set(palette.map((p: any) => p.background)).size, 7);
  for (const p of palette) {
    const a = luminance(p.color), b = luminance(p.background);
    p.contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    assert.ok(p.named && p.opacity === '1' && p.contrast >= 4.5, JSON.stringify({ theme, ...p }));
  }
  gradePalettes[theme] = palette;
};

const puzzles = JSON.parse(readFileSync('tools/record-puzzles/verified.json', 'utf8')) as RecordPuzzleData[];
const p = puzzles.find(p => p.board.filter(Boolean).length === 23 && p.proof[0][1].some(([a, v]) => v < 0 && !result(apply(p.board, p.player, a).board, -p.player as Player) && legal(apply(p.board, p.player, a).board, -p.player as Player)[0] !== PASS))!;
const wrong = p.proof[0][1].find(([a, v]) => v < 0 && legal(apply(p.board, p.player, a).board, -p.player as Player)[0] !== PASS)![0];
const after = apply(p.board, p.player, wrong).board;
const reply = new ExactEndgame().values(after, -p.player as Player).sort((a, b) => b[1] - a[1])[0][0];
const end = apply(after, -p.player as Player, reply).board;
assert.notEqual(result(end, p.player), 0);
const short: GameRecord = { id: 'ui-short', mode: 'local', date: Date.now(), initialBoard: p.board, initialPlayer: p.player, ruleVersion: 'facing-25-v1', moves: [wrong, reply], winner: winner(end, p.player)!, me: null };
const sample = JSON.parse(readFileSync('tools/analysis/sample-game.json', 'utf8')) as { record: GameRecord };
const long: GameRecord = { ...sample.record, id: 'ui-long' };
const interrupted: GameRecord = { ...long, id: 'ui-cancel', moves: long.moves.slice(0, -1), endReason: 'resign' };
const failed: GameRecord = { ...short, id: 'ui-failed', moves: short.moves.slice(0, 1), endReason: 'resign', winner: p.player };
const timeout: GameRecord = { ...failed, id: 'ui-timeout', endReason: 'timeout' };
const invalid: GameRecord = { ...short, id: 'ui-invalid', moves: [784] };
// Every child of this 24-tile position is terminal, so exact grading does not depend on a time budget.
const terminalAction = legal(after, -p.player as Player).find(a => result(apply(after, -p.player as Player, a).board, p.player) > 0.5) ?? reply;
const terminalBoard = apply(after, -p.player as Player, terminalAction).board;
const terminalRecord: GameRecord = { ...short, id: 'ui-grading-terminal', initialBoard: after, initialPlayer: -p.player as Player, moves: [terminalAction], winner: winner(terminalBoard, p.player)! };
const rootDistance = await new ExactEndgame().winDistanceAsync(p.board, p.player, p.player, async () => {});
assert.ok(rootDistance !== null && rootDistance > 0);

try {
  const endpoint = await new Promise<string>((done, fail) => {
    let log = '';
    const timer = setTimeout(() => fail(new Error('Chrome startup timeout: ' + log)), 15000);
    child.stderr!.on('data', v => { log += v; const m = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); done(m[1]); } });
    child.on('error', fail);
  });
  socket = new WebSocket(endpoint); await once(socket, 'open');
  socket.on('message', raw => {
    const m = JSON.parse(String(raw));
    if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.fail(new Error(m.error.message)) : p.done(m.result); } }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call('Runtime.enable', {}, s); await call('Page.enable', {}, s); await call('Network.enable', {}, s);
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true }, s);
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `if(!sessionStorage.getItem('analysis-ui-init')) {
    localStorage.setItem('gyeol:settings',${JSON.stringify(JSON.stringify({ nickname: 'AnalysisCheck', lang: 'ko', sound: false, vibrate: false }))});
    localStorage.setItem('gyeol:records',${JSON.stringify(JSON.stringify([short, long, interrupted, failed, timeout, invalid, terminalRecord]))});
    sessionStorage.setItem('analysis-ui-init','1');
  } window.__analysisWorkerCount=0; const NativeWorker=window.Worker; window.Worker=class extends NativeWorker { constructor(...args){super(...args); window.__analysisWorkerCount++;} };` }, s);
  const navigate = async (record: GameRecord) => {
    await call('Page.navigate', { url: 'http://127.0.0.1:5181/?analysis-check=' + record.id + '#/replay/' + record.id }, s);
    await wait(s, `(document.body.innerText.includes('복기') || document.body.innerText.includes('기보의 수순 또는 규칙')) && !document.querySelector('.splash') && !document.body.innerText.includes('분석 기록 불러오는 중')`);
  };
  await navigate(short);
  assert.deepEqual(await evaluate(s, boardExpression), end);
  await wait(s, `document.body.innerText.includes('승률 다시 분석') && !document.querySelector('progress')`);
  assert.equal(await evaluate(s, `document.querySelector('.win-details').open`), false);
  assert.equal(await evaluate(s, `document.querySelector('.win-details summary').getBoundingClientRect().height <= 64`), true);
  assert.equal(await evaluate(s, `document.querySelector('.win-details summary svg').getBoundingClientRect().width <= 24`), true);
  assert.equal(await evaluate(s, `!!document.querySelector('.move-review')`), true);
  assert.equal(await evaluate(s, `document.querySelectorAll('.move-list .move-grade:not(.grade-pending)').length`), 2);
  assert.equal(await evaluate(s, `document.querySelector('.move-overview').getBoundingClientRect().height>0 && !document.querySelector('.move-overview').closest('details')`), true);
  assert.equal(await evaluate(s, `document.querySelectorAll('.grade-rules .move-grade').length`), 7);
  assert.equal(await evaluate(s, `new Set([...document.querySelectorAll('.grade-rules svg.grade-icon')].map(e=>e.dataset.gradeIcon)).size`), 7);
  assert.equal(await evaluate(s, `Boolean(document.querySelector('.win-selected').compareDocumentPosition(document.querySelector('.win-panel'))&Node.DOCUMENT_POSITION_FOLLOWING)`), true);
  assert.equal(await evaluate(s, `Boolean(document.querySelector('.win-panel').compareDocumentPosition(document.querySelector('.move-overview'))&Node.DOCUMENT_POSITION_FOLLOWING)`), true);
  assert.equal(await evaluate(s, `document.querySelector('.grade-guide').open`), false);
  assert.equal(await evaluate(s, `document.body.innerText.includes('~')||document.body.innerText.includes('◇')`), false);
  await checkGradePlacement(s);
  await checkGradeColors(s, 'light');
  assert.equal(await evaluate(s, `window.__analysisWorkerCount`), 1);
  const basicShot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, s);
  writeFileSync('tools/analysis/ui-win-mobile.png', Buffer.from(basicShot.data, 'base64'));
  await evaluate(s, `document.querySelector('.win-details').open=true`);
  assert.equal(await evaluate(s, `document.querySelectorAll('.move-list .move-notation').length`), 2);
  await evaluate(s, `document.querySelector('[data-ply="1"]').click()`);
  await wait(s, `document.querySelector('.move-review')?.textContent.includes('추천 수 보기')`);
  assert.equal(await evaluate(s, `window.__analysisWorkerCount`), 1);
  const quickSolved = await evaluate(s, `document.querySelector('.move-review [data-review-status]').textContent==='결과 확인'`);
  if (quickSolved) {
    assert.equal(await evaluate(s, `document.querySelector('.move-review .grade-reason').textContent`), '이길 수 있었지만 패배하는 수입니다.');
    assert.deepEqual(await evaluate(s, `[...document.querySelectorAll('.move-comparison dd')].map(e=>e.textContent)`), ['패배', '승리']);
  } else {
    assert.equal(await evaluate(s, `document.querySelector('.move-review [data-review-status]').textContent`), '추정');
    assert.equal(await evaluate(s, `document.querySelector('.move-review .grade-reason').textContent.includes('점 손실')`), true);
    assert.equal(await evaluate(s, `document.querySelector('.move-evidence').open`), false);
  }
  assert.equal(await evaluate(s, `document.querySelector('.move-review').textContent.includes('%p')`), false);
  await evaluate(s, `document.querySelector('.grade-guide summary').click()`);
  assert.equal(await evaluate(s, `document.querySelector('.grade-guide').open`), true);
  assert.equal(await evaluate(s, `document.querySelectorAll('.grade-rules .grade-rule').length`), 6);
  assert.equal(await evaluate(s, `document.querySelector('.grade-guide').textContent.includes('3점 초과–5점 손실')`), true);
  await evaluate(s, `document.querySelector('.grade-guide summary').focus()`);
  assert.equal(await evaluate(s, `document.activeElement===document.querySelector('.grade-guide summary')`), true);
  await call('Page.bringToFront', {}, s);
  await call('Emulation.setFocusEmulationEnabled', { enabled: true }, s);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' }, s);
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, s);
  await wait(s, `!document.querySelector('.grade-guide').open`);
  assert.deepEqual(await evaluate(s, boardExpression), p.board);
  await checkGradePlacement(s);
  await evaluate(s, `document.querySelectorAll('.perspective-picker button')[${p.player === 1 ? 0 : 1}].click()`);
  assert.equal(await evaluate(s, `document.querySelector('.win-number').textContent`), `${rootDistance}수 내 승리`);
  assert.equal(await evaluate(s, `document.querySelector('.analysis-graph .win-proof').textContent`), `${rootDistance}수 내 승리`);
  assert.ok(await evaluate(s, `document.querySelector('.analysis-graph').getAttribute('aria-valuetext').includes('${rootDistance}수 내 승리')`));
  assert.equal(await evaluate(s, `document.body.innerText.includes('양쪽 착수와 패스 포함')`), false);
  const forcedShot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, s);
  writeFileSync('tools/analysis/ui-forced-win-mobile.png', Buffer.from(forcedShot.data, 'base64'));
  await evaluate(s, `document.querySelectorAll('.perspective-picker button')[${p.player === 1 ? 1 : 0}].click()`);
  assert.equal(await evaluate(s, `document.querySelector('.win-number').textContent`), `${rootDistance}수 내 패배`);
  await evaluate(s, `document.querySelectorAll('.perspective-picker button')[0].click()`);
  await clickText(s, '수 두기');
  assert.deepEqual(await evaluate(s, boardExpression), after);
  const placed = apply(p.board, p.player, wrong).last.placed!;
  assert.equal(await evaluate(s, `document.querySelector('.tile[data-cell="${placed[0] * 7 + placed[1]}"] .tile-grade .move-grade').dataset.grade`), 'blunder');
  assert.equal(await evaluate(s, `document.querySelectorAll('.tile-grade').length`), 1);
  await checkGradePlacement(s);
  await evaluate(s, `document.documentElement.dataset.theme='dark'`);
  await checkGradeColors(s, 'dark');
  const darkShot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, s);
  writeFileSync('tools/analysis/ui-grades-dark.png', Buffer.from(darkShot.data, 'base64'));
  await evaluate(s, `document.documentElement.dataset.theme='light'`);
  await clickText(s, '추천 수 보기');
  await wait(s, `!!document.querySelector('.line-review') && !document.body.innerText.includes('선택한 수를 분석하는 중')`);
  assert.deepEqual(await evaluate(s, boardExpression), p.board);
  await clickText(s, '수순 다음');
  const best = p.proof[0][1].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0][0];
  assert.deepEqual(await evaluate(s, boardExpression), apply(p.board, p.player, best).board);
  await clickText(s, '기보로 돌아가기');
  assert.deepEqual(await evaluate(s, boardExpression), after);
  await clickText(s, '실제 수 보기');
  await wait(s, `!!document.querySelector('.line-review') && !document.body.innerText.includes('선택한 수를 분석하는 중')`);
  assert.deepEqual(await evaluate(s, boardExpression), p.board);
  await clickText(s, '수순 다음');
  assert.deepEqual(await evaluate(s, boardExpression), after);
  await clickText(s, '기보로 돌아가기');
  await clickText(s, '돌아볼 수');
  assert.equal(await evaluate(s, `document.querySelectorAll('.move-list .move-notation').length`), 1);
  await clickText(s, '모든 수');
  await evaluate(s, `document.querySelector('.analysis-graph').scrollIntoView({block:'center'})`);
  const chart = await evaluate(s, `(()=>{const r=document.querySelector('.analysis-graph').getBoundingClientRect(); return {x:r.left+r.width*0.95,y:r.top+r.height/2};})()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: chart.x, y: chart.y, button: 'left', clickCount: 1 }, s);
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: chart.x, y: chart.y, button: 'left', clickCount: 1 }, s);
  assert.equal(await evaluate(s, `document.querySelector('.analysis-graph').getAttribute('aria-valuenow')`), '2');
  await evaluate(s, `document.querySelector('.analysis-graph').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
  assert.equal(await evaluate(s, `document.querySelector('.analysis-graph').getAttribute('aria-valuenow')`), '0');
  await evaluate(s, `document.querySelector('.analysis-graph').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  assert.equal(await evaluate(s, `document.querySelector('.analysis-graph').getAttribute('aria-valuenow')`), '1');
  const textBefore = await evaluate(s, `document.querySelector('.analysis-graph .curve').getAttribute('points')`);
  await evaluate(s, `document.querySelectorAll('.perspective-picker button')[1].click()`);
  const textAfter = await evaluate(s, `document.querySelector('.analysis-graph .curve').getAttribute('points')`);
  assert.notEqual(textBefore, textAfter);
  assert.equal(await evaluate(s, `document.documentElement.scrollWidth <= innerWidth + 1`), true);
  const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, s);
  writeFileSync('tools/analysis/ui-analysis-mobile.png', Buffer.from(shot.data, 'base64'));
  await call('Page.reload', {}, s);
  await wait(s, `document.body.innerText.includes('승률 다시 분석') && !document.querySelector('progress')`);
  assert.equal(await evaluate(s, `window.__analysisWorkerCount`), 0);
  // A grade-only cache invalidation must reuse the exact stored graph.
  const cachedGraph = await evaluate(s, `new Promise((done,fail)=>{const r=indexedDB.open('gyeol-analysis',1);r.onsuccess=()=>{const db=r.result,tx=db.transaction('analysis','readwrite'),store=tx.objectStore('analysis'),q=store.getAll();q.onsuccess=()=>{const entries=q.result;window.__savedGraph=JSON.stringify(entries.filter(e=>JSON.parse(e.key)[0]==='win').map(e=>e.analysis));for(const e of entries)if(JSON.parse(e.key)[0]!=='win')store.delete(e.key);};tx.oncomplete=()=>{db.close();done(window.__savedGraph)};tx.onerror=()=>fail(tx.error);};r.onerror=()=>fail(r.error);})`);
  await call('Page.reload', {}, s);
  await wait(s, `document.body.innerText.includes('승률 다시 분석') && document.querySelectorAll('.move-list .move-grade:not(.grade-pending)').length===2`);
  assert.equal(await evaluate(s, `window.__analysisWorkerCount`), 1);
  const reloadedGraph = await evaluate(s, `new Promise(done=>{const r=indexedDB.open('gyeol-analysis',1);r.onsuccess=()=>{const db=r.result,q=db.transaction('analysis').objectStore('analysis').getAll();q.onsuccess=()=>{db.close();done(JSON.stringify(q.result.filter(e=>JSON.parse(e.key)[0]==='win').map(e=>e.analysis)))};};})`);
  assert.equal(reloadedGraph, cachedGraph);
  await evaluate(s, `document.querySelector('.analysis-graph').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
  assert.equal(await evaluate(s, `document.querySelector('.win-number').textContent`), `${rootDistance}수 내 ${p.player === 1 ? '승리' : '패배'}`);
  assert.equal(await evaluate(s, `window.__analysisWorkerCount`), 1);
  await evaluate(s, `document.querySelector('.analysis-graph').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`);
  await evaluate(s, `document.querySelector('.win-details').open=true`);
  await clickText(s, '정밀 분석');
  await wait(s, `document.body.innerText.includes('승률 다시 분석') && !document.querySelector('progress')`);

  console.log(JSON.stringify({ stage: 'short-record-and-cache', passed: true }));

  const fullStarted = performance.now();
  await navigate(long);
  await wait(s, `!!document.querySelector('.analysis-loading')`);
  assert.equal(await evaluate(s, `document.querySelectorAll('.analysis-graph,.win-number,.move-overview').length`), 0);
  const loadingShot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, s);
  writeFileSync('tools/analysis/ui-analysis-loading-mobile.png', Buffer.from(loadingShot.data, 'base64'));
  await wait(s, `Array.from(document.querySelectorAll('.analysis-graph .curve')).reduce((n,e)=>n+e.getAttribute('points').trim().split(' ').length,0)===${long.moves.length + 1}`);
  const fullGraphVisibleMs = Math.round(performance.now() - fullStarted);
  await wait(s, `document.querySelectorAll('.move-list .move-grade:not(.grade-pending)').length===${long.moves.length}`, 180000);
  const gradesVisibleMs = Math.round(performance.now() - fullStarted);
  assert.equal(await evaluate(s, `!!document.querySelector('.analysis-loading')`), false);
  await wait(s, `document.body.innerText.includes('승률 다시 분석') && !document.querySelector('progress')`, 180000);
  const fullCompleteMs = Math.round(performance.now() - fullStarted);
  console.log(JSON.stringify({ stage: 'full-record', ms: fullCompleteMs }));
  assert.equal(await evaluate(s, `document.querySelectorAll('.move-list .move-grade:not(.grade-pending)').length`), long.moves.length);
  assert.equal(await evaluate(s, `document.querySelectorAll('.move-list .move-grade.provisional').length>0`), true);
  assert.equal(await evaluate(s, `window.__analysisWorkerCount`), 1);

  // 본판 전체 분석: 즉시 취소와 부분 완료 뒤 재개·화면 이동을 확인한다.
  await navigate(interrupted);
  const cancelStart = performance.now(); await clickText(s, '분석 중지');
  await wait(s, `!document.querySelector('progress')`);
  const cancelMs = performance.now() - cancelStart;
  await evaluate(s, `Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='승률 분석'||e.textContent==='이어서 분석').click()`);
  await wait(s, `!!document.querySelector('.analysis-loading')`, 180000);
  assert.equal(await evaluate(s, `!!document.querySelector('.analysis-graph')`), false);
  await clickText(s, '분석 중지');
  await call('Page.reload', {}, s);
  await wait(s, `!!document.querySelector('.analysis-loading') || document.body.innerText.includes('승률 다시 분석')`);
  await evaluate(s, `location.hash='#/replay/ui-short'`);
  await wait(s, `document.querySelectorAll('.move-list .move-notation').length===2`);
  await sleep(400);
  assert.equal(await evaluate(s, `document.querySelectorAll('.move-list .move-notation').length`), 2);
  await navigate(long);
  await wait(s, `document.body.innerText.includes('승률 다시 분석') && !document.querySelector('progress')`, 180000);
  await evaluate(s, `document.querySelector('.analysis-graph').scrollIntoView({block:'center'})`);
  const middle = await evaluate(s, `(()=>{const r=document.querySelector('.analysis-graph').getBoundingClientRect(); return {x:r.left+r.width*(30+10/${long.moves.length}*318)/360,y:r.top+r.height/2};})()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: middle.x, y: middle.y, button: 'left', clickCount: 1 }, s);
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: middle.x, y: middle.y, button: 'left', clickCount: 1 }, s);
  assert.equal(await evaluate(s, `document.querySelector('.analysis-graph').getAttribute('aria-valuenow')`), '10');
  assert.equal(await evaluate(s, `!!document.querySelector('.win-footnote')`), false);
  assert.equal(await evaluate(s, `!!document.querySelector('.analysis-graph .win-proof')`), false);
  await checkGradePlacement(s);
  assert.equal(await evaluate(s, `!!document.querySelector('.board .tile-grade .grade-provisional')`), false);
  assert.equal(await evaluate(s, `document.querySelector('.move-review [data-review-status]').textContent`), '추정');
  assert.equal(await evaluate(s, `document.querySelector('.move-review .grade-reason').textContent.includes('점 손실')`), true);
  assert.equal(await evaluate(s, `document.querySelector('.move-evidence').open`), false);
  assert.equal(await evaluate(s, `document.body.innerText.includes('~')||document.body.innerText.includes('◇')`), false);
  assert.equal(await evaluate(s, `document.querySelectorAll('.analysis-graph .grade-event.provisional').length===document.querySelectorAll('.analysis-graph [data-provisional="true"]').length`), true);
  const longShot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, s);
  writeFileSync('tools/analysis/ui-win-long-mobile.png', Buffer.from(longShot.data, 'base64'));
  // A selected-move refinement may update its cache, but must not restore an old selection.
  await evaluate(s, `document.querySelector('[data-ply="10"]').click()`);
  await clickText(s, '추천 수 보기');
  await evaluate(s, `document.querySelector('[data-ply="11"]').click()`);
  await wait(s, `!document.body.innerText.includes('선택한 수를 분석하는 중')`);
  assert.equal(await evaluate(s, `!!document.querySelector('.line-review')`), false);
  assert.equal(await evaluate(s, `document.querySelector('.move-review .review-row strong').textContent`), '11수');
  assert.equal(await evaluate(s, `document.querySelector('.analysis-graph').getAttribute('aria-valuenow')`), '10');

  // 실패는 별도 미분석 입력으로 재현한다. 기존 완료 캐시는 그대로 유지된다.
  const failureScript = await call('Page.addScriptToEvaluateOnNewDocument', { source: `window.__nativeWorker=window.Worker; window.Worker=class extends window.__nativeWorker { postMessage(message) { super.postMessage({...message,base:new URL('/missing-analysis-assets/',location.href).href}); } };` }, s);
  await navigate(failed);
  await wait(s, `!!document.querySelector('[role="alert"]')`);
  await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: failureScript.identifier }, s);
  await evaluate(s, `window.Worker=window.__nativeWorker`);
  await evaluate(s, `Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='승률 분석'||e.textContent==='이어서 분석').click()`);
  await wait(s, `document.body.innerText.includes('승률 다시 분석') && !document.querySelector('progress')`);
  assert.equal(await evaluate(s, `document.body.innerText.includes('그래프는 마지막 보드의 형세')`), false);
  assert.equal(await evaluate(s, `document.querySelector('.win-number').textContent`), `1수 내 ${short.winner === 1 ? '승리' : '패배'}`);
  await navigate(timeout);
  await wait(s, `document.body.innerText.includes('승률 다시 분석')`);
  assert.equal(await evaluate(s, `document.querySelector('.win-number').textContent`), `1수 내 ${short.winner === 1 ? '승리' : '패배'}`);
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  await navigate(short);
  await wait(s, `!!document.querySelector('.game-wide') && !!document.querySelector('.analysis-graph')`);
  await checkGradePlacement(s);
  assert.equal(await evaluate(s, `document.documentElement.scrollWidth <= innerWidth + 1`), true);
  const desktopShot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, s);
  writeFileSync('tools/analysis/ui-win-desktop.png', Buffer.from(desktopShot.data, 'base64'));
  await navigate(terminalRecord);
  await wait(s, `document.body.innerText.includes('승률 다시 분석') && !!document.querySelector('.move-review')`);
  assert.equal(await evaluate(s, `document.querySelector('.move-review [data-review-status]').textContent`), '결과 확인');
  const terminalLoses = winner(terminalBoard, p.player) === p.player;
  assert.equal(await evaluate(s, `document.querySelector('.move-review .grade-reason').textContent`), terminalLoses ? '이길 수 있었지만 패배하는 수입니다.' : '승리를 지키는 수입니다.');
  assert.deepEqual(await evaluate(s, `[...document.querySelectorAll('.move-comparison dd')].map(e=>e.textContent)`), [terminalLoses ? '패배' : '승리', '승리']);
  await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: true }, s);
  for (const [lang, criteria] of [['en', 'Grade guide'], ['ja', '評価ガイド'], ['zh', '评级说明'], ['ko', '등급 안내']]) {
    await evaluate(s, `(()=>{const settings=JSON.parse(localStorage.getItem('gyeol:settings'));settings.lang=${JSON.stringify(lang)};localStorage.setItem('gyeol:settings',JSON.stringify(settings));})()`);
    await call('Page.reload', {}, s);
    await wait(s, `document.querySelector('.grade-guide summary')?.textContent===${JSON.stringify(criteria)} && !!document.querySelector('.move-review .grade-reason')`);
    await evaluate(s, `document.querySelector('.grade-guide summary').click()`);
    assert.equal(await evaluate(s, `document.documentElement.scrollWidth<=innerWidth+1`), true, lang);
    assert.equal(await evaluate(s, `window.__analysisWorkerCount`), 0, lang);
  }
  await navigate(invalid);
  await wait(s, `document.body.innerText.includes('기보의 수순 또는 규칙')`);
  assert.deepEqual(errors, []);
  const report = { passed: true, viewport: '390x900', cancelMs: Math.round(cancelMs), fullGraphVisibleMs, gradesVisibleMs, fullCompleteMs, timingNote: 'One Chrome run including new worker/session setup, assets cached from earlier cases; not p95 or cold network download. The graph and move grades stay hidden behind the loading screen until analysis completes.', runtimeErrors: errors,
    cases: ['loading screen hides intermediate results', 'all move grades visible outside collapsed details', 'seven colors and vector icons in light and dark themes', 'grade icon on recentered placed tile and preview', 'provisional state shared by card, list, board, and graph', 'one persistent worker for graph and move analysis', 'proven win/loss within N plies', 'grade and graph cache reload without a worker', 'grade-only invalidation preserves cached graph', 'grading rules accessible by touch and keyboard', 'solved reason and actual/best outcomes', 'actual and recommended lines with opponent replies', 'issue filter and graph keyboard/pointer navigation', 'deep mode', 'cancel and partial resume', 'record changes cancel old work', 'model failure and retry', 'resignation and timeout do not override board evaluation', 'invalid record rejected', 'mobile and expanded desktop layout', '320px Korean/English/Japanese/Chinese criteria and cards with no overflow or extra worker'] };
  Object.assign(report, { gradePalettes });
  report.cases.push('selected-move refinement does not restore a stale move selection', 'named solid grade badges have at least 4.5:1 text contrast in light and dark themes', 'selected move and recommendation precede graph and move list', 'no tilde or diamond markers', 'grade guide and estimated score details are collapsed by default');
  writeFileSync('tools/analysis/ui-win-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error('Analysis UI check failed:', error);
  throw error;
} finally {
  if (socket?.readyState === WebSocket.OPEN) { await call('Browser.close').catch(() => undefined); socket.close(); }
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), sleep(5000)]);
  if (child.exitCode === null) child.kill();
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep) && basename(dir).startsWith('gyeol-analysis-ui-'));
  try { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
  catch (error) { console.warn('Temporary Chrome profile is still locked:', dir, error); }
}
