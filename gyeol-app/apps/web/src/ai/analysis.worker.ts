/// <reference lib="webworker" />
import { analyzeGame, type AnalysisMode, type AnalysisPosition, type GameAnalysis } from '@gyeol/ai';
import { createPredictor, type Ort } from './predictor';
import { MODEL_VERSION } from './analysis-version';

export interface AnalysisRequest { moves: number[]; start?: AnalysisPosition; mode: AnalysisMode; resume?: GameAnalysis; base: string }
export type AnalysisResponse =
  | { type: 'progress'; analysis: GameAnalysis }
  | { type: 'complete'; analysis: GameAnalysis }
  | { type: 'error'; error: string };

// 대국 워커와 분리한다. 취소 시 이 워커만 종료하면 ONNX 실행 중에도 즉시 취소된다.
self.onmessage = async ({ data }: MessageEvent<AnalysisRequest>) => {
  const post = (message: AnalysisResponse) => self.postMessage(message);
  let brain: Awaited<ReturnType<typeof createPredictor>> | undefined;
  try {
    const ort: Ort = await import(/* @vite-ignore */ `${data.base}ort/ort.wasm.min.mjs`);
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = `${data.base}ort/`;
    brain = await createPredictor(ort, `${data.base}model/model.onnx?v=${MODEL_VERSION}`);
    let lastYield = performance.now();
    const checkpoint = async () => {
      if (performance.now() - lastYield >= 12) {
        await new Promise(r => setTimeout(r, 0));
        lastYield = performance.now();
      }
    };
    const analysis = await analyzeGame(data.moves, brain.predict, {
      mode: data.mode, start: data.start, resume: data.resume, checkpoint,
      onProgress: analysis => post({ type: 'progress', analysis }),
    });
    post({ type: 'complete', analysis });
  } catch (e) {
    post({ type: 'error', error: e instanceof Error ? e.message : String(e) });
  } finally {
    await brain?.dispose();
  }
};
