import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { PASS, apply, canonical, initial, legal, type RecordPuzzleData } from '@gyeol/core';
import { analyzeGameGrades, analyzeWinProbability, gradeMove, replayAnalysis, type GameAnalysis, type Predict } from '../src';

const puzzles = JSON.parse(readFileSync(new URL('../../../tools/record-puzzles/verified.json', import.meta.url), 'utf8')) as RecordPuzzleData[];
const uniform: Predict = async board => ({ value: 0, priors: legal(board, 1).map(() => 1) });

test('all moves appear incrementally with a fixed one-evaluation-per-candidate budget', async () => {
  const a = legal(initial(), 1)[0];
  const b = legal(apply(initial(), 1, a).board, -1)[0];
  const positions = replayAnalysis([a, b]);
  let calls = 0;
  const progress: GameAnalysis[] = [];
  // 짧은 추가 탐색을 끄면 후보마다 신경망 1회만 평가한다.
  const analysis = await analyzeGameGrades([a, b], async board => { calls++; return uniform(board); }, { onProgress: a => progress.push(a), focusSims: 0 });
  expect(calls).toBe(legal(positions[0].board, 1).length + legal(positions[1].board, -1).length + 1);
  expect(progress[0].moves.map(Boolean)).toEqual([true, false]);
  expect(progress[1].moves.map(Boolean)).toEqual([true, true]);
  expect(analysis.complete).toBe(true);
  expect(analysis.moves.every(m => m && m.status === 'estimated' && m.grade === null && gradeMove(m.lossPp) === 'best')).toBe(true);
  let resumedCalls = 0;
  expect(await analyzeGameGrades([a, b], async board => { resumedCalls++; return uniform(board); }, { resume: analysis, focusSims: 0 })).toEqual(analysis);
  expect(resumedCalls).toBe(0);
});

test('candidate values use the mover perspective, and swapped colors keep grades unchanged', async () => {
  const board = initial(), actions = legal(board, 1), played = actions[0];
  const targets = actions.map(a => canonical(apply(board, 1, a).board, -1).join(','));
  const predict: Predict = async b => ({ priors: legal(b, 1).map(() => 1), value: targets.indexOf(b.join(',')) === 0 ? 0.8 : -0.8 });
  // 신경망 1회 평가 단계의 관점만 확인한다(짧은 추가 탐색은 끈다).
  const a = await analyzeGameGrades([played], predict, { focusSims: 0 });
  const b = await analyzeGameGrades([played], predict, { start: { board: board.map(v => -v), player: -1 }, focusSims: 0 });
  expect(a.moves[0]!.candidates.find(c => c.action === played)!.value).toBe(-0.8);
  expect(a.moves[0]!.lossPp).toBe(80);
  expect(gradeMove(a.moves[0]!.lossPp)).toBe('blunder');
  expect(b.moves[0]!.lossPp).toBe(a.moves[0]!.lossPp);
  expect(a.positions[0]!.green + b.positions[0]!.green).toBeCloseTo(1);
});

test('solved missed wins and forced passes remain distinct from provisional grades', async () => {
  const p = puzzles.find(p => p.board.filter(Boolean).length === 23 && p.proof[0][1].some(([, v]) => v < 0))!;
  const played = p.proof[0][1].find(([, v]) => v < 0)![0];
  const a = await analyzeGameGrades([played], uniform, { start: p, exactMs: 1000 });
  expect(a.moves[0]!.grade).toBe('blunder');
  expect(a.moves[0]!.badges).toContain('missedWin');
  const [key] = puzzles.flatMap(p => p.proof).find(([, values]) => values.length === 1 && values[0][0] === PASS)!;
  const pass = await analyzeGameGrades([PASS], uniform, { start: { board: [...key].map(v => Number(v) - 5), player: 1 }, exactMs: 1000 });
  expect(pass.moves[0]!.forced).toBe(true);
  expect(pass.moves[0]!.grade).toBeNull();
  expect(pass.moves[0]!.badges).toEqual([]);
});

test('cancellation and invalid predictions propagate, rather than producing fake grades', async () => {
  const played = legal(initial(), 1)[0];
  await expect(analyzeGameGrades([played], uniform, { checkpoint: async () => { throw new Error('cancel'); } })).rejects.toThrow('cancel');
  await expect(analyzeGameGrades([played], async () => ({ value: NaN, priors: [] }))).rejects.toThrow('Invalid AI value');
  await expect(analyzeGameGrades([PASS], uniform)).rejects.toThrow('Invalid game record');
});

test('all grades can be shown after the full preview and before expensive graph search', async () => {
  const played = legal(initial(), 1)[0];
  let grades: GameAnalysis | undefined;
  let previewReady = false, searchStarted = false, hookCalled = false;
  await analyzeWinProbability([played], uniform, {
    onProgress: graph => {
      if (graph.positions.every(Boolean)) previewReady = true;
      if (graph.positions.some(p => p?.source === 'search')) {
        searchStarted = true;
        expect(grades?.moves.every(Boolean)).toBe(true);
      }
    },
    onPreview: async () => {
      hookCalled = true;
      expect(previewReady).toBe(true);
      expect(searchStarted).toBe(false);
      grades = await analyzeGameGrades([played], uniform);
    },
  });
  expect(hookCalled && searchStarted).toBe(true);
});

