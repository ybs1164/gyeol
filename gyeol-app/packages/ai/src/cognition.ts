import { apply, canonical, legal, margin, result, TOTAL_TILES, type Board, type TimeMode } from '@gyeol/core';
import { createSearchSession, search, type Predict } from './mcts';
import { cognitionModeScale, type CognitiveProfile } from './cognitive-persona';
import { cognitiveTimeBudget } from './time-policy';

export interface CognitiveDecision {
  action: number;
  elapsedMs: number;
  stage: 'A' | 'B' | 'C' | 'D';
  candidates: number;
  simulations: number;
  reason: 'forced' | 'stable' | 'budget' | 'cancelled';
  /** Stage weights at the final public checkpoint, not probabilities. */
  weights: number[];
}
export interface CognitiveOptions {
  mode?: TimeMode;
  leftMs?: number;
  budgetMs?: number;
  /** Absolute performance.now() deadline, independent of logical thinking time. */
  deadline?: number;
  signal?: AbortSignal;
  /** Real-time execution waits here; batch execution omits waiting. */
  checkpoint?: (decision: CognitiveDecision) => Promise<void>;
}
interface Candidate { action: number; board: Board; a: number; terminal: number | null; b?: number; c?: number; d?: number }
const clamp = (x: number) => Math.max(-1, Math.min(1, x));
const outcome = (b: Board): number | null => {
  const end = result(b, 1);
  return end ? (Math.abs(end) < 0.5 ? 0 : Math.sign(end)) : null;
};
const ramp = (time: number, start: number, width: number) => Math.max(0, Math.min(1, (time - start) / width));

