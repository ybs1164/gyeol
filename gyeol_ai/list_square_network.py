"""Export the previously evaluated square openings, without new inference."""
import csv
import json
from pathlib import Path

out = Path('four_tile_network_analysis')
data = json.loads((out/'results.json').read_text(encoding='utf-8'))
rows = sorted((e for e in data['positions'] if e['shape'] == 'O'), key=lambda e:e['id'])
assert len(rows) == 204
lines = ['# 정사각형 오프닝 204개: 신경망 승률 추정', '',
         'G=초록(선공), B=갈색(후공). `/` 앞은 윗줄, 뒤는 아랫줄이다. 회전·반사 중복을 제거한 204개이며, 승률은 8개 변환의 신경망 평가 평균이다. 실제 대국 승률은 아니다.', '',
         f"모델 SHA-256: `{data['metadata']['sha256']}`", '',
         '| ID | 배치: 윗줄 / 아랫줄 | 선공 | 후공 |',
         '|---|---|---:|---:|']
for e in rows:
    lines.append(f"| {e['id']} | {e['layout']} | {e['first_win_probability']:.2%} | {e['second_win_probability']:.2%} |")
(out/'SQUARE_ALL.md').write_text('\n'.join(lines), encoding='utf-8')
fields = ['id','layout','first_win_probability','second_win_probability',
          'displayed_orientation_first_probability','orientation_probability_min','orientation_probability_max']
with (out/'square_all.csv').open('w', newline='', encoding='utf-8-sig') as f:
    writer = csv.DictWriter(f,fieldnames=fields,extrasaction='ignore')
    writer.writeheader()
    writer.writerows(rows)
print('\n'.join(lines[6:]))
