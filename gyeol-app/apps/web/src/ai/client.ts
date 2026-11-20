import { useEffect } from 'react';
import type { Level } from '@gyeol/ai';
import type { Board } from '@gyeol/core';
import type { WorkerRequest, WorkerResponse } from './ai.worker';

type Pending = { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void };
type Body<T> = T extends unknown ? Omit<T, 'id'> : never;

let worker: Worker | undefined;
let ready: Promise<void> | undefined;
let nextId = 1;
let users = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<number, Pending>();

/** AI를 쓰는 화면이 하나도 없으면 30초 뒤 워커를 종료해 wasm 메모리(수십 MB)를 돌려준다 */
const IDLE_MS = 30_000;

function shutdown() {
  for (const p of pending.values()) p.reject(new Error('AI가 종료되었습니다.'));
  pending.clear();
  worker?.terminate();
  worker = undefined;
  ready = undefined;
}

function send(msg: Body<WorkerRequest>): Promise<WorkerResponse> {
  if (!worker) {
    worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data);
    };
    worker.onerror = (e) => {
      const err = new Error(e.message || 'AI를 불러오지 못했습니다.');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      shutdown();
    };
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ ...msg, id });
  });
}

/** 모델을 미리 내려받아 첫 수 대기 시간을 줄인다 */
export function warmup(): Promise<void> {
  ready ??= send({ type: 'init', base: new URL(import.meta.env.BASE_URL, location.href).href }).then(
    () => undefined,
    (e) => {
      ready = undefined;
      throw e;
    },
  );
  return ready;
}

/** AI를 쓰는 화면에서 호출: 화면이 열려 있는 동안 워커를 유지한다 */
export function useAi(active = true) {
  useEffect(() => {
    if (!active) return;
    users++;
    clearTimeout(idleTimer);
    return () => {
      users--;
      if (users === 0) idleTimer = setTimeout(() => users === 0 && shutdown(), IDLE_MS);
    };
  }, [active]);
}

/** 정규 보드(둘 차례 = +1)에서 AI의 수 */
export async function aiMove(canonicalBoard: Board, level: Level): Promise<number> {
  await warmup();
  const res = await send({ type: 'move', board: canonicalBoard, level, seed: (Math.random() * 2 ** 32) >>> 0 });
  return res.action!;
}

/** 정규 보드들의 가치(둘 차례 기준 -1..1) */
export async function aiValues(boards: Board[]): Promise<number[]> {
  await warmup();
  return (await send({ type: 'values', boards })).values!;
}

/** 정규 보드에서 MCTS 추천 수 */
export async function aiBest(board: Board, sims = 200): Promise<number> {
  await warmup();
  return (await send({ type: 'best', board, sims })).action!;
}
