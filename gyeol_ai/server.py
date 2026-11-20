"""
결(GYEOL) 사람 vs AI 웹 서버.   실행: python server.py   →  http://localhost:8000

- ./temp/best.pth.tar 를 불러와 MCTS 로 둔다. 새 게임을 시작할 때 파일이 바뀌었으면 다시 불러온다
  (학습을 돌리는 중이라면 최신 모델과 둘 수 있음).
- 서버는 상태를 저장하지 않는다. 브라우저가 보드와 차례를 보내고 결과를 받는다.
"""
import argparse
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

from MCTS import MCTS
from gyeol import GyeolLogic as L
from gyeol.GyeolGame import GyeolGame
from gyeol.pytorch.NNet import NNetWrapper
from utils import dotdict

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, 'web')

game = GyeolGame()
net = NNetWrapper(game)
lock = threading.Lock()
model = {'path': None, 'mtime': None, 'loaded': False}


def load_model_if_changed():
    path = model['path']
    if not os.path.isfile(path):
        model['loaded'] = False
        return
    mtime = os.path.getmtime(path)
    if mtime != model['mtime']:
        folder, filename = os.path.split(path)
        try:
            net.load_checkpoint(folder, filename)
        except Exception as e:  # 학습이 파일을 쓰는 도중일 수 있음 → 기존 모델 유지
            print(f"모델 불러오기 실패, 기존 모델 유지: {e}")
            return
        model['mtime'] = mtime
        model['loaded'] = True
        print(f"모델 불러옴: {path}")


def state_payload(board, player, extra=None):
    board = np.asarray(board, dtype=np.int8)
    result = L.game_result(board, player)
    valids = [] if result != 0 else [int(a) for a in np.flatnonzero(L.valid_vector(board, player))]
    out = {
        'board': board.tolist(),
        'player': player,
        'ended': result != 0,
        'winner': 0 if result == 0 else (player if result > 0.5 else -player if result < -0.5 else 0),
        'green': int((board > 0).sum()),
        'brown': int((board < 0).sum()),
        # 합법 수: [돌릴 r, c, 새 방향, 놓을 r, c, 놓을 방향]  (패스는 [])
        'moves': [decode_for_ui(a) for a in valids],
        'model': {'loaded': model['loaded'], 'mtime': model['mtime']},
    }
    if extra:
        out.update(extra)
    return out


def decode_for_ui(a):
    if a == L.PASS_ACTION:
        return []
    cell, nd, nb, pd = L.decode_action(a)
    r, c = divmod(cell, L.N)
    return [r, c, nd, r + L.DIRS[nb][0], c + L.DIRS[nb][1], pd]


def encode_from_ui(m):
    if not m:
        return L.PASS_ACTION
    r, c, nd, pr, pc, pd = m
    return L.encode_action(r * L.N + c, nd, L.DIRS.index((pr - r, pc - c)), pd)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, code=200):
        data = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            if self.path == '/api/new':
                with lock:
                    load_model_if_changed()
                return self._json(state_payload(L.initial_board(), 1))

            board = np.array(body['board'], dtype=np.int8)
            player = int(body['player'])
            if board.shape != (L.N, L.N) or player not in (1, -1):
                return self._json({'error': 'bad state'}, 400)

            if self.path == '/api/move':
                a = encode_from_ui(body.get('move'))
                if not L.valid_vector(board, player)[a]:
                    return self._json({'error': '둘 수 없는 수입니다'}, 400)
                nb, info = L.apply_move_verbose(board, player, a)
                return self._json(state_payload(nb, -player, {'last': info}))

            if self.path == '/api/ai':
                sims = max(1, min(2000, int(body.get('sims', 200))))
                with lock:
                    mcts = MCTS(game, net, dotdict({'numMCTSSims': sims, 'cpuct': 1.5, 'dirichletAlpha': 0}))
                    canon = game.getCanonicalForm(board, player)
                    probs = mcts.getActionProb(canon, temp=0)
                    _, v = net.predict(canon)
                a = int(np.argmax(probs))
                nb, info = L.apply_move_verbose(board, player, a)
                return self._json(state_payload(nb, -player, {
                    'last': info, 'aiMove': decode_for_ui(a),
                    'aiValue': float(v),  # AI 시점 예상 승률 지표 (-1 ~ 1)
                }))

            self._json({'error': 'not found'}, 404)
        except Exception as e:  # 잘못된 요청은 400 으로 돌려준다
            self._json({'error': str(e)}, 400)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default=os.path.join(ROOT, 'temp', 'best.pth.tar'))
    ap.add_argument('--port', type=int, default=8000)
    opt = ap.parse_args()
    model['path'] = os.path.abspath(opt.model)
    load_model_if_changed()
    if not model['loaded']:
        print(f"경고: {model['path']} 가 없어 학습되지 않은 신경망으로 둡니다.")
    print(f"http://localhost:{opt.port}")
    ThreadingHTTPServer(('127.0.0.1', opt.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
