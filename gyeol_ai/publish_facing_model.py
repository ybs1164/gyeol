"""Export and validate the facing-rule model for the local web project.
Use --push to also commit and push the three model files.

Usage: python publish_facing_model.py
       python publish_facing_model.py --repo N:/Projects/ybs1164.github.io
Requires: pip install torch numpy tqdm onnx onnxruntime
"""
import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tempfile

import numpy as np
import onnx
import onnxruntime as ort
import torch

from facing import rules as L
from facing.rules import FacingGame as GyeolGame
from facing.network import FacingNNet as GyeolNNet
from gyeol.pytorch.NNet import args as net_args

ROOT = Path(__file__).resolve().parent
FILES = ['gyeol/facing/model.onnx', 'gyeol/facing/model-info.json', 'gyeol/facing/worker.js']


def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          encoding='utf-8').stdout.strip()


def sync_branch(repo, branch):
    git(repo, 'fetch', 'origin', branch)
    remote = git(repo, 'rev-parse', 'FETCH_HEAD')
    ahead, behind = map(int, git(repo, 'rev-list', '--left-right', '--count',
                                f'HEAD...{remote}').split())
    if ahead:
        raise RuntimeError(
            f'Local branch has {ahead} unpublished commit(s) and is {behind} commit(s) behind. '
            'Synchronize it with origin before publishing.')
    if behind:
        print(f'Updating {branch} by {behind} remote commit(s) (fast-forward only)...', flush=True)
        git(repo, 'merge', '--ff-only', remote)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path('N:/Projects/ybs1164.github.io'))
    parser.add_argument('--checkpoint', type=Path, default=ROOT / 'facing/temp/best.pth.tar')
    parser.add_argument('--push', action='store_true', help='Also commit and push model files.')
    opt = parser.parse_args()
    repo = opt.repo.resolve()
    branch = git(repo, 'branch', '--show-current')
    if not branch:
        raise RuntimeError('Detached HEAD: switch to a branch first.')
    if opt.push and git(repo, 'diff', '--cached', '--name-only'):
        raise RuntimeError('There are staged changes. Commit or unstage them first.')
    if opt.push and git(repo, 'status', '--porcelain', '--', *FILES):
        raise RuntimeError('Web model files have local changes. Review them first.')
    if opt.push:
        sync_branch(repo, branch)

    # Read once so export and checksum refer to the same checkpoint snapshot.
    snapshot = opt.checkpoint.read_bytes()
    digest = hashlib.sha256(snapshot).hexdigest()
    net = GyeolNNet(GyeolGame(), net_args).cpu().eval()
    net.load_state_dict(torch.load(io.BytesIO(snapshot), map_location='cpu', weights_only=True)['state_dict'])
    torch.set_num_threads(1)
    with tempfile.TemporaryDirectory(prefix='gyeol-export-') as tmp:
        model = Path(tmp) / 'model.onnx'
        torch.onnx.export(net, torch.zeros(1, 7, 7), str(model),
                          input_names=['board'], output_names=['log_policy', 'value'],
                          opset_version=17, dynamo=False)
        onnx.checker.check_model(str(model))
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(str(model), sess_options=options,
                                       providers=['CPUExecutionProvider'])
        rng = np.random.default_rng(42)
        boards = []
        for _ in range(8):
            board, player = GyeolGame().getInitBoard(), 1
            for _ in range(60):
                boards.append((board * player).copy())
                if GyeolGame().getGameEnded(board, player):
                    break
                action = int(rng.choice(np.flatnonzero(L.valid_vector(board, player))))
                board, player = L.apply_move(board, player, action), -player
        max_error = 0.0
        with torch.no_grad():
            for board in boards:
                x = board.astype(np.float32)[None]
                pi, value = net(torch.from_numpy(x))
                actual_pi, actual_value = session.run(None, {'board': x})
                expected = (pi.exp().numpy(), value.numpy())
                actual = (np.exp(actual_pi), actual_value)
                for a, b in zip(actual, expected):
                    np.testing.assert_allclose(a, b, atol=1e-5, rtol=1e-4)
                    max_error = max(max_error, float(np.max(np.abs(a - b))))
        print(f'Validated {len(boards)} positions; max error {max_error:.8g}', flush=True)
        worker_path = repo / FILES[2]
        worker = worker_path.read_text(encoding='utf-8')
        worker, count = re.subn(r"\./model\.onnx(?:\?v=[a-f0-9]+)?", f'./model.onnx?v={digest[:16]}', worker)
        if count != 1:
            raise RuntimeError('Expected exactly one model URL in worker.js; no files were changed.')
        metadata = {
            'source': opt.checkpoint.name,
            'rule': 'facing',
            'actionSize': 785,
            'sha256': digest,
            'exported': datetime.now(timezone.utc).isoformat(),
            'maxInferenceError': max_error,
            'validationPositions': len(boards),
        }
        (repo / FILES[0]).write_bytes(model.read_bytes())
        (repo / FILES[1]).write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
        worker_path.write_text(worker, encoding='utf-8')
    git(repo, 'diff', '--check')
    if not opt.push:
        print('Exported locally; no commit or push performed.')
        return
    git(repo, 'add', '--', *FILES)
    git(repo, 'commit', '-m', f'Update GYEOL facing AI model ({digest[:12]})')
    print('Committed model. Pushing...', flush=True)
    git(repo, 'push', 'origin', f'HEAD:{branch}')
    print(f'Pushed {git(repo, "rev-parse", "--short", "HEAD")}. GitHub Pages deployment will follow.')
    print('https://ybs1164.github.io/gyeol/facing/')


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f'Git failed: {exc.stderr}\nIf the commit succeeded but push failed, retry git push after resolving the error.') from exc
