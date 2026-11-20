import { describe, expect, test } from 'vitest';
import { ANALYSIS_VERSION, GRADING_VERSION, analyzeGameGrades, analyzeWinProbability, emptyAnalysis, emptyWinAnalysis } from '@gyeol/ai';
import { initial, legal } from '@gyeol/core';
import { analysisKey, winAnalysisKey, loadAnalysis, saveAnalysis, validAnalysis, validWinAnalysis } from '../src/lib/analysis-storage';
import { MODEL_VERSION } from '../src/ai/analysis-version';
import type { GameRecord } from '../src/lib/storage';

const record: GameRecord = { id: 'a', mode: 'local', date: 1, moves: [393], me: null, winner: 1 };
describe('복기 캐시', () => {
  test('승률 그래프 캐시는 수 등급 캐시와 분리하고 손상된 결과를 거부한다', async () => {
    expect(winAnalysisKey(record, 'standard')).not.toBe(analysisKey(record, 'standard'));
    expect(winAnalysisKey(record, 'deep')).not.toBe(winAnalysisKey(record, 'standard'));
    const graph = emptyWinAnalysis(record.moves, { model: MODEL_VERSION });
    expect(validWinAnalysis(graph, 1, 'standard')).toBe(true);
    expect(validWinAnalysis({ ...graph, complete: true }, 1, 'standard')).toBe(false);
    expect(validWinAnalysis({ ...graph, model: 'other' }, 1, 'standard')).toBe(false);
    expect(validWinAnalysis({ ...graph, positions: [{ green: NaN }, null] }, 1, 'standard')).toBe(false);
    const complete = await analyzeWinProbability([], async b => ({ priors: legal(b, 1).map(() => 1), value: 0.2 }), { model: MODEL_VERSION, exactMs: 0 });
    expect(validWinAnalysis(complete, 0, 'standard')).toBe(true);
    const broken = structuredClone(complete);
    broken.positions[0]!.source = 'network';
    expect(validWinAnalysis(broken, 0, 'standard')).toBe(false);
    const proven = structuredClone(complete);
    proven.positions[0] = { green: 1, status: 'exact', source: 'proven', provenOutcome: 1, rawValue: 1, simulations: 0, calibrated: false, forcedWinPlies: 3, winDistanceKind: 'upper-bound' };
    expect(validWinAnalysis(proven, 0, 'standard')).toBe(true);
    proven.positions[0].forcedWinPlies = undefined;
    expect(validWinAnalysis(proven, 0, 'standard')).toBe(false);
  });
  test('기보·시작판·차례·분석 모드를 키에서 구분하고 ID만 다른 동일 기보는 재사용한다', () => {
    const base = analysisKey(record, 'standard');
    expect(analysisKey({ ...record, id: 'b' }, 'standard')).toBe(base);
    expect(analysisKey(record, 'deep')).not.toBe(base);
    expect(analysisKey({ ...record, moves: [385] }, 'standard')).not.toBe(base);
    expect(analysisKey({ ...record, initialPlayer: -1 }, 'standard')).not.toBe(base);
    expect(analysisKey({ ...record, initialBoard: initial().map(v => -v) }, 'standard')).not.toBe(base);
  });

  test('부분 결과는 허용하고 손상된 캐시는 거부한다', () => {
    const a = emptyAnalysis(1, 'standard');
    expect(validAnalysis(a, 1, 'standard')).toBe(true);
    expect(validAnalysis(a, 2, 'standard')).toBe(false);
    expect(validAnalysis(a, 1, 'deep')).toBe(false);
    expect(validAnalysis({ ...a, version: -1 }, 1, 'standard')).toBe(false);
    expect(validAnalysis({ ...a, positions: [{ green: NaN }, null] }, 1, 'standard')).toBe(false);
    expect(validAnalysis({ ...a, positions: [false, null] }, 1, 'standard')).toBe(false);
    expect(validAnalysis({ ...a, moves: [{ candidates: [null] }] }, 1, 'standard')).toBe(false);
  });

  test('IndexedDB를 사용할 수 없어도 분석 저장·불러오기는 실패를 전파하지 않는다', async () => {
    await expect(loadAnalysis('x', 1, 'standard')).resolves.toBeNull();
    await expect(saveAnalysis('x', emptyAnalysis(1, 'standard'))).resolves.toBeUndefined();
  });

  test('new decisions survive JSON storage while missing or contradictory reasons and grades are rejected', async () => {
    const analysis = await analyzeGameGrades(record.moves, async b => ({ value: 0, priors: legal(b, 1).map(() => 1) }));
    expect(validAnalysis(JSON.parse(JSON.stringify(analysis)), 1, 'standard')).toBe(true);
    const move = analysis.moves[0]!;
    for (const change of [
      { provisionalGrade: undefined }, { grade: 'good' }, { lossPoints: 20 }, { reasonCode: 'preservedWin' },
      { bestValue: 1 }, { status: 'exact' }, { lossRange: [0, 1] }, { badges: ['onlyWin'] },
    ]) expect(validAnalysis({ ...analysis, moves: [{ ...move, ...change }] }, 1, 'standard')).toBe(false);
    expect(validAnalysis({ ...analysis, version: 4, gradingVersion: 2 }, 1, 'standard')).toBe(false);
    const key = JSON.parse(analysisKey(record, 'standard'));
    expect(key.slice(0, 2)).toEqual([ANALYSIS_VERSION, GRADING_VERSION]);
    // Changing grade schema must not invalidate the independent graph cache.
    expect(JSON.parse(winAnalysisKey(record, 'standard')).slice(0, 2)).toEqual(['win', 5]);
  });
});
