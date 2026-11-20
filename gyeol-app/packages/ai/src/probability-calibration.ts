export const PROBABILITY_RULE = 'facing-25-v1';
export type ProbabilityEvaluator = 'network' | 'root-q' | 'root-mean';
export interface ProbabilityCalibration {
  version: string;
  model: string;
  rule: string;
  evaluator: ProbabilityEvaluator;
  simulations: number;
  reference: string;
  /** 적합 계수만 있다고 보정 검증 완료로 취급하지 않는다. */
  accepted: boolean;
  coefficients: [number, number, number];
  validationGames: number;
  remainingRange: [number, number];
}
export interface CalibrationSample { value: number; remaining: number; won: 0 | 1; game: string }
const clamp = (x: number) => Math.max(1e-5, Math.min(1 - 1e-5, x));
export const probabilityFeatures = (value: number, remaining: number): [number, number, number] => {
  const p = clamp((value + 1) / 2);
  return [Math.log(p / (1 - p)), 1, (remaining - 12.5) / 12.5];
};
export function calibratedProbability(value: number, remaining: number, coefficients: ProbabilityCalibration['coefficients']): number {
  const features = probabilityFeatures(value, remaining);
  const z = features.reduce((n, f, i) => n + f * coefficients[i], 0);
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

/** 한 대국의 여러 국면이 독립 대국처럼 과대 가중되지 않도록 대국별 합계 가중치를 맞춘다. */
export function fitProbability(samples: CalibrationSample[], iterations = 1200): ProbabilityCalibration['coefficients'] {
  if (!samples.length) throw new Error('No calibration samples');
  const counts = new Map<string, number>();
  for (const s of samples) counts.set(s.game, (counts.get(s.game) ?? 0) + 1);
  const coefficients: [number, number, number] = [1, 0, 0];
  for (let step = 0; step < iterations; step++) {
    const gradient = [0, 0, 0];
    for (const sample of samples) {
      const error = calibratedProbability(sample.value, sample.remaining, coefficients) - sample.won;
      const weight = 1 / counts.get(sample.game)! / counts.size;
      probabilityFeatures(sample.value, sample.remaining).forEach((f, i) => { gradient[i] += weight * error * f; });
    }
    const rate = 0.1 / Math.sqrt(1 + step / 150);
    for (let i = 0; i < 3; i++) coefficients[i] -= rate * (gradient[i] + 0.002 * (coefficients[i] - (i === 0 ? 1 : 0)));
    coefficients[0] = Math.max(0.001, coefficients[0]); // 평가가 좋아질수록 승률이 내려가는 보정 금지
  }
  return coefficients;
}

export function probabilityMetrics(samples: CalibrationSample[], predict: (s: CalibrationSample) => number) {
  const grouped = new Map<string, { brier: number; logLoss: number; n: number }>();
  const bins = Array.from({ length: 10 }, () => ({ n: 0, predicted: 0, won: 0 }));
  for (const s of samples) {
    const p = clamp(predict(s));
    const game = grouped.get(s.game) ?? { brier: 0, logLoss: 0, n: 0 };
    game.brier += (p - s.won) ** 2; game.logLoss -= s.won ? Math.log(p) : Math.log(1 - p); game.n++;
    grouped.set(s.game, game);
    const bin = bins[Math.min(9, Math.floor(p * 10))]; bin.n++; bin.predicted += p; bin.won += s.won;
  }
  return {
    games: grouped.size, positions: samples.length,
    brier: grouped.size ? [...grouped.values()].reduce((n, g) => n + g.brier / g.n, 0) / grouped.size : null,
    logLoss: grouped.size ? [...grouped.values()].reduce((n, g) => n + g.logLoss / g.n, 0) / grouped.size : null,
    bins: bins.map((b, i) => ({ from: i / 10, to: (i + 1) / 10, n: b.n, predicted: b.n ? b.predicted / b.n : null, observed: b.n ? b.won / b.n : null })),
  };
}
