"""Shared residual tower with an additional initial-placement policy head."""
import torch
from torch import nn

from gyeol.pytorch.GyeolNNet import GyeolNNet
from gyeol.pytorch.NNet import NNetWrapper, args
from free_game import SETUP_SIZE


class FreeStartNet(NNetWrapper):
    def __init__(self, game):
        self.nnet = GyeolNNet(game, args)
        # Base forward concatenates spatial moves, then this pooled head.
        # Its first output remains PASS; the rest are relative placements.
        self.nnet.p_pass = nn.Linear(args.num_channels, 1 + SETUP_SIZE)
        self.board_x, self.board_y = game.getBoardSize()
        self.action_size = game.getActionSize()
        self.device = torch.device('cuda' if args.cuda else 'cpu')
        self.nnet.to(self.device)
