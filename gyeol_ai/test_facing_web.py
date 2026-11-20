"""Compare the browser rules against Python and exercise browser MCTS."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

import numpy as np

from facing.rules import FacingGame, base_action
from gyeol import GyeolLogic as base


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path('N:/Projects/ybs1164.github.io'))
    opts = parser.parse_args()
    rng = np.random.default_rng(20261021)
    game = FacingGame()
    cases = []
    for _ in range(25):
        board, player = game.getInitBoard(), 1
        while not game.getGameEnded(board, player):
            moves = np.flatnonzero(game.getValidMoves(board, player)).tolist()
            action = int(rng.choice(moves))
            after, info = base.apply_move_verbose(board, player, base_action(action))
            cases.append(dict(board=board.reshape(-1).tolist(), player=player,
                              moves=moves, action=action, after=after.reshape(-1).tolist(),
                              last=info, result=game.getGameEnded(after, -player)))
            board, player = after, -player
    with tempfile.TemporaryDirectory() as tmp:
        fixtures = Path(tmp) / 'cases.json'
        fixtures.write_text(json.dumps(cases), encoding='utf-8')
        runner = Path(tmp) / 'check.mjs'
        source = '''
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const E = await import(process.argv[2]);
const cases = JSON.parse(readFileSync(process.argv[3], 'utf8'));
for (const c of cases) {
  assert.deepEqual(E.legal(c.board,c.player).sort((a,b)=>a-b), c.moves);
  assert.deepEqual(E.apply(c.board,c.player,c.action), {board:c.after,last:c.last});
  assert.equal(E.result(c.after,-c.player),c.result);
  for (const a of c.moves) {
    if(a===E.PASS)continue;
    const [r,col,nd,pr,pc,pd]=E.decode(a);
    const dirs=[[-1,0],[0,1],[1,0],[0,-1]];
    assert.equal(pr+dirs[pd][0],r);
    assert.equal(pc+dirs[pd][1],col);
  }
}
const predict=async()=>({policy:Array(785).fill(1/785),value:0});
for(const player of [1,-1]) {
  let b=E.initial(),p=player,turn=0;
  while(!E.result(b,p)) {
    assert.ok(++turn<60);
    const a=await E.search(b.map(v=>v*p),4,predict);
    assert.ok(E.legal(b,p).includes(a));
    b=E.apply(b,p,a).board;p=-p;
  }
}
console.log(`Validated ${cases.length} Python/browser transitions and two MCTS games.`);
'''
        runner.write_text(source, encoding='utf-8')
        engine = (opts.repo / 'gyeol/facing/engine.js').resolve().as_uri()
        subprocess.run(['node', str(runner), engine, str(fixtures)], check=True)


if __name__ == '__main__':
    main()
