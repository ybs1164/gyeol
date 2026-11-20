"""Separate 785-output network for the facing rule (no baseline weights)."""
import torch
from torch import nn

from gyeol.pytorch.GyeolNNet import GyeolNNet
from gyeol.pytorch.NNet import NNetWrapper, args


class FacingNNet(GyeolNNet):
    def __init__(self, game, config):
        super().__init__(game, config)
        # Per cell: rotated direction (4) x placement position (4).
        self.p_conv = nn.Conv2d(config.num_channels, 16, 1)


class FacingNet(NNetWrapper):
    def __init__(self, game):
        self.nnet = FacingNNet(game, args)
        self.board_x, self.board_y = game.getBoardSize()
        self.action_size = game.getActionSize()
        self.device = torch.device('cuda' if args.cuda else 'cpu')
        self.nnet.to(self.device)
