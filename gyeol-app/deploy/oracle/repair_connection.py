#!/usr/bin/env python3
"""Add a public HTTPS/WSS route without replacing other Caddy sites or exposing SQLite."""
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.request

DOMAIN = 'gyeol.146.56.189.166.sslip.io'
PUBLIC_IP = '146.56.189.166'
BEGIN = '# BEGIN GYEOL PUBLIC CONNECTION'
END = '# END GYEOL PUBLIC CONNECTION'
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def run(args, check=True, timeout=30):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError('Command failed: ' + ' '.join(args[:3]) + '\n' + result.stderr.strip()[-1600:])
    return result


def site_block(domain=DOMAIN):
    return (BEGIN + '\nhttps://' + domain + ''' {
    tls {
        issuer acme {
            dir https://acme-v02.api.letsencrypt.org/directory
        }
    }
    encode gzip
    reverse_proxy 127.0.0.1:8787
}
''' + END + '\n')


def render_config(original, domain=DOMAIN):
    block = site_block(domain)
    if BEGIN in original or END in original:
        if original.count(BEGIN) != 1 or original.count(END) != 1:
            raise RuntimeError('Ambiguous managed block; existing configuration was preserved.')
        expression = re.compile(r'(?ms)^' + re.escape(BEGIN) + r'\r?\n.*?^' + re.escape(END) + r'\r?$\n?')
        candidate, count = expression.subn(lambda _: block, original)
        if count != 1:
            raise RuntimeError('Invalid managed block; existing configuration was preserved.')
        return candidate
    return original + ('\n' if original and not original.endswith('\n') else '') + '\n' + block


def proxy_hosts(config):
    found = set()
    def visit(value, hosts=()):
        if isinstance(value, dict):
            own = [host for matcher in value.get('match', []) for host in matcher.get('host', [])]
            hosts = own or hosts
            if value.get('handler') == 'reverse_proxy':
                if any(upstream.get('dial') in ('127.0.0.1:8787', 'localhost:8787', '[::1]:8787') for upstream in value.get('upstreams', [])):
                    found.update(hosts)
            for child in value.values():
                visit(child, hosts)
        elif isinstance(value, list):
            for child in value:
                visit(child, hosts)
    visit(config)
    return sorted(host for host in found if re.fullmatch(r'[a-zA-Z0-9.-]+', host) and '.' in host)


def http_hosts(config):
    found = set()
    def visit(value):
        if isinstance(value, dict):
            for matcher in value.get('match', []):
                found.update(matcher.get('host', []))
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(config.get('apps', {}).get('http', {}))
    return found


def local_health():
    with OPENER.open('http://127.0.0.1:8787/health', timeout=4) as response:
        result = json.load(response)
    if not result.get('ok'):
        raise RuntimeError('The local database/worker is not healthy.')
    if result.get('maintenance'):
        raise RuntimeError('The server is in maintenance mode; it has not been opened automatically.')
    return result


