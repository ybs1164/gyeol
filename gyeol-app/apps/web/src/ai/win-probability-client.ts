import type { WinRequest, WinResponse } from './win-probability.worker';
import type { GameAnalysis, MoveAnalysis, WinAnalysis } from '@gyeol/ai';

type WithoutEnvelope<T> = T extends unknown ? Omit<T, 'id' | 'base'> : never;
type Pending = { resolve: (response: WinResponse) => void; reject: (error: Error) => void; progress?: (response: WinResponse) => void };
export interface WinJob<T> { result: Promise<T>; cancel: () => void }

/** 복기 화면이 살아 있는 동안 ONNX 세션을 재사용한다. 그래프와 상세 수 분석은 순서대로 실행한다. */
export class WinAnalysisClient {
  private worker?: Worker;
  private nextId = 0;
  private pending = new Map<number, Pending>();

  private send(request: WithoutEnvelope<WinRequest>, progress?: (response: WinResponse) => void): WinJob<WinResponse> {
    if (!this.worker) {
      const worker = new Worker(new URL('./win-probability.worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      worker.onmessage = ({ data }: MessageEvent<WinResponse>) => {
        if (worker !== this.worker) return;
        const pending = this.pending.get(data.id);
        if (!pending) return;
        if (data.type === 'progress' || data.type === 'gradesProgress') { pending.progress?.(data); return; }
        this.pending.delete(data.id);
        if (data.type === 'error') { pending.reject(new Error(data.error)); this.dispose(new Error(data.error)); }
        else pending.resolve(data);
      };
      worker.onerror = e => { if (worker === this.worker) this.dispose(new Error(e.message || 'Analysis failed')); };
      worker.onmessageerror = () => { if (worker === this.worker) this.dispose(new Error('Invalid analysis response')); };
    }
    const id = ++this.nextId;
    const result = new Promise<WinResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      try { this.worker!.postMessage({ ...request, id, base: new URL(import.meta.env.BASE_URL, location.href).href }); }
      catch (e) { this.pending.delete(id); reject(e); }
    });
    return { result, cancel: () => { if (this.pending.has(id)) this.dispose(); } };
  }

  graph(request: Extract<WithoutEnvelope<WinRequest>, { task: 'graph' }>, progress: (graph: WinAnalysis) => void, grades?: (analysis: GameAnalysis) => void): WinJob<WinAnalysis> {
    const job = this.send(request, response => {
      if (response.type === 'progress') progress(response.graph);
      if (response.type === 'gradesProgress') grades?.(response.analysis);
    });
    return { ...job, result: job.result.then(r => { if (r.type !== 'graph') throw new Error('Invalid graph response'); return r.graph; }) };
  }

  move(request: Extract<WithoutEnvelope<WinRequest>, { task: 'move' }>): WinJob<MoveAnalysis> {
    const job = this.send(request);
    return { ...job, result: job.result.then(r => { if (r.type !== 'move') throw new Error('Invalid move response'); return r.move; }) };
  }

  grades(request: Extract<WithoutEnvelope<WinRequest>, { task: 'grades' }>, progress: (analysis: GameAnalysis) => void): WinJob<GameAnalysis> {
    const job = this.send(request, response => { if (response.type === 'gradesProgress') progress(response.analysis); });
    return { ...job, result: job.result.then(r => { if (r.type !== 'grades') throw new Error('Invalid grades response'); return r.analysis; }) };
  }

  dispose(error: Error = new DOMException('Analysis cancelled', 'AbortError')) {
    this.worker?.terminate(); this.worker = undefined;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
}
