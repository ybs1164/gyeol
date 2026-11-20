"""Vectorize the existing PUCT edge scan for frozen, noise-free evaluations."""
import math

import numpy as np

from MCTS import MCTS, EPS


class OpeningFastMCTS(MCTS):
    def __init__(self, game, nnet, args):
        super().__init__(game, nnet, args)
        self.edges = {}

    def search(self, canonicalBoard, root=False):
        s = self.game.stringRepresentation(canonicalBoard)
        if s not in self.Es:
            self.Es[s] = self.game.getGameEnded(canonicalBoard, 1)
        if self.Es[s] != 0:
            return -self.Es[s]
        if s not in self.Ps:
            return super().search(canonicalBoard, root=root)
        if root and self.root_noise is not None:
            raise ValueError('OpeningFastMCTS supports noise-free evaluation only')
        if s not in self.edges:
            actions = np.flatnonzero(self.Vs[s])
            coeff = self.args.cpuct * self.Ps[s][actions]
            assert coeff.dtype == np.float32
            self.edges[s] = (actions, coeff, np.zeros(len(actions), dtype=np.int64),
                             np.zeros(len(actions), dtype=np.float64))
        actions, coeff, visits, q = self.edges[s]
        # NumPy 2's scalar rules make the original scalar edge scores float32.
        # Preserve that rounding and the original first-action tie break.
        scores = coeff * math.sqrt(self.Ns[s] + EPS)
        seen = visits > 0
        scores[seen] = q[seen].astype(np.float32) + (
            coeff[seen] * math.sqrt(self.Ns[s]) / (1 + visits[seen]).astype(np.float32))
        index = int(np.argmax(scores))
        action = int(actions[index])
        child, player = self.game.getNextState(canonicalBoard, 1, action)
        child = self.game.getCanonicalForm(child, player)
        value = self.search(child)
        edge = (s, action)
        if edge in self.Qsa:
            self.Qsa[edge] = (self.Nsa[edge] * self.Qsa[edge] + value) / (self.Nsa[edge] + 1)
            self.Nsa[edge] += 1
        else:
            self.Qsa[edge] = value
            self.Nsa[edge] = 1
        visits[index] = self.Nsa[edge]
        q[index] = self.Qsa[edge]
        self.Ns[s] += 1
        return -value
