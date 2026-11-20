/**
 * Glicko-2 (Mark Glickman, 2012) — 한 판마다 갱신.
 * rating/rd 는 Glicko 척도(기본 1500/350), vol 은 변동성(기본 0.06).
 */
export interface Rating {
  rating: number;
  rd: number;
  vol: number;
}

export const DEFAULT_RATING: Rating = { rating: 1500, rd: 350, vol: 0.06 };
const TAU = 0.5;
const SCALE = 173.7178;

/** 미참여 기간은 하루 단위. 원본을 바꾸지 않아 반복 조회로 RD가 중복 증가하지 않는다. */
export function withInactivity<T extends Rating>(me: T, lastRatedAt: number, now = Date.now()): T {
  const days = Math.max(0, Math.floor((now - lastRatedAt) / 86_400_000));
  return { ...me, rd: Math.min(350, Math.sqrt(me.rd ** 2 + days * (SCALE * me.vol) ** 2)) };
}

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const E = (mu: number, muj: number, phij: number) => 1 / (1 + Math.exp(-g(phij) * (mu - muj)));

/** score: 1 승, 0.5 무, 0 패 */
export function update(me: Rating, opp: Rating, score: number): Rating {
  const mu = (me.rating - 1500) / SCALE;
  const phi = me.rd / SCALE;
  const muj = (opp.rating - 1500) / SCALE;
  const phij = opp.rd / SCALE;

  const gj = g(phij);
  const ej = E(mu, muj, phij);
  const v = 1 / (gj * gj * ej * (1 - ej));
  const delta = v * gj * (score - ej);

  // 변동성 (Illinois 알고리즘)
  const a = Math.log(me.vol * me.vol);
  const f = (x: number) => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (TAU * TAU);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else fA /= 2;
    B = C;
    fB = fC;
  }
  const vol = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * gj * (score - ej);
  return {
    rating: muNew * SCALE + 1500,
    rd: Math.max(30, Math.min(350, phiNew * SCALE)),
    vol,
  };
}
