import { ExactEndgame, PASS, TOTAL_TILES, apply, canonical, initial, isLegal, legal, result, tileCount, type Board, type Player } from '@gyeol/core';
import { createSearchSession, search, type Predict, type SearchSession } from './mcts';
import { GRADING_VERSION, decideMove, type MoveBadge, type MoveDecision, type EvaluationStatus } from './grading';
export type { EvaluationStatus } from './grading';

export const ANALYSIS_VERSION = 8;
export type AnalysisMode = 'standard' | 'deep';
export interface AnalysisPosition { board: Board; player: Player }
export interface CandidateEvaluation {
  action: number;
  value: number;
  simulations: number;
  status: EvaluationStatus;
  pv: number[];
  margin?: number;
  drift?: number;
  /** 얕은 첫 탐색의 값. 깊게 읽어야 보이는 수를 구별한다. */
  shallow?: number;
  resultKey?: string;
}
export interface MoveAnalysis extends MoveDecision {
  ply: number;
  player: Player;
  played: number;
  candidates: CandidateEvaluation[];
}
export interface PositionEvaluation { green: number; status: EvaluationStatus }
export interface GameAnalysis {
  version: number;
  gradingVersion: number;
  mode: AnalysisMode;
  complete: boolean;
  positions: (PositionEvaluation | null)[];
  moves: (MoveAnalysis | null)[];
}
export interface AnalysisOptions {
  mode?: AnalysisMode;
  start?: AnalysisPosition;
  resume?: GameAnalysis;
  checkpoint?: () => Promise<void>;
  onProgress?: (analysis: GameAnalysis) => void;
  /** 테스트/벤치마크용. 기본값은 실제 브라우저용 예산이다. */
  baseSims?: number;
  exactNodes?: number;
  exactMs?: number;
  /** 정밀 모드에서도 전체 잠정 등급만 먼저 계산한다. */
  fastOnly?: boolean;
  /** 빠른 등급에서 후보별 승패를 정확히 푸는 남은 타일 수의 상한. */
  gradeExactRemaining?: number;
  /** 빠른 등급에서 유력 후보(상위 3개 + 실제 수)만 더 읽는 탐색 횟수. 0이면 신경망 1회 평가만. */
  focusSims?: number;
}
/**
 * 빠른 등급의 기본 예산. tools/bench_standard_vs_deep.ts 로 정밀 분석과 비교해 골랐다(8판, Node).
 * 일반 분석: 남은 8장까지 후보별 승패를 정확히 풀고, 나머지 수는 상위 3개 + 실제 수만 16회 더 읽는다.
 *   정밀 분석과의 정확도 차이 14.5 → 9.3점, 수마다 손실 차이 9.5 → 6.3점, 판당 1.6 → 12.4초.
 *   32회로 늘리면 시간은 두 배인데 정확도 차이는 1점 남짓만 준다.
 * 정밀 분석의 첫 단계는 뒤에서 모든 후보를 다시 읽으므로 예전 예산을 그대로 쓴다.
 */
export const FAST_GRADE_BUDGET = {
  standard: { exactRemaining: 8, exactNodes: 1_000_000, exactMs: 1500, focusSims: 16 },
  deep: { exactRemaining: 5, exactNodes: 75_000, exactMs: 180, focusSims: 0 },
} as const;

export const terminalValue = (r: number) => Math.abs(r) < 0.5 ? 0 : Math.sign(r);
export const greenValue = (value: number, player: Player) => (1 + value * player) / 2;

export function replayAnalysis(moves: number[], start: AnalysisPosition = { board: initial(), player: 1 }): AnalysisPosition[] {
  if (!Array.isArray(start.board) || start.board.length !== 49 || !start.board.every(v => Number.isInteger(v) && Math.abs(v) <= 4)
    || ![1, -1].includes(start.player) || tileCount(start.board) > TOTAL_TILES || !Array.isArray(moves)) throw new Error('Invalid game record');
  const out = [{ board: start.board.slice(), player: start.player }];
  for (const action of moves) {
    const prev = out[out.length - 1];
    if (result(prev.board, prev.player) || !isLegal(prev.board, prev.player, action)) throw new Error('Invalid game record');
    out.push({ board: apply(prev.board, prev.player, action).board, player: -prev.player as Player });
  }
  return out;
}

