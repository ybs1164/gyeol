import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import type { DatabaseEngine } from './database';

/** Structured async commands; callers never mutate persisted state. */
export class Store {
  private worker: Worker;
  private next = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  readonly ready: Promise<void>;
  private failure?: Error;
  private closing = false;
  private closed?: Promise<void>;
  constructor(path: string | null = null, create = false) {
    const options = { path: path ?? ':memory:', create: path === null || create };
    if (import.meta.url.endsWith('.ts')) {
      const module = new URL('./database.worker.ts', import.meta.url).href;
      this.worker = new Worker(`import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(module)}, ${JSON.stringify(import.meta.url)}));`,
        { eval: true, workerData: options });
    } else {
      const file = new URL('./database.worker.mjs', import.meta.url);
      if (!existsSync(file)) throw new Error('DB worker is missing; rebuild the server package');
      this.worker = new Worker(file, { workerData: options });
    }
    this.ready = new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        this.failure = error; reject(error);
        for (const job of this.pending.values()) job.reject(error);
        this.pending.clear();
      };
      this.worker.on('error', fail);
      this.worker.on('exit', code => {
        if (!this.closing || code !== 0) fail(new Error(`Database worker exited (${code})`));
      });
      this.worker.on('message', message => {
        if (message.ready) { resolve(); return; }
        const job = this.pending.get(message.id); if (!job) return;
        this.pending.delete(message.id);
        if (message.error) job.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else job.resolve(message.result);
      });
    });
    void this.ready.catch(() => undefined);
  }

  async call<K extends { [P in keyof DatabaseEngine]: DatabaseEngine[P] extends (...args: any[]) => any ? P : never }[keyof DatabaseEngine]>(
    method: K, ...args: Parameters<Extract<DatabaseEngine[K], (...args: any[]) => any>>
  ): Promise<Awaited<ReturnType<Extract<DatabaseEngine[K], (...args: any[]) => any>>>> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.closing) throw new Error('Database is closing');
    const id = ++this.next;
    return new Promise<Awaited<ReturnType<Extract<DatabaseEngine[K], (...args: any[]) => any>>>>((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, method, args }); });
  }

  close(): Promise<void> {
    return this.closed ??= (async () => {
      try { await this.call('close'); } finally { this.closing = true; await this.worker.terminate(); }
    })();
  }
}
