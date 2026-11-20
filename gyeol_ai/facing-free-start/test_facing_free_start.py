import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from facing_free_game import FacingFreeStartGame, ACTION_SIZE, REGULAR_SIZE, placement
from facing_free_net import FacingFreeStartNet
from facing.rules import FacingGame
from facing.network import FacingNet
from free_coach import FreeStartCoach
from gyeol import GyeolLogic as L
from gyeol.pytorch.NNet import args as net_args
from MCTS import MCTS
import numpy as np
import torch
from utils import dotdict

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('facing_free_evaluation', HERE / 'evaluate.py')
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


class FacingFreeStartTests(unittest.TestCase):
    def test_all_setup_pairs_resume_facing_rules(self):
        game = FacingFreeStartGame()
        regular = FacingGame()
        self.assertEqual(ACTION_SIZE, 1109)
        empty = game.getInitBoard()
        self.assertEqual(game.getGameEnded(empty, 1), 0)
        self.assertEqual(game.getValidMoves(empty, 1).sum(), 4)
        for direction in range(4):
            first, player = game.getNextState(empty, 1, placement(0, 0, direction))
            self.assertEqual(player, -1)
            self.assertEqual(game.getValidMoves(first, player).sum(), 320)
            for action in np.flatnonzero(game.getValidMoves(first, player)):
                board, turn = game.getNextState(first, player, int(action))
                self.assertEqual(turn, 1)
                self.assertEqual((board > 0).sum(), 1)
                self.assertEqual((board < 0).sum(), 1)
                r0, r1, c0, c1 = L.bbox(board)
                self.assertLessEqual(max(r1-r0+1, c1-c0+1), 5)
                valid = game.getValidMoves(board, turn)
                np.testing.assert_array_equal(valid[:REGULAR_SIZE], regular.getValidMoves(board, turn))
                self.assertFalse(valid[REGULAR_SIZE:].any())
                a = int(np.flatnonzero(valid)[0])
                expected, _ = regular.getNextState(board, turn, a)
                actual, _ = game.getNextState(board, turn, a)
                np.testing.assert_array_equal(actual, expected)
        with self.assertRaises(ValueError):
            game.getNextState(empty, 1, 784)
        with self.assertRaises(ValueError):
            game.getNextState(first, -1, placement(0, 0, 0))
        with self.assertRaises(ValueError):
            game.getNextState(first, 1, placement(1, 0, 0))
        with self.assertRaises(ValueError):
            game.getNextState(board, 1, placement(1, 0, 0))

    def test_setup_and_regular_symmetries(self):
        game = FacingFreeStartGame()
        first, _ = game.getNextState(game.getInitBoard(), 1, placement(0, 0, 1))
        for dr, dc in [(-4, -4), (4, 0), (0, -4), (1, 0), (2, -1)]:
            for direction in range(4):
                action = placement(dr, dc, direction)
                board, _ = game.getNextState(first, -1, action)
                pi = np.zeros(ACTION_SIZE); pi[action] = 1
                for sym, (transformed, policy) in zip(L.SYMMETRIES, game.getSymmetries(first, pi)):
                    actual, _ = game.getNextState(transformed, -1, int(np.argmax(policy)))
                    np.testing.assert_array_equal(actual, L.recenter(L.transform_board(board, sym)))
                for action in np.flatnonzero(game.getValidMoves(board, 1)):
                    pi = np.zeros(ACTION_SIZE); pi[action] = 1
                    child, _ = game.getNextState(board, 1, int(action))
                    for sym, (transformed, policy) in zip(L.SYMMETRIES, game.getSymmetries(board, pi)):
                        mapped = int(np.argmax(policy))
                        self.assertEqual(policy.sum(), 1)
                        self.assertTrue(game.getValidMoves(transformed, 1)[mapped])
                        actual, _ = game.getNextState(transformed, 1, mapped)
                        np.testing.assert_array_equal(actual, L.recenter(L.transform_board(child, sym)))

    def test_facing_warm_start_preserves_regular_predictions(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(net_args, {
            'num_channels': 4, 'num_res_blocks': 1, 'cuda': False,
        }):
            regular = FacingNet(FacingGame())
            regular.save_checkpoint(folder, 'source.pth.tar')
            game = FacingFreeStartGame()
            net = FacingFreeStartNet(game)
            metadata = net.initialize_from_facing(Path(folder) / 'source.pth.tar')
            self.assertFalse(metadata['setup_trained'])
            board = L.initial_board()
            old_pi, old_value = regular.predict(board)
            new_pi, new_value = net.predict(board)
            valid = FacingGame().getValidMoves(board, 1)
            expected = old_pi * valid; expected /= expected.sum()
            actual = new_pi[:REGULAR_SIZE] * valid; actual /= actual.sum()
            np.testing.assert_allclose(actual, expected, atol=1e-6)
            self.assertAlmostEqual(float(old_value), float(new_value), places=6)
            first, player = game.getNextState(game.getInitBoard(), 1, placement(0, 0, 0))
            pi, _ = net.predict(game.getCanonicalForm(first, player))
            valid = game.getValidMoves(first, player)
            masked = pi[valid > 0]; masked /= masked.sum()
            np.testing.assert_allclose(masked, np.full(320, 1/320), atol=1e-7)
            net.save_checkpoint(folder, 'expanded.pth.tar')
            restored = FacingFreeStartNet(game)
            restored.load_checkpoint(folder, 'expanded.pth.tar')
            np.testing.assert_array_equal(net.predict(board)[0], restored.predict(board)[0])

    def test_training_iteration_setup_targets_and_resume(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(net_args, {
            'num_channels': 4, 'num_res_blocks': 1, 'epochs': 1, 'batch_size': 32,
            'cuda': False, 'train_threads': 1, 'diagnostic_samples': 32,
        }):
            game = FacingFreeStartGame()
            net = FacingFreeStartNet(game)
            config = dotdict(seed=42, checkpoint=folder, numIters=1, numEps=4,
                tempThreshold=10, numMCTSSims=2, cpuct=1.5, dirichletAlpha=.3, dirichletEps=.25,
                fixedValGames=0, valFraction=.25, validationSuiteGames=3, validationAddGames=1,
                maxlenOfQueue=200000, numItersForTrainExamplesHistory=10, arenaCompare=4,
                arenaOpeningMoves=8, updateThreshold=.55, load_folder_file=(folder, 'best.pth.tar'))
            np.random.seed(42); torch.manual_seed(42)
            coach = FreeStartCoach(game, net, config)
            net.save_checkpoint(folder, 'best.pth.tar')
            before = net.nnet.p_pass.weight.detach().clone()
            coach.learn()
            records = [json.loads(s) for s in (Path(folder) / 'opening_games.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertEqual(len(records), 6)
            for rec in records:
                board, player = game.getInitBoard(), 1
                for i, action in enumerate(rec['actions']):
                    self.assertTrue(game.getValidMoves(board, player)[action])
                    board, player = game.getNextState(board, player, action)
                    if i == 1:
                        np.testing.assert_array_equal(board, rec['opening'])
                self.assertEqual(game.getGameEnded(board, 1), rec['result'])
            row = json.loads((Path(folder) / 'training_metrics.jsonl').read_text(encoding='utf-8'))
            self.assertEqual([len(o) for o in row['arena_openings']], [0, 2])
            candidate = torch.load(Path(folder) / row['candidate'], map_location='cpu', weights_only=True)['state_dict']
            self.assertFalse(torch.equal(before[1:], candidate['p_pass.weight'][1:]))
            examples = [e for batch in coach.trainExamplesHistory for e in batch if np.count_nonzero(e[0]) < 2]
            self.assertEqual({np.count_nonzero(e[0]) for e in examples}, {0, 1})
            self.assertTrue(all(np.all(e[1][0] >= REGULAR_SIZE) for e in examples))
            restored = FacingFreeStartNet(game)
            restored.load_checkpoint(folder, 'best.pth.tar')
            resumed = FreeStartCoach(game, restored, config)
            resumed.loadTrainExamples()
            self.assertEqual(len(resumed.trainExamplesHistory), len(coach.trainExamplesHistory))

    def test_evaluation_freezes_model_and_completes_games(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(net_args, {
            'num_channels': 4, 'num_res_blocks': 1, 'cuda': False,
        }):
            folder = Path(folder)
            game = FacingFreeStartGame()
            net = FacingFreeStartNet(game)
            net.save_checkpoint(str(folder), 'source.pth.tar')
            out = folder / 'evaluation'
            args = ['evaluate.py', '--model', str(folder / 'source.pth.tar'), '--output', str(out),
                    '--openings', '1', '--games', '8', '--sims', '2', '--batch-size', '8']
            with patch.object(sys, 'argv', args):
                evaluation.main()
            report = json.loads((out / 'results.json').read_text(encoding='utf-8'))
            self.assertGreater(len(report['screen']), 100)
            self.assertTrue(report['openings'][0]['original'])
            self.assertEqual(report['openings'][0]['summary']['games'], 8)
            self.assertEqual((out / 'model.pth.tar').read_bytes(), (folder / 'source.pth.tar').read_bytes())
            self.assertTrue((out / 'REPORT.md').is_file())
            # Resume must retain the frozen model even if the live source changes.
            (folder / 'source.pth.tar').write_bytes(b'new live checkpoint')
            with patch.object(sys, 'argv', args):
                evaluation.main()
            resumed = json.loads((out / 'results.json').read_text(encoding='utf-8'))
            self.assertEqual(resumed['openings'][0]['records'], report['openings'][0]['records'])


if __name__ == '__main__':
    unittest.main()
