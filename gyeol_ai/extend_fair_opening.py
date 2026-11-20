"""Include observed balanced four-tile positions beyond the square family."""
import json
import numpy as np
from find_fair_opening import OUT, search, key
from gyeol.GyeolGame import GyeolGame
from gyeol.pytorch.NNet import NNetWrapper


def main():
    path=OUT/'screen.json'
    rows=json.loads(path.read_text())
    (OUT/'screen_square.json').write_text(json.dumps(rows[:214],indent=2),encoding='utf-8')
    known={key(np.array(c['board'],dtype=np.int8)) for c in rows}
    game=GyeolGame()
    net=NNetWrapper(game)
    net.load_checkpoint(str(OUT),'model.pth.tar')
    for r in json.loads((OUT/'replay_four_tiles.json').read_text()):
        b=np.array(r['board'],dtype=np.int8)
        if key(b) in known: continue
        known.add(key(b))
        c=dict(id=len(rows),tiles=4,board=r['board'],diagram=r['diagram'],original=False,
            source='replay',historical_games=r['games'],historical_first_wins=r['wins'])
        c['screen']=search(game,net,b,200)
        rows.append(c)
        if len(rows)%20==0: print('extended',len(rows),flush=True)
    path.write_text(json.dumps(rows,indent=2),encoding='utf-8')
    extra=sorted([c for c in rows if c.get('source')=='replay'],key=lambda c:abs(c['screen']['best_q']))
    print([(c['id'],c['diagram'],c['screen']['best_q'],c['historical_games'],c['historical_first_wins']) for c in extra[:12]],flush=True)


if __name__=='__main__': main()
