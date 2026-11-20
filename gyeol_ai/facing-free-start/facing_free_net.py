"""Facing tower and move head plus 324 relative setup outputs."""
import hashlib
import io

import torch
from torch import nn

from facing_free_game import SETUP_SIZE
from facing.network import FacingNet
from gyeol.pytorch.NNet import args


class FacingFreeStartNet(FacingNet):
    def __init__(self, game):
        super().__init__(game)
        self.nnet.p_pass = nn.Linear(args.num_channels, 1 + SETUP_SIZE).to(self.device)

    def initialize_from_facing(self, path):
        """Keep regular policy/value predictions; start setup choices uniformly."""
        snapshot = path.read_bytes()
        source = torch.load(io.BytesIO(snapshot), map_location=self.device, weights_only=True)['state_dict']
        weight, bias = source['p_pass.weight'], source['p_pass.bias']
        if weight.shape != (1, args.num_channels) or bias.shape != (1,):
            raise ValueError('Initialization requires a regular facing checkpoint')
        target = self.nnet.state_dict()
        target['p_pass.weight'].zero_()
        target['p_pass.bias'].zero_()
        target['p_pass.weight'][:1].copy_(weight)
        target['p_pass.bias'][:1].copy_(bias)
        source['p_pass.weight'] = target['p_pass.weight']
        source['p_pass.bias'] = target['p_pass.bias']
        self.nnet.load_state_dict(source, strict=True)
        self.nnet.eval()
        return dict(source=str(path.resolve()), sha256=hashlib.sha256(snapshot).hexdigest(),
                    method='retain facing tower, value and regular policy; zero setup logits',
                    setup_trained=False)
