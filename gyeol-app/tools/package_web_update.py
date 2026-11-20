"""Create a self-contained static web updater; no database or server settings included."""
from pathlib import Path
import base64
import hashlib
import io
import tarfile

root = Path(__file__).resolve().parents[1]
source = root / 'apps/web/dist'
assert (source / 'sw.js').is_file(), 'Build the production web app first.'
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
    for path in sorted(source.rglob('*')):
        if path.is_file() and path.relative_to(source).parts[0] not in ('model', 'ort'):
            archive.add(path, arcname=path.relative_to(source).as_posix(), recursive=False)
payload = buffer.getvalue()
template = '''#!/usr/bin/env python3
import base64, datetime, hashlib, io, json, os, shutil, tarfile, tempfile, urllib.request
from pathlib import Path, PurePosixPath

PAYLOAD = __PAYLOAD__
DIGEST = __DIGEST__

def health():
    with urllib.request.urlopen('http://127.0.0.1:8787/health', timeout=10) as response:
        if not json.load(response).get('ok'):
            raise RuntimeError('Server health check failed')

def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.gyeol-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
        os.chmod(name, 0o644)
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)

def main():
    if os.geteuid() != 0: raise RuntimeError('Run with sudo python3 w')
    data = base64.b64decode(PAYLOAD)
    if hashlib.sha256(data).hexdigest() != DIGEST: raise RuntimeError('Invalid download')
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for item in archive.getmembers():
            name = PurePosixPath(item.name)
            if not item.isfile() or name.is_absolute() or '..' in name.parts:
                raise RuntimeError('Unsafe archive path')
            files[name.as_posix()] = archive.extractfile(item).read()
    if 'index.html' not in files or 'sw.js' not in files: raise RuntimeError('Incomplete web bundle')
    public = Path('/opt/gyeol/current/public').resolve(strict=True)
    if not (public / 'index.html').is_file(): raise RuntimeError('Installed web directory missing')
    if not (public / 'model/model.onnx').is_file() or not (public / 'ort/ort-wasm-simd-threaded.wasm').is_file():
        raise RuntimeError('Existing AI assets missing; use the full server installer')
    for name in files:
        (public / name).resolve().relative_to(public)
    health()
    backup = Path('/opt/gyeol/web-backups') / datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup.mkdir(parents=True)
    order = sorted(n for n in files if n not in ('index.html', 'sw.js')) + ['index.html', 'sw.js']
    written = []
    try:
        for name in order:
            target = public / name
            existed = target.exists()
            if existed:
                saved = backup / name
                saved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, saved)
            atomic(target, files[name])
            written.append((name, existed))
        health()
        with urllib.request.urlopen('http://127.0.0.1:8787/', timeout=10) as response:
            if response.read() != files['index.html']: raise RuntimeError('Updated web not served')
    except Exception:
        for name, existed in reversed(written):
            if existed: atomic(public / name, (backup / name).read_bytes())
            else: (public / name).unlink(missing_ok=True)
        raise
    print('Web updated. Refresh the browser. Backup: ' + str(backup))

if __name__ == '__main__': main()
'''
script = template.replace('__PAYLOAD__', repr(base64.b64encode(payload).decode())).replace('__DIGEST__', repr(hashlib.sha256(payload).hexdigest()))
target = root / 'dist/gyeol-web-update.py'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(script.encode('utf-8'))
compile(script, str(target), 'exec')
print(f'{target}: {target.stat().st_size} bytes; public assets only')
