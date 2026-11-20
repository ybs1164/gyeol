"""Tests for the continuous-learning P3 pieces: python -m unittest facing.test_distill"""
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

from facing import distill as D
from facing import rules as R
from facing.network import MARGIN_KEYS, FacingNNet
from gyeol.pytorch.GyeolNNet import GyeolNNet
from gyeol.pytorch.NNet import args as net_args

HERE = Path(__file__).resolve().parent
BEST = HERE / 'temp' / 'best.pth.tar'
FIXTURE = json.loads((HERE / 'fixtures' / 'symmetry_keys.json').read_text(encoding='utf-8'))['rows']


def boards(n=24, seed=3):
    rng, game, out = np.random.default_rng(seed), R.FacingGame(), []
    board, player = game.getInitBoard(), 1
    while len(out) < n:
        if game.getGameEnded(board, player):
            board, player = game.getInitBoard(), 1
        out.append((board * player).astype(np.int8))
        board, player = R.apply_move(board, player, int(rng.choice(np.flatnonzero(R.valid_vector(board, player))))), -player
    return out


class SymmetryKeyTests(unittest.TestCase):
    def test_matches_typescript_symmetry_key(self):
        for row in FIXTURE:
            self.assertEqual(D.key_digest(np.array(row['board'])), row['digest'])
            self.assertEqual(D.key_digest(np.array(row['variant'])), row['digest'])


class LabelTests(unittest.TestCase):
    def label(self, board, tier='exact', margin=3):
        legal = np.flatnonzero(R.valid_vector(board, 1))
        policy = [[int(a), 1 / len(legal[:3])] for a in legal[:3]]
        return {'v': 1, 'key': D.key_digest(board), 'tier': tier, 'board': board.reshape(-1).tolist(), 'remaining': 5,
                'value': 1, 'margin': margin, 'policy': policy, 'search': None}

    def test_examples_keep_legal_policies_under_symmetry_and_exclude_frozen(self):
        sample = boards(12)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'labels-000001.jsonl'
            rows = [self.label(b, margin=None if i % 2 else 3) for i, b in enumerate(sample)]
            path.write_text('\n'.join(json.dumps(r) for r in rows + rows[:2]) + '\n', encoding='utf-8')
            labels, stats = D.load_labels([path], exclude={rows[5]['key']})
            self.assertEqual(stats['excluded'], 1)
            self.assertEqual(stats['duplicates'], len({r['key'] for r in rows[:2]} - {rows[5]['key']}))
            examples = D.label_examples(labels, R.FacingGame())
            self.assertEqual(len(examples), 8 * len(labels))
            for board, (idx, prob), value, margin in examples:
                legal = R.valid_vector(board, 1)
                self.assertTrue(all(legal[i] for i in idx))
                self.assertAlmostEqual(float(prob.sum()), 1.0, places=5)
                self.assertTrue(np.isnan(margin) or abs(margin - 3 / 25) < 1e-9)

    def test_rejects_key_from_different_symmetry_code(self):
        row = self.label(boards(1)[0])
        row['key'] = '0' * 16
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'labels.jsonl'
            path.write_text(json.dumps(row) + '\n', encoding='utf-8')
            with self.assertRaises(ValueError):
                D.load_labels([path], exclude=set())


@unittest.skipUnless(BEST.exists(), 'needs facing/temp/best.pth.tar')
class NetworkTests(unittest.TestCase):
    def setUp(self):
        self.net = FacingNNet(R.FacingGame(), net_args).eval()
        self.state = torch.load(BEST, map_location='cpu', weights_only=True)['state_dict']

    def test_old_checkpoint_loads_and_policy_value_are_unchanged(self):
        self.assertTrue(self.net.load_compatible(self.state))
        x = torch.from_numpy(np.array(boards(16), dtype=np.int8))
        with torch.no_grad():
            old_pi, old_v = GyeolNNet.forward(self.net, x)
            pi, v, m = self.net.heads(x)
        torch.testing.assert_close(pi, old_pi)
        torch.testing.assert_close(v, old_v)
        self.assertTrue(torch.all(m.abs() <= 1))
        with self.assertRaises(RuntimeError):
            self.net.load_compatible({k: v for k, v in self.state.items() if not k.startswith('v_fc2')})
        self.assertEqual(set(MARGIN_KEYS) & set(self.state), set())

    def test_fine_tune_lowers_label_loss_and_exports_three_outputs(self):
        import export_facing_onnx as E
        self.net.load_compatible(self.state)
        game = R.FacingGame()
        rows = [D.Label(D.key_digest(b), 'exact', 5, b, [[int(np.flatnonzero(R.valid_vector(b, 1))[0]), 1.0]], 1.0, 4.0)
                for b in boards(16, seed=9)]
        examples = D.label_examples(rows, game)
        before = D.evaluate(self.net, examples, R.ACTION_SIZE, 'cpu')
        D.fine_tune(self.net, examples, [], steps=40, batch_size=32, label_share=1.0, lr=1e-3, weight_decay=0,
                    margin_weight=1.0, device='cpu', seed=1, log=lambda *_: None)
        after = D.evaluate(self.net, examples, R.ACTION_SIZE, 'cpu')
        self.assertLess(after['value_mse'], before['value_mse'])
        self.assertLess(after['margin_mae'], before['margin_mae'])
        with tempfile.TemporaryDirectory() as tmp:
            ckpt = Path(tmp) / 'candidate.pth.tar'
            torch.save({'state_dict': self.net.state_dict()}, ckpt)
            info = E.export(ckpt, Path(tmp) / 'onnx')
            session = ort.InferenceSession(str(Path(tmp) / 'onnx' / 'model.onnx'), providers=['CPUExecutionProvider'])
            self.assertEqual([o.name for o in session.get_outputs()], ['log_policy', 'value', 'margin'])
            self.assertLess(info['maxInferenceError'], 1e-3)


if __name__ == '__main__':
    unittest.main()
