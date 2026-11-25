import type { MoveAnalysis } from '@gyeol/ai';
import { PASS } from '@gyeol/core';
import type { ReviewType } from '../lib/move-types';
import { t } from '../i18n';
import { MoveTypeBadge } from './MoveTypeBadge';

export const outcomeLabel = (value: number) => t(value > 0 ? 'grading.win' : value < 0 ? 'grading.loss' : 'grading.draw');
export const moveReason = (move: MoveAnalysis) => t(`grading.reason.${move.reasonCode}`, { n: move.lossPoints.toFixed(1) });

/** 선택한 수: 평가 타입과 그 이유, 종국까지 확인된 경우의 승·무·패 비교, 추천 수 보기. */
/** number: 패스를 세지 않는 수 번호(이 수까지 둔 착수 수). 패스면 직전 번호에 패스를 붙인다. */
export function MoveReview({ move, number = move.ply, type, byOutcome = false, onLine, busy = false }: { move: MoveAnalysis; number?: number; type: ReviewType | null; byOutcome?: boolean; onLine: (kind: 'actual' | 'best') => void; busy?: boolean }) {
  const solved = !move.forced && move.status === 'exact';
  const fact = move.badges.find(b => ['onlyWin', 'onlyDefense', 'missedDefense'].includes(b));
  const title = move.played === PASS ? `${t('grading.moveNumber', { n: number })} · ${t('rp.pass')}` : t('grading.moveNumber', { n: number });
  return <section className="move-review" aria-label={title}>
    <div className="review-row"><strong>{title}</strong><div className="move-verdict">
      {move.forced ? <span className="small muted">{t(move.played === PASS ? 'review.forcedPass' : 'review.forced')}</span> : <MoveTypeBadge type={type} />}
      {solved && <span className="small muted" data-review-status>{t('review.exact')}</span>}
    </div></div>
    {!move.forced && type && <p className="grade-reason" data-type-reason>{t(byOutcome ? 'type.reason.lostOutcome' : `type.reason.${type}`)}</p>}
    {(move.forced || solved && !byOutcome) && <p className="grade-reason">{moveReason(move)}</p>}
    {fact && <p className="small move-achievement">{t(`review.${fact}`)}</p>}
    {solved && <dl className="move-comparison">
      <div><dt>{t('grading.actual')}</dt><dd>{outcomeLabel(move.playedValue)}</dd></div>
      <div><dt>{t('grading.best')}</dt><dd>{outcomeLabel(move.bestValue)}</dd></div>
    </dl>}
    {busy && <p className="small" role="status">{t('win.moveBusy')}</p>}
    <div className="actions">
      {!move.forced && <button className="btn primary" disabled={busy} onClick={() => onLine('best')}>{t('review.recommend')}</button>}
      <button className="btn" disabled={busy} onClick={() => onLine('actual')}>{t('review.actual')}</button>
    </div>
  </section>;
}
