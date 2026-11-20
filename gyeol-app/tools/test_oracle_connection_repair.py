"""Safety checks for the privileged proxy repair. No system services are changed."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('repair', ROOT / 'deploy/oracle/repair_connection.py')
REPAIR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPAIR)


class RepairSafety(unittest.TestCase):
    def test_preserves_other_sites_and_is_idempotent(self):
        original = '# operator config\nimport sites/*\nexample.test {\n respond "keep"\n}\n'
        candidate = REPAIR.render_config(original)
        self.assertTrue(candidate.startswith(original))
        self.assertEqual(candidate.count(REPAIR.BEGIN), 1)
        self.assertEqual(REPAIR.render_config(candidate), candidate)
        self.assertIn('reverse_proxy 127.0.0.1:8787', candidate)

    def test_malformed_marker_is_not_overwritten(self):
        with self.assertRaises(RuntimeError):
            REPAIR.render_config(REPAIR.BEGIN + '\noperator change\n')

    def test_only_gyeol_proxy_hosts_are_discovered(self):
        config = {'apps': {'http': {'servers': {'s': {'routes': [
            {'match': [{'host': ['other.example']}], 'handle': [{'handler': 'reverse_proxy', 'upstreams': [{'dial': '127.0.0.1:3000'}]}]},
            {'match': [{'host': ['gyeol.example']}], 'handle': [{'handler': 'subroute', 'routes': [{'handle': [{'handler': 'reverse_proxy', 'upstreams': [{'dial': '127.0.0.1:8787'}]}]}]}]},
        ]}}}}}
        self.assertEqual(REPAIR.proxy_hosts(config), ['gyeol.example'])
        self.assertEqual(REPAIR.http_hosts(config), {'other.example', 'gyeol.example'})

    def test_validation_failure_does_not_replace_original(self):
        with tempfile.TemporaryDirectory(prefix='gyeol-repair-test-') as folder:
            root = Path(folder)
            config = root / 'Caddyfile'
            original = b'# original\nexample.test { respond "keep" }\n'
            config.write_bytes(original)
            def fail(args, **kwargs):
                raise RuntimeError('invalid candidate')
            with patch.object(REPAIR, 'run', side_effect=fail), self.assertRaises(RuntimeError):
                REPAIR.apply_config(config, 'invalid', 'caddy', 'caddy', root / 'backups')
            self.assertEqual(config.read_bytes(), original)
            self.assertFalse(list(root.glob('.gyeol-*')))

    def test_failed_reload_restores_original_bytes_and_permissions(self):
        with tempfile.TemporaryDirectory(prefix='gyeol-repair-test-') as folder:
            root = Path(folder)
            config = root / 'Caddyfile'
            original = b'# original\nexample.test { respond "keep" }\n'
            config.write_bytes(original)
            config.chmod(0o640)
            reloads = []
            def command(args, **kwargs):
                if args[:2] == ['systemctl', 'reload']:
                    reloads.append(config.read_bytes())
                    if len(reloads) == 1:
                        raise RuntimeError('reload failed')
                return subprocess.CompletedProcess(args, 0, '', '')
            with patch.object(REPAIR, 'run', side_effect=command), self.assertRaises(RuntimeError):
                REPAIR.apply_config(config, REPAIR.render_config(original.decode()), 'caddy', 'caddy', root / 'backups')
            self.assertEqual(config.read_bytes(), original)
            self.assertEqual(config.stat().st_mode & 0o777, 0o640)
            self.assertEqual(len(reloads), 2)
            self.assertNotEqual(reloads[0], original)
            self.assertEqual(reloads[1], original)
            self.assertEqual(next((root / 'backups').glob('*/Caddyfile.before')).read_bytes(), original)

    def test_operator_change_is_preserved_if_file_changes_during_validation(self):
        with tempfile.TemporaryDirectory(prefix='gyeol-repair-test-') as folder:
            root = Path(folder)
            config = root / 'Caddyfile'
            config.write_bytes(b'# before\n')
            operator_change = b'# another operator changed the configuration\n'
            def command(args, **kwargs):
                config.write_bytes(operator_change)
                return subprocess.CompletedProcess(args, 0, '', '')
            with patch.object(REPAIR, 'run', side_effect=command), self.assertRaisesRegex(RuntimeError, 'changed during'):
                REPAIR.apply_config(config, REPAIR.site_block(), 'caddy', 'caddy', root / 'backups')
            self.assertEqual(config.read_bytes(), operator_change)

    def test_success_preserves_backup(self):
        with tempfile.TemporaryDirectory(prefix='gyeol-repair-test-') as folder:
            root = Path(folder)
            config = root / 'Caddyfile'
            original = b'# before\n'
            config.write_bytes(original)
            candidate = REPAIR.render_config(original.decode())
            with patch.object(REPAIR, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')):
                backup, saved = REPAIR.apply_config(config, candidate, 'caddy', 'caddy', root / 'backups')
            self.assertEqual(config.read_text(), candidate)
            self.assertEqual(saved, original)
            self.assertEqual(backup.read_bytes(), original)

    def test_rollback_does_not_overwrite_later_operator_change(self):
        with tempfile.TemporaryDirectory(prefix='gyeol-repair-test-') as folder:
            config = Path(folder) / 'Caddyfile'
            config.write_bytes(b'# later operator change\n')
            with patch.object(REPAIR, 'run') as command, self.assertRaisesRegex(RuntimeError, 'another operator'):
                REPAIR.restore_config(config, b'# original\n', 'caddy', b'# our candidate\n')
            command.assert_not_called()
            self.assertEqual(config.read_bytes(), b'# later operator change\n')


if __name__ == '__main__':
    unittest.main(verbosity=2)
