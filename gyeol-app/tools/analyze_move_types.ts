// 모든 보관 기보(AI 대전 + 온라인 대국)의 수를 규칙만으로 계산한 특징으로 나눈다. 신경망 평가는 쓰지 않는다.
// 실행: node --experimental-sqlite --import tsx tools/analyze_move_types.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CELLS, DIRS, PASS, apply, bounds, canPlaceAt, colOf, decode, dirOf, idx, initial, isLegal, legal, owner, result, rowOf, tileCount, type Board, type Player } from '../packages/core/src/index';

interface Game { id: string; origin: 'ai' | 'online'; initial: Board; initialPlayer: Player; moves: number[] }
const games: Game[] = [];
const seen = new Set<string>();
const add = (g: Game) => { const key = JSON.stringify([g.initial, g.initialPlayer, g.moves]); if (!seen.has(key)) { seen.add(key); games.push(g); } };
const source = JSON.parse(readFileSync('tools/record-puzzles/source-games.json', 'utf8')) as { games: { id: string; source: string; initial: Board; initialPlayer: Player; moves: number[] }[] };
for (const g of source.games) add({ id: g.id, origin: g.source === 'online-record' ? 'online' : 'ai', initial: g.initial, initialPlayer: g.initialPlayer, moves: g.moves });
const dbPath = 'packages/server/data/gyeol.sqlite';
let dbGames = 0;
if (existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare("select id, initial_board_json b, initial_player p from games where status = 'finished'").all() as { id: string; b: string; p: number }[];
  const moves = db.prepare('select action from game_moves where game_id = ? order by ply');
  for (const row of rows) {
    const list = (moves.all(row.id) as { action: number }[]).map(m => m.action);
    if (list.length) { dbGames++; add({ id: `db-${row.id}`, origin: 'online', initial: JSON.parse(row.b), initialPlayer: row.p as Player, moves: list }); }
  }
  db.close();
}

/** 그 판에서 q가 한 수로 뒤집을 수 있는 최대 장수와, 뒤집히는 칸의 합집합. */
function captures(board: Board, q: Player) {
  let max = 0, moves = 0;
  const cells = new Set<number>();
  for (const a of legal(board, q)) {
    if (a === PASS) break;
    const next = apply(board, q, a);
    const n = next.last.flipped!.length;
    if (!n) continue;
    moves++; max = Math.max(max, n);
    const [dr, dc] = next.last.shift;
    for (const [r, c] of next.last.flipped!) cells.add(idx(r - dr, c - dc));
  }
  return { max, moves, cells };
}

interface Row {
  origin: 'ai' | 'online'; tiles: number; winnerMove: boolean | null;
  flips: number; bestFlips: number; threatBefore: number; threatAfter: number; follow: number;
  placedAtRisk: boolean; gainAtRisk: boolean; forcesPass: boolean; ends: boolean;
  expands: boolean; neighbours: number; rotatedFaces: 'placed' | 'own' | 'opponent' | 'open' | 'dead';
  options: number;
}
const rows: Row[] = [];
let passes = 0, invalid = 0;
for (const game of games) {
  let board = game.initial ?? initial(), player = game.initialPlayer ?? 1;
  const trail: { board: Board; player: Player; action: number }[] = [];
  let ok = true;
  for (const action of game.moves) {
    if (result(board, player) || !isLegal(board, player, action)) { ok = false; break; }
    trail.push({ board, player, action });
    board = apply(board, player, action).board; player = -player as Player;
  }
  if (!ok) { invalid++; continue; }
  const end = result(board, player);
  const winner = !end ? null : Math.abs(end) < 0.5 ? 0 : Math.sign(end) * player;
  for (const { board: b, player: p, action } of trail) {
    if (action === PASS) { passes++; continue; }
    const m = decode(action)!, opp = -p as Player;
    const next = apply(b, p, action);
    const [dr, dc] = next.last.shift;
    const placed = idx(m.pr, m.pc);
    const flippedCells = next.last.flipped!.map(([r, c]) => idx(r - dr, c - dc));
    // 위협은 중앙 정렬 전 좌표로 비교하기 위해 정렬하지 않은 판에서 계산한다.
    const raw = b.slice();
    raw[idx(m.r, m.c)] = opp * (m.newDir + 1); raw[placed] = p * (m.placeDir + 1);
    for (const cell of flippedCells) raw[cell] = -raw[cell];
    const mine = captures(b, p), before = captures(b, opp), after = captures(raw, opp), follow = captures(raw, p);
    const [r0, r1, c0, c1] = bounds(b), [n0, n1, m0, m1] = bounds(raw);
    const tr = m.r + DIRS[m.newDir][0], tc = m.c + DIRS[m.newDir][1];
    const target = tr < 0 || tr > 6 || tc < 0 || tc > 6 ? null : raw[idx(tr, tc)];
    rows.push({
      origin: game.origin, tiles: tileCount(b), winnerMove: winner === null || winner === 0 ? null : winner === p,
      flips: flippedCells.length, bestFlips: mine.max, threatBefore: before.max, threatAfter: after.max, follow: follow.max,
      placedAtRisk: after.cells.has(placed), gainAtRisk: flippedCells.some(cell => after.cells.has(cell)),
      forcesPass: legal(next.board, opp)[0] === PASS && !result(next.board, opp), ends: !!result(next.board, opp),
      expands: (n1 - n0 + 1) * (m1 - m0 + 1) > (r1 - r0 + 1) * (c1 - c0 + 1),
      neighbours: DIRS.filter(([y, x]) => { const r = m.pr + y, c = m.pc + x; return r >= 0 && r < 7 && c >= 0 && c < 7 && raw[idx(r, c)] !== 0; }).length,
      rotatedFaces: tr === m.pr && tc === m.pc ? 'placed' : target === null || target === 0 ? (target === 0 && canPlaceAt(raw, tr, tc) ? 'open' : 'dead')
        : owner(target) === owner(raw[idx(m.r, m.c)]) ? (owner(raw[idx(m.r, m.c)]) === p ? 'own' : 'opponent') : (owner(target) === p ? 'own' : 'opponent'),
      options: legal(b, p).length,
    });
  }
}

