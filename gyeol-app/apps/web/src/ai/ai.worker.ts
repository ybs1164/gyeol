/// <reference lib="webworker" />
import { chooseMove, search, type Level, type Predict } from '@gyeol/ai';
import { rng, type Board } from '@gyeol/core';
import { createPredictor, type Ort } from './predictor';
import { MODEL_VERSION } from './analysis-version';

export type WorkerRequest =
  | { id: number; type: 'init'; base: string }
  | { id: number; type: 'move'; board: Board; level: Level; seed: number }
  /** 각 정규 보드의 가치(둘 차례 기준 -1..1) */
  | { id: number; type: 'values'; boards: Board[] }
  /** 정규 보드에서 MCTS 최선 수 */
  | { id: number; type: 'best'; board: Board; sims: number };

export type WorkerResponse = { id: number; action?: number; values?: number[]; ready?: true; error?: string };

let base = '/';
let ready: Promise<Predict> | undefined;

function load(): Promise<Predict> {
  ready ??= (async () => {
    const ort: Ort = await import(/* @vite-ignore */ `${base}ort/ort.wasm.min.mjs`);
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = `${base}ort/`;
    return (await createPredictor(ort, `${base}model/model.onnx?v=${MODEL_VERSION}`)).predict;
  })();
  ready.catch(() => (ready = undefined));
  return ready;
}

self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  const reply = (msg: Omit<WorkerResponse, 'id'>) => self.postMessage({ id: data.id, ...msg } satisfies WorkerResponse);
  try {
    if (data.type === 'init') {
      base = data.base;
      await load();
      return reply({ ready: true });
    }
    const predict = await load();
    if (data.type === 'move') reply({ action: await chooseMove(data.board, data.level, predict, rng(data.seed)) });
    else if (data.type === 'values') {
      const values: number[] = [];
      for (const b of data.boards) values.push((await predict(b)).value);
      reply({ values });
    } else reply({ action: (await search(data.board, data.sims, predict, { random: rng(1) })).action });
  } catch (e) {
    reply({ error: e instanceof Error ? e.message : String(e) });
  }
};
