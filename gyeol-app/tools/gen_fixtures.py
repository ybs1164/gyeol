"""Python 규칙(gyeol_ai)으로 무작위 대국을 두어 TS 엔진 비교용 고정 예제를 만든다.

실행:  python tools/gen_fixtures.py [--ai ../gyeol_ai] [--games 40]
출력:  packages/core/test/fixtures.json
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ai', type=Path, default=ROOT.parent / 'gyeol_ai')
    parser.add_argument('--games', type=int, default=40)
    parser.add_argument('--seed', type=int, default=20261110)
    opts = parser.parse_args()
    sys.path.insert(0, str(opts.ai.resolve()))

    import numpy as np
    from facing.rules import FacingGame, base_action, PASS_ACTION
    from gyeol import GyeolLogic as base

    rng = np.random.default_rng(opts.seed)
    game = FacingGame()
    cases = []
    for _ in range(opts.games):
        board, player = game.getInitBoard(), 1
        while not game.getGameEnded(board, player):
            moves = np.flatnonzero(game.getValidMoves(board, player)).tolist()
            action = int(rng.choice(moves))
            after, info = base.apply_move_verbose(board, player, base_action(action))
            if action == PASS_ACTION:
                info = {'pass': True}
            cases.append(dict(
                board=board.reshape(-1).tolist(), player=player, moves=moves, action=action,
                after=after.reshape(-1).tolist(), last=info,
                result=float(game.getGameEnded(after, -player)),
            ))
            board, player = after, -player
    out = ROOT / 'packages/core/test/fixtures.json'
    out.write_text(json.dumps(cases, separators=(',', ':')), encoding='utf-8')
    passes = sum(1 for c in cases if c['action'] == PASS_ACTION)
    captures = sum(1 for c in cases if c['last'].get('flipped'))
    print(f'{len(cases)} transitions ({passes} passes, {captures} captures) -> {out}')


if __name__ == '__main__':
    main()
