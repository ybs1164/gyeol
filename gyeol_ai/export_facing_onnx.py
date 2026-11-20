"""Export a facing checkpoint to ONNX for the app and validate it against PyTorch. No git, no publishing.

  python export_facing_onnx.py --checkpoint <candidate.pth.tar> --out <dir>

Outputs (input `board` float32 [1, 7, 7], side to move = +1):
  log_policy [1, 785]   value [1, 1] (-1..1)   margin [1, 1] (final tile margin in tiles, side to move)
Apps that only read log_policy/value keep working. Writes <out>/model.onnx and <out>/model-info.json.
"""
import argparse
import hashlib
import io
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from torch import nn

from facing import rules as L
from facing.network import MARGIN_SCALE, FacingNNet
from facing.rules import FacingGame
from gyeol.pytorch.NNet import args as net_args


class Exported(nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, board):
        log_pi, v, m = self.net.heads(board)
        return log_pi, v, m * MARGIN_SCALE


def sample_boards(count_games=8, seed=42):
    rng, game, boards = np.random.default_rng(seed), FacingGame(), []
    for _ in range(count_games):
        board, player = game.getInitBoard(), 1
        for _ in range(60):
            boards.append((board * player).copy())
            if game.getGameEnded(board, player):
                break
            board, player = L.apply_move(board, player, int(rng.choice(np.flatnonzero(L.valid_vector(board, player))))), -player
    return boards


def export(checkpoint: Path, out: Path):
    snapshot = checkpoint.read_bytes()
    net = FacingNNet(FacingGame(), net_args).cpu().eval()
    fresh_margin = net.load_compatible(torch.load(io.BytesIO(snapshot), map_location='cpu', weights_only=True)['state_dict'])
    torch.set_num_threads(1)
    out.mkdir(parents=True, exist_ok=True)
    model = out / 'model.onnx'
    wrapped = Exported(net).eval()
    torch.onnx.export(wrapped, torch.zeros(1, 7, 7), str(model), input_names=['board'],
                      output_names=['log_policy', 'value', 'margin'], opset_version=17, dynamo=False)
    onnx.checker.check_model(str(model))
    options = ort.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider'])
    boards, max_error = sample_boards(), 0.0
    with torch.no_grad():
        for board in boards:
            x = board.astype(np.float32)[None]
            expected = [t.numpy() for t in wrapped(torch.from_numpy(x))]
            actual = session.run(None, {'board': x})
            expected[0], actual[0] = np.exp(expected[0]), np.exp(actual[0])
            for a, b in zip(actual, expected):
                np.testing.assert_allclose(a, b, atol=1e-4, rtol=1e-4)
                max_error = max(max_error, float(np.max(np.abs(a - b))))
    info = {
        'source': checkpoint.name, 'rule': 'facing', 'actionSize': L.ACTION_SIZE,
        'sha256': hashlib.sha256(snapshot).hexdigest(),
        'onnxSha256': hashlib.sha256(model.read_bytes()).hexdigest(),
        'outputs': {'log_policy': 'log probabilities over 785 actions', 'value': 'side to move, -1..1',
                    'margin': 'final tile margin, side to move, tiles' + (' (untrained head)' if fresh_margin else '')},
        'exported': datetime.now(timezone.utc).isoformat(),
        'maxInferenceError': max_error, 'validationPositions': len(boards),
    }
    (out / 'model-info.json').write_text(json.dumps(info, indent=2) + '\n', encoding='utf-8')
    return info


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    opt = parser.parse_args()
    info = export(opt.checkpoint, opt.out)
    print(f"Exported {opt.out / 'model.onnx'} (onnx {info['onnxSha256'][:16]}); validated {info['validationPositions']} positions, "
          f"max error {info['maxInferenceError']:.3g}")
