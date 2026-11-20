import type { GameAnalysis } from '@gyeol/ai';
import type { AnalysisRequest, AnalysisResponse } from './analysis.worker';

export interface AnalysisJob { result: Promise<GameAnalysis>; cancel: () => void }

export function startAnalysis(request: Omit<AnalysisRequest, 'base'>, onProgress: (analysis: GameAnalysis) => void): AnalysisJob {
  const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let rejectJob: (error: Error) => void = () => {};
  const result = new Promise<GameAnalysis>((resolve, reject) => {
    rejectJob = reject;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true; worker.terminate(); reject(error);
    };
    worker.onmessage = ({ data }: MessageEvent<AnalysisResponse>) => {
      if (settled) return;
      if (data.type === 'progress') onProgress(data.analysis);
      else if (data.type === 'complete') { settled = true; worker.terminate(); resolve(data.analysis); }
      else fail(new Error(data.error));
    };
    worker.onerror = e => fail(new Error(e.message || 'Analysis worker failed'));
    worker.onmessageerror = () => fail(new Error('Analysis response failed'));
    worker.postMessage({ ...request, base: new URL(import.meta.env.BASE_URL, location.href).href } satisfies AnalysisRequest);
  });
  return {
    result,
    cancel: () => {
      if (settled) return;
      settled = true; worker.terminate(); rejectJob(new DOMException('Analysis cancelled', 'AbortError'));
    },
  };
}
