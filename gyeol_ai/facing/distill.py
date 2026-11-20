"""Continuous learning P3: fine-tune the facing network on server labels mixed with self-play replay.

Labels come from gyeol-app/tools/learning/relabel.ts (TrainingLabel JSONL, side to move = +1):
  exact  -> exact outcome value, exact margin, policy = all optimal moves
  proven -> exact outcome value, deep-search policy, margin only when solved
  search -> deep-search Q value and policy, no margin
Replay examples are the existing self-play (board, (idx, prob), v) tuples; they carry no margin.

Never train on the frozen test set: rows whose symmetry key is in `exclude` are dropped and counted.
"""
import hashlib
import json
from dataclasses import dataclass

import numpy as np
import torch

from gyeol import GyeolLogic as base
from facing import rules as R
from facing.network import MARGIN_SCALE

N = base.N
LABEL_VERSION = 1


def symmetry_key(board):
    """Same as packages/core symmetryKey for a canonical board: min over 8 symmetries (recentered) of positionKey."""
    best = None
    for sym in base.SYMMETRIES:
        b = base.recenter(base.transform_board(np.asarray(board).reshape(N, N), sym))
        key = ''.join(str(int(v) + 5) for v in b.reshape(-1))
        if best is None or key < best:
            best = key
    return best


def key_digest(board):
    return hashlib.sha256(symmetry_key(board).encode()).hexdigest()[:16]


def frozen_keys(paths):
    """Digests of frozen test positions (gyeol-app/tools/learning/frozen/*.jsonl; green-view board + player)."""
    keys = set()
    for path in paths:
        with open(path, encoding='utf-8') as f:
            for line in f:
                if line.strip():
                    row = json.loads(line)
                    keys.add(key_digest(np.array(row['board'], dtype=np.int8) * row['player']))
    return keys


@dataclass
class Label:
    key: str
    tier: str
    remaining: int
    board: np.ndarray  # (N, N) int8, side to move = +1
    policy: list
    value: float
    margin: float  # tiles from the side to move, nan if unknown


def load_labels(paths, exclude):
    """Returns (labels, stats). Raises if a label's key disagrees with the TS key (symmetry code drift)."""
    labels, stats = [], {'rows': 0, 'excluded': 0, 'duplicates': 0, 'tiers': {}}
    seen = set()
    for path in paths:
        with open(path, encoding='utf-8') as f:
            for line in f:
                if not line.strip():
                    continue
                row = json.loads(line)
                stats['rows'] += 1
                if row['v'] != LABEL_VERSION:
                    raise ValueError(f'Unknown label version {row["v"]} in {path}')
                board = np.array(row['board'], dtype=np.int8).reshape(N, N)
                key = key_digest(board)
                if key != row['key']:
                    raise ValueError(f'Symmetry key mismatch in {path}: python {key} != label {row["key"]}')
                if key in exclude:
                    stats['excluded'] += 1
                    continue
                if key in seen:
                    stats['duplicates'] += 1
                    continue
                seen.add(key)
                margin = np.nan if row['margin'] is None else float(row['margin'])
                labels.append(Label(key, row['tier'], int(row['remaining']), board, row['policy'], float(row['value']), margin))
                stats['tiers'][row['tier']] = stats['tiers'].get(row['tier'], 0) + 1
    return labels, stats


def label_examples(labels, game):
    """8 symmetries per label, as (board, (idx, prob), v, margin / MARGIN_SCALE or nan)."""
    out = []
    for label in labels:
        pi = np.zeros(R.ACTION_SIZE, dtype=np.float64)
        for action, prob in label.policy:
            pi[int(action)] = prob
        m = label.margin / MARGIN_SCALE if np.isfinite(label.margin) else np.nan
        for board, sym_pi in game.getSymmetries(label.board, pi):
            idx = np.flatnonzero(sym_pi)
            out.append((board.astype(np.int8), (idx, sym_pi[idx].astype(np.float32)), label.value, m))
    return out


