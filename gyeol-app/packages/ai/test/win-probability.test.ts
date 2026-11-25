import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { ExactEndgame, PASS, apply, canonical, initial, legal, result, tileCount, type Player, type RecordPuzzleData } from '@gyeol/core';
import { analyzeWinProbability, emptyWinAnalysis, expectedMargin, MARGIN_PER_VALUE, smoothWinCurve, WIN_PROOF_REMAINING, calibratedProbability, fitProbability, probabilityMetrics, search, type CalibrationSample, type Predict, type ProbabilityCalibration, type WinAnalysis } from '../src';

const uniform: Predict = async board => ({ priors: legal(board, 1).map(() => 1), value: 0.2 });
const start = { board: initial(), player: 1 as Player };
const action = legal(start.board, start.player)[0];
const puzzles = JSON.parse(readFileSync(new URL('../../../tools/record-puzzles/verified.json', import.meta.url), 'utf8')) as RecordPuzzleData[];

describe('실제 국면의 승률 분석', () => {
  test('실제 국면마다 64회만 탐색하고 전체 미리보기를 먼저 제공한다', async () => {
    const frames: WinAnalysis[] = [];
    const graph = await analyzeWinProbability([action], uniform, { exactMs: 0, onProgress: a => frames.push(a) });
    expect(graph.positions).toHaveLength(2);
    expect(graph.metrics.evaluations).toBe(2);
    expect(graph.metrics.simulations).toBe(128);
    expect(graph.complete).toBe(true);
    const preview = frames.find(a => a.positions.every(Boolean) && a.positions.every(p => p?.source === 'network'));
    expect(preview).toBeTruthy(); expect(preview!.metrics.simulations).toBe(0);
    expect(graph.positions.every(p => p?.simulations === 64)).toBe(true);
    expect('moves' in graph).toBe(false);
  });

  test('가벼운 반환 경로는 평가를 바꾸지 않고 PV 생성을 생략한다', async () => {
    const full = await search(initial(), 64, uniform, { random: () => 0 });
    const light = await search(initial(), 64, uniform, { random: () => 0, details: 'none' });
    expect(light.action).toBe(full.action); expect(light.value).toBe(full.value); expect(light.meanValue).toBe(full.meanValue);
    expect(light.visits).toEqual(full.visits); expect(light.candidates).toEqual([]);
  });

  test('그래프에 자식 최대값 대신 해당 국면의 루트 평가를 사용한다', async () => {
    expect(emptyWinAnalysis([]).input).toBe(emptyWinAnalysis([], { start }).input);
    const graph = await analyzeWinProbability([], uniform, { exactMs: 0 });
    const root = await search(canonical(start.board, start.player), 64, uniform, { random: () => 0, details: 'none' });
    expect(graph.positions[0]!.green).toBe((root.meanValue + 1) / 2);
    expect(graph.metrics.simulations).toBe(64);
  });

  test('후반의 최선 대응 결과는 독립된 정확 결과로 구분한다', async () => {
    const p = puzzles.find(p => tileCount(p.board) === 23)!;
    const graph = await analyzeWinProbability([p.source.playedMove], uniform, { start: p, exactMs: 10000 });
    const value = new ExactEndgame().value(p.board, p.player);
    expect(graph.positions[0]!.source).toBe('proven');
    expect(graph.positions[0]!.provenOutcome).toBe(Math.sign(value) * p.player);
    expect(graph.positions[0]!.calibrated).toBe(false);
    expect(graph.positions[0]!.winDistanceKind).toBe('exact');
    expect(graph.positions[0]!.forcedWinPlies).toBeLessThanOrEqual(25 - tileCount(p.board));
    expect(graph.metrics.simulations).toBe(0);
  });

  test('수 계산 예산이 끝나도 승리 증명과 안전한 수 상한을 유지한다', async () => {
    const p = puzzles.find(p => tileCount(p.board) === 23)!;
    const distance = vi.spyOn(ExactEndgame.prototype, 'winDistanceAsync').mockRejectedValue(new Error('Graph exact budget'));
    try {
      const graph = await analyzeWinProbability([], uniform, { start: p, exactMs: 10000 });
      expect(graph.positions[0]!.status).toBe('exact');
      expect(graph.positions[0]!.winDistanceKind).toBe('upper-bound');
      expect(graph.positions[0]!.forcedWinPlies).toBe(2);
      expect(graph.metrics.simulations).toBe(0);
    } finally { distance.mockRestore(); }
  });

  test('남은 타일 7장 국면도 승패를 증명하고, 증명 범위 밖은 탐색 추정으로 둔다', async () => {
    const solver = new ExactEndgame();
    // 초기판에서 결정적으로 수를 골라 원하는 남은 타일 수의 진행 중 국면을 만든다.
    const findAt = (remaining: number) => {
      for (let seed = 0; seed < 50; seed++) {
        let board = initial(), player = 1 as Player, k = seed;
        while (25 - tileCount(board) > remaining && !result(board, player)) {
          const moves = legal(board, player);
          board = apply(board, player, moves[(k = (k * 7 + 3) % 9973) % moves.length]).board; player = -player as Player;
        }
        if (25 - tileCount(board) === remaining && !result(board, player)) return { board, player };
      }
      return null;
    };
    for (const remaining of [6, 7]) {
      const p = findAt(remaining);
      expect(p).not.toBeNull();
      const graph = await analyzeWinProbability([], uniform, { start: p!, exactMs: 10000 });
      expect(graph.positions[0]!.source).toBe('proven');
      expect(graph.positions[0]!.green).toBe((1 + Math.sign(solver.value(p!.board, p!.player)) * p!.player) / 2);
    }
    const beyond = findAt(WIN_PROOF_REMAINING + 1);
    if (beyond) expect((await analyzeWinProbability([], uniform, { start: beyond, exactMs: 10000 })).positions[0]!.source).toBe('search');
  });

  test('승패만 찾는 증명은 타일 차이 전체 탐색과 같은 승패를 더 적은 노드로 낸다', async () => {
    for (const p of puzzles.filter(p => 25 - tileCount(p.board) <= 6).slice(0, 12)) {
      const full = new ExactEndgame(), quick = new ExactEndgame();
      const margin = full.value(p.board, p.player);
      expect(await quick.outcomeAsync(p.board, p.player, async () => {})).toBe(Math.sign(margin));
      expect(quick.nodes).toBeLessThanOrEqual(full.nodes);
    }
  });

  test('시간 제한이 소진되면 증명 완료로 표시하지 않는다', async () => {
    const p = puzzles.find(p => tileCount(p.board) === 23)!;
    const graph = await analyzeWinProbability([], uniform, { start: p, exactMs: 0 });
    expect(graph.positions[0]!.status).toBe('estimated');
    expect(graph.positions[0]!.source).toBe('search');
    expect(graph.positions[0]!.forcedWinPlies).toBeUndefined();
  });

  test('부분 재개는 완료한 국면 탐색을 다시 계산하지 않는다', async () => {
    let partial: WinAnalysis | undefined;
    await expect(analyzeWinProbability([action], uniform, {
      exactMs: 0, model: 'model-a', onProgress: a => { if (a.metrics.simulations >= 64) partial = a; },
      checkpoint: async () => { if (partial) throw new Error('cancel'); },
    })).rejects.toThrow('cancel');
    const resumed = await analyzeWinProbability([action], uniform, { resume: partial, model: 'model-a', exactMs: 0 });
    expect(resumed.metrics.simulations).toBe(128); expect(resumed.metrics.evaluations).toBe(2);
    expect(resumed.positions[0]).toEqual(partial!.positions[0]);
    const changedModel = await analyzeWinProbability([action], uniform, { resume: partial, model: 'model-b', exactMs: 0 });
    expect(changedModel.metrics.simulations).toBe(128); expect(changedModel.model).toBe('model-b');
  });

  test('색 반전은 승률 관점만 반전한다', async () => {
    const a = await analyzeWinProbability([action], uniform, { start, exactMs: 0 });
    const b = await analyzeWinProbability([action], uniform, { start: { board: start.board.map(v => -v), player: -1 }, exactMs: 0 });
    a.positions.forEach((point, i) => expect(point!.green + b.positions[i]!.green).toBeCloseTo(1));
  });

  test('보정은 검증 상태·모델·예산·읽기 규칙이 모두 맞아야 적용한다', async () => {
    const calibration: ProbabilityCalibration = { version: 'test', model: 'test-model', rule: 'facing-25-v1', evaluator: 'root-mean', simulations: 64, reference: 'reference', accepted: true, coefficients: [0.5, 0, 0], validationGames: 200, remainingRange: [4, 23] };
    const accepted = await analyzeWinProbability([], uniform, { exactMs: 0, model: 'test-model', calibrations: [calibration] });
    expect(accepted.positions[0]!.calibrated).toBe(true);
    for (const change of [{ accepted: false }, { model: 'other' }, { simulations: 128 }, { evaluator: 'root-q' as const }, { remainingRange: [4, 22] as [number, number] }]) {
      const rejected = await analyzeWinProbability([], uniform, { exactMs: 0, model: 'test-model', calibrations: [{ ...calibration, ...change }] });
      expect(rejected.positions[0]!.calibrated).toBe(false);
    }
  });

  test('표준 25장 규칙의 빈자리에서는 최소 한 쪽에 합법 배치가 있다', () => {
    for (let height = 1; height <= 5; height++) for (let width = 1; width <= 5; width++) {
      const board = Array(49).fill(0);
      for (let r = 1; r <= height; r++) for (let c = 1; c <= width; c++) board[r * 7 + c] = (r + c) % 2 ? 2 : -4;
      if (height * width < 25) {
        expect(legal(board, 1)[0] !== PASS || legal(board, -1)[0] !== PASS).toBe(true);
        expect(result(board, 1)).toBe(0);
      }
    }
    const full = Array(49).fill(0);
    for (let r = 1; r <= 5; r++) for (let c = 1; c <= 5; c++) full[r * 7 + c] = (r + c) % 2 ? 1 : -1;
    for (let r = 1; r <= 5; r++) for (let c = 1; c <= 5; c++) {
      const hole = full.slice(); hole[r * 7 + c] = 0;
      expect(legal(hole, 1)[0] !== PASS || legal(hole, -1)[0] !== PASS).toBe(true);
    }
    expect(Math.abs(result(full, 1))).toBe(1);
  });

  test('종국과 불법 기보는 신경망 평가와 분리한다', async () => {
    const ended = Array(49).fill(0);
    const graph = await analyzeWinProbability([], async () => { throw new Error('unexpected network'); }, { start: { board: ended, player: 1 } });
    expect(graph.positions[0]!.green).toBe(0.5); expect(graph.positions[0]!.source).toBe('terminal');
    await expect(analyzeWinProbability([PASS], uniform)).rejects.toThrow('Invalid game record');
    expect(apply(initial(), 1, action).board).not.toEqual(initial());
  });
});

