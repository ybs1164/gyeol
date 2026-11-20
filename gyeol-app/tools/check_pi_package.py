"""Verify and run the actual Pi distribution using the local Node runtime."""
from pathlib import Path
import hashlib
import json
import os
import socket
import subprocess
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
archive = ROOT / 'dist/gyeol-pi-server.tar.gz'
expected = archive.with_suffix('.gz.sha256').read_text(encoding='ascii').split()[0]
assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected
with tempfile.TemporaryDirectory(prefix='gyeol-pi-check-') as temp:
    with tarfile.open(archive) as tar:
        for m in tar.getmembers():
            assert not m.issym() and not m.islnk(), m.name
            assert not any(x in m.name for x in ('.jks', 'keystore.properties', 'node_modules/', '/data/')), m.name
        tar.extractall(temp, filter='data')
    package = Path(temp) / 'gyeol-pi-server'
    for line in (package / 'SHA256SUMS').read_text(encoding='utf-8').splitlines():
        digest, name = line.split('  ', 1)
        assert hashlib.sha256((package / name).read_bytes()).hexdigest() == digest, name
    assert (package / 'README.md').read_bytes() == (ROOT / 'deploy/pi/README.md').read_bytes()
    assert (package / 'public/model/model.onnx').stat().st_size > 1_000_000
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    data = Path(temp) / 'players.json'
    env = dict(os.environ, PORT=str(port), HOST='127.0.0.1', DATA=str(data),
               STATIC=str(package / 'public'), AI_DIR=str(package / 'public'), BOT_WAIT_SECONDS='0.2')
    log_path = Path(temp) / 'server.log'
    def start():
        log = log_path.open('ab')
        proc = subprocess.Popen(['node', str(package / 'server.mjs')], cwd=package, env=env, stdout=log, stderr=log)
        log.close()
        try:
            for _ in range(100):
                if proc.poll() is not None:
                    raise RuntimeError(log_path.read_text(encoding='utf-8', errors='replace'))
                try:
                    with urllib.request.urlopen(url + '/health', timeout=1) as response:
                        assert json.load(response)['ok'] is True
                    return proc
                except OSError:
                    time.sleep(.1)
            raise RuntimeError('Server did not become healthy')
        except BaseException:
            proc.terminate()
            proc.wait(timeout=10)
            raise
    proc = start()
    try:
        subprocess.run(['node', str(package / 'smoke.mjs'), url, '--ai'], cwd=package, check=True, timeout=190)
        time.sleep(1)
        saved = json.loads(data.read_text(encoding='utf-8'))
        assert len(saved['players']) >= 1003
        assert len(saved['games']) == 2
        assert all(g['status'] == 'finished' for g in saved['games'].values())
    finally:
        proc.terminate()
        proc.wait(timeout=15)
        print(log_path.read_text(encoding='utf-8', errors='replace'))
    proc = start()
    try:
        with urllib.request.urlopen(url + '/health', timeout=3) as response:
            assert json.load(response)['players'] == len(saved['players'])
        assert json.loads(data.read_text(encoding='utf-8'))['games'] == saved['games']
        print('PASS: distribution checksums, no signing keys/data, real AI, persisted data after restart')
    finally:
        proc.terminate()
        proc.wait(timeout=15)
