import { gameReport, type GameAnalysis } from '@gyeol/ai';
import type { Player } from '@gyeol/core';
import { t } from '../i18n';
import { sideName } from '../lib/skins';
import { REVIEW_TYPES, type TypedMove } from '../lib/move-types';
import { MoveTypeBadge } from './MoveTypeBadge';

/** 대국 요약: 정확도와 평가 타입(공격 · 방어 · 최선 수 · 내준 수)의 횟수를 한 줄씩. */
export function GameReport({ analysis, typed, me }: { analysis: Pick<GameAnalysis, 'moves'> | null; typed: readonly TypedMove[]; me: Player | null }) {
  const sides = (me === null ? [1, -1] : [me, -me]) as Player[];
  if (!typed.length) return null;
  return <section className="game-report" aria-label={t('review.summary')}>
    <div className="review-row"><strong>{t('review.summary')}</strong></div>
    <div className="report-sides">{sides.map(player => {
      const report = analysis ? gameReport(analysis, player) : null;
      const mine = typed.filter(move => move.player === player);
      return <div className="report-side" key={player} data-side={player} data-own={player === me}>
        <div className="report-head">
          <span className="report-name">{sideName(player)}</span>
          {report?.accuracy != null && <span className="report-score" data-accuracy>{Math.round(report.accuracy)}</span>}
        </div>
        {report?.accuracy != null && <>
          <p className="small muted">{t('report.accuracy')}</p>
          <dl className="report-phases">{report.phases.map((value, i) => <div key={i}>
            <dt>{t(`report.phase.${i}`)}</dt>
            <dd>{value === null ? '—' : <><span className="report-meter" aria-hidden="true"><span style={{ width: `${Math.round(value)}%` }} /></span>{Math.round(value)}</>}</dd>
          </div>)}</dl>
        </>}
        <ul className="report-types">{REVIEW_TYPES.map(type => <li className="report-type" key={type} data-type-count={type}>
          <MoveTypeBadge type={type} /> <span className="report-count">{mine.filter(move => move.type === type).length}</span>
        </li>)}</ul>
      </div>;
    })}</div>
  </section>;
}
