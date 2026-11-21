import { ExactEndgame, PASS, TOTAL_TILES, canonical, initial, legal, result, tileCount, type Player, type Winner } from '@gyeol/core';
import { replayAnalysis, terminalValue, greenValue, type AnalysisMode, type AnalysisPosition } from './analysis';
import { search, type Predict } from './mcts';
import { PROBABILITY_RULE, calibratedProbability, type ProbabilityCalibration } from './probability-calibration';

export const WIN_ANALYSIS_VERSION = 5;
/**
 * 그래프 정확 증명을 시도하는 남은 타일 수의 상한. 실제로 어디까지 증명할지는 아래 노드·시간 예산이 정한다.
 * 승패만 (-1, 1) 창으로 찾으므로 타일 차이 전체를 찾을 때보다 10~200배 적은 노드로 증명된다.
 * 6장 국면의 64회 탐색은 평균 34%p 어긋나 증명 경계에서 그래프가 크게 튀었다.
 */
export const WIN_PROOF_REMAINING = 10;
/** 그래프 증명 예산(전체 기보 공유). 정밀 분석은 후반 몇 수를 더 증명하도록 크게 준다. */
export const WIN_PROOF_BUDGET = { standard: { nodes: 150_000, ms: 400 }, deep: { nodes: 1_500_000, ms: 4000 } } as const;
/** 128판 파일럿의 별도 선택 대국에서 고른 읽기 규칙. 최종 검사로 재선택하지 않는다. */
export const WIN_ROOT_EVALUATOR = 'root-mean' as const;
export const ROOT_SIMULATIONS = { standard: 64, deep: 128 } as const;
export interface WinPoint {
  green: number;
  status: 'estimated' | 'exact';
  source: 'network' | 'search' | 'terminal' | 'proven';
  rawValue: number;
  simulations: number;
  calibrated: boolean;
  provenOutcome?: Winner;
  /** 승리 측이 올바르게 둘 때의 보장 상한. 상대 착수와 강제 패스도 각각 1수다. */
  forcedWinPlies?: number;
  winDistanceKind?: 'exact' | 'upper-bound';
}
export interface WinAnalysis {
  version: number;
  input: string;
  model: string;
  mode: AnalysisMode;
  evaluator: 'root-q' | 'root-mean';
  stage: 'preview' | 'search' | 'proof' | 'complete';
  complete: boolean;
  calibration: string;
  positions: (WinPoint | null)[];
  metrics: { evaluations: number; simulations: number; exactNodes: number; previewMs: number | null; totalMs: number; executions?: number; cacheHits?: number; inferenceMs?: number; loadMs?: number };
}
export interface WinOptions {
  mode?: AnalysisMode;
  start?: AnalysisPosition;
  model?: string;
  evaluator?: 'root-q' | 'root-mean';
  calibrations?: ProbabilityCalibration[];
  resume?: WinAnalysis;
  checkpoint?: () => Promise<void>;
  onProgress?: (analysis: WinAnalysis) => void;
  /** 전체 미리보기를 전달한 뒤, 추가 탐색 전에 실행할 작업. */
  onPreview?: () => Promise<void>;
  /** 전체 기보가 공유하는 정확 탐색 시간 예산 */
  exactMs?: number;
}
export const winInput = (moves: number[], start?: AnalysisPosition) => JSON.stringify([start?.board ?? initial(), start?.player ?? 1, moves]);
export const calibrationId = (calibrations?: ProbabilityCalibration[]) => JSON.stringify((calibrations ?? []).filter(c => c.accepted).map(c => c.version).sort());
export function emptyWinAnalysis(moves: number[], options: WinOptions = {}): WinAnalysis {
  return { version: WIN_ANALYSIS_VERSION, input: winInput(moves, options.start), model: options.model ?? 'unknown', mode: options.mode ?? 'standard', evaluator: options.evaluator ?? WIN_ROOT_EVALUATOR, calibration: calibrationId(options.calibrations), stage: 'preview', complete: false,
    positions: Array(moves.length + 1).fill(null), metrics: { evaluations: 0, simulations: 0, exactNodes: 0, previewMs: null, totalMs: 0 } };
}

