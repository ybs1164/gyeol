"""Build on this PC; ship only runtime files, never Android signing keys or player data."""
from pathlib import Path
import argparse
import hashlib
import os
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
npm = 'npm.cmd' if os.name == 'nt' else 'npm'
parser = argparse.ArgumentParser()
parser.add_argument('--skip-build', action='store_true', help='Reuse previously verified web/server builds')
parser.add_argument('--target', choices=('pi', 'oracle'), default='pi', help='ARM64 deployment profile')
args = parser.parse_args()
if not args.skip_build:
    subprocess.run([npm, 'run', 'build'], cwd=ROOT, check=True)
subprocess.run(['node', 'node_modules/esbuild/bin/esbuild', 'tools/server_smoke.ts', '--bundle',
    '--platform=node', '--format=esm', '--target=node22', '--outfile=packages/server/dist/smoke.mjs',
    '--external:bufferutil', '--external:utf-8-validate',
    "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"], cwd=ROOT, check=True)
out = ROOT / 'dist'
out.mkdir(exist_ok=True)
bundle_name = f'gyeol-{args.target}-server'
archive = out / f'{bundle_name}.tar.gz'
with tempfile.TemporaryDirectory(prefix='gyeol-pi-') as temp:
    stage = Path(temp) / bundle_name
    shutil.copytree(ROOT / 'deploy/pi', stage)
    if args.target == 'oracle':
        shutil.copy2(stage / 'install.sh', stage / 'install-base.sh')
        for filename in ('install.sh', 'server.env.example', 'README.md'):
            shutil.copy2(ROOT / 'deploy/oracle' / filename, stage / filename)
    shutil.copy2(ROOT / 'docs/database-operations.md', stage / 'DATABASE.md')
    for filename in ('server.mjs', 'database.worker.mjs', 'db-cli.mjs'):
        shutil.copy2(ROOT / 'packages/server/dist' / filename, stage / filename)
    shutil.copytree(ROOT / 'packages/server/dist/migrations', stage / 'migrations')
    # Ship the driver's JS and Linux ARM64 N-API binary, never the Windows addon.
    driver = ROOT / 'node_modules/better-sqlite3'
    runtime_driver = stage / 'node_modules/better-sqlite3'
    shutil.copytree(driver / 'lib', runtime_driver / 'lib')
    shutil.copy2(driver / 'package.json', runtime_driver / 'package.json')
    shutil.copy2(driver / 'LICENSE', runtime_driver / 'LICENSE')
    (runtime_driver / 'prebuilds').mkdir()
    shutil.copy2(driver / 'prebuilds/linux-arm64.node', runtime_driver / 'prebuilds/linux-arm64.node')
    shutil.copy2(ROOT / 'packages/server/dist/smoke.mjs', stage / 'smoke.mjs')
    shutil.copy2(ROOT / 'tools/validate_server_package.mjs', stage / 'validate-package.mjs')
    shutil.copytree(ROOT / 'apps/web/dist', stage / 'public')
    manifest = []
    for p in sorted(stage.rglob('*')):
        if p.is_file():
            # Windows checkouts must still produce runnable Linux shell/env/unit files.
            if p.suffix in ('.sh', '.service', '.timer', '.mjs') or p.name == 'server.env.example':
                p.write_bytes(p.read_bytes().replace(b'\r\n', b'\n'))
            manifest.append(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.relative_to(stage).as_posix())
    (stage / 'SHA256SUMS').write_bytes(('\n'.join(manifest) + '\n').encode('utf-8'))
    with tarfile.open(archive, 'w:gz') as tar:
        tar.add(stage, arcname=stage.name)
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix(archive.suffix + '.sha256').write_bytes((checksum + '  ' + archive.name + '\n').encode('ascii'))
print(f'Package: {archive} ({archive.stat().st_size:,} bytes)')
print(f'SHA256: {checksum}')
