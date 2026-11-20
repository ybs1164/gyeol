/**
 * 서버(Node)에서 학습 모델을 돌린다. 브라우저와 같은 onnxruntime-web(wasm)과 model.onnx 를 쓴다.
 * aiDir 에는 ort/ 와 model/model.onnx 가 있어야 한다 (apps/web/public 또는 빌드된 apps/web/dist).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPredictor, type Ort, type Predict } from '@gyeol/ai';

export function hasModel(aiDir: string): boolean {
  return existsSync(join(aiDir, 'model', 'model.onnx')) && existsSync(join(aiDir, 'ort', 'ort.wasm.min.mjs'));
}

export async function loadBrain(aiDir: string, cacheSize = 20_000): Promise<Predict> {
  return (await loadBrainContext(aiDir, cacheSize)).predict;
}

/** 벤치마크에서는 모델 실행 횟수와 추론 시간을 따로 측정한다. */
export async function loadBrainContext(aiDir: string, cacheSize = 20_000) {
  const ort: Ort = await import(/* @vite-ignore */ pathToFileURL(join(aiDir, 'ort', 'ort.wasm.min.mjs')).href);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = pathToFileURL(join(aiDir, 'ort') + '/').href;
  const model = readFileSync(join(aiDir, 'model', 'model.onnx'));
  return createPredictor(ort, model, cacheSize);
}
