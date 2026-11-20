/** Local play with the exact batch profiles, separate accounts and match history. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type WideCognitivePersona as CognitivePersona, WIDE_COGNITION_VERSION as COGNITION_VERSION } from '@gyeol/ai';
import { loadBrain } from '../packages/server/src/brain';
import { createServer } from '../packages/server/src/server';

const root = fileURLToPath(new URL('../', import.meta.url));
const batch = join(root, 'tools/calibration/cognition-v2-wide');
const manifest = JSON.parse(readFileSync(join(batch, 'manifest.json'), 'utf8')) as { modelHash: string };
const profiles = JSON.parse(readFileSync(join(batch, 'roster.json'), 'utf8')) as CognitivePersona[];
if (profiles.length !== 1000 || profiles.some(p => p.cognition.version !== COGNITION_VERSION)) throw new Error('Invalid batch profiles');
for (const file of ['packages/ai/src/cognition-wide.ts', 'packages/core/src/rules.ts', 'packages/ai/src/cognition.ts', 'packages/ai/src/cognitive-persona.ts',
  'packages/ai/src/time-policy.ts', 'packages/ai/src/mcts.ts', 'packages/ai/src/predictor.ts']) {
  if (!readFileSync(join(root, file)).equals(readFileSync(join(batch, 'source', file)))) throw new Error(`Batch engine changed: ${file}`);
}
const aiDir = join(root, 'apps/web/public');
const modelHash = createHash('sha256').update(readFileSync(join(aiDir, 'model/model.onnx'))).digest('hex');
if (modelHash !== manifest.modelHash) throw new Error('Batch model changed');
const staticDir = join(root, 'apps/web/dist');
if (!existsSync(join(staticDir, 'index.html'))) throw new Error('Run npm run build -w @gyeol/web first');
const portIndex = process.argv.indexOf('--port');
const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid preview port');
console.log('Loading the batch ONNX model for local play…');
const brain = await loadBrain(aiDir);
const server = createServer({
  host: '127.0.0.1', port, staticDir, brain: async () => brain,
  botProfiles: profiles, botWaitMs: 500,
  createDatabase: true,
  dbPath: join(root, 'packages/server/data/cognitive-wide-preview.sqlite'),
  accountLimit: { count: 100, windowMs: 60 * 60 * 1000 },
});
await server.listen();
console.log(JSON.stringify({ ready: true, pid: process.pid, url: `http://localhost:${port}/#/pvp`,
  bots: server.botCount, engine: COGNITION_VERSION, ratings: '974-2207 target scale; actual strength validation is running',
  data: 'packages/server/data/cognitive-wide-preview.sqlite' }));
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await server.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
