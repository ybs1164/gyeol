/**
 * 모델 하나로 관문의 기준 대국 8판을 정밀 분석한다(대국마다 따로 실행해 병렬로 돌릴 수 있다).
 *   npx tsx tools/learning/deep_reference.ts --model <model.onnx> --game <0-7> --out <폴더>
 * 결과: <out>/deep-<대국 id>.json ({ ms, model, analysis }). 같은 모델의 빠른 분석과 비교할 때 쓴다.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { analyzeGameGrades } from '../../packages/ai/src/index';
import { loadModel } from './lib';
import { referenceGameList } from './reference-games';

const arg = (name: string) => { const i = process.argv.indexOf(name); if (i < 0) throw new Error(`${name} is required`); return process.argv[i + 1]; };
const model = await loadModel(resolve(arg('--model')), 100_000);
const game = referenceGameList()[Number(arg('--game'))];
if (!game) throw new Error('Unknown game index');
const out = resolve(arg('--out'));
mkdirSync(out, { recursive: true });
const t = performance.now();
const analysis = await analyzeGameGrades(game.moves, model.predict, { start: game.start, mode: 'deep' });
writeFileSync(join(out, `deep-${game.id}.json`), JSON.stringify({ ms: Math.round(performance.now() - t), model: model.sha.slice(0, 16), analysis }));
console.log(JSON.stringify({ game: game.id, seconds: Math.round((performance.now() - t) / 1000) }));
await model.dispose();
