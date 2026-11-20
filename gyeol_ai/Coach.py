import json
import uuid
import logging
import os
import time
from collections import deque
from pickle import Pickler, Unpickler
from random import shuffle

import numpy as np
from tqdm import tqdm

from Arena import Arena
from MCTS import MCTS
from utils import dotdict

log = logging.getLogger(__name__)


class Coach():
    """자가대국 → 학습 → 이전 모델과 대결 → 이기면 교체 (alpha-zero-general 과 동일한 루프)."""

    def __init__(self, game, nnet, args):
        self.game = game
        self.nnet = nnet
        self.pnet = self.nnet.__class__(self.game)  # 경쟁 상대(이전 모델)
        self.args = args
        self.mcts = MCTS(self.game, self.nnet, self.args)
        self.trainExamplesHistory = []
        self.arena_args = dotdict({**args, 'dirichletAlpha': 0})

    def executeEpisode(self, random_opponent=None):
        trainExamples = []
        board = self.game.getInitBoard()
        self.curPlayer = 1
        episodeStep = 0

        while True:
            episodeStep += 1
            canonicalBoard = self.game.getCanonicalForm(board, self.curPlayer)
            temp = int(episodeStep < self.args.tempThreshold)

            # Keep the search distribution as the target, even for greedy moves.
            pi = self.mcts.getActionProb(canonicalBoard, temp=1)
            for b, p in self.game.getSymmetries(canonicalBoard, pi):
                idx = np.flatnonzero(p)  # 정책은 대부분 0 이므로 희소 형태로 저장 (메모리 절약)
                trainExamples.append([b, self.curPlayer, (idx.astype(np.int16), p[idx].astype(np.float32)), None])

            if self.curPlayer == random_opponent:
                action = np.random.choice(np.flatnonzero(self.game.getValidMoves(canonicalBoard, 1)))
            elif temp:
                action = np.random.choice(len(pi), p=pi)
            else:
                action = np.random.choice(np.flatnonzero(pi == pi.max()))
            board, self.curPlayer = self.game.getNextState(board, self.curPlayer, action)

            r = self.game.getGameEnded(board, self.curPlayer)
            if r != 0:
                return [(x[0], x[2], r * ((-1) ** (x[1] != self.curPlayer))) for x in trainExamples]

    def arena_openings(self, seed):
        """Unique nonterminal positions, reused with the model colors swapped."""
        rng = np.random.default_rng(seed)
        openings, positions = [], set()
        count = self.args.arenaCompare // 2
        for _ in range(max(100, count * 100)):
            board, player, actions = self.game.getInitBoard(), 1, []
            for _ in range(int(rng.integers(2, self.args.get('arenaOpeningMoves', 8) + 1))):
                if self.game.getGameEnded(board, player):
                    break
                action = int(rng.choice(np.flatnonzero(self.game.getValidMoves(board, player))))
                actions.append(action)
                board, player = self.game.getNextState(board, player, action)
            key = (self.game.stringRepresentation(board), player)
            if not self.game.getGameEnded(board, player) and key not in positions:
                positions.add(key)
                openings.append(actions)
                if len(openings) == count:
                    return openings
        raise RuntimeError('Could not generate enough distinct arena positions')

    def learn(self):
        run_id = uuid.uuid4().hex[:12]
        fixed_path = os.path.join(self.args.checkpoint, 'fixed_validation.examples')
        fixed_examples = []
        suite_path = os.path.join(self.args.checkpoint, 'validation_suite_v2.examples')
        suite = []
        if os.path.isfile(suite_path):
            with open(suite_path, 'rb') as f:
                suite = Unpickler(f).load()
        if os.path.isfile(fixed_path):
            with open(fixed_path, 'rb') as f:
                fixed_examples = Unpickler(f).load()
        start = time.time()
        limit = self.args.get('timeLimitHours', 0) * 3600
        last_dur = 0
        for i in range(1, self.args.numIters + 1):
            elapsed = time.time() - start
            # 직전 반복만큼 더 걸린다고 보고, 제한 시간을 넘길 것 같으면 새 반복을 시작하지 않는다
            if limit and elapsed + last_dur > limit:
                log.info(f'시간 제한 도달: {elapsed / 3600:.2f}시간 경과, {i - 1}회 반복 후 종료')
                break
            iter_start = time.time()
            log.info(f'Starting Iter #{i} ... (경과 {elapsed / 3600:.2f}h)')
            # 이어서 학습할 때도 항상 새 자가대국부터 한다 (같은 데이터로 다시 학습하면 과적합만 커진다)
            games = []
            for _ in tqdm(range(self.args.numEps), desc="Self Play"):
                self.mcts = MCTS(self.game, self.nnet, self.args)
                games.append(self.executeEpisode())

            # Reserve fresh complete games permanently; never add them to replay.
            if not fixed_examples and self.args.get('fixedValGames', 0):
                count = min(self.args.fixedValGames, len(games) - 2)
                if count > 0:
                    fixed_examples = [e for g in games[:count] for e in g]
                    games = games[count:]
                    os.makedirs(self.args.checkpoint, exist_ok=True)
                    with open(fixed_path, 'wb') as f:
                        Pickler(f).dump(fixed_examples)
            # 이번 반복 대국 중 일부를 '판 단위'로 떼어 검증용으로 쓴다 (같은 판의 대칭·이웃 수가 학습에 섞이지 않게).
            # 학습이 끝나면 다음 반복부터는 학습 데이터로 합류한다.
            # Build a versioned holdout across iterations and opponent types.
            # Never mix its visit-distribution targets with legacy one-hot metrics.
            capacity = self.args.get('validationSuiteGames', 100)
            if len(suite) < capacity:
                reserve = min(self.args.get('validationAddGames', 3),
                              capacity - len(suite), max(0, len(games) - 2))
                for g in games[:reserve]:
                    suite.append({'run_id': run_id, 'iteration': i,
                                  'opponent': 'self', 'examples': g})
                games = games[reserve:]
                for side in (1, -1):
                    if len(suite) >= capacity:
                        break
                    self.mcts = MCTS(self.game, self.nnet, self.args)
                    suite.append({'run_id': run_id, 'iteration': i,
                                  'opponent': f'random_{side}',
                                  'examples': self.executeEpisode(random_opponent=side)})
                os.makedirs(self.args.checkpoint, exist_ok=True)
                with open(suite_path, 'wb') as f:
                    Pickler(f).dump(suite)
            n_val = max(1, int(len(games) * self.args.get('valFraction', 0.1)))
            val_games, train_games = games[:n_val], games[n_val:]
            valExamples = [e for g in val_games for e in g]

            iterationTrainExamples = deque([], maxlen=self.args.maxlenOfQueue)
            for g in games:
                iterationTrainExamples += g
            self.trainExamplesHistory.append(iterationTrainExamples)
            if len(self.trainExamplesHistory) > self.args.numItersForTrainExamplesHistory:
                log.warning(f"Removing the oldest entry in trainExamples. len = {len(self.trainExamplesHistory)}")
                self.trainExamplesHistory.pop(0)
            self.saveTrainExamples(i - 1)

            trainExamples = []
            for e in self.trainExamplesHistory[:-1]:   # 이전 반복들 + 이번 반복의 학습용 판
                trainExamples.extend(e)
            trainExamples.extend(e for g in train_games for e in g)
            shuffle(trainExamples)

            self.nnet.save_checkpoint(folder=self.args.checkpoint, filename='temp.pth.tar')
            self.pnet.load_checkpoint(folder=self.args.checkpoint, filename='temp.pth.tar')
            training_report = self.nnet.train(trainExamples, valExamples)
            fixed_metrics = self.nnet.evaluate(fixed_examples) if fixed_examples else None
            suite_metrics = {}
            for opponent in sorted({g['opponent'] for g in suite}):
                examples = [e for g in suite if g['opponent'] == opponent for e in g['examples']]
                suite_metrics[opponent] = {
                    'examples': len(examples),
                    'previous': self.pnet.evaluate(examples),
                    'candidate': self.nnet.evaluate(examples),
                }
            candidate = f'candidate_{run_id}_{i}.pth.tar'
            self.nnet.save_checkpoint(folder=self.args.checkpoint, filename=candidate)
            players = {}

            def reset_players():
                players['previous'] = MCTS(self.game, self.pnet, self.arena_args)
                players['new'] = MCTS(self.game, self.nnet, self.arena_args)

            log.info('PITTING AGAINST PREVIOUS VERSION')
            arena = Arena(lambda x: np.argmax(players['previous'].getActionProb(x, temp=0)),
                          lambda x: np.argmax(players['new'].getActionProb(x, temp=0)),
                          self.game, reset_players=reset_players)
            opening_seed = self.args.get('seed', 0) + i + int(run_id[:8], 16)
            openings = self.arena_openings(opening_seed)
            pwins, nwins, draws = arena.playGames(self.args.arenaCompare, openings=openings)

            log.info('NEW/PREV WINS : %d / %d ; DRAWS : %d' % (nwins, pwins, draws))
            if pwins + nwins == 0 or float(nwins) / (pwins + nwins) < self.args.updateThreshold:
                log.info('REJECTING NEW MODEL')
                self.nnet.load_checkpoint(folder=self.args.checkpoint, filename='temp.pth.tar')
            else:
                log.info('ACCEPTING NEW MODEL')
                self.nnet.save_checkpoint(folder=self.args.checkpoint, filename=self.getCheckpointFile(i))
                self.nnet.save_checkpoint(folder=self.args.checkpoint, filename='best.pth.tar')
            records = arena.game_records
            half = len(records) // 2
            stats = {
                'run_id': run_id, 'iteration': i, 'candidate': candidate,
                'seed': self.args.get('seed'),
                'fixed_validation': fixed_metrics,
                'schema_version': 2, 'policy_target': 'mcts_visit_distribution',
                'validation_suite': suite_metrics, 'validation_suite_games': len(suite),
                'arena_opening_seed': opening_seed, 'arena_openings': openings,
                'training': training_report, 'new_wins': nwins, 'previous_wins': pwins,
                'draws': draws,
                'accepted': bool(pwins + nwins and nwins / (pwins + nwins) >= self.args.updateThreshold),
                'new_first_wins': sum(r['result'] == 1 for r in records[half:]),
                'new_second_wins': sum(r['result'] == -1 for r in records[:half]),
                'mean_moves': float(np.mean([r['moves'] for r in records])),
                'unique_games': len({tuple(r['opening'] + r['actions']) for r in records}),
                'arena_games': records,
            }
            with open(os.path.join(self.args.checkpoint, 'training_metrics.jsonl'), 'a', encoding='utf-8') as f:
                f.write(json.dumps(stats, ensure_ascii=False) + '\n')
            log.info('Arena: new first %d/%d, second %d/%d, mean %.1f moves, unique games %d/%d',
                     stats['new_first_wins'], half, stats['new_second_wins'], half,
                     stats['mean_moves'], stats['unique_games'], len(records))
            last_dur = time.time() - iter_start
            log.info(f'Iter #{i} 소요 {last_dur / 60:.1f}분')

    def getCheckpointFile(self, iteration):
        return 'checkpoint_' + str(iteration) + '.pth.tar'

    def saveTrainExamples(self, iteration):
        folder = self.args.checkpoint
        os.makedirs(folder, exist_ok=True)
        filename = os.path.join(folder, "trainExamples.examples")  # 반복마다 덮어씀 (전체 이력이 들어 있음)
        with open(filename, "wb+") as f:
            Pickler(f).dump(self.trainExamplesHistory)

    def loadTrainExamples(self):
        examplesFile = os.path.join(self.args.load_folder_file[0], "trainExamples.examples")
        if not os.path.isfile(examplesFile):
            log.warning(f'File "{examplesFile}" with trainExamples not found! 자가대국부터 시작합니다.')
        else:
            log.info("File with trainExamples found. Loading it...")
            with open(examplesFile, "rb") as f:
                self.trainExamplesHistory = Unpickler(f).load()
            log.info('Loading done!')