test('deep mode publishes all provisional grades before refinement, without marking the job complete', async () => {
  const played = legal(initial(), 1)[0];
  const preview = await analyzeGameGrades([played], uniform, { mode: 'deep', fastOnly: true });
  expect(preview.moves.every(Boolean)).toBe(true);
  expect(preview.complete).toBe(false);
  expect(preview.moves[0]!.candidates.every(c => c.simulations === 0)).toBe(true);
  const refined = await analyzeGameGrades([played], uniform, { mode: 'deep', resume: preview, baseSims: 1 });
  expect(refined.complete).toBe(true);
  expect(refined.moves[0]!.candidates.some(c => c.simulations > 0)).toBe(true);
});

test('automatic and resumed grades keep a sole improving move best in either color', async () => {
  const board = initial(), played = legal(board, 1)[0];
  const target = canonical(apply(board, 1, played).board, -1).join(',');
  const predict: Predict = async b => ({ priors: legal(b, 1).map(() => 1), value: b.join(',') === target ? -0.4 : 0 });
  for (const player of [1, -1] as const) {
    const a = await analyzeGameGrades([played], predict, { start: { board: board.map(v => v * player), player } });
    const move = a.moves[0]!;
    expect(move.provisionalGrade).toBe('best');
    expect(move.lossPoints).toBe(0);
    expect(move.reasonCode).toBe('loss');
    expect(move).not.toHaveProperty('baselineValue');
    expect(await analyzeGameGrades([played], predict, { start: { board: board.map(v => v * player), player }, resume: a })).toEqual(a);
  }
});

test('every verified late-game candidate agrees with the independent stored proof and outcome grade', async () => {
  const late = puzzles.filter(p => p.board.filter(Boolean).length >= 22);
  expect(late.length).toBeGreaterThan(100);
  for (const p of late) {
    const proof = p.proof[0][1];
    const played = proof.find(([, margin]) => margin < 0)?.[0] ?? proof[0][0];
    const analysis = await analyzeGameGrades([played], uniform, { start: p, exactMs: 10000, exactNodes: 1_000_000 });
    const move = analysis.moves[0]!;
    expect(move.status, p.id).toBe('exact');
    expect(move.candidates.map(c => [c.action, c.margin]), p.id).toEqual(proof);
    const best = Math.max(...proof.map(([, margin]) => Math.sign(margin)));
    const actual = Math.sign(proof.find(([a]) => a === played)![1]);
    expect(move.grade, p.id).toBe(move.forced ? null : best === actual ? 'best' : best === 1 && actual === -1 ? 'blunder' : 'mistake');
  }
});

test('endgame grades are solved from the last move backward, so a hard early endgame cannot starve easy late ones', async () => {
  // 최강 AI끼리 둔 실제 대국. 19수부터 남은 타일이 5장 이하다.
  const moves = [389, 368, 392, 378, 390, 408, 301, 289, 310, 298, 414, 426, 542, 538, 358, 478, 647, 624, 589, 631, 515, 496, 784, 465];
  // 이 노드 예산으로는 19·20수를 풀 수 없다. 앞에서부터 풀면 거기서 예산이 끝나 21~23수까지 추정으로 남았다.
  const a = await analyzeGameGrades(moves, uniform, { exactMs: 100_000, exactNodes: 3000 });
  expect(a.moves.slice(20, 24).map(m => m!.status)).toEqual(['exact', 'exact', 'exact', 'exact']);
  expect(a.moves.slice(18, 20).map(m => m!.status)).toEqual(['estimated', 'estimated']);
  // 승부가 정해진 뒤의 수는 손실 없이 결과를 그대로 말한다: 흰색은 승리 유지, 진갈색은 어떻게 둬도 패배.
  expect(a.moves[20]).toMatchObject({ reasonCode: 'allLose', lossPoints: 0 });
  expect(a.moves[21]).toMatchObject({ reasonCode: 'preservedWin', lossPoints: 0 });
  // 기본 예산이면 남은 타일 5장 이하의 수(19~24수)를 모두 정확히 푼다.
  const full = await analyzeGameGrades(moves, uniform, { exactMs: 100_000 });
  expect(full.moves.slice(18).every(m => m!.status === 'exact')).toBe(true);
});

test('standard grades read the top three candidates and the played move a little deeper', async () => {
  const board = initial(), actions = legal(board, 1);
  // 정책이 고르지 않은 수를 두어도 실제 수는 반드시 더 읽는다.
  const played = actions[actions.length - 1];
  const a = await analyzeGameGrades([played], uniform);
  const read = a.moves[0]!.candidates.filter(c => c.simulations > 0);
  expect(read.length).toBeGreaterThanOrEqual(4); expect(read.length).toBeLessThan(actions.length);
  expect(read.every(c => c.simulations === 16 && c.shallow !== undefined)).toBe(true);
  expect(read.some(c => c.action === played)).toBe(true);
  // 정밀 분석의 첫 단계는 예전처럼 신경망 1회 평가만 한다.
  const fast = await analyzeGameGrades([played], uniform, { mode: 'deep', fastOnly: true });
  expect(fast.moves[0]!.candidates.every(c => c.simulations === 0)).toBe(true);
});
