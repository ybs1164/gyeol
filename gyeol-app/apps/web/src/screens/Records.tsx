import { useEffect, useMemo, useRef, useState } from 'react';
import { emptyWinAnalysis, gameReport, replayAnalysis, smoothWinCurve, type AnalysisMode, type GameAnalysis, type WinAnalysis } from '@gyeol/ai';
import { PASS, apply, result, decode, idx, initial, moveType, movesPlayed, type Player } from '@gyeol/core';
import { MoveList, movesFromActions } from '../components/GameLayout';
import { MoveTypeBadge } from '../components/MoveTypeBadge';
import { Board } from '../components/Board';
import { Score } from '../components/Score';
import { AnalysisGraph } from '../components/AnalysisGraph';
import { GameReport } from '../components/GameReport';
import { ScoreDiffBar } from '../components/ScoreDiffBar';
import { Popup } from '../components/ui';
import { resolveMoveType, type TypedMove } from '../lib/move-types';
import { advance, startPosition, type Position } from '../game/track';
import { WinAnalysisClient } from '../ai/win-probability-client';
import { PROBABILITY_CALIBRATIONS } from '../ai/probability-calibrations';
import { MODEL_VERSION } from '../ai/analysis-version';
import { analysisKey, winAnalysisKey, loadWinAnalysis, loadAnalysis, saveAnalysis } from '../lib/analysis-storage';
import { accuracyLog, records, type GameRecord } from '../lib/storage';
import { sideName } from '../lib/skins';
import { forcedWinLabel } from '../lib/win-label';
import { useLayout } from '../lib/layout';
import { useShortcuts } from '../lib/keys';
import { Icon } from '../components/Icon';
import { t } from '../i18n';
import type { Go } from '../App';

function outcome(r: GameRecord): { text: string; cls: string } {
  if (r.me === null) return { text: r.winner ? t('rec.sideWin', { color: sideName(r.winner) }) : t('rec.draw'), cls: '' };
  if (r.winner === 0) return { text: t('rec.draw'), cls: '' };
  return r.winner === r.me ? { text: t('rec.win'), cls: 'strong' } : { text: t('rec.lose'), cls: 'muted' };
}

export function Replay({ id, go }: { id: string; go: Go }) { return <ReplayGame key={id} id={id} go={go} />; }

