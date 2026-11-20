import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: { server: 'packages/server/src/main.ts', 'database.worker': 'packages/server/src/database.worker.ts', 'db-cli': 'packages/server/src/db-cli.ts' },
  outdir: 'packages/server/dist', outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['better-sqlite3', 'bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
await build({ absWorkingDir: root, entryPoints: ['tools/server_smoke.ts'], outfile: 'packages/server/dist/smoke.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['bufferutil','utf-8-validate'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
mkdirSync(new URL('../packages/server/dist/migrations/', import.meta.url), { recursive: true });
cpSync(new URL('../packages/server/src/migrations/001.sql', import.meta.url), new URL('../packages/server/dist/migrations/001.sql', import.meta.url));
