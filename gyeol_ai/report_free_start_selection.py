"""Report independent confirmation of frozen original free-start openings."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

from select_free_start_openings import DEFAULT_OUT, display


def draw_layouts(path, entries):
    from PIL import Image, ImageDraw, ImageFont
    canvas = Image.new('RGB', (1050,400), '#f5f4f0')
    drawing = ImageDraw.Draw(canvas)
    font_path = Path('C:/Windows/Fonts/malgun.ttf')
    def font(size):
        return ImageFont.truetype(str(font_path), size) if font_path.exists() else ImageFont.load_default()
    drawing.text((24,7), 'Free-start 균형 후보 · 초록 선공 / 갈색 후공', font=font(21), fill='#202821')
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1050" height="400" viewBox="0 0 1050 400">',
             '<rect width="1050" height="400" fill="#f5f4f0"/>',
             '<g font-family="Segoe UI, Malgun Gothic, sans-serif">',
             '<text x="24" y="32" font-size="21" fill="#202821">Free-start 균형 후보 · 초록 선공 / 갈색 후공</text>']
    for i, entry in enumerate(entries):
        x = 18 + 344*i
        d = display(entry['board']); s = entry['summary']
        dr, dc = d['second_offset']
        top, bottom = min(0,dr), max(0,dr)
        left, right = min(0,dc), max(0,dc)
        rows, cols = bottom-top+1, right-left+1
        size = 44
        bx = x + (326 - cols*size)/2
        by = 150 + (176 - rows*size)/2
        parts += [f'<rect x="{x}" y="54" width="326" height="326" rx="14" fill="white" stroke="#dddcd4"/>',
                  f'<text x="{x+18}" y="88" font-size="20" font-weight="600">{i+1}. 배치 {entry["id"]}</text>',
                  f'<text x="{x+18}" y="115" font-size="17">선공 {s["first_wins"]}/{s["games"]}승 · {s["first_win_rate"]:.1%}</text>']
        drawing.rounded_rectangle((x,54,x+326,380), radius=14, fill='white', outline='#dddcd4')
        drawing.text((x+18,65), f"{i+1}. 배치 {entry['id']}", font=font(20), fill='#202821')
        drawing.text((x+18,94), f"선공 {s['first_wins']}/{s['games']}승 · {s['first_win_rate']:.1%}", font=font(17), fill='#202821')
        for r in range(rows):
            for c in range(cols):
                xx, yy = bx+c*size, by+r*size
                parts.append(f'<rect x="{xx}" y="{yy}" width="44" height="44" fill="#fafaf7" stroke="#dddcd4"/>')
                drawing.rectangle((xx,yy,xx+44,yy+44),fill='#fafaf7',outline='#dddcd4')
        for rr, cc, arrow, color in [(0,0,'↑','#2b825b'),(dr,dc,d['second_direction'],'#956443')]:
            xx, yy = bx+(cc-left)*size+3, by+(rr-top)*size+3
            parts += [f'<rect x="{xx}" y="{yy}" width="38" height="38" rx="7" fill="{color}"/>',
                      f'<text x="{xx+19}" y="{yy+29}" text-anchor="middle" font-size="32" fill="white">{arrow}</text>']
            drawing.rounded_rectangle((xx,yy,xx+38,yy+38),radius=7,fill=color)
            drawing.text((xx+19,yy+18),arrow,font=font(32),fill='white',anchor='mm')
        parts.append(f'<text x="{x+18}" y="355" font-size="14" fill="#596359">평균 타일 차 {s["mean_margin"]:+.2f}장 · 현재 AI 기준</text>')
        drawing.text((x+18,337),f"평균 타일 차 {s['mean_margin']:+.2f}장 · 현재 AI 기준",font=font(14),fill='#596359')
    parts += ['</g></svg>']
    path.write_text('\n'.join(parts),encoding='utf-8')
    canvas.save(path.with_suffix('.png'))


def rank(entries):
    return sorted(entries, key=lambda e: (abs(e['summary']['first_win_rate']-.5),
                  abs(e['summary']['mean_margin']), e['balance_score']))


def main():
    out = DEFAULT_OUT
    pilot = json.loads((out / 'pilot.json').read_text(encoding='utf-8'))
    confirmation = json.loads((out / 'confirmation.json').read_text(encoding='utf-8'))
    plan = json.loads((out / 'selection_plan.json').read_text(encoding='utf-8'))
    digest = hashlib.sha256((out / 'model.pth.tar').read_bytes()).hexdigest()
    assert pilot['complete'] and confirmation['complete']
    assert pilot['sha256'] == confirmation['sha256'] == digest
    expected = [e['id'] for e in rank(pilot['openings'])[:plan['confirmation']['layouts']]]
    assert confirmation['settings']['ids'] == expected
    assert confirmation['settings']['games'] == plan['confirmation']['games_per_layout']
    assert confirmation['settings']['seed'] == plan['confirmation']['seed']
    assert pilot['settings']['sims'] == confirmation['settings']['sims']
    assert not ({pilot['settings']['seed']+i for i in range(pilot['settings']['games'])}
                & {confirmation['settings']['seed']+i for i in range(confirmation['settings']['games'])})
    ranked = rank(confirmation['openings'])
    recommended = ranked[:3]
    results = dict(created_utc=datetime.now(timezone.utc).isoformat(), sha256=digest,
                   scope='Original free-start; 168 neural screens, 8 pilot layouts, 4 independently confirmed layouts',
                   confirmation_ids=expected,
                   recommendations=[dict(id=e['id'], summary=e['summary'], board=e['board'],
                                         layout=display(e['board'])) for e in recommended])
    (out / 'recommendations.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    draw_layouts(out / 'recommended-layouts.svg', recommended)
    lines = ['# 기존 free-start 모델의 균형 배치 후보', '',
             f"대상: `free-start/temp/best.pth.tar`의 고정 사본. SHA-256 `{digest}`.", '',
             '모든 회전·반사 중복을 제외한 168개 배치의 신경망 가치를 검사하고, 방향별 절댓값의 최댓값이 작은 8개를 예비 대국했다. 예비 대국에서 승률이 50%에 가까운 4개를 골라 별도 난수로 확인했다. 색을 바꾸는 것은 다른 배치로 취급했다.', '',
             f"예비: 배치당 {pilot['settings']['games']}국, seed={pilot['settings']['seed']}+대국 번호. 확인: 배치당 {confirmation['settings']['games']}국, seed={confirmation['settings']['seed']}+대국 번호. 두 단계 모두 수당 MCTS {confirmation['settings']['sims']}회. 예비 승률과 확인 승률은 합산하지 않았다.", '',
             '## 독립 확인 결과', '',
             '| 추천 순서 | 배치 ID | 선공 / 후공 승 | 선공 승률 | 95% 구간 | 선공 평균 타일 차 |',
             '|---:|---:|---:|---:|---:|---:|']
    for number, e in enumerate(ranked, 1):
        s=e['summary']; lo,hi=s['wilson_95']
        lines.append(f"| {number} | {e['id']} | {s['first_wins']} / {s['second_wins']} | {s['first_win_rate']:.1%} | {lo:.1%}~{hi:.1%} | {s['mean_margin']:+.3f}장 |")
    lines += ['', '승률이 50%에 가까운 순서로 정렬하고, 동률이면 평균 타일 차이 절댓값, 신경망 선별 점수를 사용했다. 위 순서는 표본상 순위다. 신뢰구간이 겹치는 후보 사이의 실제 우열은 확정할 수 없다.', '',
              '## 추천 배치 세 가지', '',
              'G=초록(선공), B=갈색(후공), ·=빈칸. 두 장을 아래와 같이 놓은 뒤 초록이 정규 첫 수를 둔다. 회전·반사는 동등한 배치다. 아래 그림은 초록의 화살표가 ↑를 보도록 정렬했다.', '']
    for e in recommended:
        s=e['summary']; d=display(e['board'])
        lines += [f"### 배치 {e['id']}: 선공 {s['first_wins']}/{s['games']}승 ({s['first_win_rate']:.1%})", '',
                  '```text', d['diagram'], '```', '',
                  f"초록=(0,0), ↑. 갈색의 상대 위치 (행,열)={tuple(d['second_offset'])}, 화살표 {d['second_direction']}. 행 +는 아래, 열 +는 오른쪽.", '']
    lines += ['## 예비 대국', '',
              '| 배치 ID | 선공 승률 | 평균 타일 차 | 확인 대상으로 선정 |', '|---:|---:|---:|:---:|']
    for e in rank(pilot['openings']):
        s=e['summary']
        lines.append(f"| {e['id']} | {s['first_win_rate']:.1%} | {s['mean_margin']:+.3f} | {'예' if e['id'] in expected else ''} |")
    total_games = sum(len(e['records']) for stage in (pilot, confirmation) for e in stage['openings'])
    total_moves = sum(len(r['actions']) for stage in (pilot, confirmation) for e in stage['openings'] for r in e['records'])
    lines += ['', '## 조건과 해석 범위', '',
              '각 배치에서 같은 모델이 양쪽을 맡았다. 첫 6수는 MCTS 방문 비율대로 확률 선택하고 이후는 최다 방문 수를 선택했다. 회전·반사 8개를 균등 배분했다. 루트 노이즈 없음, cpuct=1.5. 이미 두 장이 놓인 상태에서의 유불리이며 빈 판에서 배치를 고르는 능력의 평가는 아니다.', '',
              '95% 구간은 해당 AI·대국 방식의 Wilson 이항 근사 구간으로 방향별 차이나 모델 오차를 포함하지 않는다. 168개 배치 모두의 실측 승률을 비교한 순위는 아니며, 신경망으로 추린 후보 중의 결과다. 32국만으로 승률이 정확히 50%임을 입증할 수 없고, 선택한 후보 중에서도 우연히 50%에 가까운 결과가 생길 수 있다.', '',
              f"총 {total_games}국, {total_moves}수의 합법성·진행 기록·최종 보드·승패·타일 차이·패스 수를 재생 검증했다. 모든 배치의 방향별 대국 수와 seed를 검사했다. 원본 모델과 학습 자료는 변경하지 않았다.", '',
              '확인 대국에서는 PUCT 점수 계산을 벡터화했다. 원본 MCTS와 18개 초·중·후반 배치에서 각 128회 탐색의 반환값·모든 방문 수·Q값을 매 단계 비교해 완전히 일치함을 확인했고, 실제 고정 모델의 8개 초기 배치에서도 각 100회 탐색 결과가 일치했다. 검증 결과는 `fast_mcts_validation.json`에 있다.', '',
              '## 재현', '', '```powershell',
              'python select_free_start_openings.py --ids 25 17 10 16 32 11 31 103 --games 8 --sims 100 --seed 2026102400 --label pilot',
              f"python select_free_start_openings.py --ids {' '.join(map(str,expected))} --games 32 --sims 100 --seed 2026112400 --label confirmation --fast",
              'python report_free_start_selection.py', '```', '',
              '`screen.json`은 168개 배치와 신경망 평가, `pilot.json`·`confirmation.json`은 모든 수순과 최종 보드, `recommendations.json`은 추천 배치의 좌표와 요약이다. 같은 명령으로 재실행하면 저장한 모델과 완료한 대국을 재사용한다.']
    (out / 'REPORT.md').write_text('\n'.join(lines)+'\n', encoding='utf-8')
    print(json.dumps(results, ensure_ascii=False, indent=2))
    print('Report:',out/'REPORT.md')


if __name__ == '__main__':
    main()