function ReplayGame({ id, go }: { id: string; go: Go }) {
  const record = useMemo(() => records.get(id), [id]);
  const replay = useMemo(() => {
    if (!record) return { positions: [] as Position[], invalid: false };
    try {
      if (record.ruleVersion && record.ruleVersion !== 'facing-25-v1') throw new Error('Unknown rules');
      const start = { board: record.initialBoard ?? initial(), player: record.initialPlayer ?? 1 };
      replayAnalysis(record.moves, start);
      const positions = [startPosition(start.board, start.player)];
      for (const a of record.moves) positions.push(advance(positions[positions.length - 1], a));
      return { positions, invalid: false };
    } catch { return { positions: [] as Position[], invalid: true }; }
  }, [record]);
  const { positions } = replay;
  const n = record?.moves.length ?? 0;
  const [at, setAt] = useState(n);
  const [pendingPly, setPendingPly] = useState<number | null>(null);
  const [mode, setMode] = useState<AnalysisMode>('standard');
  const [analysis, setAnalysis] = useState<GameAnalysis | null>(null);
  const [win, setWin] = useState<WinAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [moveBusy, setMoveBusy] = useState(false);
  const [error, setError] = useState(false);
  // 복기를 열면 대국 요약 · 승률 추정 · 모든 수를 팝업으로 먼저 보여 준다.
  const [overview, setOverview] = useState(true);
  const [perspective, setPerspective] = useState<Player>(record?.me ?? 1);
  const [line, setLine] = useState<{ ply: number; kind: 'actual' | 'best'; step: number } | null>(null);
  const [lineGraphs, setLineGraphs] = useState<Record<string, WinAnalysis>>({});
  const job = useRef<{ cancel: () => void } | null>(null);
  const client = useMemo(() => new WinAnalysisClient(), []);
  const generation = useRef(0);
  const reviewSelection = useRef(0);
  const autoPaused = useRef(false);
  const loadedCache = useRef('');
  const cacheKey = useMemo(() => record ? analysisKey(record, mode) : '', [record, mode]);
  const graphKey = useMemo(() => record ? winAnalysisKey(record, mode) : '', [record, mode]);
  const layout = useLayout();

  useEffect(() => {
    const token = ++generation.current;
    loadedCache.current = '';
    autoPaused.current = false; setAnalyzing(false);
    setLoading(true); setAnalysis(null); setWin(null); setError(false); setLine(null); setMoveBusy(false);
    if (!record || replay.invalid) { setLoading(false); return; }
    void Promise.all([loadAnalysis(cacheKey, n, mode), loadWinAnalysis(graphKey, n, mode)]).then(([saved, graph]) => {
      if (token !== generation.current) return;
      loadedCache.current = cacheKey;
      setAnalysis(saved); setWin(graph); setLoading(false);
    });
    return () => { generation.current++; job.current?.cancel(); job.current = null; };
  }, [cacheKey, graphKey, mode, n, record, replay.invalid]);
  useEffect(() => () => client.dispose(), [client]);
  // 평가 타입은 판 위의 타일로 바로 정하고, 종국까지 확인된 결과가 나오면 그 결과와 맞춘다.
  const tiles = useMemo(() => record && positions.length ? record.moves.map((action, i) => moveType(positions[i].board, positions[i].player, action)) : [], [record, positions]);
  // 화면에 쓰는 승률 곡선: 둘 차례에 따라 번갈아 치우치는 추정 오차를 이웃 국면과 평균내 없앤다.
  const curve = useMemo(() => win ? smoothWinCurve(win.positions) : null, [win]);
  const typed = useMemo<TypedMove[]>(() => tiles.map((info, i) => resolveMoveType(info, positions[i].player, curve?.[i], curve?.[i + 1], analysis?.moves[i])), [tiles, positions, curve, analysis]);
  // 내 정확도는 분석이 끝난 판만 기록해 이전 판과 비교한다.
  const myAccuracy = useMemo(() => analysis?.complete && record && record.me !== null ? gameReport(analysis, record.me).accuracy : null, [analysis, record]);
  useEffect(() => { if (record && myAccuracy !== null) accuracyLog.put({ id: record.id, date: record.date, accuracy: myAccuracy }); }, [record, myAccuracy]);

  const analyze = async (refresh = false) => {
    if (!record || analyzing || moveBusy) return;
    const token = ++generation.current;
    autoPaused.current = false;
    setAnalyzing(true); setError(false);
    const start = { board: record.initialBoard ?? initial(), player: record.initialPlayer ?? 1 };
    let grades = refresh ? undefined : analysis ?? undefined;
    try {
      if (refresh || !win?.complete) {
        const resume = refresh ? undefined : win ?? undefined;
        if (!resume) setWin(emptyWinAnalysis(record.moves, { start, mode, model: MODEL_VERSION, calibrations: PROBABILITY_CALIBRATIONS }));
        const active = client.graph({ task: 'graph', moves: record.moves, mode, start, resume, includeGrades: !grades?.complete, gradeResume: grades }, partial => {
          if (token !== generation.current) return;
          setWin(partial); void saveAnalysis(graphKey, partial);
        }, partial => {
          if (token !== generation.current) return;
          grades = partial;
          setAnalysis(partial); void saveAnalysis(cacheKey, partial);
        });
        job.current = active;
        const result = await active.result;
        if (token !== generation.current) return;
        setWin(result); void saveAnalysis(graphKey, result);
      }
      if (!grades?.complete) {
        const active = client.grades({ task: 'grades', moves: record.moves, mode, start, resume: grades }, partial => {
          if (token !== generation.current) return;
          setAnalysis(partial); void saveAnalysis(cacheKey, partial);
        });
        job.current = active;
        const result = await active.result;
        if (token !== generation.current) return;
        setAnalysis(result); void saveAnalysis(cacheKey, result);
      }
    } catch (e) {
      if (token === generation.current && !(e instanceof DOMException && e.name === 'AbortError')) setError(true);
    } finally {
      if (token === generation.current) { setAnalyzing(false); job.current = null; }
    }
  };
  useEffect(() => {
    if (loadedCache.current === cacheKey && !loading && !analyzing && !error && !autoPaused.current && record && !replay.invalid && (!win?.complete || !analysis?.complete)) void analyze();
  }, [loading, analyzing, error, cacheKey, graphKey, win?.complete, analysis?.complete]);
  const cancel = () => { autoPaused.current = true; generation.current++; job.current?.cancel(); job.current = null; setAnalyzing(false); setMoveBusy(false); };
  const jump = (i: number) => { reviewSelection.current++; setAt(Math.max(0, Math.min(n, i))); setLine(null); setPendingPly(null); };
  const selectMove = (ply: number) => { jump(ply - 1); setPendingPly(ply); };
  const selected = analysis?.moves[(line?.ply ?? pendingPly ?? at) - 1] ?? null;
  const candidate = line && selected ? [...selected.candidates].sort((a, b) => b.value - a.value || (b.margin ?? 0) - (a.margin ?? 0)).find(c => line.kind === 'actual' ? c.action === selected.played : selected.bestActions.includes(c.action)) : null;
  const pv = candidate?.pv ?? [];
  // 추천 수 · 실제 수 양상도 국면마다 승률을 매겨 왼쪽 막대에 보여 준다. 수순 시작 국면부터 그래프와 같은 방식으로 평가한다.
  const lineKey = line && pv.length ? `${mode}:${line.ply}:${pv.join(',')}` : '';
  const lineRequested = useRef(new Set<string>());
  useEffect(() => {
    if (!lineKey || !line || lineRequested.current.has(lineKey)) return;
    lineRequested.current.add(lineKey);
    const parent = positions[line.ply - 1];
    const save = (graph: WinAnalysis) => setLineGraphs(g => ({ ...g, [lineKey]: graph }));
    const active = client.graph({ task: 'graph', moves: pv, mode, start: { board: parent.board, player: parent.player } }, save);
    // 다른 분석을 취소하느라 작업자가 닫히면 다음에 다시 열 때 이어서 평가한다.
    active.result.then(save, () => { lineRequested.current.delete(lineKey); });
  }, [lineKey]);
  const lineGraph = lineKey ? lineGraphs[lineKey] : undefined;
  const lineCurve = useMemo(() => lineGraph ? smoothWinCurve(lineGraph.positions) : null, [lineGraph]);
  // 단축키: ← → 한 수, Home · End 처음 · 끝 (그래프와 슬라이더에 포커스가 있으면 그쪽이 처리)
  useShortcuts({
    ArrowLeft: () => jump(at - 1),
    ArrowRight: () => jump(at + 1),
    Home: () => jump(0),
    End: () => jump(n),
  });

  if (!record || replay.invalid) return <div className="screen"><div className="topbar"><button className="icon-btn" onClick={() => go('me')} aria-label={t('nav.back')}><Icon name="back" /></button></div><p className="muted">{t(replay.invalid ? 'review.invalid' : 'err.not_found')}</p></div>;

  const o = outcome(record);
  let pos = positions[at];
  if (line) {
    pos = positions[line.ply - 1];
    for (const a of pv.slice(0, line.step)) pos = advance(pos, a);
  }
  const nextAction = line ? pv[line.step] : pendingPly ? record.moves[pendingPly - 1] : undefined;
  const sm = nextAction !== undefined && nextAction !== PASS ? decode(nextAction) : null;
  const point = curve?.[at];
  // 수순 첫 국면은 기보 그래프 값과 같게 두고, 이후 국면은 수순 평가 값을 쓴다.
  const barPoint = line ? (line.step === 0 ? point : null) ?? lineCurve?.[line.step] : point;
  const forcedLabel = forcedWinLabel(point, perspective);
  const complete = win?.complete;
  const reviewPly = line?.ply ?? pendingPly ?? at;
  const startLine = async (kind: 'actual' | 'best') => {
    if (!selected || !analysis || analyzing || moveBusy) return;
    const selectionToken = reviewSelection.current;
    const chosen = [...selected.candidates].sort((a, b) => b.value - a.value || (b.margin ?? 0) - (a.margin ?? 0))
      .find(c => kind === 'actual' ? c.action === selected.played : selected.bestActions.includes(c.action))!;
    const parent = positions[selected.ply - 1];
    if (chosen.pv.length < 2 && !result(apply(parent.board, parent.player, chosen.action).board, -parent.player as Player)) {
      const token = ++generation.current;
      setMoveBusy(true); setError(false);
      try {
        const active = client.move({ task: 'move', position: { board: parent.board, player: parent.player }, played: selected.played, ply: selected.ply, mode });
        job.current = active;
        const detailed = await active.result;
        if (token !== generation.current) return;
        const updated = { ...analysis, moves: analysis.moves.map((m, i) => i === detailed.ply - 1 ? detailed : m) };
        setAnalysis(updated); void saveAnalysis(cacheKey, updated);
      } catch (e) {
        if (token === generation.current && !(e instanceof DOMException && e.name === 'AbortError')) setError(true);
        return;
      } finally {
        if (token === generation.current) { setMoveBusy(false); job.current = null; }
      }
    }
    if (selectionToken === reviewSelection.current) {
      setAt(selected.ply - 1); setPendingPly(null); setLine({ ply: selected.ply, kind, step: 0 });
    }
  };

  const head = <div className="topbar"><button className="icon-btn" onClick={() => go('me')} aria-label={t('nav.back')}><Icon name="back" /></button><h2>{t('rp.title')}</h2><span className={`small ${o.cls}`}>{o.text}</span></div>;
  const boardView = <>
    <Score board={pos.board} turn={at < n || line ? pos.player : null} />
    <p className="status">{t('rp.move', { i: movesPlayed(record.moves, at), n: movesPlayed(record.moves) })}{!line && at > 0 && record.moves[at - 1] === PASS && ` · ${t('rp.pass')}`}</p>
    <div className="rp-board-row">
      <ScoreDiffBar point={barPoint} board={pos.board} perspective={perspective} />
      <Board pos={{ ...pos, animate: false }} interactive={false} showLast={nextAction === undefined} showCoordinates
        moveType={!line && reviewPly > 0 ? typed[reviewPly - 1]?.type : null}
        marks={sm ? [idx(sm.r, sm.c)] : []}
        ghost={sm ? { cell: idx(sm.pr, sm.pc), player: pos.player, dir: sm.placeDir } : null} />
    </div>
    {pendingPly && <button className="btn" onClick={() => jump(pendingPly)}>{t('notation.apply')}</button>}
  </>;
  const lineView = line && <section className="line-review" aria-live="polite">
      <p className="small">{t('review.line', { kind: t(line.kind === 'actual' ? 'grading.actual' : 'grading.best'), step: line.step, total: pv.length })}</p>
      {pv.length === 1 && candidate && !result(apply(positions[line.ply - 1].board, positions[line.ply - 1].player, candidate.action).board, -positions[line.ply - 1].player as Player) && <p className="small muted">{t('grading.noReply')}</p>}
      <div className="actions"><button className="btn" disabled={line.step === 0} onClick={() => setLine({ ...line, step: line.step - 1 })} aria-label={t('review.linePrev')}>&#9664;</button><button className="btn" disabled={line.step >= pv.length} onClick={() => setLine({ ...line, step: line.step + 1 })} aria-label={t('review.lineNext')}>&#9654;</button></div>
      <button className="text-btn" onClick={() => jump(line.ply)}>{t('review.closeLine')}</button>
    </section>;
  const controls = <>
    <div className="actions replay-controls">
      <button className="btn" onClick={() => jump(0)} disabled={at === 0 && !line} aria-label={t('review.first')}>⏮</button>
      <button className="btn" onClick={() => jump(at - 1)} disabled={at === 0 && !line} aria-label={t('review.prev')}>◀</button>
      <button className="btn" onClick={() => jump(at + 1)} disabled={at === n && !line} aria-label={t('review.next')}>▶</button>
      <button className="btn" onClick={() => jump(n)} disabled={at === n && !line} aria-label={t('review.last')}>⏭</button>
    </div>
    <input className="range" aria-label={t('rp.title')} type="range" min={0} max={n} value={at} onChange={e => jump(Number(e.target.value))} />
  </>;
  const overviewButton = <button className="btn overview-open" onClick={() => setOverview(true)}>{t('rp.overview')}</button>;
  const busy = loading || analyzing || (!error && !autoPaused.current && (!win?.complete || !analysis?.complete));
  const loadingView = <section className="analysis-loading" aria-busy="true" aria-label={t('win.analyze')}>
    <div role="status" aria-label={t('win.analyze')}><span className="spin" aria-hidden="true" /></div>
    {analyzing && <button className="text-btn" onClick={cancel}>{t('review.cancel')}</button>}
  </section>;
  // 팝업: 대국 요약 → 모든 수 → 분석 방식. 수를 고르면 팝업을 닫고 판에서 그 수를 보여 준다.
  const overviewView = busy ? loadingView : <>
    <GameReport analysis={analysis} typed={typed} me={record.me} />
    <section className="move-overview" aria-label={t('review.all')}>
      <div className="review-row"><strong>{t('review.all')}</strong><span className="small muted">{analysis?.moves.filter((m, i) => m && record.moves[i] !== PASS).length ?? 0} / {movesPlayed(record.moves)}</span></div>
      <div className="move-list"><MoveList moves={movesFromActions(record.moves, record.initialPlayer ?? 1, record.initialBoard ?? initial())}
        selectedIndex={(pendingPly ?? at) - 1} onSelect={i => { selectMove(i + 1); setOverview(false); }}
        renderDetail={i => <MoveTypeBadge type={typed[i]?.type} iconOnly />} /></div>
    </section>
    <div className="actions analysis-modes">{(['standard', 'deep'] as const).map(m => <button className="btn" key={m} aria-pressed={mode === m} disabled={analyzing || loading || moveBusy} onClick={() => setMode(m)}>{t(`review.${m}`)}</button>)}</div>
  </>;
  const overviewPopup = overview && <Popup className="review-popup" onClose={() => setOverview(false)}>
    <div className="review-popup-head"><h3>{t('rp.overview')}</h3><button className="text-btn" onClick={() => setOverview(false)}>{t('rp.closeOverview')}</button></div>
    {overviewView}
  </Popup>;
  // 판 아래: 추천 수 · 실제 수 보기 → 승률 추정 그래프. 대국 분석 버튼은 맨 아래에 둔다.
  const analysisView = busy ? loadingView : <>
    {selected && <div className="actions review-lines">
      {!selected.forced && <button className="btn primary" disabled={moveBusy} onClick={() => void startLine('best')}>{t('review.recommend')}</button>}
      <button className="btn" disabled={moveBusy} onClick={() => void startLine('actual')}>{t('review.actual')}</button>
    </div>}
    {moveBusy && <button className="text-btn" onClick={cancel}>{t('review.cancel')}</button>}
    <section className="win-panel" aria-label={t('win.title')}>
      <div className="review-row"><strong>{t('win.title')}</strong><div className="perspective-picker">{([1, -1] as const).map(p => <button className="text-btn" key={p} aria-pressed={perspective === p} onClick={() => setPerspective(p)}>{sideName(p)}</button>)}</div></div>
      <div className="win-reading" aria-live="polite">
        {(forcedLabel || point?.status === 'exact') && <span className="win-number">{forcedLabel ?? (point!.provenOutcome ? t('rec.sideWin', { color: sideName(point!.provenOutcome) }) : t('rec.draw'))}</span>}
        <span className="win-state">{!point ? t('review.notAnalyzed') : point.status === 'exact' ? t(point.source === 'terminal' ? 'win.finished' : 'win.proven') : t('win.estimated')}</span>
      </div>
      {win ? <AnalysisGraph label={t('win.title')} analysis={{ positions: curve!, marks: typed }} actions={record.moves} at={at} perspective={perspective} jump={jump} /> : <div className="win-placeholder">{t('win.empty')}</div>}
      <div className="win-actions"><button className="text-btn" disabled={moveBusy} onClick={() => void analyze(!!complete && !!analysis?.complete)}>{t(complete && analysis?.complete ? 'win.refresh' : win?.positions.some(Boolean) ? 'review.resume' : 'win.analyze')}</button></div>
      {error && <p className="feedback no" role="alert">{t('review.error')}</p>}
    </section>
  </>;

  // 넓은 창: 판과 이동 버튼은 왼쪽에 고정, 수순 비교 · 분석은 오른쪽 패널에서만 스크롤
  if (layout === 'expanded') return <div className="screen replay-screen game-wide">
    {head}
    <div className="gw-body">
      <div className="gw-board rp-board">{boardView}{controls}<p className="kbd-hint">{t('keys.replay')}</p></div>
      <div className="gw-side">{lineView}{analysisView}{overviewButton}</div>
    </div>
    {overviewPopup}
  </div>;

  return <div className="screen replay-screen">
    {head}
    {boardView}
    {lineView}
    {controls}
    {analysisView}
    {overviewButton}
    {overviewPopup}
  </div>;
}
