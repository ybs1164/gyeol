import { ANALYSIS_VERSION, GRADES, GRADING_VERSION, MOVE_BADGES, decideMove, type AnalysisMode, type GameAnalysis, type MoveAnalysis } from '@gyeol/ai';
import { initial, PASS } from '@gyeol/core';
import { MODEL_VERSION } from '../ai/analysis-version';
import type { GameRecord } from './storage';
import { WIN_ANALYSIS_VERSION, WIN_ROOT_EVALUATOR, ROOT_SIMULATIONS, calibrationId, type WinAnalysis } from '@gyeol/ai';
import { PROBABILITY_CALIBRATIONS } from '../ai/probability-calibrations';

const STORE = 'analysis';
const MAX_ENTRIES = 100;
const MAX_BYTES = 24 * 1024 * 1024;
let opening: Promise<IDBDatabase | null> | undefined;
function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise(resolve => {
    try {
      const request = indexedDB.open('gyeol-analysis', 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { opening = undefined; resolve(null); };
      request.onblocked = () => { opening = undefined; resolve(null); };
    } catch { resolve(null); }
  });
  return opening;
}

export function winAnalysisKey(record: GameRecord, mode: AnalysisMode): string {
  return JSON.stringify(['win', WIN_ANALYSIS_VERSION, WIN_ROOT_EVALUATOR, ROOT_SIMULATIONS[mode], calibrationId(PROBABILITY_CALIBRATIONS), MODEL_VERSION,
    record.ruleVersion ?? 'facing-25-v1', mode, record.initialBoard ?? initial(), record.initialPlayer ?? 1, record.moves]);
}

export function validWinAnalysis(value: unknown, length: number, mode: AnalysisMode): value is WinAnalysis {
  if (!value || typeof value !== 'object') return false;
  const a = value as WinAnalysis;
  return a.version === WIN_ANALYSIS_VERSION && a.mode === mode && typeof a.input === 'string' && typeof a.complete === 'boolean'
    && a.evaluator === WIN_ROOT_EVALUATOR
    && a.model === MODEL_VERSION
    && ['preview', 'search', 'proof', 'complete'].includes(a.stage) && a.calibration === calibrationId(PROBABILITY_CALIBRATIONS)
    && Array.isArray(a.positions) && a.positions.length === length + 1
    && (!a.complete || (a.stage === 'complete' && a.positions.every(p => p && p.source !== 'network'))) && typeof a.metrics === 'object' && a.metrics !== null
    && (a.metrics.previewMs === null || (Number.isFinite(a.metrics.previewMs) && a.metrics.previewMs >= 0))
    && ['evaluations', 'simulations', 'exactNodes', 'totalMs'].every(k => Number.isFinite(a.metrics[k as keyof typeof a.metrics]) && (a.metrics[k as keyof typeof a.metrics] ?? -1) >= 0)
    && a.positions.every(p => p === null || (typeof p === 'object' && Number.isFinite(p.green) && p.green >= 0 && p.green <= 1
      && Number.isFinite(p.rawValue) && Math.abs(p.rawValue) <= 1 && Number.isInteger(p.simulations) && p.simulations >= 0
      && ['estimated', 'exact'].includes(p.status) && ['network', 'search', 'terminal', 'proven'].includes(p.source) && typeof p.calibrated === 'boolean'
      && (p.source === 'proven' && p.provenOutcome !== 0
        ? Number.isInteger(p.forcedWinPlies) && p.forcedWinPlies! >= 1 && p.forcedWinPlies! <= 50 && ['exact', 'upper-bound'].includes(p.winDistanceKind ?? '')
        : p.forcedWinPlies === undefined && p.winDistanceKind === undefined)
      && (p.status === 'exact'
        ? ['terminal', 'proven'].includes(p.source) && [-1, 0, 1].includes(p.provenOutcome!) && p.simulations === 0 && p.calibrated === false
        : p.source === 'network' ? p.simulations === 0 : p.source === 'search' && p.simulations === ROOT_SIMULATIONS[mode])));
}