describe('화면용 승률 곡선', () => {
  const e = (green: number) => ({ green, status: 'estimated' as const });
  const x = (green: number) => ({ green, status: 'exact' as const });

  test('둘 차례에 따라 번갈아 치우친 추정을 상쇄한다', () => {
    // 실제 흐름은 0.4로 일정하고, 둘 차례에 따라 ±0.1씩 번갈아 어긋난 추정
    const curve = smoothWinCurve([0.3, 0.5, 0.3, 0.5, 0.3, 0.5].map(e));
    curve.slice(1, -1).forEach(p => expect(p!.green).toBeCloseTo(0.4));
    // 끝점은 이웃 하나와 평균낸다
    expect(curve[0]!.green).toBeCloseTo(0.4); expect(curve[5]!.green).toBeCloseTo(0.4);
  });

  test('꾸준한 흐름과 증명된 점은 바꾸지 않는다', () => {
    const steady = [0.6, 0.5, 0.4, 0.3].map(e);
    smoothWinCurve(steady).slice(1, -1).forEach((p, i) => expect(p!.green).toBeCloseTo(steady[i + 1].green));
    const mixed = smoothWinCurve([e(0.3), e(0.5), x(0), x(0), null, e(0.7)]);
    expect(mixed[1]!.green).toBeCloseTo(0.4); // 증명된 이웃은 평균에 넣지 않는다
    expect(mixed[2]).toEqual(x(0)); expect(mixed[4]).toBeNull(); expect(mixed[5]!.green).toBe(0.7);
  });
});

