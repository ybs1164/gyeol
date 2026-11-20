import { apply, legal, margin, result, TOTAL_TILES, type Board } from '@gyeol/core';
import { createSearchSession, search, type Predict } from './mcts';
import { cognitionModeScale, type CognitiveProfile } from './cognitive-persona';
import { cognitiveTimeBudget } from './time-policy';
import type { CognitiveDecision, CognitiveOptions } from './cognition';

export const WIDE_COGNITION_VERSION = 'cognition-v2-wide';
export interface WideCognitiveProfile extends Omit<CognitiveProfile, 'version'> {
  version: typeof WIDE_COGNITION_VERSION;
  /** A target on the old display scale, not a measured Elo. */
  targetRating: number;
  decisionWindowMs: number;
  attentionFraction: number;
  maxSimulations: number;
}
export interface WideCognitivePersona { id: string; name: string; cognition: WideCognitiveProfile }
const POINTS = [974, 1300, 1500, 1600, 1750, 1900, 2207];
const STARTS = [[2400, 5500, 9000], [1600, 3800, 6500], [1000, 2300, 4000],
  [650, 1500, 2800], [400, 950, 1700], [250, 550, 1000], [250, 550, 1000]];
const WIDTHS = [1, 2, 4, 6, 8, 12, 12];
const WINDOWS = [1200, 1900, 3000, 3900, 4900, 6000, 8000];
const RATES = [8, 12, 24, 64, 128, 192, 320];
const SIMS = [0, 0, 32, 128, 512, 1024, 2048];
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export function wideCognitiveProfile(position: number): WideCognitiveProfile {
  if (!Number.isFinite(position) || position < 0 || position > 1) throw new Error('Invalid wide skill position');
  const targetRating = mix(974, 2207, position);
  let lo = 0;
  while (lo < POINTS.length - 2 && targetRating >= POINTS[lo + 1]) lo++;
  const f = (targetRating - POINTS[lo]) / (POINTS[lo + 1] - POINTS[lo]);
  const startMs = STARTS[lo].map((v, i) => mix(v, STARTS[lo + 1][i], f)) as [number, number, number];
  const targetTier: CognitiveProfile['targetTier'] = targetRating < 1300 ? 'bronze' : targetRating < 1500 ? 'silver' :
    targetRating < 1600 ? 'gold' : targetRating < 1750 ? 'plat' : targetRating < 1900 ? 'dia' : 'master';
  return { version: WIDE_COGNITION_VERSION, skillPosition: position, targetRating, targetTier,
    startMs, rampMs: startMs.map(v => v / 2) as [number, number, number],
    candidateWidth: mix(WIDTHS[lo], WIDTHS[lo + 1], f), workRate: mix(.65, 3, position),
    simulationRate: mix(RATES[lo], RATES[lo + 1], f), earlyCommitGap: mix(.12, .02, position),
    minimumThinkMs: mix(1200, 600, position), decisionWindowMs: mix(WINDOWS[lo], WINDOWS[lo + 1], f),
    attentionFraction: .04 + .96 * position ** .65, maxSimulations: Math.round(mix(SIMS[lo], SIMS[lo + 1], f)) };
}

export function createWideRoster(identities: { id: string; name: string }[]): WideCognitivePersona[] {
  if (identities.length < 2 || new Set(identities.map(x => x.id)).size !== identities.length ||
      new Set(identities.map(x => x.name)).size !== identities.length) throw new Error('Invalid wide identities');
  return identities.map((p, i) => ({ id: p.id, name: p.name, cognition: wideCognitiveProfile(i / (identities.length - 1)) }));
}

interface Candidate { action: number; board: Board; a: number; terminal: number | null; b?: number; c?: number }
const clamp = (v: number) => Math.max(-1, Math.min(1, v));
const ramp = (t: number, start: number, width: number) => Math.max(0, Math.min(1, (t - start) / width));
const outcome = (board: Board) => { const r = result(board, 1); return r ? Math.abs(r) < .5 ? 0 : Math.sign(r) : null; };

