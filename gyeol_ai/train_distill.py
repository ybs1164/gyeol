"""Continuous learning P3: fine-tune the facing model on server labels + self-play replay.

  python train_distill.py --labels <labels dir> [<dir> ...] --out <candidate dir>
      [--base facing/temp/best.pth.tar] [--replay facing/temp/trainExamples.examples]
      [--frozen ../gyeol-app/tools/learning/frozen/exact-test-v1.jsonl] [--steps 3000] [--label-share 0.5]

Writes <out>/candidate.pth.tar and <out>/report.json. Never overwrites the base checkpoint.
Validation: 5% of labels by symmetry key (never trained on) and the newest self-play iteration (excluded from training).
The frozen test set is excluded here too; it is only used by tools/learning/score_model.ts (P4 gate).
"""
import argparse
import glob
import hashlib
import json
import os
import pickle
import random
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch

from facing import distill as D
from facing import rules as R
from facing.network import FacingNet
from gyeol.pytorch.NNet import args as net_args

ROOT = Path(__file__).resolve().parent


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--labels', nargs='+', required=True, help='relabel.ts output folders or labels-*.jsonl files')
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--base', type=Path, default=ROOT / 'facing/temp/best.pth.tar')
    p.add_argument('--replay', type=Path, default=ROOT / 'facing/temp/trainExamples.examples')
    p.add_argument('--frozen', nargs='+', default=[str(ROOT.parent / 'gyeol-app/tools/learning/frozen/exact-test-v1.jsonl')])
    p.add_argument('--steps', type=int, default=3000)
    p.add_argument('--batch-size', type=int, default=256)
    p.add_argument('--label-share', type=float, default=0.5)
    p.add_argument('--lr', type=float, default=3e-4)
    p.add_argument('--weight-decay', type=float, default=1e-4)
    p.add_argument('--margin-weight', type=float, default=1.0)
    p.add_argument('--val-share', type=float, default=0.05)
    p.add_argument('--threads', type=int, default=os.cpu_count() or 1)
    p.add_argument('--seed', type=int, default=20261121)
    o = p.parse_args()
    if not (0 < o.label_share <= 1 and 0 < o.val_share < 0.5 and o.steps > 0):
        p.error('Require 0 < label-share <= 1, 0 < val-share < 0.5, steps > 0')
    if (o.out / 'candidate.pth.tar').resolve() == o.base.resolve():
        p.error('Refusing to overwrite the base checkpoint')
    o.out.mkdir(parents=True, exist_ok=True)
    random.seed(o.seed); np.random.seed(o.seed); torch.manual_seed(o.seed)
    torch.set_num_threads(o.threads)
    started = time.time()

    files = []
    for item in o.labels:
        files += sorted(glob.glob(os.path.join(item, 'labels-*.jsonl'))) if os.path.isdir(item) else [item]
    if not files:
        raise SystemExit('No label files found')
    exclude = D.frozen_keys(o.frozen)
    labels, label_stats = D.load_labels(files, exclude)
    if not labels:
        raise SystemExit('No usable labels')
    cut = int(o.val_share * 2 ** 32)
    is_val = lambda label: int(label.key[:8], 16) < cut  # noqa: E731  (deterministic by position)
    game = R.FacingGame()
    label_train = D.label_examples([l for l in labels if not is_val(l)], game)
    label_val_rows = [l for l in labels if is_val(l)]
    label_val = {tier: D.label_examples([l for l in label_val_rows if l.tier == tier], game)
                 for tier in sorted({l.tier for l in label_val_rows})}

    replay_train, replay_val = [], []
    if o.replay and o.replay.exists():
        with open(o.replay, 'rb') as f:
            history = pickle.load(f)
        replay_train = [e for chunk in history[:-1] for e in chunk]
        newest = history[-1]
        ids = np.random.default_rng(o.seed).choice(len(newest), min(len(newest), 4096), replace=False)
        replay_val = [newest[i] for i in ids]

    wrapper = FacingNet(game)
    net, device = wrapper.nnet, wrapper.device
    base_bytes = o.base.read_bytes()
    fresh_margin = net.load_compatible(torch.load(o.base, map_location=device, weights_only=True)['state_dict'])

    def scores():
        return {'labels': {tier: D.evaluate(net, ex, R.ACTION_SIZE, device) for tier, ex in label_val.items()},
                'replay': D.evaluate(net, replay_val, R.ACTION_SIZE, device)}

    before = scores()
    print(f'labels {len(labels)} ({label_stats["tiers"]}), train examples {len(label_train)}, replay {len(replay_train)}', flush=True)
    history = D.fine_tune(net, label_train, replay_train, steps=o.steps, batch_size=o.batch_size, label_share=o.label_share,
                          lr=o.lr, weight_decay=o.weight_decay, margin_weight=o.margin_weight, device=device, seed=o.seed)
    after = scores()

    candidate = o.out / 'candidate.pth.tar'
    torch.save({'state_dict': net.state_dict()}, candidate)
    report = {
        'created': datetime.now(timezone.utc).isoformat(), 'seconds': round(time.time() - started),
        'base': {'path': str(o.base), 'sha256': hashlib.sha256(base_bytes).hexdigest(), 'margin_head_initialized': fresh_margin},
        'candidate': {'path': str(candidate), 'sha256': hashlib.sha256(candidate.read_bytes()).hexdigest()},
        'config': {k: (str(v) if isinstance(v, Path) else v) for k, v in vars(o).items()},
        'network': {k: net_args[k] for k in ('num_channels', 'num_res_blocks', 'dropout')},
        'data': {'label_files': files, 'labels': label_stats, 'label_train_examples': len(label_train),
                 'label_val_positions': len(label_val_rows), 'replay_train': len(replay_train), 'replay_val': len(replay_val),
                 'frozen_excluded_keys': len(exclude)},
        'validation_before': before, 'validation_after': after, 'history': history,
    }
    (o.out / 'report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    for tier, b in before['labels'].items():
        a = after['labels'][tier]
        print(f'  [{tier:6}] value MSE {b["value_mse"]:.3f} -> {a["value_mse"]:.3f}  acc {b["accuracy"]:.1%} -> {a["accuracy"]:.1%}'
              f'  pi {b["loss_pi"]:.3f} -> {a["loss_pi"]:.3f}  margin MAE {b["margin_mae"]} -> {a["margin_mae"]}')
    if before['replay']:
        b, a = before['replay'], after['replay']
        print(f'  [replay] value MSE {b["value_mse"]:.3f} -> {a["value_mse"]:.3f}  pi {b["loss_pi"]:.3f} -> {a["loss_pi"]:.3f}')
    print(f'wrote {candidate} and report.json in {report["seconds"]}s')


if __name__ == '__main__':
    main()
