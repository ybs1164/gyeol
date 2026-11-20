/** 일반 분석 수 평가가 종반 국면을 어디까지 정확히 푸는지 노드 예산별로 확인한다. npx tsx tools/analysis/diag_grade_exact_order.ts */
import { analyzeGameGrades } from '../../packages/ai/src/index';
import { legal } from '../../packages/core/src/index';
const moves = [389,368,392,378,390,408,301,289,310,298,414,426,542,538,358,478,647,624,589,631,515,496,784,465];
const uniform = async (board: number[]) => ({ value: 0, priors: legal(board, 1).map(() => 1) });
for (const exactNodes of [500, 3000, 20_000, 75_000]) {
  const a = await analyzeGameGrades(moves, uniform, { exactMs: 100_000, exactNodes });
  console.log(exactNodes, a.moves.map((m, i) => m!.status === 'exact' ? i + 1 : null).filter(Boolean).join(' '));
}