/** 한 수의 종류: 무엇을 했는가(행동) × 그 뒤 어떻게 되는가(결과). */
const act = (r: Row) => r.flips >= 3 ? 'chain3' : r.flips === 2 ? 'chain2' : r.flips === 1 ? 'single'
  : r.bestFlips > 0 ? 'declined' : 'quiet';
const aftermath = (r: Row) => r.ends ? 'final' : r.forcesPass ? 'lockout'
  : r.threatAfter === 0 ? 'safe' : r.threatAfter > r.flips ? 'outtraded' : r.gainAtRisk || r.placedAtRisk ? 'retakable' : 'elsewhere';
const quietPurpose = (r: Row) => r.threatBefore > 0 && r.threatAfter < r.threatBefore ? (r.follow > 0 ? 'defend+threat' : 'defend')
  : r.threatAfter > r.threatBefore ? (r.follow > 0 ? 'threat-but-loosens' : 'loosens')
  : r.follow > 0 ? 'threat' : 'positional';

function table<K extends string>(key: (r: Row) => K, list = rows) {
  const out: Record<string, { n: number; share: number; winnerShare: number | null; meanTiles: number; ai: number; online: number }> = {};
  const groups = new Map<string, Row[]>();
  for (const r of list) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  for (const [k, g] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const decided = g.filter(r => r.winnerMove !== null);
    out[k] = {
      n: g.length, share: +(g.length / list.length * 100).toFixed(1),
      winnerShare: decided.length ? +(decided.filter(r => r.winnerMove).length / decided.length * 100).toFixed(1) : null,
      meanTiles: +(g.reduce((n, r) => n + r.tiles, 0) / g.length).toFixed(1),
      ai: g.filter(r => r.origin === 'ai').length, online: g.filter(r => r.origin === 'online').length,
    };
  }
  return out;
}
const phase = (r: Row) => r.tiles <= 9 ? 'opening' : r.tiles <= 17 ? 'middle' : 'end';
const quiet = rows.filter(r => r.flips === 0);
const decided = rows.filter(r => r.winnerMove !== null);
const report = {
  date: new Date().toISOString(),
  games: { total: games.length, ai: games.filter(g => g.origin === 'ai').length, online: games.filter(g => g.origin === 'online').length, fromDatabase: dbGames, invalid },
  moves: { total: rows.length, passes, baselineWinnerShare: +(decided.filter(r => r.winnerMove).length / decided.length * 100).toFixed(1) },
  act: table(act), aftermath: table(aftermath), actByAftermath: table(r => `${act(r)} / ${aftermath(r)}`),
  quietPurpose: table(quietPurpose, quiet), quietRotation: table(r => r.rotatedFaces, quiet),
  captureRotation: table(r => r.rotatedFaces, rows.filter(r => r.flips > 0)),
  greedy: table(r => r.bestFlips === 0 ? 'no capture available' : r.flips === r.bestFlips ? 'took the largest' : r.flips > 0 ? 'took a smaller one' : 'declined'),
  shape: table(r => `${r.expands ? 'expands' : 'fills'} / contact ${Math.min(3, r.neighbours)}${r.neighbours >= 3 ? '+' : ''}`),
  byPhase: Object.fromEntries(['opening', 'middle', 'end'].map(p => [p, table(act, rows.filter(r => phase(r) === p))])),
  byOrigin: Object.fromEntries(['ai', 'online'].map(o => [o, { act: table(act, rows.filter(r => r.origin === o)), aftermath: table(aftermath, rows.filter(r => r.origin === o)) }])),
  exposure: table(r => r.threatAfter === 0 ? 'opponent cannot capture' : r.threatAfter <= r.threatBefore ? 'threat not increased' : 'threat increased'),
  options: { mean: +(rows.reduce((n, r) => n + r.options, 0) / rows.length).toFixed(1) },
};
const b3 = (n: number) => n >= 3 ? '3+' : String(n);
Object.assign(report, {
  captureExchange: table(r => `took ${b3(r.flips)} / reply ${b3(r.threatAfter)}`, rows.filter(r => r.flips > 0 && !r.ends && !r.forcesPass)),
  nonCapture: table(r => `${r.bestFlips ? 'declined ' + b3(r.bestFlips) : 'none available'} / reply ${b3(r.threatAfter)} / follow ${b3(r.follow)}`, rows.filter(r => r.flips === 0 && !r.ends && !r.forcesPass)),
  nonCaptureThreatChange: table(r => `${r.bestFlips ? 'declined' : 'none'} / threat ${r.threatAfter < r.threatBefore ? 'down' : r.threatAfter > r.threatBefore ? 'up' : 'same'} (${r.rotatedFaces})`, rows.filter(r => r.flips === 0 && !r.ends && !r.forcesPass)),
});
/** 최종 구분: 내가 얻은 것(flips), 상대에게 남긴 것(threatAfter), 내가 쥐고 있는 것(follow)의 크기 비교. */
const kind = (r: Row) => r.ends ? '1 finish' : r.forcesPass ? '2 lockout'
  : r.flips > 0 ? (r.threatAfter === 0 ? '3 clean capture' : r.flips >= 2 && r.threatAfter < r.flips ? '4 big capture' : r.threatAfter === r.flips ? '5 even trade' : r.threatAfter > r.flips ? '6 losing capture' : '4 big capture')
  : r.threatAfter === 0 ? '7 seal' : r.follow >= 2 && r.threatAfter < r.follow ? '8 loaded wait' : r.follow >= r.threatAfter ? '9 balanced wait' : '10 loose';
