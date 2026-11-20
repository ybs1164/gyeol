/// <reference lib="webworker" />
import { analyzeGameGrades, analyzeMove, analyzeWinProbability, type AnalysisMode, type AnalysisPosition, type GameAnalysis, type MoveAnalysis, type WinAnalysis } from '@gyeol/ai';
import { createPredictor, type Ort } from './predictor';
import { MODEL_VERSION } from './analysis-version';
import { PROBABILITY_CALIBRATIONS } from './probability-calibrations';

export type WinRequest = { id: number; base: string; mode: AnalysisMode } & (
  | { task: 'graph'; moves: number[]; start: AnalysisPosition; resume?: WinAnalysis; includeGrades?: boolean; gradeResume?: GameAnalysis }
  | { task: 'move'; position: AnalysisPosition; played: number; ply: number }
  | { task: 'grades'; moves: number[]; start: AnalysisPosition; resume?: GameAnalysis }
);
export type WinResponse = { id: number } & (
  | { type: 'progress'; graph: WinAnalysis }
  | { type: 'graph'; graph: WinAnalysis; runtime: { loadMs: number; executions: number; cacheHits: number; inferenceMs: number } }
  | { type: 'move'; move: MoveAnalysis }
  | { type: 'gradesProgress'; analysis: GameAnalysis }
  | { type: 'grades'; analysis: GameAnalysis }
  | { type: 'error'; error: string }
);
type Payload<T> = T extends unknown ? Omit<T, 'id'> : never;
let brain: Promise<Awaited<ReturnType<typeof createPredictor>>> | undefined;
const load = (base: string) => brain ??= (async () => {
  const ort: Ort = await import(/* @vite-ignore */ `${base}ort/ort.wasm.min.mjs`);
  ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = `${base}ort/`;
  return createPredictor(ort, `${base}model/model.onnx?v=${MODEL_VERSION}`);
})();
let queue: Promise<void> = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<WinRequest>) => {
  queue = queue.then(async () => {
    const post = (message: Payload<WinResponse>) => self.postMessage({ ...message, id: data.id });
    try {
      const started = performance.now();
      const predictor = await load(data.base);
      const loadMs = performance.now() - started;
      const before = { ...predictor.stats };
      let yielded = performance.now();
      const checkpoint = async () => {
        if (performance.now() - yielded >= 16) { await new Promise(r => setTimeout(r, 0)); yielded = performance.now(); }
      };
      if (data.task === 'graph') {
        const graph = await analyzeWinProbability(data.moves, predictor.predict, {
          start: data.start, mode: data.mode, resume: data.resume, model: MODEL_VERSION, calibrations: PROBABILITY_CALIBRATIONS,
          checkpoint, onProgress: graph => post({ type: 'progress', graph }),
          onPreview: data.includeGrades ? async () => {
            const analysis = await analyzeGameGrades(data.moves, predictor.predict, {
              start: data.start, mode: data.mode, resume: data.gradeResume, checkpoint, fastOnly: true,
              onProgress: analysis => post({ type: 'gradesProgress', analysis }),
            });
            post({ type: 'gradesProgress', analysis });
          } : undefined,
        });
        const runtime = { loadMs, executions: predictor.stats.executions - before.executions, cacheHits: predictor.stats.cacheHits - before.cacheHits, inferenceMs: predictor.stats.inferenceMs - before.inferenceMs };
        Object.assign(graph.metrics, runtime);
        post({ type: 'graph', graph, runtime });
      } else if (data.task === 'grades') {
        const analysis = await analyzeGameGrades(data.moves, predictor.predict, {
          start: data.start, mode: data.mode, resume: data.resume, checkpoint,
          onProgress: analysis => post({ type: 'gradesProgress', analysis }),
        });
        post({ type: 'grades', analysis });
      } else post({ type: 'move', move: await analyzeMove(data.position, data.played, data.ply, predictor.predict, { mode: data.mode, checkpoint }) });
    } catch (e) {
      brain = undefined;
      post({ type: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  });
};
