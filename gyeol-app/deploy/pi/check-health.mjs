import { readFileSync } from 'node:fs';
const env = readFileSync('/etc/gyeol/server.env', 'utf8');
const port = env.match(/^PORT=(\d+)$/m)?.[1] ?? '8787';
try {
  const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
  if (!r.ok || (await r.json()).ok !== true) process.exit(1);
} catch { process.exit(1); }
