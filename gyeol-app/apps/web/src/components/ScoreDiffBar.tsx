import { expectedMargin } from '@gyeol/ai';
import { margin, type Board, type Player, type Winner } from '@gyeol/core';
import type { WinDistancePoint } from '../lib/win-label';
import { sideName } from '../lib/skins';
import { t } from '../i18n';

export type BarPoint = { green: number } & WinDistancePoint;

/**
 * 판 왼쪽의 세로 막대. 채움은 승률 그래프와 같은 값(초록 승률)이고, 보는 색(perspective)이 아래쪽이다.
 * 숫자는 승패가 정해지지 않았으면 그 승률을 바꾼 예상 최종 타일 차이, 최선 대응 결과가 증명됐으면
 * 몇 수 안에 누가 이기는지, 종국이면 실제 타일 차이다. 분석값이 없으면 비워 둔다.
 */
export function ScoreDiffBar({ point, board, perspective }: { point: BarPoint | null | undefined; board: Board; perspective: Player }) {
  if (!point || !Number.isFinite(point.green)) {
    const label = t('review.notAnalyzed');
    return (
      <div className="score-diff-bar" role="img" aria-label={label} title={label} data-lead="none">
        <span className="sdb-mid" aria-hidden="true" />
        <span className="sdb-num even" aria-hidden="true">–</span>
      </div>
    );
  }
  const green = Math.max(0, Math.min(1, point.green));
  const own = perspective === 1 ? green : 1 - green; // 아래쪽(보는 색)의 승률
  const { lead, text, label } = reading(point, board);
  return (
    <div className="score-diff-bar" role="img" aria-label={label} title={label} data-lead={lead} data-state={point.status === 'exact' ? point.source : 'estimated'}>
      <span className={`sdb-fill ${perspective === 1 ? 'b' : 'g'}`} style={{ height: `${(1 - own) * 100}%` }} />
      <span className={`sdb-fill ${perspective === 1 ? 'g' : 'b'}`} style={{ height: `${own * 100}%` }} />
      <span className="sdb-mid" aria-hidden="true" />
      <span className={`sdb-num ${lead === 0 ? 'even' : lead === perspective ? 'bottom' : 'top'} ${lead === 1 ? 'g' : lead === -1 ? 'b' : ''}`} aria-hidden="true">{text}</span>
    </div>
  );
}

function reading(point: BarPoint, board: Board): { lead: Winner; text: string; label: string } {
  if (point.status === 'exact' && point.provenOutcome !== undefined) {
    const winner = point.provenOutcome;
    if (point.source === 'terminal') {
      const diff = Math.abs(margin(board));
      return winner === 0
        ? { lead: 0, text: '0', label: `${t('win.finished')} · ${t('rp.barDraw')}` }
        : { lead: winner, text: `+${diff}`, label: `${t('win.finished')} · ${t('rp.barWon', { color: sideName(winner), n: diff })}` };
    }
    if (winner === 0) return { lead: 0, text: t('rec.draw'), label: `${t('win.proven')} · ${t('rp.barDraw')}` };
    const plies = Number.isInteger(point.forcedWinPlies) && point.forcedWinPlies! > 0 ? point.forcedWinPlies! : null;
    return plies === null
      ? { lead: winner, text: t('rp.barWinShort'), label: `${t('win.proven')} · ${t('rec.sideWin', { color: sideName(winner) })}` }
      : { lead: winner, text: t('rp.barPlies', { n: plies }), label: t('rp.barWinIn', { color: sideName(winner), n: plies }) };
  }
  // 예상 차이는 소수점 한 자리까지 보여 준다.
  const estimate = Math.round(expectedMargin(point.green) * 10) / 10;
  const lead: Winner = estimate > 0 ? 1 : estimate < 0 ? -1 : 0;
  const winPct = Math.round((lead === -1 ? 1 - point.green : point.green) * 100);
  const n = Math.abs(estimate).toFixed(1);
  return {
    lead,
    text: lead ? `+${n}` : '0.0',
    label: lead
      ? t('rp.barEstimate', { color: sideName(lead), n, p: winPct })
      : t('rp.barEven', { p: Math.round(point.green * 100) }),
  };
}
