import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import torch
from gyeol import GyeolLogic as L
from gyeol.pytorch.NNet import args as net_args
from MCTS import MCTS
from utils import dotdict
from free_game import FreeStartGame, ACTION_SIZE, placement
from free_net import FreeStartNet
from free_coach import FreeStartCoach
from evaluate import layouts, play, summarize
import evaluate


class FreeStartTests(unittest.TestCase):
    def setUp(self):
        self.game = FreeStartGame()

    def test_all_initial_pairs_fit_and_regular_rules_resume(self):
        g = self.game
        empty = g.getInitBoard()
        self.assertEqual(g.getGameEnded(empty, 1), 0)
        self.assertEqual(g.getValidMoves(empty, 1).sum(), 4)
        for d in range(4):
            first, p = g.getNextState(empty, 1, placement(0, 0, d))
            self.assertEqual(p, -1)
            self.assertEqual(g.getGameEnded(first, p), 0)
            self.assertEqual(g.getValidMoves(first, p).sum(), 320)
            for a in np.flatnonzero(g.getValidMoves(first, p)):
                b, p2 = g.getNextState(first, p, a)
                self.assertEqual(p2, 1)
                self.assertEqual(np.count_nonzero(b > 0), 1)
                self.assertEqual(np.count_nonzero(b < 0), 1)
                r0, r1, c0, c1 = L.bbox(b)
                self.assertLessEqual(max(r1-r0+1, c1-c0+1), 5)
                np.testing.assert_array_equal(g.getValidMoves(b, p2)[:L.ACTION_SIZE], L.valid_vector(b, p2))
                self.assertFalse(g.getValidMoves(b, p2)[L.ACTION_SIZE:].any())
        with self.assertRaises(ValueError):
            g.getNextState(empty, 1, L.PASS_ACTION)
        with self.assertRaises(ValueError):
            g.getNextState(first, -1, placement(0, 0, 0))

    def test_symmetries_preserve_setup_transitions(self):
        g = self.game
        empty = g.getInitBoard()
        for d in range(4):
            first, _ = g.getNextState(empty, 1, placement(0, 0, d))
            for dr, dc in [(-4, -4), (-4, 0), (4, 4), (0, 4), (1, -2)]:
                for pd in range(4):
                    a = placement(dr, dc, pd)
                    pi = np.zeros(ACTION_SIZE)
                    pi[a] = 1
                    child, _ = g.getNextState(first, -1, a)
                    for sym, (b, p) in zip(L.SYMMETRIES, g.getSymmetries(first, pi)):
                        aa = int(np.argmax(p))
                        self.assertTrue(g.getValidMoves(b, -1)[aa])
                        actual, _ = g.getNextState(b, -1, aa)
                        expected = L.recenter(L.transform_board(child, sym))
                        np.testing.assert_array_equal(actual, expected)
                        self.assertEqual(p.sum(), 1)

    def test_evaluation_and_complete_random_search_games(self):
        g = self.game
        class UniformNet:
            def predict(self, board):
                return np.ones(ACTION_SIZE) / ACTION_SIZE, 0.
        boards = layouts(g)
        self.assertGreater(len(boards), 100)
        records = [play(g, UniformNet(), boards[i], 2, 100+i, i) for i in range(4)]
        self.assertEqual(summarize(records)['games'], 4)
        self.assertTrue(all(r['result'] in (-1, 1) for r in records))

    def test_training_iteration_setup_targets_and_resume(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(net_args, {
            'num_channels': 4, 'num_res_blocks': 1, 'epochs': 1,
            'batch_size': 32, 'cuda': False, 'train_threads': 1, 'diagnostic_samples': 32,
        }):
            g = self.game
            net = FreeStartNet(g)
            pi, value = net.predict(g.getInitBoard())
            self.assertEqual(pi.shape, (ACTION_SIZE,))
            self.assertTrue(np.isfinite(value))
            cfg = dotdict(seed=42, checkpoint=folder, numIters=1, numEps=4,
                          tempThreshold=10, numMCTSSims=2, cpuct=1.5,
                          dirichletAlpha=.3, dirichletEps=.25, fixedValGames=0,
                          valFraction=.25, validationSuiteGames=3, validationAddGames=1,
                          maxlenOfQueue=200000, numItersForTrainExamplesHistory=10,
                          arenaCompare=4, arenaOpeningMoves=8, updateThreshold=.55,
                          load_folder_file=(folder, 'best.pth.tar'))
            np.random.seed(42)
            torch.manual_seed(42)
            coach = FreeStartCoach(g, net, cfg)
            net.save_checkpoint(folder, 'best.pth.tar')
            before = net.nnet.p_pass.weight.detach().clone()
            coach.learn()
            row = json.loads((Path(folder) / 'training_metrics.jsonl').read_text())
            self.assertEqual(len(row['arena_openings']), 2)
            self.assertEqual([len(a) for a in row['arena_openings']], [0, 2])
            candidates = list(Path(folder).glob('candidate_*.pth.tar'))
            candidate = torch.load(candidates[0], map_location='cpu')['state_dict']['p_pass.weight']
            self.assertFalse(torch.equal(before[1:], candidate[1:]))
            records = [json.loads(line) for line in (Path(folder) / 'opening_games.jsonl').read_text().splitlines()]
            self.assertEqual(len(records), 6)
            for rec in records:
                b, player = g.getInitBoard(), 1
                for i, a in enumerate(rec['actions']):
                    self.assertTrue(g.getValidMoves(b, player)[a])
                    b, player = g.getNextState(b, player, a)
                    if i == 1:
                        np.testing.assert_array_equal(b, rec['opening'])
                self.assertEqual(g.getGameEnded(b, 1), rec['result'])
            examples = [e for batch in coach.trainExamplesHistory for e in batch]
            setup = [e for e in examples if np.count_nonzero(e[0]) < 2]
            self.assertTrue(any(np.count_nonzero(e[0]) == 0 for e in setup))
            self.assertTrue(any(np.count_nonzero(e[0]) == 1 for e in setup))
            self.assertTrue(all(np.all(e[1][0] >= L.ACTION_SIZE) for e in setup))
            restored = FreeStartNet(g)
            restored.load_checkpoint(folder, 'best.pth.tar')
            resumed = FreeStartCoach(g, restored, cfg)
            resumed.loadTrainExamples()
            self.assertEqual(len(resumed.trainExamplesHistory), len(coach.trainExamplesHistory))

    def test_evaluation_command_writes_frozen_model_and_report(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(net_args, {
            'num_channels': 4, 'num_res_blocks': 1, 'cuda': False,
        }):
            home = Path(folder)
            net = FreeStartNet(self.game)
            net.save_checkpoint(str(home / 'temp'), 'best.pth.tar')
            with patch.object(evaluate, 'HERE', home), patch.object(sys, 'argv', [
                'evaluate.py', '--openings', '1', '--games', '8', '--sims', '2',
            ]):
                evaluate.main()
            result_path = next((home / 'evaluations').glob('*/results.json'))
            result = json.loads(result_path.read_text())
            self.assertEqual(len(result['openings'][0]['records']), 8)
            self.assertEqual(result['openings'][0]['summary']['games'], 8)
            self.assertTrue(result_path.with_name('REPORT.md').is_file())
            self.assertEqual(result_path.with_name('model.pth.tar').read_bytes(),
                             (home / 'temp' / 'best.pth.tar').read_bytes())


if __name__ == '__main__':
    unittest.main()