def to_tensors(batch, action_size, device):
    boards = torch.from_numpy(np.array([e[0] for e in batch], dtype=np.int8)).to(device)
    pis = np.zeros((len(batch), action_size), dtype=np.float32)
    for row, e in enumerate(batch):
        idx, val = e[1]
        pis[row, idx] = val
    vs = torch.tensor([float(e[2]) for e in batch], dtype=torch.float32, device=device)
    ms = torch.tensor([float(e[3]) if len(e) > 3 else np.nan for e in batch], dtype=torch.float32, device=device)
    return boards, torch.from_numpy(pis).to(device), vs, ms


def losses(net, batch, action_size, device):
    boards, target_pi, target_v, target_m = to_tensors(batch, action_size, device)
    log_pi, v, m = net.heads(boards)
    v, m = v.view(-1), m.view(-1)
    l_pi = -torch.sum(target_pi * log_pi) / len(batch)
    l_v = torch.mean((target_v - v) ** 2)
    has_m = torch.isfinite(target_m)
    l_m = torch.mean((target_m[has_m] - m[has_m]) ** 2) if has_m.any() else torch.zeros((), device=device)
    return l_pi, l_v, l_m, (v, m, target_v, target_m, has_m)


@torch.no_grad()
def evaluate(net, examples, action_size, device):
    """Policy cross-entropy, value MSE, sign accuracy on decisive targets, margin MAE in tiles."""
    if not examples:
        return None
    net.eval()
    tot = {'pi': 0.0, 'v': 0.0, 'hit': 0.0, 'decisive': 0, 'm_abs': 0.0, 'm_n': 0}
    for i in range(0, len(examples), 1024):
        batch = examples[i:i + 1024]
        l_pi, l_v, _, (v, m, tv, tm, has_m) = losses(net, batch, action_size, device)
        tot['pi'] += l_pi.item() * len(batch)
        tot['v'] += l_v.item() * len(batch)
        decisive = tv != 0
        tot['hit'] += torch.sum(torch.sign(v[decisive]) == torch.sign(tv[decisive])).item()
        tot['decisive'] += int(decisive.sum().item())
        tot['m_abs'] += torch.sum(torch.abs(m[has_m] - tm[has_m])).item() * MARGIN_SCALE
        tot['m_n'] += int(has_m.sum().item())
    n = len(examples)
    return {'n': n, 'loss_pi': tot['pi'] / n, 'value_mse': tot['v'] / n,
            'accuracy': tot['hit'] / max(1, tot['decisive']),
            'margin_mae': tot['m_abs'] / tot['m_n'] if tot['m_n'] else None}


def fine_tune(net, label_train, replay_train, *, steps, batch_size, label_share, lr, weight_decay, margin_weight,
              device, seed, log=print):
    """Mixed-batch fine-tuning. Each batch takes round(label_share * batch_size) label examples."""
    rng = np.random.default_rng(seed)
    optimizer = torch.optim.Adam(net.parameters(), lr=lr, weight_decay=weight_decay)
    n_label = int(round(label_share * batch_size)) if replay_train else batch_size
    n_replay = batch_size - n_label
    history = []
    net.train()
    for step in range(1, steps + 1):
        batch = [label_train[i] for i in rng.integers(len(label_train), size=n_label)]
        if n_replay:
            batch += [replay_train[i] for i in rng.integers(len(replay_train), size=n_replay)]
        l_pi, l_v, l_m, _ = losses(net, batch, R.ACTION_SIZE, device)
        loss = l_pi + l_v + margin_weight * l_m
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        if step % 100 == 0 or step == steps:
            history.append({'step': step, 'loss_pi': l_pi.item(), 'loss_v': l_v.item(), 'loss_m': l_m.item()})
            log(f'  step {step}/{steps} pi {l_pi.item():.3f} v {l_v.item():.3f} m {l_m.item():.4f}')
    net.eval()
    return history
