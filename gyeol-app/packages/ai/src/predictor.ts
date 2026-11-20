import { legal, type Board } from '@gyeol/core';
import type { Predict, Prediction } from './mcts';

/** WASM tanh의 float32 끝점 오차만 보정한다. 비정상 출력까지 정상 값으로 숨기지 않는다. */
export function normalizeNetworkValue(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > 1 + 1e-6) throw new Error(`Invalid network value: ${value}`);
  return Math.max(-1, Math.min(1, value));
}

/** 쓰는 부분만 정의한 onnxruntime-web 타입 */
export interface OrtTensor {
  data: ArrayLike<number>;
}
export interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}
export interface Ort {
  env: { wasm: { numThreads: number; wasmPaths: string } };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
  InferenceSession: { create(model: string | Uint8Array, opts: object): Promise<OrtSession> };
}

/**
 * 메모리를 아끼는 추론기.
 * - 785칸 정책 전체 대신 합법 수의 확률만 저장 (보통 10~40개 → 국면당 수백 바이트)
 * - LRU 캐시 상한 (기본 4,000 국면)
 * - ONNX Runtime의 메모리 아레나/패턴 비활성화: 입력 크기가 고정이라 속도 차이는 작고 상주 메모리가 줄어든다
 */
export async function createPredictor(ort: Ort, model: string | Uint8Array, cacheSize = 4000, lowMemory = true) {
  const session = await ort.InferenceSession.create(model, {
    executionProviders: ['wasm'],
    enableCpuMemArena: !lowMemory,
    enableMemPattern: !lowMemory,
    executionMode: 'sequential',
    graphOptimizationLevel: 'all',
  });
  const cache = new Map<string, Prediction>();
  const stats = { executions: 0, cacheHits: 0, inferenceMs: 0 };
  const predict: Predict = async (board: Board) => {
    const key = board.join(',');
    const hit = cache.get(key);
    if (hit) {
      stats.cacheHits++;
      // LRU: 최근 사용으로 갱신
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const started = performance.now();
    const out = await session.run({ board: new ort.Tensor('float32', Float32Array.from(board), [1, 7, 7]) });
    stats.executions++; stats.inferenceMs += performance.now() - started;
    const log = out.log_policy.data;
    const priors = Float32Array.from(legal(board, 1), (a) => Math.exp(log[a]));
    const value: Prediction = { priors, value: normalizeNetworkValue(Number(out.value.data[0])) };
    // 타일 차이 출력(margin)은 새 모델에만 있다. 없으면 기존처럼 정책·가치만 쓴다.
    const margin = out.margin ? Number(out.margin.data[0]) : NaN;
    if (Number.isFinite(margin)) value.margin = Math.max(-25, Math.min(25, margin));
    cache.set(key, value);
    if (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
    return value;
  };

  return {
    predict,
    stats,
    clearCache: () => cache.clear(),
    async dispose() {
      cache.clear();
      await session.release?.();
    },
  };
}