describe('승률 보정', () => {
  const samples: CalibrationSample[] = Array.from({ length: 100 }, (_, i) => [
    { value: 0.8, remaining: 12, won: (i % 10 < 6 ? 1 : 0) as 0 | 1, game: String(i) },
    { value: -0.8, remaining: 12, won: (i % 10 < 4 ? 1 : 0) as 0 | 1, game: String(i) },
  ]).flat();

  test('과도하게 확신하는 예측을 보정하면서 단조성을 유지한다', () => {
    const coefficients = fitProbability(samples);
    expect(coefficients[0]).toBeGreaterThan(0);
    const raw = probabilityMetrics(samples, s => (s.value + 1) / 2);
    const fitted = probabilityMetrics(samples, s => calibratedProbability(s.value, s.remaining, coefficients));
    expect(fitted.brier!).toBeLessThan(raw.brier!); expect(fitted.logLoss!).toBeLessThan(raw.logLoss!);
    expect(calibratedProbability(0.8, 12, coefficients)).toBeGreaterThan(calibratedProbability(-0.8, 12, coefficients));
  });

  test('긴 대국의 반복 국면이 적합 가중치를 독점하지 않는다', () => {
    const original = [{ value: 0.5, remaining: 12, won: 0 as const, game: 'a' }, { value: -0.5, remaining: 12, won: 1 as const, game: 'b' }];
    const replicated = [...Array(20).fill(original[0]), original[1]];
    const a = fitProbability(original), b = fitProbability(replicated);
    a.forEach((coefficient, i) => expect(coefficient).toBeCloseTo(b[i], 10));
  });

  test('상수 확률의 점수와 구간 표본 수를 공개한다', () => {
    const metrics = probabilityMetrics(samples, () => 0.5);
    expect(metrics.games).toBe(100); expect(metrics.positions).toBe(200); expect(metrics.brier).toBe(0.25);
    expect(metrics.bins.reduce((n, b) => n + b.n, 0)).toBe(200);
    expect(() => fitProbability([])).toThrow();
  });
});

describe('승률 → 예상 타일 차이', () => {
  test('50%는 0장, 양 끝은 ±계수, 색에 대해 대칭이다', () => {
    expect(expectedMargin(0.5)).toBe(0);
    expect(expectedMargin(1)).toBeCloseTo(MARGIN_PER_VALUE);
    expect(expectedMargin(0)).toBeCloseTo(-MARGIN_PER_VALUE);
    for (const p of [0.1, 0.37, 0.62, 0.9]) expect(expectedMargin(p)).toBeCloseTo(-expectedMargin(1 - p));
  });
  test('승률 순서를 그대로 지키고 범위 밖 값은 자른다', () => {
    const values = [0, 0.2, 0.45, 0.55, 0.8, 1].map(expectedMargin);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(expectedMargin(1.2)).toBe(expectedMargin(1));
    expect(expectedMargin(-0.1)).toBe(expectedMargin(0));
  });
});
