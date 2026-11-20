// 공격(!)으로 표시된 수 직후 승률 그래프가 둔 사람에게 불리하게 움직이는 경우를 실제 기보로 잰다.
// 실행: node --import tsx tools/audit_attack_swing.ts [판 수]
import { readFileSync, writeFileSync } from 'node:fs';
import { analyzeWinProbability } from '../packages/ai/src/index';
import { apply, margin, moveType, type Board, type Player } from '../packages/core/src/index';
import { replayAnalysis } from '../packages/ai/src/analysis';
import { loadBrainContext } from '../packages/server/src/brain';

const count = Number(process.argv[2] ?? 24);
const source = JSON.parse(readFileSync('tools/record-puzzles/source-games.json', 'utf8')) as { games: { id: string; moves: number[]; initial: Board; initialPlayer: Player }[] };
const unique = [...new Map(source.games.map(g => [JSON.stringify([g.initial, g.initialPlayer, g.moves]), g])).values()];
const games = Array.from({ length: Math.min(count, unique.length) }, (_, i) => unique[Math.floor(i * unique.length / Math.min(count, unique.length))]);
const brain = await loadBrainContext('apps/web/public', 4000);
const rows: any[] = [];
for (const game of games) {
  brain.clearCache();
  const start = { board: game.initial, player: game.initialPlayer };
  const graph = await analyzeWinProbability(game.moves, brain.predict, { start });
  const positions = replayAnalysis(game.moves, start);
  for (let i = 0; i < game.moves.length; i++) {
    const { board, player } = positions[i], action = game.moves[i];
    const info = moveType(board, player, action);
    const before = graph.positions[i], after = graph.positions[i + 1];
    if (!before || !after) continue;
    const mine = (p: { green: number }) => player === 1 ? p.green : 1 - p.green;
    const next = positions[i + 1];
    const reply = i + 1 < game.moves.length ? apply(next.board, next.player, game.moves[i + 1]).last.flipped?.length ?? 0 : null;
    rows.push({
      id: game.id, ply: i + 1, player, type: info.type, flips: info.flips, threatBefore: info.threatBefore, threatAfter: info.threatAfter,
      reply, tiles: board.filter(Boolean).length,
      marginChange: (margin(next.board) - margin(board)) * player,
      before: +mine(before).toFixed(3), after: +mine(after).toFixed(3), swing: +(mine(after) - mine(before)).toFixed(3),
      beforeSource: before.source, afterSource: after.source,
    });
  }
  console.log(JSON.stringify({ done: games.indexOf(game) + 1, of: games.length, id: game.id }));
}
await brain.dispose();
const by = (type: string | null) => rows.filter(r => r.type === type);
const summary = (list: any[]) => {
  const swings = list.map(r => r.swing).sort((a, b) => a - b);
  const q = (f: number) => swings.length ? swings[Math.min(swings.length - 1, Math.floor(f * swings.length))] : null;
  return { n: list.length, median: q(0.5), p10: q(0.1), dropOver10: list.filter(r => r.swing <= -0.1).length, dropOver25: list.filter(r => r.swing <= -0.25).length, rise: list.filter(r => r.swing > 0).length };
};
const report = {
  date: new Date().toISOString(), games: games.length, moves: rows.length,
  byType: Object.fromEntries(['attack', 'defense', 'gift', null].map(t => [String(t), summary(by(t))])),
  attackDrops: by('attack').filter(r => r.swing <= -0.1).sort((a, b) => a.swing - b.swing),
  rows,
};
writeFileSync('tools/analysis/attack-swing/report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ byType: report.byType }, null, 1));
