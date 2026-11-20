import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseEngine } from './database';

const engine = new DatabaseEngine(workerData.path, workerData.create);
let commands = 0, failures = 0, lastWriteFailureAt: number | null = null;
let lastCommandMs = 0, maxCommandMs = 0;
const writes = new Set(['authenticate','seedPlayer','patchPlayer','syncBots','seedGame','patchGame','createGame','joinGame','applyMove','finishGame','recover','importData']);
let chain = Promise.resolve();
parentPort!.on('message', ({ id, method, args }) => {
  chain = chain.then(async () => {
    const began = performance.now();
    commands++;
    try {
      const fn = engine[method as keyof DatabaseEngine];
      if (typeof fn !== 'function' || method === 'constructor' || method.startsWith('_')) throw new Error('Unknown DB command');
      let result = await (fn as (...args: unknown[]) => unknown).apply(engine, args);
      if (writes.has(method)) lastWriteFailureAt = null;
      lastCommandMs = performance.now() - began; maxCommandMs = Math.max(maxCommandMs,lastCommandMs);
      if (method === 'health') result = { ...(result as object), ok: lastWriteFailureAt === null,
        metrics: { commands, failures, lastWriteFailureAt, lastCommandMs, maxCommandMs } };
      parentPort!.postMessage({ id, result });
      if (method === 'close') parentPort!.close();
    } catch (error) {
      const e = error as Error & { code?: string };
      failures++;
      if (writes.has(method)) lastWriteFailureAt = Date.now();
      parentPort!.postMessage({ id, error: { message: e.message, code: e.code } });
    }
  });
});
parentPort!.postMessage({ ready: true });
