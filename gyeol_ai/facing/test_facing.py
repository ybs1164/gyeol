import tempfile
import unittest

import numpy as np

from gyeol import GyeolLogic as base
from facing import rules as R
from facing.network import FacingNet
from Coach import Coach
from MCTS import MCTS
from main import args
from utils import dotdict


class FacingTests(unittest.TestCase):
    def test_rules_and_symmetries_through_games(self):
        rng = np.random.default_rng(42)
        game = R.FacingGame()
        for _ in range(5):
            board, player = game.getInitBoard(), 1
            for turn in range(60):
                if game.getGameEnded(board, player):
                    break
                valid = game.getValidMoves(board, player)
                # Exactly the subset of baseline moves pointing toward the pivot.
                expected = [a // 4 for a in base.legal_moves(board, player)
                            if base.decode_action(a)[3] == (base.decode_action(a)[2] + 2) % 4]
                self.assertEqual(set(np.flatnonzero(valid)), set(expected or [R.PASS_ACTION]))
                action = int(rng.choice(np.flatnonzero(valid)))
                old = board.copy()
                out, next_player = game.getNextState(board, player, action)
                np.testing.assert_array_equal(board, old)
                np.testing.assert_array_equal(out, base.apply_move(board, player, R.base_action(action)))
                for sym, mapping in zip(base.SYMMETRIES, R.SYMMETRY_MAPS):
                    transformed = base.transform_board(board, sym)
                    np.testing.assert_array_equal(game.getValidMoves(transformed, player)[mapping], valid)
                    moved, _ = game.getNextState(transformed, player, int(mapping[action]))
                    np.testing.assert_array_equal(moved, base.recenter(base.transform_board(out, sym)))
                board, player = out, next_player
            else:
                self.fail('Game did not terminate')

    def test_invalid_direction_and_pass(self):
        game = R.FacingGame()
        board = game.getInitBoard()
        with self.assertRaises(ValueError):
            game.getNextState(board, 1, R.PASS_ACTION)
        board[:] = 1
        self.assertEqual(list(np.flatnonzero(game.getValidMoves(board, -1))), [R.PASS_ACTION])

    def test_network_search_training_and_checkpoint(self):
        game = R.FacingGame()
        net = FacingNet(game)
        config = dotdict({**args, 'numMCTSSims': 2})
        pi = MCTS(game, net, config).getActionProb(game.getInitBoard(), temp=1)
        self.assertEqual(len(pi), 785)
        self.assertAlmostEqual(float(np.sum(pi)), 1)
        self.assertFalse(np.any(np.asarray(pi)[game.getValidMoves(game.getInitBoard(), 1) == 0]))
        examples = Coach(game, net, config).executeEpisode()
        self.assertTrue(examples)
        from gyeol.pytorch.NNet import args as net_args
        previous = net_args.copy()
        try:
            net_args.update(epochs=1, batch_size=8, train_threads=1)
            report = net.train(examples[:16], examples[16:24])
            self.assertTrue(np.all(np.isfinite(report['train_after'])))
        finally:
            net_args.update(previous)
        with tempfile.TemporaryDirectory() as folder:
            net.save_checkpoint(folder)
            restored = FacingNet(game)
            restored.load_checkpoint(folder)
            np.testing.assert_array_equal(net.predict(game.getInitBoard())[0],
                                          restored.predict(game.getInitBoard())[0])


if __name__ == '__main__':
    unittest.main()
