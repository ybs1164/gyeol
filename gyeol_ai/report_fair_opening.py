"""Write a readable report from the completed, frozen-model experiments."""
import json
from pathlib import Path
from find_fair_opening import OUT


def main():
    data=json.loads((OUT/'confirmation.json').read_text())
    assert all(c['summary']['games']==data['settings']['games'] for c in data['candidates'])
    candidates=json.loads((OUT/'screen.json').read_text())
    meta=json.loads((OUT/'metadata.json').read_text())
    ranked=sorted((c for c in data['candidates'] if c['id']!=6),
                  key=lambda c:(abs(c['summary']['first_win_rate']-.5),abs(c['summary']['mean_margin'])))
    best=ranked[0]
    arrows={1:'↑',2:'→',3:'↓',4:'←'}
    def board_lines(board):
        return '\n'.join('  '.join(' · ' if v==0 else ('초록' if v>0 else '갈색')+arrows[abs(v)] for v in row) for row in board)
    text=[f'# 초기 배치 공정성 비교\n',
          f"새 난수 재평가에서 50%에 가장 가까운 후보: **{best['id']}**. 초록 선공.\n",
          '```text\n'+board_lines(best['diagram'])+'\n```\n',
          '이는 조사한 후보 중 현재 모델의 대국 결과가 가장 균형에 가까운 배치이며, 완전한 공정성이나 최적 플레이에서의 50:50을 증명하지는 않는다.\n',
          '## 최종 비교\n',
          '| 후보 | 선공 승 / 후공 승 | 선공 승률 | 승률 Wilson 95% 구간 | 선공 평균 돌 수 차이 |\n|---|---:|---:|---:|---:|']
    for c in data['candidates']:
        s=c['summary']; lo,hi=s['wilson_95']
        text.append(f"| {c['id']}{' (기존)' if c['id']==6 else ''} | {s['first_wins']} / {s['second_wins']} | {s['first_win_rate']:.1%} | {lo:.1%}–{hi:.1%} | {s['mean_margin']:+.2f} |")
    text += ['\n모든 후보를 동일한 새 난수 24개와 회전·반사 8방향으로 비교했다. 양쪽 모두 같은 모델, 매 수 MCTS 100회, 처음 6수는 방문 비율에 따라 확률 선택, 이후에는 최다 방문 수 선택이다. 루트 노이즈는 사용하지 않았다. 최종 비교의 각 후보는 서로 다른 수순 24개인지 원시 결과에 기록했다.\n',
             '## 조사 범위와 해석\n',
             '- 인접한 돌 2개: 방향 조합을 회전·반사 중복 제거한 10종.\n- 각 색 2개인 2×2: 색·방향 조합 1,536개에서 대칭 중복을 제거한 204종.\n- 저장된 자가대국에 나타난 각 색 2개 배치: 추가 91종.\n- 총 305종을 200회 MCTS로 조사하고, 우선 후보 15종과 추가 후보 2종은 2,000회 탐색했다. 조사 탐색은 루트 정책에 합법 수 균등 확률을 10% 혼합해 기존 정책 편중을 줄였다. 실제 대국에서는 이 혼합을 사용하지 않았다.\n- 대국 비교는 10종의 배치에 대해 수행했다. 1차 128판, 새 난수 최종 비교 96판. 별도 탐색용 후보 144의 12판은 이 비교 표에서 제외했다.\n- 기존 시작 배치만으로 학습한 모델이므로 새 배치의 값 함수는 보정되지 않을 수 있다. 실제로 탐색 평가가 0에 가까워도 선공 승률이 높게 나온 후보가 있었다. 추천은 신경망의 초기 값만으로 정하지 않았다.\n- 승률 구간은 고정 모델·선택한 대국 방식의 이항 표본 구간이다. 후보 선택 효과, 모델 오차, 더 강한 플레이의 영향을 포함하지 않는다. 후보 간 차이를 확정하는 검정으로 해석하면 안 된다.\n- 모든 가능한 4돌 위치나 더 큰 초기 배치를 전수 탐색한 것은 아니다.\n',
             '## 후보 배치\n']
    for c in data['candidates']:
        text += [f"### 후보 {c['id']}\n",'```text\n'+board_lines(c['diagram'])+'\n```\n']
    text += ['## 재현과 원시 자료\n',
             f"고정 모델 SHA-256: `{meta['sha256']}`. 분석 시작 때 `temp/best.pth.tar`를 읽어 `model.pth.tar`에 고정했다.\n",
             '- `screen.json`: 전체 305종의 배치와 1차 탐색 결과.\n- `finalists.json`, `extended_deep.json`: 깊은 탐색 결과.\n- `comparison.json`, `diagonal_comparison.json`: 1차 대국 결과.\n- `confirmation.json`: 최종 비교 전체 수순, 결과, 난수, 방향, 점수 차이.\n',
             '```powershell\npython validate_fair_opening_batch.py --ids 18 284 301 6 --games 24 --sims 100 --seed 2026101900 --label confirmation --batch-size 32\npython report_fair_opening.py\n```\n']
    (OUT/'REPORT.md').write_text('\n'.join(text),encoding='utf-8')
    (OUT/'recommended_board.json').write_text(json.dumps(dict(id=best['id'],board=candidates[best['id']]['board'],
         diagram=best['diagram'],first_player=1,summary=best['summary'],model_sha256=meta['sha256']),indent=2),encoding='utf-8')
    print(json.dumps(dict(recommended=best['id'],summary=best['summary'],all=[dict(id=c['id'],summary=c['summary']) for c in data['candidates']]),indent=2))


if __name__=='__main__': main()
