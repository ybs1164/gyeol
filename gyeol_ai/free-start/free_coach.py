"""Learn setup choices and retain per-opening self-play evidence."""
import json
from pathlib import Path
import uuid

import numpy as np

from Coach import Coach
from gyeol import GyeolLogic as L


class FreeStartCoach(Coach):
    def __init__(self, game, nnet, args):
        super().__init__(game, nnet, args)
        self.session_id = uuid.uuid4().hex

    def arena_openings(self, seed):
        # Half of the color-swapped pairs evaluate learned setup choices;
        # half start from reproducible, diverse two-tile placements.
        rng = np.random.default_rng(seed)
        pairs = self.args.arenaCompare // 2
        openings = [()] * ((pairs + 1) // 2)
        for _ in range(pairs - len(openings)):
            board, player, actions = self.game.getInitBoard(), 1, []
            for _ in range(2):
                action = int(rng.choice(np.flatnonzero(self.game.getValidMoves(board, player))))
                actions.append(action)
                board, player = self.game.getNextState(board, player, action)
            openings.append(actions)
        return openings

    def executeEpisode(self, random_opponent=None):
        examples, actions = [], []
        board, player = self.game.getInitBoard(), 1
        opening = None
        while True:
            canonical = self.game.getCanonicalForm(board, player)
            pi = self.mcts.getActionProb(canonical, temp=1)
            for b, p in self.game.getSymmetries(canonical, pi):
                idx = np.flatnonzero(p)
                examples.append((b, player, (idx.astype(np.int16), p[idx].astype(np.float32))))
            if player == random_opponent:
                action = int(np.random.choice(np.flatnonzero(self.game.getValidMoves(board, player))))
            elif len(actions) + 1 < self.args.tempThreshold:
                action = int(np.random.choice(len(pi), p=pi))
            else:
                action = int(np.random.choice(np.flatnonzero(pi == pi.max())))
            actions.append(action)
            board, player = self.game.getNextState(board, player, action)
            if len(actions) == 2:
                opening = board.copy()
            result = self.game.getGameEnded(board, 1)
            if result:
                variants = [L.recenter(L.transform_board(opening, s)) for s in L.SYMMETRIES]
                record = dict(session=self.session_id, random_opponent=random_opponent,
                              opening_key=min(b.tobytes() for b in variants).hex(),
                              opening=opening.tolist(), actions=actions,
                              result=float(result), margin=int(np.sign(board).sum()),
                              seed=self.args.seed)
                folder = Path(self.args.checkpoint)
                folder.mkdir(parents=True, exist_ok=True)
                with (folder / 'opening_games.jsonl').open('a', encoding='utf-8') as f:
                    f.write(json.dumps(record) + '\n')
                return [(b, p, result if owner == 1 else -result) for b, owner, p in examples]