/**
 * 화면에 그릴 승률 곡선. 추정 점은 둘 차례 쪽에서 적은 횟수로 탐색해, 둘 차례에 따라 한쪽으로 치우친 오차가
 * 한 수마다 번갈아 나타난다(64·128회 탐색에서 이웃 평균과 평균 7%p 차이). 바로 앞뒤 국면은 상대 쪽에서 탐색한
 * 값이므로 1:2:1 로 평균내면 이 톱니가 상쇄된다. 증명된 점과 종국은 그대로 두고, 이웃으로도 쓰지 않는다.
 * 저장하는 분석 값은 바꾸지 않는다.
 */
export function smoothWinCurve<T extends Pick<WinPoint, 'green' | 'status'>>(points: readonly (T | null)[]): (T | null)[] {
  const estimate = (i: number) => points[i]?.status === 'estimated' ? points[i]!.green : null;
  return points.map((point, i) => {
    if (!point || point.status !== 'estimated') return point;
    const before = estimate(i - 1), after = estimate(i + 1);
    const green = before !== null && after !== null ? (before + 2 * point.green + after) / 4
      : before !== null ? (before + point.green) / 2 : after !== null ? (point.green + after) / 2 : point.green;
    return { ...point, green };
  });
}

/**
 * 그래프 승률을 최종 타일 차이로 바꾸는 계수. 승률이 1(=AI 값 +1)이면 약 +3.7장.
 * tools/analysis/fit_margin_from_win.ts 로 calibration-pilot-5bcbf837 128판(모델 5bcbf837, 64회 탐색, 1:2:1 평균)에서
 * 앱이 쓰는 1차식(MODEL='linear v, k=a')으로 맞췄다. 정규분포 역함수 식은 선택 구간 RMSE 4.53으로 1차식(4.58)과 거의 같았다.
 * 시험 대국 평균 절대 오차 3.2장(RMSE 4.5, 항상 0으로 추정하면 5.0). 새 모델은 대국이 접전이라 이전 모델(8.27)보다 작다.
 */
export const MARGIN_PER_VALUE = 3.75;
/** 초록 승률 → 예상 최종 타일 차이(초록 − 갈색, 소수). 화면에서는 반올림해 쓴다. */
export const expectedMargin = (green: number) => MARGIN_PER_VALUE * (2 * Math.max(0, Math.min(1, green)) - 1);

