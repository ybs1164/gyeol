"""Separate 785-output network for the facing rule (no baseline weights).

Margin head (2026-11, continuous learning P3): predicts the final tile margin from the side to move's view,
scaled to [-1, 1] by MARGIN_SCALE. `forward` still returns (log_pi, v) so self-play, MCTS and the existing
training loop are unchanged; `heads` also returns the margin. Checkpoints saved before the head existed load
with the head freshly initialized (see `load_compatible`).
"""
import os

import torch
import torch.nn.functional as F
from torch import nn

from gyeol.pytorch.GyeolNNet import GyeolNNet, encode_boards
from gyeol.pytorch.NNet import NNetWrapper, args

MARGIN_SCALE = 25.0
MARGIN_KEYS = ('m_fc1.weight', 'm_fc1.bias', 'm_fc2.weight', 'm_fc2.bias')


class FacingNNet(GyeolNNet):
    def __init__(self, game, config):
        super().__init__(game, config)
        # Per cell: rotated direction (4) x placement position (4).
        self.p_conv = nn.Conv2d(config.num_channels, 16, 1)
        # Margin head shares the value convolution features.
        self.m_fc1 = nn.Linear(4 * self.n * self.n, 64)
        self.m_fc2 = nn.Linear(64, 1)

    def heads(self, boards):
        """(log_pi, value in [-1, 1], margin / MARGIN_SCALE in [-1, 1]); all from the side to move."""
        x = encode_boards(boards)
        x = self.tower(self.stem(x))
        p = self.p_conv(x).permute(0, 2, 3, 1).reshape(x.size(0), -1)
        pi = torch.cat([p, self.p_pass(x.mean(dim=(2, 3)))], dim=1)
        features = self.v_conv(x).flatten(1)
        v = F.dropout(F.relu(self.v_fc1(features)), p=self.dropout, training=self.training)
        v = torch.tanh(self.v_fc2(v))
        m = torch.tanh(self.m_fc2(F.relu(self.m_fc1(features))))
        return F.log_softmax(pi, dim=1), v, m

    def forward(self, boards):
        log_pi, v, _ = self.heads(boards)
        return log_pi, v

    def load_compatible(self, state_dict):
        """Load a checkpoint; only the margin head may be missing (older checkpoints). Returns True if it was."""
        result = self.load_state_dict(state_dict, strict=False)
        if result.unexpected_keys or set(result.missing_keys) - set(MARGIN_KEYS):
            raise RuntimeError(f'Incompatible checkpoint: missing={result.missing_keys} unexpected={result.unexpected_keys}')
        return bool(result.missing_keys)


class FacingNet(NNetWrapper):
    def __init__(self, game):
        self.nnet = FacingNNet(game, args)
        self.board_x, self.board_y = game.getBoardSize()
        self.action_size = game.getActionSize()
        self.device = torch.device('cuda' if args.cuda else 'cpu')
        self.nnet.to(self.device)

    def load_checkpoint(self, folder='checkpoint', filename='checkpoint.pth.tar'):
        filepath = os.path.join(folder, filename)
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"No model in path {filepath}")
        checkpoint = torch.load(filepath, map_location=self.device)
        self.nnet.load_compatible(checkpoint['state_dict'])