export async function loadWinAnalysis(key: string, length: number, mode: AnalysisMode): Promise<WinAnalysis | null> {
  const db = await open(); if (!db) return null;
  return new Promise(resolve => {
    try {
      const request = db.transaction(STORE).objectStore(STORE).get(key);
      request.onsuccess = () => resolve(validWinAnalysis(request.result?.analysis, length, mode) ? request.result.analysis : null);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export function analysisKey(record: GameRecord, mode: AnalysisMode): string {
  // 입력 전체를 키에 넣어 짧은 해시 충돌로 다른 기보를 혼동하지 않는다.
  return JSON.stringify([ANALYSIS_VERSION, GRADING_VERSION, MODEL_VERSION, record.ruleVersion ?? 'facing-25-v1', mode, record.initialBoard ?? initial(), record.initialPlayer ?? 1, record.moves]);
}

export function validAnalysis(value: unknown, length: number, mode: AnalysisMode): value is GameAnalysis {
  if (!value || typeof value !== 'object') return false;
  const a = value as GameAnalysis;
  return a.version === ANALYSIS_VERSION && a.gradingVersion === GRADING_VERSION && a.mode === mode
    && typeof a.complete === 'boolean'
    && Array.isArray(a.positions) && a.positions.length === length + 1 && Array.isArray(a.moves) && a.moves.length === length
    && (!a.complete || (a.positions.every(Boolean) && a.moves.every(Boolean)))
    && a.positions.every(p => p === null || (typeof p === 'object' && Number.isFinite(p.green) && p.green >= 0 && p.green <= 1 && ['estimated', 'stable', 'exact'].includes(p.status)))
    && a.moves.every((m, i) => m === null || (typeof m === 'object' && m.ply === i + 1 && (m.player === 1 || m.player === -1)
      && Number.isFinite(m.lossPp) && m.lossPp >= 0 && typeof m.forced === 'boolean' && (m.grade === null || GRADES.includes(m.grade))
      && ['estimated', 'stable', 'exact'].includes(m.status) && Array.isArray(m.bestActions) && m.bestActions.length > 0
      && Array.isArray(m.badges) && m.badges.every(b => MOVE_BADGES.includes(b))
      && Array.isArray(m.candidates) && m.candidates.length > 0
      && m.candidates.every(c => c !== null && typeof c === 'object' && Number.isFinite(c.value) && c.value >= -1 && c.value <= 1
        && Number.isInteger(c.action) && c.action >= 0 && c.action <= 784 && Number.isFinite(c.simulations) && c.simulations >= 0
        && ['estimated', 'stable', 'exact'].includes(c.status) && Array.isArray(c.pv) && c.pv[0] === c.action
        && c.pv.every(a => Number.isInteger(a) && a >= 0 && a <= 784)
        && (c.drift === undefined || Number.isFinite(c.drift) && c.drift >= 0)
        && (c.shallow === undefined || Number.isFinite(c.shallow) && Math.abs(c.shallow) <= 1)
        && (c.status !== 'exact' || [-1, 0, 1].includes(c.value) && typeof c.resultKey === 'string' && c.resultKey.split(',').length === 49 && c.resultKey.split(',').every(v => /^-?[0-4]$/.test(v))))
      && m.candidates.some(c => c.action === m.played) && m.bestActions.every(a => m.candidates.some(c => c.action === a))
      && validDecision(m)));
}

/** Reject stale or internally contradictory decisions instead of repairing them in the UI. */
function validDecision(move: MoveAnalysis): boolean {
  try {
    if (new Set(move.candidates.map(c => c.action)).size !== move.candidates.length) return false;
    const expected = decideMove(move.candidates, move.played, PASS);
    const fields = ['bestValue', 'playedValue', 'lossPoints', 'lossPp', 'grade', 'provisionalGrade', 'reasonCode', 'forced', 'status'] as const;
    return fields.every(key => move[key] === expected[key])
      && JSON.stringify(move.bestActions) === JSON.stringify(expected.bestActions)
      && JSON.stringify(move.lossRange) === JSON.stringify(expected.lossRange)
      && expected.badges.every(b => move.badges.includes(b))
      && new Set(move.badges).size === move.badges.length
      && move.badges.every(b => expected.badges.includes(b) || b === 'convertedChance' && expected.badges.some(b => b === 'missedWin' || b === 'missedChance'));
  } catch { return false; }
}

export async function loadAnalysis(key: string, length: number, mode: AnalysisMode): Promise<GameAnalysis | null> {
  const db = await open();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const request = db.transaction(STORE).objectStore(STORE).get(key);
      request.onsuccess = () => resolve(validAnalysis(request.result?.analysis, length, mode) ? request.result.analysis : null);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function saveAnalysis(key: string, analysis: GameAnalysis | WinAnalysis): Promise<void> {
  const db = await open();
  if (!db) return;
  // 저장 실패는 복기를 중단하지 않는다. 기보는 별도 localStorage에 보존된다.
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.put({ key, analysis, updated: Date.now(), bytes: JSON.stringify(analysis).length * 2 });
      const all = store.getAll();
      all.onsuccess = () => {
        const entries = all.result.sort((a, b) => b.updated - a.updated);
        let bytes = 0;
        for (let i = 0; i < entries.length; i++) {
          bytes += entries[i].bytes ?? 0;
          if (i >= MAX_ENTRIES || bytes > MAX_BYTES) store.delete(entries[i].key);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}