/** Lower profiles have limited attention/time; upper profiles search the entire legal root. */
export async function wideCognitiveMove(board: Board, profile: WideCognitiveProfile, predict: Predict, opts: CognitiveOptions = {}): Promise<CognitiveDecision> {
  const moves = legal(board, 1), scale = cognitionModeScale(opts.mode ?? 'blitz');
  const budget = cognitiveTimeBudget(board, opts.mode ?? 'blitz', opts.leftMs ?? 180000);
  const hard = Math.min(budget.hardMs, opts.budgetMs ?? Infinity, profile.decisionWindowMs * scale);
  const expired = () => !!opts.signal?.aborted || performance.now() >= (opts.deadline ?? Infinity);
  let time = Math.min(hard, 80 * scale);
  const visible = moves.slice(0, Math.max(1, Math.ceil(moves.length * profile.attentionFraction)));
  const initialMargin = margin(board);
  const candidates: Candidate[] = visible.map(action => {
    const next = apply(board, 1, action).board;
    return { action, board: next, a: clamp((margin(next) - initialMargin) / 12), terminal: outcome(next) };
  });
  let active = candidates;
  let latest: CognitiveDecision = { action: visible[0], elapsedMs: time, stage: 'A', candidates: visible.length,
    simulations: 0, reason: moves.length === 1 ? 'forced' : 'budget', weights: [1, 0, 0, 0] };
  const starts = profile.startMs.map(v => v * scale), ramps = profile.rampMs.map(v => v * scale);
  const localRank = () => {
    const weights = [1, latest.stage !== 'A' ? 1.5 * ramp(time, starts[0], ramps[0]) : 0,
      latest.stage === 'C' ? 2 * ramp(time, starts[1], ramps[1]) : 0, 0];
    const score = (c: Candidate) => c.terminal !== null ? c.terminal * 10 : c.a + (c.b ?? 0) * weights[1] + (c.c ?? 0) * weights[2];
    active.sort((a, b) => score(b) - score(a) || a.action - b.action);
    latest = { ...latest, action: active[0].action, elapsedMs: time, candidates: active.length, weights };
  };
  const publish = async () => { if (!expired()) await opts.checkpoint?.({ ...latest, weights: [...latest.weights] }); };
  localRank(); await publish();
  if (moves.length === 1 || hard <= time || expired()) return latest;
  const width = Math.min(active.length, Math.max(1, Math.ceil(profile.candidateWidth)));
  time = Math.max(time, starts[0]);
  const checked: Candidate[] = [];
  if (time < hard && !expired()) for (const c of active.slice(0, width)) {
    const replies = legal(c.board, -1);
    const cost = Math.max(60, replies.length * 5) * scale / profile.workRate;
    if (time + cost > hard || expired()) break;
    c.b = Math.min(...replies.map(a => { const next = apply(c.board, -1, a).board; return outcome(next) ?? margin(next) / TOTAL_TILES; }));
    if (expired()) break;
    time += cost; checked.push(c);
  }
  if (checked.length) { active = checked; latest.stage = 'B'; localRank(); await publish(); }
  time = Math.max(time, starts[1]);
  const continued: Candidate[] = [];
  if (time < hard && !expired()) for (const c of active) {
    const replies = legal(c.board, -1).map(a => { const next = apply(c.board, -1, a).board;
      return { board: next, value: outcome(next) ?? margin(next) / TOTAL_TILES }; })
      .sort((a, b) => a.value - b.value).slice(0, width);
    const cost = Math.max(90, replies.length * 75) * scale / profile.workRate;
    if (time + cost > hard || expired()) break;
    c.c = Math.min(...replies.map(reply => {
      const end = outcome(reply.board);
      if (end !== null) return end;
      return Math.max(...legal(reply.board, 1).map(a => { const next = apply(reply.board, 1, a).board; return outcome(next) ?? margin(next) / TOTAL_TILES; }));
    }));
    if (expired()) break;
    time += cost; continued.push(c);
  }
  if (continued.length) { active = continued; latest.stage = 'C'; localRank(); await publish(); }

  // The learned search is stationary. Its visit-based preference replaces local heuristics as the gate opens.
  time = Math.max(time, starts[2]);
  const session = createSearchSession();
  while (time < hard && !expired() && session.simulations < profile.maxSimulations) {
    const step = Math.min(16, profile.maxSimulations - session.simulations);
    const cost = step * 1000 * scale / profile.simulationRate;
    if (time + cost > hard) break;
    const searched = await search(board, session.simulations + step, predict, {
      session, random: () => 0, details: 'root', deadline: opts.deadline,
      checkpoint: async () => { if (expired()) throw new Error('Wide cognitive search cancelled'); },
    }).catch(error => { if (expired()) return null; throw error; });
    if (!searched || expired()) break;
    time += cost;
    const g = ramp(time, starts[2], ramps[2]);
    const maxVisits = Math.max(...searched.candidates.map(c => c.visits));
    if (maxVisits === 0) continue;
    const ranked = searched.candidates.filter(c => c.visits > 0).map(c => {
      const next = apply(board, 1, c.action).board, end = outcome(next);
      const immediate = clamp((margin(next) - initialMargin) / 12);
      return { ...c, score: end !== null ? end * 10 : (1 - g) * immediate + g * (2 * c.visits / maxVisits - 1) };
    }).sort((a, b) => b.score - a.score || b.visits - a.visits || a.action - b.action);
    latest = { ...latest, action: ranked[0].action, elapsedMs: time, stage: 'D', candidates: searched.candidates.length,
      simulations: searched.simulations, weights: [1 - g, 0, 0, g] };
    await publish();
  }
  latest.elapsedMs = Math.min(hard, Math.max(latest.elapsedMs, Math.min(hard, time)));
  if (opts.signal?.aborted) latest.reason = 'cancelled';
  await publish();
  return latest;
}
