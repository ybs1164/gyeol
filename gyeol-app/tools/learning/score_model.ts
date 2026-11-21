/**
 * P0/P4: 모델 하나를 얼린 정확 시험 세트로 채점한다. 같은 입력이면 같은 숫자가 나온다(탐색 난수 고정).
 *   npx tsx tools/learning/score_model.ts [--model apps/web/public/model/model.onnx] [--sims 64] [--set exact-test-v1] [--fresh]
 * 결과: tools/learning/reports/<set>-<onnx sha 16>-s<sims>.json (이미 있으면 다시 계산하지 않음, --fresh 로 강제)
 * 지표(초록 기준 승률 p): 승패 적중률(무승부 제외), Brier, log loss, 10구간 보정, 예상 타일 차이 평균 오차(expectedMargin),
 * 모델에 타일 차이 출력이 있으면 그 평균 오차(marginHeadMae).
 */
import { formatMetrics, scoreModel } from './lib';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const sims = Number(arg('--sims', '64'));
const { report, file } = await scoreModel(arg('--model', 'apps/web/public/model/model.onnx'), { sims, set: arg('--set', 'exact-test-v1'), fresh: process.argv.includes('--fresh') });
console.log(formatMetrics('network', report.network.all));
console.log(formatMetrics(`search${sims}`, report.search.all));
console.log(`wrote ${file}`);