/** 실제 국면만 평가한다. 후보 전수 비교·수 등급·PV 추출은 이 경로에서 하지 않는다. */
export async function analyzeWinProbability(moves: number[], predict: Predict, options: WinOptions = {}): Promise<WinAnalysis> {
  const positions = replayAnalysis(moves, options.start);
  const mode = options.mode ?? 'standard', budget = ROOT_SIMULATIONS[mode];
  const blank = emptyWinAnalysis(moves, options);
  const resume = options.resume;
  const analysis = resume?.version === blank.version && resume.input === blank.input && resume.model === blank.model && resume.mode === mode && resume.evaluator === blank.evaluator && resume.calibration === blank.calibration && resume.positions.length === positions.length
    ? structuredClone(resume) : blank;
  const started = performance.now();
  const previousMs = analysis.metrics.totalMs;
  const checkpoint = options.checkpoint ?? (async () => {});
  const emit = () => { analysis.metrics.totalMs = previousMs + performance.now() - started; options.onProgress?.(structuredClone(analysis)); };
  const makePoint = (value: number, i: number, source: WinPoint['source'], simulations: number): WinPoint => {
    if (!Number.isFinite(value) || value < -1 || value > 1) throw new Error('Invalid AI value');
    const pos = positions[i];
    const remaining = TOTAL_TILES - tileCount(pos.board);
    const evaluator = source === 'network' ? 'network' : analysis.evaluator;
    const calibration = options.calibrations?.find(c => c.accepted && c.model === options.model && c.rule === PROBABILITY_RULE
      && c.evaluator === evaluator && c.simulations === (source === 'network' ? 0 : budget) && remaining >= c.remainingRange[0] && remaining <= c.remainingRange[1]);
    const probability = calibration ? calibratedProbability(value, remaining, calibration.coefficients) : (value + 1) / 2;
    return { green: pos.player === 1 ? probability : 1 - probability, status: 'estimated', source, rawValue: value, simulations, calibrated: !!calibration };
  };

  analysis.stage = 'preview';
  for (let i = 0; i < positions.length; i++) {
    await checkpoint();
    if (analysis.positions[i]) continue;
    const pos = positions[i], end = result(pos.board, pos.player);
    if (end) analysis.positions[i] = { green: greenValue(terminalValue(end), pos.player), rawValue: terminalValue(end), status: 'exact', source: 'terminal', simulations: 0, calibrated: false, provenOutcome: Math.abs(end) < 0.5 ? 0 : Math.sign(end) * pos.player as Winner };
    else {
      analysis.positions[i] = makePoint((await predict(canonical(pos.board, pos.player))).value, i, 'network', 0);
      analysis.metrics.evaluations++;
    }
    if (i % 4 === 0) emit();
  }
  analysis.metrics.previewMs ??= previousMs + performance.now() - started;
  emit(); // 첫 점 시간이 아니라 전체 미리보기 완료 시점
  await options.onPreview?.();

  // 마지막 판부터 한 판 전체 예산으로 정확한 종국 결과를 확인한다.
  analysis.stage = 'proof';
  const solver = new ExactEndgame(WIN_PROOF_BUDGET[mode].nodes);
  const deadline = performance.now() + (options.exactMs ?? WIN_PROOF_BUDGET[mode].ms);
  const exactCheck = async () => { await checkpoint(); if (performance.now() > deadline) throw new Error('Graph exact budget'); };
  for (let i = positions.length - 1; i >= 0; i--) {
    const point = analysis.positions[i]!;
    if (point.status === 'exact' || TOTAL_TILES - tileCount(positions[i].board) > WIN_PROOF_REMAINING) continue;
    try {
      const value = await solver.outcomeAsync(positions[i].board, positions[i].player, exactCheck);
      analysis.positions[i] = { green: greenValue(value, positions[i].player), rawValue: value, status: 'exact', source: 'proven', simulations: 0, calibrated: false, provenOutcome: value * positions[i].player as Winner };
    } catch (e) {
      if (!(e instanceof Error) || !['Graph exact budget', 'Exact endgame node limit exceeded'].includes(e.message)) throw e;
      break;
    }
  }
  // 25장까지 매 배치 사이 패스는 최대 한 번이다. 증명된 승리에는 항상 안전한 상한을 제공한다.
  for (let i = positions.length - 1; i >= 0; i--) {
    const point = analysis.positions[i]!;
    if (point.source !== 'proven' || !point.provenOutcome || point.forcedWinPlies !== undefined) continue;
    const remaining = TOTAL_TILES - tileCount(positions[i].board);
    point.forcedWinPlies = 2 * remaining - (legal(positions[i].board, positions[i].player)[0] === PASS ? 0 : 1);
    point.winDistanceKind = 'upper-bound';
  }
  // 승패 증명을 우선하고, 같은 시간·노드 예산의 남은 몫으로 승리 수 상한을 좁힌다.
  for (let i = positions.length - 1; i >= 0; i--) {
    const point = analysis.positions[i]!;
    if (point.source !== 'proven' || !point.provenOutcome || point.winDistanceKind === 'exact') continue;
    try {
      const distance = await solver.winDistanceAsync(positions[i].board, positions[i].player, point.provenOutcome as Player, exactCheck);
      if (distance === null || distance < 1) throw new Error('Inconsistent exact win proof');
      point.forcedWinPlies = distance;
      point.winDistanceKind = 'exact';
    } catch (e) {
      if (!(e instanceof Error) || !['Graph exact budget', 'Exact endgame node limit exceeded'].includes(e.message)) throw e;
      break; // 추가 예산 없이 이미 증명된 승리와 안전한 상한을 유지한다.
    }
  }
  analysis.metrics.exactNodes += solver.nodes;
  emit();
  analysis.stage = 'search';
  for (let i = 0; i < positions.length; i++) {
    await checkpoint();
    const point = analysis.positions[i]!;
    if (point.status === 'exact' || (point.source === 'search' && point.simulations === budget)) continue;
    const pos = positions[i];
    const root = await search(canonical(pos.board, pos.player), budget, predict, { details: 'none', random: () => 0, checkpoint });
    analysis.positions[i] = makePoint(analysis.evaluator === 'root-mean' ? root.meanValue : root.value, i, 'search', root.simulations);
    analysis.metrics.simulations += root.simulations;
    emit();
  }
  await checkpoint();
  analysis.stage = 'complete'; analysis.complete = true; emit();
  return analysis;
}
