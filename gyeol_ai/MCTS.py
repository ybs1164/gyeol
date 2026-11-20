import logging
import math

import numpy as np

EPS = 1e-8

log = logging.getLogger(__name__)


class MCTS():
    """alpha-zero-general 의 MCTS (PUCT)."""

    def __init__(self, game, nnet, args):
        self.game = game
        self.nnet = nnet
        self.args = args
        self.Qsa = {}  # (s,a) Q 값
        self.Nsa = {}  # (s,a) 방문 수
        self.Ns = {}   # s 방문 수
        self.Ps = {}   # 신경망의 초기 정책
        self.Es = {}   # 게임 종료 여부
        self.Vs = {}   # 합법 수

    def getActionProb(self, canonicalBoard, temp=1):
        # One noisy prior per move; never mutate the cached network prior.
        self.root_prior = None
        self.root_noise = None
        if self.args.get('dirichletAlpha', 0) > 0:
            idx = np.flatnonzero(self.game.getValidMoves(canonicalBoard, 1))
            self.root_noise = (idx, np.random.dirichlet(
                [self.args.dirichletAlpha] * len(idx)))
        for _ in range(self.args.numMCTSSims):
            self.search(canonicalBoard, root=True)

        s = self.game.stringRepresentation(canonicalBoard)
        counts = np.array([self.Nsa.get((s, a), 0) for a in range(self.game.getActionSize())],
                          dtype=np.float64)

        if temp == 0:
            bestAs = np.flatnonzero(counts == counts.max())
            probs = np.zeros(len(counts))
            probs[np.random.choice(bestAs)] = 1
            return probs

        counts = counts ** (1. / temp)
        return counts / counts.sum()

    def search(self, canonicalBoard, root=False):
        s = self.game.stringRepresentation(canonicalBoard)

        if s not in self.Es:
            self.Es[s] = self.game.getGameEnded(canonicalBoard, 1)
        if self.Es[s] != 0:
            return -self.Es[s]

        if s not in self.Ps:
            self.Ps[s], v = self.nnet.predict(canonicalBoard)
            valids = self.game.getValidMoves(canonicalBoard, 1)
            self.Ps[s] = self.Ps[s] * valids
            sum_Ps_s = np.sum(self.Ps[s])
            if sum_Ps_s > 0:
                self.Ps[s] /= sum_Ps_s
            else:
                log.error("All valid moves were masked, doing a workaround.")
                self.Ps[s] = self.Ps[s] + valids
                self.Ps[s] /= np.sum(self.Ps[s])
            self.Vs[s] = valids
            self.Ns[s] = 0
            return -v

        valids = self.Vs[s]
        prior = self.Ps[s]
        # 루트에 디리클레 노이즈를 섞어 자가대국 탐험을 늘린다
        if root and self.root_noise is not None:
            if self.root_prior is None:
                idx, noise = self.root_noise
                self.root_prior = prior.copy()
                eps = self.args.get('dirichletEps', 0.25)
                self.root_prior[idx] = (1 - eps) * prior[idx] + eps * noise
            prior = self.root_prior

        cur_best = -float('inf')
        best_act = -1
        sqrt_ns = math.sqrt(self.Ns[s] + EPS)
        for a in np.flatnonzero(valids):
            if (s, a) in self.Qsa:
                u = self.Qsa[(s, a)] + self.args.cpuct * prior[a] * math.sqrt(self.Ns[s]) / (1 + self.Nsa[(s, a)])
            else:
                u = self.args.cpuct * prior[a] * sqrt_ns
            if u > cur_best:
                cur_best = u
                best_act = a

        a = int(best_act)
        next_s, next_player = self.game.getNextState(canonicalBoard, 1, a)
        next_s = self.game.getCanonicalForm(next_s, next_player)

        v = self.search(next_s)

        if (s, a) in self.Qsa:
            self.Qsa[(s, a)] = (self.Nsa[(s, a)] * self.Qsa[(s, a)] + v) / (self.Nsa[(s, a)] + 1)
            self.Nsa[(s, a)] += 1
        else:
            self.Qsa[(s, a)] = v
            self.Nsa[(s, a)] = 1

        self.Ns[s] += 1
        return -v