export function emptyAnalysis(length: number, mode: AnalysisMode): GameAnalysis {
  return { version: ANALYSIS_VERSION, gradingVersion: GRADING_VERSION, mode, complete: false, positions: Array(length + 1).fill(null), moves: Array(length).fill(null) };
}

async function analyzePosition(pos: AnalysisPosition, played: number, predict: Predict, opts: AnalysisOptions): Promise<{ candidates: CandidateEvaluation[]; exact: boolean }> {
  const checkpoint = opts.checkpoint ?? (async () => {});
  const actions = legal(pos.board, pos.player);
  const turn = -pos.player as Player;
  if (TOTAL_TILES - tileCount(pos.board) <= 5) {
    const solver = new ExactEndgame(opts.exactNodes ?? 100_000);
    const deadline = performance.now() + (opts.exactMs ?? 350);
    const check = async () => {
      await checkpoint();
      if (performance.now() > deadline) throw new Error('Exact analysis deadline');
    };
    try {
      const values = await solver.valuesAsync(pos.board, pos.player, check);
      const candidates: CandidateEvaluation[] = values.map(([action, margin]) => ({ action, margin, value: Math.sign(margin), simulations: 0, status: 'exact', pv: [action] }));
      // PV 계산이 한도를 넘겨도 이미 증명한 루트 결과는 유지한다.
      for (const c of [...candidates].sort((a, b) => b.value - a.value || b.margin! - a.margin!).filter((c, i) => i === 0 || c.action === played)) {
        let board = apply(pos.board, pos.player, c.action).board, player = turn;
        try {
          for (let depth = 1; depth < 5 && !result(board, player); depth++) {
            const replies = await solver.valuesAsync(board, player, check);
            replies.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
            c.pv.push(replies[0][0]);
            board = apply(board, player, replies[0][0]).board; player = -player as Player;
          }
        } catch (e) {
          // 취소도 바깥 checkpoint에서 다시 전달된다.
          if (!(e instanceof Error) || !['Exact analysis deadline', 'Exact endgame node limit exceeded'].includes(e.message)) throw e;
        }
      }
      return { candidates, exact: true };
    } catch (e) {
      if (!(e instanceof Error) || !['Exact analysis deadline', 'Exact endgame node limit exceeded'].includes(e.message)) throw e;
    }
  }

  // 모든 후보에 최소 탐색을 적용한다. 정책에서 빠진 실제 착수도 빠지지 않는다.
  const base = opts.baseSims ?? (opts.mode === 'deep' ? 48 : 12);
  const sessions = new Map<number, SearchSession>();
  const evaluate = async (action: number, sims: number): Promise<CandidateEvaluation> => {
    await checkpoint();
    const child = apply(pos.board, pos.player, action).board;
    const end = result(child, turn);
    if (end) return { action, value: -terminalValue(end), simulations: 0, status: 'exact', pv: [action] };
    if (!sessions.has(action)) sessions.set(action, createSearchSession());
    const found = await search(canonical(child, turn), sims, predict, { random: () => 0, checkpoint, session: sessions.get(action) });
    const reply = found.candidates.find(c => c.action === found.action);
    return { action, value: -found.value, simulations: found.simulations, status: 'estimated', pv: [action, ...(reply?.pv ?? [])].slice(0, 5) };
  };
  const candidates: CandidateEvaluation[] = [];
  for (const action of actions) candidates.push(await evaluate(action, base));
  const roughBest = Math.max(...candidates.map(c => c.value));
  const ordered = [...candidates].sort((a, b) => b.value - a.value || a.action - b.action);
  const contenders = new Set(ordered.filter((c, i) => i < 3 || (i < 6 && c.value >= roughBest - 0.06) || c.action === played).map(c => c.action));
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.status === 'exact' || !contenders.has(c.action)) continue;
    const refined = await evaluate(c.action, base * 4);
    const deeper = await evaluate(c.action, base * 8);
    const drift = Math.abs(deeper.value - refined.value);
    candidates[i] = { ...deeper, drift, shallow: c.value, status: drift <= 0.06 ? 'stable' : 'estimated' };
  }
  // 후순위 후보도 정밀 평가보다 좋아 보이면 검토 범위를 넓힌다.
  const refinedBest = Math.max(...candidates.filter(c => contenders.has(c.action)).map(c => c.value));
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (contenders.has(c.action) || c.status === 'exact' || c.value < refinedBest - 0.12) continue;
    const refined = await evaluate(c.action, base * 4);
    const deeper = await evaluate(c.action, base * 8);
    candidates[i] = { ...deeper, drift: Math.abs(deeper.value - refined.value), shallow: c.value, status: Math.abs(deeper.value - refined.value) <= 0.06 ? 'stable' : 'estimated' };
  }
  return { candidates, exact: candidates.every(c => c.status === 'exact') };
}