def probe_site(domain):
    if not re.fullmatch(r'[a-zA-Z0-9.-]+', domain):
        raise RuntimeError('Invalid public hostname')
    args = ['curl', '-fsS', '--noproxy', '*', '--max-time', '5', '--resolve', domain + ':443:127.0.0.1']
    health = json.loads(run(args + ['https://' + domain + '/health'], timeout=8).stdout)
    if not health.get('ok') or health.get('maintenance'):
        raise RuntimeError('HTTPS does not reach the healthy GYEOL server.')
    html = run(args + ['https://' + domain + '/'], timeout=8).stdout
    if 'gyeol' not in html.lower():
        raise RuntimeError('The hostname does not serve the GYEOL web app.')
    nonce = base64.b64encode(os.urandom(16)).decode('ascii')
    context = ssl.create_default_context()
    with socket.create_connection(('127.0.0.1', 443), timeout=5) as connection:
        with context.wrap_socket(connection, server_hostname=domain) as tls:
            request = ('GET /ws HTTP/1.1\r\nHost: ' + domain + '\r\nOrigin: https://' + domain +
                       '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + nonce + '\r\n\r\n')
            tls.sendall(request.encode('ascii'))
            data = b''
            while b'\r\n\r\n' not in data and len(data) < 16384:
                part = tls.recv(4096)
                if not part:
                    break
                data += part
    head = data.decode('iso-8859-1')
    expected = base64.b64encode(hashlib.sha1((nonce + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
    if not re.match(r'HTTP/1\.[01] 101\b', head) or expected not in head:
        raise RuntimeError('The public WebSocket route did not upgrade correctly.')


def adapt(caddy, config):
    return json.loads(run([caddy, 'adapt', '--adapter', 'caddyfile', '--config', str(config)], timeout=30).stdout)


def apply_config(config, candidate, caddy, unit, backup_root=Path('/var/backups/gyeol-connect')):
    """Preserve exact original bytes and restore them if validation or reload fails."""
    original = config.read_bytes()
    stat = config.stat()
    backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(backup_root, 0o700)
    folder = Path(tempfile.mkdtemp(prefix=time.strftime('%Y%m%d-%H%M%S-'), dir=str(backup_root)))
    backup = folder / 'Caddyfile.before'
    backup.write_bytes(original)
    os.chmod(backup, 0o600)
    fd, name = tempfile.mkstemp(prefix='.gyeol-', dir=str(config.parent))
    temporary = Path(name)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(candidate.encode('utf-8'))
    replaced = False
    try:
        run([caddy, 'validate', '--adapter', 'caddyfile', '--config', str(temporary)], timeout=40)
        os.chmod(temporary, stat.st_mode & 0o777)
        os.chown(temporary, stat.st_uid, stat.st_gid)
        if config.read_bytes() != original:
            raise RuntimeError('Caddy configuration changed during repair; refusing to overwrite it.')
        os.replace(temporary, config)
        replaced = True
        run(['systemctl', 'reload', unit], timeout=40)
        return backup, original
    except Exception:
        if replaced:
            restore_config(config, original, unit, candidate.encode('utf-8'))
        raise
    finally:
        if temporary.exists():
            temporary.unlink()


def restore_config(config, original, unit, expected_current=None):
    if expected_current is not None and config.read_bytes() != expected_current:
        raise RuntimeError('Caddyfile changed after repair; refusing to overwrite another operator. Original backup was retained.')
    fd, name = tempfile.mkstemp(prefix='.gyeol-restore-', dir=str(config.parent))
    temporary = Path(name)
    stat = config.stat()
    with os.fdopen(fd, 'wb') as stream:
        stream.write(original)
    os.chmod(temporary, stat.st_mode & 0o777)
    os.chown(temporary, stat.st_uid, stat.st_gid)
    os.replace(temporary, config)
    result = run(['systemctl', 'reload', unit], check=False, timeout=40)
    if result.returncode:
        raise RuntimeError('Original file restored, but Caddy reload failed; inspect systemctl status caddy.')


def remember_url(domain):
    path = Path('/etc/gyeol/public-url')
    path.write_bytes(('https://' + domain + '\n').encode())
    os.chmod(path, 0o644)
    print('\nREADY: https://' + domain, flush=True)
    print('HTTPS, the GYEOL web page and WSS /ws are working. Port 8787 remains private.', flush=True)


def main():
    if '--print-block' in sys.argv:
        print(site_block(), end='')
        return
    if os.name != 'posix' or os.geteuid() != 0:
        raise RuntimeError('Run: sudo python3 f')
    print('Checking GYEOL backend...', flush=True)
    run(['systemctl', 'start', 'gyeol'], timeout=40)
    error = None
    for _ in range(8):
        try:
            local_health()
            error = None
            break
        except Exception as problem:
            error = problem
            time.sleep(1)
    if error:
        raise RuntimeError('Local GYEOL server failed its health check: ' + str(error))
    caddy = shutil.which('caddy')
    if not caddy or run(['systemctl', 'is-active', '--quiet', 'caddy'], check=False).returncode:
        raise RuntimeError('Caddy is not a standard active systemd service. No proxy/firewall settings were changed.')
    command = run(['systemctl', 'show', 'caddy', '--property=ExecStart', '--value']).stdout
    match = re.search(r'--config(?:=|\s+)([^\s;]+)', command)
    if not match:
        raise RuntimeError('Could not identify the active Caddyfile. Existing configuration was preserved.')
    config = Path(match.group(1).strip('"\'')).resolve(strict=True)
    if config.suffix.lower() == '.json':
        raise RuntimeError('Caddy uses JSON rather than a Caddyfile. Existing configuration was preserved.')
    source = config.read_text(encoding='utf-8')
    if '{$' in source:
        raise RuntimeError('Caddyfile uses service environment variables. Stopped to preserve its existing configuration.')
    current = adapt(caddy, config)
    try:
        with OPENER.open('http://127.0.0.1:2019/config/', timeout=3) as response:
            live = json.load(response)
    except Exception:
        live = None
    if live is not None and live != current:
        raise RuntimeError('Active Caddy API configuration differs from its file. No settings were overwritten.')
    # Keep a predictable address so the operator and external browser checks agree.
    for host in [DOMAIN] if DOMAIN in http_hosts(current) else []:
        try:
            probe_site(host)
            remember_url(host)
            return
        except Exception:
            pass
    if DOMAIN in http_hosts(current) and BEGIN not in source:
        raise RuntimeError('The proposed hostname already has an unmanaged route. No route was overwritten.')
    addresses = {row[4][0] for row in socket.getaddrinfo(DOMAIN, 443, type=socket.SOCK_STREAM)}
    if PUBLIC_IP not in addresses:
        raise RuntimeError('Public DNS does not resolve to this Oracle IP. No settings were changed.')
    print('Adding HTTPS route: ' + DOMAIN, flush=True)
    candidate = render_config(source)
    backup, original = apply_config(config, candidate, caddy, 'caddy')
    print('Original Caddyfile backup: ' + str(backup), flush=True)
    try:
        deadline = time.monotonic() + 120
        last = None
        while time.monotonic() < deadline:
            try:
                probe_site(DOMAIN)
                remember_url(DOMAIN)
                return
            except Exception as error:
                last = error
                time.sleep(3)
        raise RuntimeError('HTTPS/WSS did not become healthy: ' + str(last))
    except Exception:
        restore_config(config, original, 'caddy', candidate.encode('utf-8'))
        print('Original Caddy configuration restored.', flush=True)
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('REPAIR STOPPED: ' + str(error), file=sys.stderr)
        sys.exit(1)
