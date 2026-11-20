import { type TimeMode } from '@gyeol/core';

export const COGNITION_VERSION = 'cognition-v1';
export interface CognitiveProfile {
  version: typeof COGNITION_VERSION;
  skillPosition: number;
  targetTier: 'bronze' | 'silver' | 'gold' | 'plat' | 'dia' | 'master';
  /** B (reply), C (continuation), D (network), milliseconds in blitz. */
  startMs: [number, number, number];
  rampMs: [number, number, number];
  candidateWidth: number;
  workRate: number;
  simulationRate: number;
  earlyCommitGap: number;
  minimumThinkMs: number;
}
export interface CognitivePersona { id: string; name: string; cognition: CognitiveProfile }

const STARTS = [[2400, 5500, 9000], [1600, 3800, 6500], [1000, 2300, 4000],
  [650, 1500, 2800], [400, 950, 1700], [250, 550, 1000]];
const WIDTHS = [2, 3, 4, 6, 8, 12];
const TIERS: CognitiveProfile['targetTier'][] = ['bronze', 'silver', 'gold', 'plat', 'dia', 'master'];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Continuous profiles, including both ends of the approved six-tier range. */
export function cognitiveProfile(position: number): CognitiveProfile {
  if (!Number.isFinite(position) || position < 0 || position > 1) throw new Error('Invalid skill position');
  const x = position * 5, lo = Math.min(4, Math.floor(x)), f = x - lo;
  const startMs = STARTS[lo].map((a, k) => lerp(a, STARTS[lo + 1][k], f)) as [number, number, number];
  return {
    version: COGNITION_VERSION, skillPosition: position, targetTier: TIERS[Math.round(x)],
    startMs, rampMs: startMs.map(x => x / 2) as [number, number, number],
    candidateWidth: lerp(WIDTHS[lo], WIDTHS[lo + 1], f),
    workRate: lerp(0.7, 2.5, position), simulationRate: lerp(12, 80, position),
    earlyCommitGap: lerp(0.10, 0.025, position), minimumThinkMs: lerp(1200, 600, position),
  };
}

export function createCognitiveRoster(identities: { id: string; name: string }[]): CognitivePersona[] {
  if (identities.length < 2 || new Set(identities.map(x => x.id)).size !== identities.length ||
      new Set(identities.map(x => x.name)).size !== identities.length) throw new Error('Invalid roster identities');
  return identities.map((p, i) => ({ id: p.id, name: p.name, cognition: cognitiveProfile(i / (identities.length - 1)) }));
}

export const cognitionModeScale = (mode: TimeMode) => mode === 'bullet' ? 0.65 : mode === 'rapid' ? 1.15 : 1;
