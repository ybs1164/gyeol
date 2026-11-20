import type { MoveAnalysis } from '@gyeol/ai';
import type { MoveTypeInfo, Player } from '@gyeol/core';

/**
 * 복기에서 보여 주는 수 타입.
 *   공격 · 방어: 판 위의 타일로 정한다 (공격은 둔 사람이 유리할 때만).
 *   내준 수(?): 서로 최선을 다할 때의 결과가 이 수로 나빠졌다 (승리→무·패, 무→패). 타일로는 정하지 않는다.
 *   최선 수(★): 위 셋이 아니면서 AI가 찾은 가장 좋은 수와 같다.
 */
export const REVIEW_TYPES = ['attack', 'defense', 'best', 'gift'] as const;
export type ReviewType = typeof REVIEW_TYPES[number];

export interface TypedMove extends Omit<MoveTypeInfo, 'type'> {
  type: ReviewType | null;
  player: Player;
  /**
   * 'tiles': 판 위의 타일로 정했다(공격 · 방어). 'outcome': 종국까지 확인한 결과가 나빠져서 내준 수가 됐다.
   * 'analysis': AI 수 분석에서 최선 수로 확인했다.
   */
  cause: 'tiles' | 'outcome' | 'analysis' | null;
}
/** 승률 그래프의 한 점에서 쓰는 부분. green 은 선공(1)이 이길 추정 확률, 종국까지 확인된 점만 결과를 가진다. */
export interface OutcomePoint { status: string; provenOutcome?: number; green?: number }

const LOST_OUTCOME = ['winToDraw', 'winToLoss', 'drawToLoss'];
/** 둔 사람 기준 결과: 1 승, 0 무, -1 패. 확인되지 않았으면 null. */
const outcomeFor = (point: OutcomePoint | null | undefined, player: Player) =>
  point?.status === 'exact' && point.provenOutcome !== undefined ? point.provenOutcome * player : null;

/**
 * 이 수 뒤에 둔 사람이 유리한가. 확인된 결과가 있으면 승리일 때만, 없으면 승률 추정이 50%를 넘을 때,
 * 그래프 점도 없으면 수 분석의 실제 수 평가가 0보다 클 때. 아무 정보도 없으면 유리하다고 보지 않는다.
 */
function favorable(player: Player, after?: OutcomePoint | null, decision?: MoveAnalysis | null): boolean {
  const now = outcomeFor(after, player);
  if (now !== null) return now > 0;
  if (after?.green !== undefined) return (player === 1 ? after.green : 1 - after.green) > 0.5;
  return !!decision && !decision.forced && decision.playedValue > 0;
}

/** AI 수 분석에서 실제로 둔 수가 가장 좋은 수였는가. 강제수는 고를 수가 없었으므로 제외한다. */
const isBest = (decision?: MoveAnalysis | null) =>
  !!decision && !decision.forced && (decision.grade === 'best' || decision.bestActions.includes(decision.played));

/**
 * 수 타입을 정한다. 최선 대응 시 결과가 나빠진 수만 내준 수이고, 몇 장을 뒤집었든 다른 타입보다 앞선다.
 * 결과는 승률 그래프의 증명된 두 점이나 수 분석의 종국 판정 중 하나로 확인한다.
 * 타일로 상대에게 뒤집을 기회를 늘려 준 것만으로는 내준 수가 아니다.
 * 타일로는 공격이어도 이 수 뒤에 둔 사람이 유리하지 않으면 공격으로 표시하지 않는다.
 * 그렇게 해서 공격 · 방어 · 내준 수 어느 것도 아닌 수가 AI의 최선 수와 같으면 최선 수다.
 */
export function resolveMoveType(info: MoveTypeInfo, player: Player, before?: OutcomePoint | null, after?: OutcomePoint | null, decision?: MoveAnalysis | null): TypedMove {
  const was = outcomeFor(before, player), now = outcomeFor(after, player);
  const worse = was !== null && now !== null && now < was
    || !!decision && !decision.forced && decision.status === 'exact' && LOST_OUTCOME.includes(decision.reasonCode);
  if (worse) return { ...info, player, type: 'gift', cause: 'outcome' };
  const type = info.type === 'gift' || info.type === 'attack' && !favorable(player, after, decision) ? null : info.type;
  if (type) return { ...info, player, type, cause: 'tiles' };
  if (isBest(decision)) return { ...info, player, type: 'best', cause: 'analysis' };
  return { ...info, player, type: null, cause: null };
}