function classify(ply: number, pos: AnalysisPosition, played: number, candidates: CandidateEvaluation[]): MoveAnalysis {
  // Exact uniqueness is about resulting positions, not merely action IDs.
  // 추정 후보는 실제 수와 같은 결과 판을 만들 때만 표시해 하나의 선택지로 센다.
  const key = (action: number) => apply(pos.board, pos.player, action).board.join(',');
  const playedKey = key(played);
  const twins = candidates.filter(c => key(c.action) === playedKey).length > 1;
  const compared = candidates.map(c => c.status === 'exact' ? { ...c, resultKey: key(c.action) }
    : twins && key(c.action) === playedKey ? { ...c, resultKey: playedKey } : c);
  return { ply, player: pos.player, played, candidates: compared, ...decideMove(compared, played, PASS) };
}

/** 선택한 한 수만 상세 분석한다. 전체 그래프를 재계산하지 않는다. */
export async function analyzeMove(pos: AnalysisPosition, played: number, ply: number, predict: Predict, opts: AnalysisOptions = {}): Promise<MoveAnalysis> {
  replayAnalysis([played], pos);
  const { candidates } = await analyzePosition(pos, played, predict, opts);
  return classify(ply, pos, played, candidates);
}

/** 직전 상대의 실수로 생긴 기회인지 같은 색 관점에서 확인한다. */
export function opportunityBadges(move: MoveAnalysis, previous: PositionEvaluation | null, current: PositionEvaluation): MoveBadge[] {
  if (!move.badges.some(b => b === 'missedWin' || b === 'missedChance') || !previous || previous.status === 'estimated' || current.status === 'estimated') return move.badges;
  return (current.green - previous.green) * move.player >= 0.15 ? [...move.badges, 'convertedChance'] : move.badges;
}

export async function analyzeGame(moves: number[], predict: Predict, opts: AnalysisOptions = {}): Promise<GameAnalysis> {
  const positions = replayAnalysis(moves, opts.start);
  const mode = opts.mode ?? 'standard';
  const saved = opts.resume;
  const analysis = saved?.version === ANALYSIS_VERSION && saved.gradingVersion === GRADING_VERSION && saved.mode === mode && saved.moves.length === moves.length && saved.positions.length === positions.length
    ? structuredClone(saved) : emptyAnalysis(moves.length, mode);
  const checkpoint = opts.checkpoint ?? (async () => {});
  // 첫 탐색이 끝나기 전에도 시작 국면의 신경망 추정값을 먼저 보여준다.
  const first = positions[0];
  if (!analysis.positions[0] && TOTAL_TILES - tileCount(first.board) > 5 && !result(first.board, first.player)) {
    await checkpoint();
    const value = (await predict(canonical(first.board, first.player))).value;
    if (!Number.isFinite(value) || value < -1 || value > 1) throw new Error('Invalid AI value');
    analysis.positions[0] = { green: greenValue(value, first.player), status: 'estimated' };
    opts.onProgress?.(structuredClone(analysis));
  }
  for (let i = 0; i < moves.length; i++) {
    await checkpoint();
    if (analysis.moves[i]) continue;
    const { candidates } = await analyzePosition(positions[i], moves[i], predict, opts);
    const move = classify(i + 1, positions[i], moves[i], candidates);
    const best = Math.max(...candidates.map(c => c.value));
    analysis.positions[i] = { green: greenValue(best, positions[i].player), status: move.status };
    move.badges = opportunityBadges(move, analysis.positions[i - 1] ?? null, analysis.positions[i]!);
    analysis.moves[i] = move;
    opts.onProgress?.(structuredClone(analysis));
  }
  // 기권/시간패 기록의 승자는 사용하지 않는다. 마지막 보드 자체의 평가다.
  if (!analysis.positions[moves.length]) {
    const last = positions[moves.length];
    const end = result(last.board, last.player);
    if (end) analysis.positions[moves.length] = { green: greenValue(terminalValue(end), last.player), status: 'exact' };
    else {
      const found = await analyzePosition(last, legal(last.board, last.player)[0], predict, opts);
      const value = Math.max(...found.candidates.map(c => c.value));
      analysis.positions[moves.length] = { green: greenValue(value, last.player), status: found.exact ? 'exact' : 'estimated' };
    }
  }
  await checkpoint();
  analysis.complete = true;
  opts.onProgress?.(structuredClone(analysis));
  return analysis;
}

