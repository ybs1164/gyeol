import copy
import os
import time

import numpy as np
import torch
import torch.optim as optim
from tqdm import tqdm

from NeuralNet import NeuralNet
from utils import AverageMeter, dotdict
from .GyeolNNet import GyeolNNet

# 7x7 소형 네트워크를 한 장씩 추론할 때는 CPU 스레드 1개가 가장 빠르다 (멀티스레드 동기화 비용 > 연산량)
torch.set_num_threads(1)

args = dotdict({
    'lr': 1e-3,
    'weight_decay': 1e-4,
    'dropout': 0.3,
    'epochs': 2,          # 같은 데이터를 여러 번 보면 가치 헤드가 결과를 외워 버린다(과적합)
    'batch_size': 256,
    'train_threads': os.cpu_count() or 1,
    'cuda': torch.cuda.is_available(),
    'num_channels': 64,
    'num_res_blocks': 6,
    'diagnostic_samples': 4096,
})


class NNetWrapper(NeuralNet):
    def __init__(self, game):
        self.nnet = GyeolNNet(game, args)
        self.board_x, self.board_y = game.getBoardSize()
        self.action_size = game.getActionSize()
        self.device = torch.device('cuda' if args.cuda else 'cpu')
        self.nnet.to(self.device)

    def train(self, examples, val_examples=None):
        # 학습은 배치 연산이라 멀티스레드가 유리하다. 끝나면 추론용 1스레드로 복귀.
        torch.set_num_threads(args.train_threads)
        try:
            return self._train(examples, val_examples)
        finally:
            torch.set_num_threads(1)

    def _to_tensors(self, batch):
        boards, pis, vs = list(zip(*batch))
        boards = torch.from_numpy(np.array(boards, dtype=np.int8)).to(self.device)
        dense = np.zeros((len(pis), self.action_size), dtype=np.float32)
        for row, (idx, val) in enumerate(pis):  # 희소 (인덱스, 확률) → 밀집 벡터
            dense[row, idx] = val
        target_pis = torch.from_numpy(dense).to(self.device)
        target_vs = torch.from_numpy(np.array(vs, dtype=np.float32)).to(self.device)
        return boards, target_pis, target_vs

    @torch.no_grad()
    def evaluate(self, examples):
        """학습에 쓰지 않은 데이터에서의 (Loss_pi, Loss_v, 승패 적중률)."""
        self.nnet.eval()
        tot_pi = tot_v = hit = 0.0
        for i in range(0, len(examples), 1024):
            boards, target_pis, target_vs = self._to_tensors(examples[i:i + 1024])
            out_pi, out_v = self.nnet(boards)
            out_v = out_v.view(-1)
            tot_pi += -torch.sum(target_pis * out_pi).item()
            tot_v += torch.sum((target_vs - out_v) ** 2).item()
            hit += torch.sum(torch.sign(out_v) == target_vs).item()
        n = len(examples)
        return tot_pi / n, tot_v / n, hit / n

    def _log_val(self, label, val_examples):
        if val_examples:
            l_pi, l_v, acc = self.evaluate(val_examples)
            print(f'  [검증 {label}] Loss_pi={l_pi:.3f}  Loss_v={l_v:.3f}  승패 적중 {acc * 100:.1f}%  (n={len(val_examples)})')

    def _train(self, examples, val_examples=None):
        optimizer = optim.Adam(self.nnet.parameters(), lr=args.lr, weight_decay=args.weight_decay)
        # A separate RNG keeps diagnostic sampling from changing training batches.
        ids = np.random.default_rng(0).choice(
            len(examples), min(len(examples), args.diagnostic_samples), replace=False)
        diagnostic = [examples[i] for i in ids]
        best_score = float('inf')
        best_state = None
        report = {'epochs': [], 'selected_epoch': None,
                  'train_sample_size': len(diagnostic),
                  'train_before': self.evaluate(diagnostic),
                  'validation_before': self.evaluate(val_examples) if val_examples else None}
        for epoch in range(args.epochs):
            print('EPOCH ::: ' + str(epoch + 1))
            self.nnet.train()
            pi_losses = AverageMeter()
            v_losses = AverageMeter()

            batch_count = max(1, int(len(examples) / args.batch_size))
            t = tqdm(range(batch_count), desc='Training Net')
            for _ in t:
                sample_ids = np.random.randint(len(examples), size=args.batch_size)
                boards, target_pis, target_vs = self._to_tensors([examples[i] for i in sample_ids])

                out_pi, out_v = self.nnet(boards)
                l_pi = -torch.sum(target_pis * out_pi) / target_pis.size(0)
                l_v = torch.sum((target_vs - out_v.view(-1)) ** 2) / target_vs.size(0)
                total_loss = l_pi + l_v

                pi_losses.update(l_pi.item(), boards.size(0))
                v_losses.update(l_v.item(), boards.size(0))
                t.set_postfix(Loss_pi=pi_losses, Loss_v=v_losses)

                optimizer.zero_grad()
                total_loss.backward()
                optimizer.step()
            if val_examples:
                l_pi, l_v, acc = self.evaluate(val_examples)
                report['epochs'].append({'epoch': epoch + 1, 'loss_pi': l_pi,
                                         'loss_v': l_v, 'accuracy': acc,
                                         'train_eval': self.evaluate(diagnostic),
                                         'train_batch_loss_pi': pi_losses.avg,
                                         'train_batch_loss_v': v_losses.avg})
                print(f'  [Validation epoch {epoch + 1}] Loss_pi={l_pi:.3f} Loss_v={l_v:.3f} accuracy={acc:.1%}')
                if np.isfinite(l_pi + l_v) and l_pi + l_v < best_score:
                    best_score = l_pi + l_v
                    best_state = copy.deepcopy(self.nnet.state_dict())
                    report['selected_epoch'] = epoch + 1
        if val_examples:
            if best_state is None:
                raise RuntimeError('No finite validation score')
            self.nnet.load_state_dict(best_state)
            print(f"  [Selected epoch] {report['selected_epoch']} (validation sum={best_score:.3f})")
        report['train_after'] = self.evaluate(diagnostic)
        report['validation_after'] = self.evaluate(val_examples) if val_examples else None
        return report

    @torch.no_grad()
    def predict(self, board):
        b = torch.from_numpy(np.ascontiguousarray(board, dtype=np.int8)).unsqueeze(0).to(self.device)
        self.nnet.eval()
        pi, v = self.nnet(b)
        return torch.exp(pi).cpu().numpy()[0], v.cpu().numpy()[0][0]

    def save_checkpoint(self, folder='checkpoint', filename='checkpoint.pth.tar'):
        os.makedirs(folder, exist_ok=True)
        torch.save({'state_dict': self.nnet.state_dict()}, os.path.join(folder, filename))

    def load_checkpoint(self, folder='checkpoint', filename='checkpoint.pth.tar'):
        filepath = os.path.join(folder, filename)
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"No model in path {filepath}")
        checkpoint = torch.load(filepath, map_location=self.device)
        self.nnet.load_state_dict(checkpoint['state_dict'])