/** No random draws. All private computation becomes usable only at its public checkpoint. */
export async function cognitiveMove(board: Board, profile: CognitiveProfile, predict: Predict, opts: CognitiveOptions = {}): Promise<CognitiveDecision> {
  const moves = legal(board, 1), mode = opts.mode ?? 'blitz', scale = cognitionModeScale(mode);
  const deadline = opts.deadline ?? Infinity;
  const expired = () => opts.signal?.aborted || performance.now() >= deadline;
  const initialMargin = margin(board);
  const candidates: Candidate[] = moves.map(action => {
    const next = apply(board, 1, action).board;
    return { action, board: next, a: clamp((margin(next) - initialMargin) / 12), terminal: outcome(next) };
  }).sort((a, b) => (b.terminal === 1 ? 1 : 0) - (a.terminal === 1 ? 1 : 0) || b.a - a.a || a.action - b.action);
  const gapA = candidates.length > 1 ? candidates[0].a - candidates[1].a : 1;
  const budget = cognitiveTimeBudget(board, mode, opts.leftMs ?? 180000, gapA < 0.05 ? 0.40 : 0.23);
  const hard = Math.max(0, Math.min(opts.budgetMs ?? budget.hardMs, budget.hardMs));
  let target = Math.min(hard, budget.softMs), time = Math.min(hard, 80 * scale);
  let latest: CognitiveDecision = { action: candidates[0].action, elapsedMs: time, stage: 'A', candidates: candidates.length,
    simulations: 0, reason: moves.length === 1 ? 'forced' : 'budget', weights: [1, 0, 0, 0] };
  const publish = async () => { if (!expired()) await opts.checkpoint?.({ ...latest, weights: [...latest.weights] }); };
  await publish();
  if (moves.length === 1 || expired() || hard <= time) return latest;

  const starts = profile.startMs.map(x => x * scale), ramps = profile.rampMs.map(x => x * scale);
  const minimum = profile.minimumThinkMs * scale;
  const width = Math.min(candidates.length, Math.max(2, Math.ceil(profile.candidateWidth)));
  let active = candidates;
  let previous = latest.action, stable = 0;
  const weightsAt = () => [1, 1.5 * ramp(time, starts[0], ramps[0]),
    active.every(c => c.c !== undefined) ? 2 * ramp(time, starts[1], ramps[1]) : 0,
    latest.stage === 'D' ? 4 * ramp(time, starts[2], ramps[2]) : 0];
  const score = (c: Candidate, weights: number[]) => c.terminal === null
    ? (c.a + (c.b ?? 0) * weights[1] + (c.c ?? 0) * weights[2] + (c.d ?? 0) * weights[3]) / weights.reduce((a, b) => a + b, 0)
    : c.terminal * 10;
  const rank = () => {
    const weights = weightsAt();
    active.sort((a, b) => score(b, weights) - score(a, weights) || a.action - b.action);
    latest = { ...latest, action: active[0].action, elapsedMs: time, candidates: active.length, weights };
    stable = previous === latest.action ? stable + 1 : 0;
    if (previous !== latest.action) target = Math.min(hard, Math.max(target, time + 700 * scale));
    previous = latest.action;
  };

  // A small local gain can be played before the opponent's reply is recognized.
  if (profile.skillPosition < 0.4 && gapA >= profile.earlyCommitGap && minimum < starts[0]) {
    time = Math.min(hard, minimum);
    latest = { ...latest, elapsedMs: time, reason: 'stable' };
    await publish();
    return latest;
  }

  // B: complete the same reply check for a set before comparing that set.
  time = Math.max(time, starts[0]);
  if (time >= target || time >= hard || expired()) {
    latest = { ...latest, elapsedMs: Math.min(target, hard) }; await publish(); return latest;
  }
  const checked: Candidate[] = [];
  for (const c of candidates.slice(0, width)) {
    const replies = legal(c.board, -1);
    const cost = Math.max(60, replies.length * 5) * scale / profile.workRate;
    if (time + cost > hard || expired()) break;
    let worst = Infinity;
    for (const reply of replies) {
      const next = apply(c.board, -1, reply).board;
      worst = Math.min(worst, outcome(next) ?? margin(next) / TOTAL_TILES);
    }
    if (expired()) break;
    time += cost;
    c.b = clamp(worst); checked.push(c);
  }
  if (!checked.length) return latest;
  active = checked; latest.stage = 'B'; rank(); await publish();
  const gap = active.length > 1 ? score(active[0], latest.weights) - score(active[1], latest.weights) : 1;
  if (time >= target || (time >= minimum && gap > profile.earlyCommitGap && profile.skillPosition < 0.6) || expired()) {
    latest.reason = time < target ? 'stable' : 'budget'; return latest;
  }

  // C: limited minimax; local evaluation remains stationary throughout each job.
  time = Math.max(time, starts[1]);
  const continued: Candidate[] = [];
  if (time < target && time < hard && !expired()) {
    for (const c of active) {
      const replies = legal(c.board, -1).map(action => {
        const b = apply(c.board, -1, action).board;
        return { action, board: b, value: outcome(b) ?? margin(b) / TOTAL_TILES };
      }).sort((a, b) => a.value - b.value || a.action - b.action).slice(0, Math.ceil(profile.candidateWidth));
      const cost = Math.max(90, replies.length * 75) * scale / profile.workRate;
      if (time + cost > hard || expired()) break;
      let worst = Infinity;
      for (const reply of replies) {
        const ended = outcome(reply.board);
        let best = ended ?? -Infinity;
        if (ended === null) for (const action of legal(reply.board, 1)) {
          const next = apply(reply.board, 1, action).board;
          best = Math.max(best, outcome(next) ?? margin(next) / TOTAL_TILES);
        }
        worst = Math.min(worst, best);
      }
      if (expired()) break;
      time += cost; c.c = clamp(worst); continued.push(c);
    }
    if (continued.length) { active = continued; latest.stage = 'C'; rank(); await publish(); }
  }

  // D is a stationary, separately gated network search. Never use its policy before the gate.
  const session = createSearchSession();
  time = Math.max(time, starts[2]);
  while (time < target && time < hard && !expired()) {
    const sims = session.simulations + 8;
    const cost = 8000 * scale / profile.simulationRate;
    if (time + cost > hard || sims > 512) break;
    const searched = await search(canonical(board, 1), sims, predict, {
      session, random: () => 0, deadline: Number.isFinite(deadline) ? deadline : undefined, details: 'root',
      checkpoint: async () => { if (expired()) throw new Error('Cognitive search cancelled'); },
    }).catch(error => { if (expired()) return null; throw error; });
    if (!searched || expired()) break;
    time += cost;
    const known = searched.candidates.filter(x => x.value !== null && x.visits >= 2);
    const comparable = active.filter(c => known.some(k => k.action === c.action));
    if (comparable.length >= Math.min(2, active.length)) {
      const pool = active;
      active = comparable;
      for (const c of active) c.d = known.find(k => k.action === c.action)!.value!;
      latest.stage = 'D'; latest.simulations = searched.simulations; rank(); await publish();
      if (stable >= 3 && time >= minimum && active.length > 1 &&
          score(active[0], latest.weights) - score(active[1], latest.weights) > profile.earlyCommitGap) {
        latest.reason = 'stable'; return latest;
      }
      active = pool;
    }
  }
  latest.elapsedMs = Math.min(hard, Math.max(latest.elapsedMs, Math.min(target, time)));
  if (opts.signal?.aborted) latest.reason = 'cancelled';
  await publish();
  return latest;
}
