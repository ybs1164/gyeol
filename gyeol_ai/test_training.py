"""Fast regression checks; no production checkpoints are modified."""
import unittest
import json
import pickle
import tempfile
from pathlib import Path
from unittest.mock import patch

import numpy as np
import torch

from Arena import Arena
from Coach import Coach
from MCTS import MCTS
from gyeol.GyeolGame import GyeolGame
from gyeol.pytorch.NNet import NNetWrapper, args
from utils import dotdict


class TrainingTests(unittest.TestCase):
    def test_learning_loop_keeps_suite_out_of_replay(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(args, {
                'num_channels': 4, 'num_res_blocks': 1, 'epochs': 1,
                'batch_size': 64, 'cuda': False, 'train_threads': 1,
                'diagnostic_samples': 64}):
            game = GyeolGame()
            net = NNetWrapper(game)
            settings = dotdict(seed=42, checkpoint=folder, numIters=1,
                               numEps=4, tempThreshold=8, numMCTSSims=5,
                               cpuct=1.5, dirichletAlpha=.3, dirichletEps=.25,
                               fixedValGames=0, valFraction=.25,
                               validationSuiteGames=3, validationAddGames=1,
                               maxlenOfQueue=200000, numItersForTrainExamplesHistory=10,
                               arenaCompare=4, arenaOpeningMoves=4, updateThreshold=.55)
            coach = Coach(game, net, settings)
            generated = []
            execute = coach.executeEpisode
            def capture(*a, **kw):
                result = execute(*a, **kw)
                generated.append(result)
                return result
            with patch.object(coach, 'executeEpisode', side_effect=capture) as episodes:
                coach.learn()
            self.assertEqual(episodes.call_count, 6)
            with open(Path(folder) / 'validation_suite_v2.examples', 'rb') as f:
                suite = pickle.load(f)
            self.assertEqual({g['opponent'] for g in suite}, {'self', 'random_1', 'random_-1'})
            # Whole reserved games are absent; common opening boards may still recur.
            replay_ids = {id(e) for e in coach.trainExamplesHistory[0]}
            for index in (0, 4, 5):
                self.assertTrue(replay_ids.isdisjoint(id(e) for e in generated[index]))
            self.assertEqual(len(replay_ids), sum(len(g) for g in generated[1:4]))
            row = json.loads((Path(folder) / 'training_metrics.jsonl').read_text(encoding='utf8'))
            self.assertEqual(row['schema_version'], 2)
            self.assertEqual(row['validation_suite_games'], 3)
            self.assertIn('train_after', row['training'])
            self.assertEqual(len(row['arena_openings']), 2)

    def test_noise_once_per_move(self):
        game = GyeolGame()

        class Net:
            def predict(self, board):
                return np.ones(game.getActionSize()) / game.getActionSize(), 0.

        mcts = MCTS(game, Net(), dotdict(numMCTSSims=5, cpuct=1.5,
                                       dirichletAlpha=.3, dirichletEps=.25))
        board = game.getInitBoard()
        with patch('numpy.random.dirichlet', wraps=np.random.dirichlet) as noise:
            pi = mcts.getActionProb(board)
            self.assertEqual(noise.call_count, 1)
            np.testing.assert_allclose(pi.sum(), 1.)
            self.assertTrue(np.all(pi[game.getValidMoves(board, 1) == 0] == 0))
            prior = mcts.Ps[game.stringRepresentation(board)].copy()
            mcts.getActionProb(board)
            self.assertEqual(noise.call_count, 2)
            np.testing.assert_array_equal(prior, mcts.Ps[game.stringRepresentation(board)])
        mcts.args['dirichletAlpha'] = 0
        with patch('numpy.random.dirichlet') as noise:
            mcts.getActionProb(board)
            noise.assert_not_called()

    def test_best_epoch_restores_full_state(self):
        game = GyeolGame()
        with patch.dict(args, {'num_channels': 4, 'num_res_blocks': 1,
                               'epochs': 2, 'batch_size': 2, 'cuda': False}):
            net = NNetWrapper(game)
            board = game.getInitBoard()
            legal = np.flatnonzero(game.getValidMoves(board, 1))
            examples = [(board, (legal, np.ones(len(legal)) / len(legal)), 1.)] * 2
            validation = list(examples)
            states = []

            def evaluate(data):
                if data is not validation:
                    return (1., .2, .8)
                states.append({k: v.clone() for k, v in net.nnet.state_dict().items()})
                return [(3., 1., .5), (2., .5, .6), (3., .8, .4), (2., .5, .6)][len(states) - 1]

            with patch.object(net, 'evaluate', side_effect=evaluate):
                report = net._train(examples, validation)
            self.assertEqual(report['selected_epoch'], 1)
            for key, value in net.nnet.state_dict().items():
                torch.testing.assert_close(value, states[1][key])
            self.assertEqual(report['train_before'], report['train_after'])
            self.assertEqual(report['validation_after'], (2., .5, .6))

    def test_greedy_move_keeps_soft_training_target(self):
        class Game:
            def getInitBoard(self): return np.zeros((1, 1), dtype=np.int8)
            def getCanonicalForm(self, board, player): return board
            def getSymmetries(self, board, pi): return [(board, pi)]
            def getNextState(self, board, player, action):
                self.action = action
                return board, -player
            def getGameEnded(self, board, player): return -1

        class Search:
            def getActionProb(self, board, temp):
                self.temp = temp
                return np.array([.25, .75])

        coach = Coach.__new__(Coach)
        coach.game, coach.mcts = Game(), Search()
        coach.args = dotdict(tempThreshold=1)
        examples = coach.executeEpisode()
        self.assertEqual(coach.game.action, 1)
        self.assertEqual(coach.mcts.temp, 1)
        np.testing.assert_allclose(examples[0][1][1], [.25, .75])

    def test_distinct_paired_openings(self):
        coach = Coach.__new__(Coach)
        coach.game = GyeolGame()
        coach.args = dotdict(arenaCompare=40, arenaOpeningMoves=8)
        openings = coach.arena_openings(42)
        self.assertEqual(openings, coach.arena_openings(42))
        positions = set()
        for opening in openings:
            board, player = coach.game.getInitBoard(), 1
            for action in opening:
                self.assertTrue(coach.game.getValidMoves(board, player)[action])
                board, player = coach.game.getNextState(board, player, action)
            self.assertEqual(coach.game.getGameEnded(board, player), 0)
            positions.add((board.tobytes(), player))
        self.assertEqual(len(positions), 20)

        def first_legal(board):
            return int(np.flatnonzero(coach.game.getValidMoves(board, 1))[0])

        arena = Arena(first_legal, first_legal, coach.game)
        arena.playGames(4, openings=openings[:2])
        self.assertEqual([r['opening'] for r in arena.game_records], openings[:2] * 2)

    def test_arena_resets_every_game_and_restores_sides(self):
        class Game:
            def getInitBoard(self): return 0
            def getGameEnded(self, board, player): return player if board else 0
            def getCanonicalForm(self, board, player): return board
            def getValidMoves(self, board, player): return [1]
            def getNextState(self, board, player, action): return 1, -player

        resets = []
        player1, player2 = lambda _: 0, lambda _: 0
        arena = Arena(player1, player2, Game(), reset_players=lambda: resets.append(1))
        self.assertEqual(arena.playGames(4), (2, 2, 0))
        self.assertEqual(len(resets), 4)
        self.assertIs(arena.player1, player1)
        self.assertEqual(len(arena.game_records), 4)


if __name__ == '__main__':
    unittest.main()