/** 모든 합법 후보의 자식 국면을 같은 깊이로 비교한다. 빠른 평가는 잠정 등급으로 남긴다. */
export async function analyzeGameGrades(moves: number[], predict: Predict, opts: AnalysisOptions = {}): Promise<GameAnalysis> {
  const positions = replayAnalysis(moves, opts.start);
  const mode = opts.mode ?? 'standard';
  const saved = opts.resume;
  const compatible = saved?.version === ANALYSIS_VERSION && saved.gradingVersion === GRADING_VERSION && saved.mode === mode
    && saved.moves.length === moves.length && saved.positions.length === positions.length
    && saved.moves.every((m, i) => !m || m.played === moves[i] && m.player === positions[i].player);
  const analysis = compatible ? structuredClone(saved!) : emptyAnalysis(moves.length, mode);
  const checkpoint = opts.checkpoint ?? (async () => {});
  const budget = FAST_GRADE_BUDGET[mode];
  const exactLimit = opts.gradeExactRemaining ?? budget.exactRemaining, focusSims = opts.focusSims ?? budget.focusSims;
  const solver = new ExactEndgame(opts.exactNodes ?? budget.exactNodes);
  // 빠른 등급 전체에 공유하는 증명 예산. 수마다 350ms를 추가하지 않는다.
  let exactRemaining = opts.exactMs ?? budget.exactMs;
  const emit = () => opts.onProgress?.(structuredClone(analysis));
  // 종국에 가까운(쉬운) 국면부터 거꾸로 푼다. 앞에서부터 풀면 가장 어려운 첫 종반 국면이 공유 예산을 다 써 버려,
  // 타일 몇 장 남지 않은 국면까지 신경망 추정으로 평가되었다. 남은 타일은 수가 갈수록 줄기만 하므로
  // 한 국면에서 예산이 끝나면 그보다 앞 국면은 더 어렵다고 보고 멈춘다. 같은 풀이기의 결과 캐시도 앞 국면에 재사용된다.
  const exact = new Map<number, CandidateEvaluation[]>();
  for (let i = moves.length - 1; i >= 0 && exactRemaining > 0; i--) {
    const pos = positions[i];
    if (analysis.moves[i] || TOTAL_TILES - tileCount(pos.board) > exactLimit) continue;
    await checkpoint();
    const started = performance.now(), deadline = started + exactRemaining;
    try {
      const check = async () => {
        await checkpoint();
        if (performance.now() > deadline) throw new Error('Exact analysis deadline');
      };
      // 5장 이하는 싸므로 타일 차이(margin)까지 찾아 둔다(수순 보기의 동률 정렬에 쓴다).
      // 그보다 앞 국면은 정확한 등급에 필요한 후보별 승패만 찾아, 같은 예산으로 더 앞까지 푼다.
      if (TOTAL_TILES - tileCount(pos.board) <= 5) {
        const values = await solver.valuesAsync(pos.board, pos.player, check);
        exact.set(i, values.map(([action, margin]) => ({ action, margin, value: Math.sign(margin), simulations: 0, status: 'exact', pv: [action] })));
      } else {
        const values = await solver.outcomesAsync(pos.board, pos.player, check);
        exact.set(i, values.map(([action, value]) => ({ action, value, simulations: 0, status: 'exact', pv: [action] })));
      }
    } catch (e) {
      if (!(e instanceof Error) || !['Exact analysis deadline', 'Exact endgame node limit exceeded'].includes(e.message)) throw e;
      break;
    } finally { exactRemaining -= performance.now() - started; }
  }
  for (let i = 0; i < moves.length; i++) {
    await checkpoint();
    if (analysis.moves[i]) continue;
    const pos = positions[i], turn = -pos.player as Player;
    let candidates: CandidateEvaluation[] | undefined = exact.get(i);
    if (!candidates) {
      candidates = [];
      for (const action of legal(pos.board, pos.player)) {
        await checkpoint();
        const child = apply(pos.board, pos.player, action).board;
        const end = result(child, turn);
        const value = end ? -terminalValue(end) : -(await predict(canonical(child, turn))).value;
        if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error('Invalid AI value');
        candidates.push({ action, value, simulations: 0, status: end ? 'exact' : 'estimated', pv: [action] });
      }
      if (focusSims > 0) {
        // 실제 수와 최선 수의 비교가 등급을 정하므로, 상위 3개와 실제 수만 더 읽는다.
        // 덜 읽은 후보가 다시 읽은 최선보다 좋아 보이면 그 후보도 읽어 같은 깊이로 비교한다.
        const deeper = async (c: CandidateEvaluation): Promise<CandidateEvaluation> => {
          if (c.status === 'exact') return c;
          await checkpoint();
          const found = await search(canonical(apply(pos.board, pos.player, c.action).board, turn), focusSims, predict, { random: () => 0, checkpoint, details: 'none' });
          return { ...c, value: -found.value, simulations: found.simulations, shallow: c.value };
        };
        const ordered = [...candidates].sort((a, b) => b.value - a.value || a.action - b.action);
        const focus = new Set(ordered.slice(0, 3).map(c => c.action).concat(moves[i]));
        for (let k = 0; k < candidates.length; k++) if (focus.has(candidates[k].action)) candidates[k] = await deeper(candidates[k]);
        const read = Math.max(...candidates.filter(c => focus.has(c.action)).map(c => c.value));
        for (let k = 0; k < candidates.length; k++) if (!focus.has(candidates[k].action) && candidates[k].value > read) candidates[k] = await deeper(candidates[k]);
      }
    }
    const move = classify(i + 1, pos, moves[i], candidates);
    analysis.moves[i] = move;
    analysis.positions[i] = { green: greenValue(Math.max(...candidates.map(c => c.value)), pos.player), status: move.status };
    emit();
  }
  const last = positions[moves.length];
  if (!analysis.positions[moves.length]) {
    await checkpoint();
    const end = result(last.board, last.player);
    const value = end ? terminalValue(end) : (await predict(canonical(last.board, last.player))).value;
    if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error('Invalid AI value');
    analysis.positions[moves.length] = { green: greenValue(value, last.player), status: end ? 'exact' : 'estimated' };
  }
  // 정밀 모드를 선택했을 때만 추가 탐색. 먼저 모든 수의 빠른 등급을 표시한다.
  if (mode === 'deep' && !opts.fastOnly) {
    for (let i = 0; i < moves.length; i++) {
      await checkpoint();
      if (analysis.moves[i]?.status !== 'estimated') continue;
      const move = await analyzeMove(positions[i], moves[i], i + 1, predict, opts);
      analysis.moves[i] = move;
      analysis.positions[i] = { green: greenValue(Math.max(...move.candidates.map(c => c.value)), positions[i].player), status: move.status };
      emit();
    }
  }
  await checkpoint();
  analysis.complete = mode !== 'deep' || !opts.fastOnly;
  emit();
  return analysis;
}

export function analysisSummary(analysis: GameAnalysis, player: Player) {
  const all = analysis.moves.filter((m): m is MoveAnalysis => !!m && m.player === player && !m.forced);
  const graded = all.filter(m => m.grade !== null);
  const estimated = graded.filter(m => m.status !== 'exact');
  return {
    total: all.length, graded: graded.length,
    provisional: all.length - graded.length, exact: graded.length - estimated.length,
    averageLoss: estimated.length ? estimated.reduce((n, m) => n + m.lossPoints, 0) / estimated.length : null,
    mistakes: graded.filter(m => m.grade === 'mistake' || m.grade === 'blunder').length,
    best: graded.filter(m => m.grade === 'best').length,
    missed: graded.filter(m => m.badges.includes('missedWin') || m.badges.includes('missedChance') || m.badges.includes('missedDefense')).length,
  };
}

export const isPass = (move: MoveAnalysis) => move.played === PASS;