const sorted = (t: ReturnType<typeof table>) => Object.fromEntries(Object.entries(t).sort((a, b) => parseInt(a[0]) - parseInt(b[0])));
Object.assign(report, {
  kinds: sorted(table(kind)),
  kindsByPhase: Object.fromEntries(['opening', 'middle', 'end'].map(p => [p, sorted(table(kind, rows.filter(r => phase(r) === p)))])),
  kindsByOrigin: Object.fromEntries(['ai', 'online'].map(o => [o, sorted(table(kind, rows.filter(r => r.origin === o)))])),
  kindsDeclined: sorted(table(r => `${kind(r)}${r.flips === 0 && r.bestFlips > 0 ? ' (declined a capture)' : ''}`, rows.filter(r => r.flips === 0))),
  waitRotation: table(r => `${kind(r)} / ${r.rotatedFaces}`, rows.filter(r => r.flips === 0 && !r.ends && !r.forcesPass)),
});
/** 앱에 적용한 세 가지 평가 타입과 같은 기준. */
const evaluationType = (r: Row) => r.flips >= 1 && r.threatAfter < r.flips ? 'attack (!)'
  : r.threatBefore > 0 && r.threatAfter < r.threatBefore ? 'defense'
  : r.threatAfter > r.threatBefore && r.threatAfter > r.flips ? 'gift (?)' : 'none';
Object.assign(report, {
  evaluationTypes: table(evaluationType),
  evaluationTypesByPhase: Object.fromEntries(['opening', 'middle', 'end'].map(p => [p, table(evaluationType, rows.filter(r => phase(r) === p))])),
  evaluationTypesByOrigin: Object.fromEntries(['ai', 'online'].map(o => [o, table(evaluationType, rows.filter(r => r.origin === o))])),
  evaluationVariants: {
    giftLoose: table(r => r.threatAfter > Math.max(r.flips, r.follow) ? 'gift' : 'x'),
    defenseSeal: table(r => r.threatBefore > 0 && r.threatAfter === 0 ? 'seal' : 'x'),
    defenseAny: table(r => r.threatBefore > 0 && r.threatAfter < r.threatBefore ? 'down' : 'x'),
  },
});
mkdirSync('tools/analysis/move-types', { recursive: true });
writeFileSync('tools/analysis/move-types/report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1));
void CELLS; void colOf; void rowOf; void dirOf;
