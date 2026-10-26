#!/usr/bin/env python3
"""Exercise the real bridge process with disposable paths and a recording verifier."""
import json
import os
from pathlib import Path
import subprocess
import socket
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit

BRIDGE = Path(__file__).with_name('recovery-binary-bridge.py')


class BridgeBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='jeeta-bridge-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'scratch'
        self.root.mkdir()
        self.socket = self.root / 'socket'
        self.socket.mkdir()
        self.bind_socket(self.socket)
        self.key = self.root / 'key'
        self.key.write_text('synthetic-key')
        self.record = self.base / 'invocation.json'
        self.binary = self.base / 'verifier'
        self.binary.write_text('#!/usr/bin/python3\nimport json, os\n'
            f'with open({str(self.record)!r}, "w") as f: json.dump(dict(os.environ), f)\n'
            'print("recovery: passed")\n')
        self.binary.chmod(0o700)

    def bind_socket(self, directory):
        listener = socket.socket(socket.AF_UNIX)
        self.addCleanup(listener.close)
        listener.bind(str(directory / '.s.PGSQL.5432'))

    def run_bridge(self, socket='/work/socket', key='/work/key'):
        self.record.unlink(missing_ok=True)
        (self.root / 'binary-response').unlink(missing_ok=True)
        (self.root / 'binary-request').write_text(f'recovery-verify\n{socket}\n{key}\n')
        waiter = ('import pathlib,time,sys; p=pathlib.Path(sys.argv[1]); '
                  'deadline=time.monotonic()+4\n'
                  'while not p.exists() and time.monotonic()<deadline: time.sleep(.01)\n')
        return subprocess.run([sys.executable, str(BRIDGE), str(self.root), str(self.binary),
            sys.executable, '-c', waiter, str(self.root / 'binary-response')],
            capture_output=True, timeout=8)

    def assert_refused(self, **paths):
        self.run_bridge(**paths)
        self.assertFalse(self.record.exists(), 'escaped request invoked the host verifier')

    def test_double_slash_cannot_discard_scratch_root(self):
        outside = self.base / 'outside'
        outside.mkdir()
        self.bind_socket(outside)
        outside_key = self.base / 'outside-key'
        outside_key.write_text('outside-key')
        for argument, path in (('socket', outside), ('key', outside_key)):
            with self.subTest(argument=argument):
                self.assert_refused(**{argument: '/work/' + str(path)})

    def test_symlink_components_are_rejected_for_socket_and_key(self):
        outside = self.base / 'outside'
        outside.mkdir()
        self.bind_socket(outside)
        (outside / 'key').write_text('outside-key')
        (self.root / 'escape').symlink_to(outside, target_is_directory=True)
        (self.root / 'key-link').symlink_to(self.key)
        for paths in ({'socket': '/work/escape'}, {'key': '/work/escape/key'},
                      {'key': '/work/key-link'}):
            with self.subTest(paths=paths):
                self.assert_refused(**paths)

    def test_socket_leaf_symlink_cannot_connect_outside_scratch(self):
        outside = self.base / 'outside-socket'
        outside.mkdir()
        self.bind_socket(outside)
        leaf = self.socket / '.s.PGSQL.5432'
        leaf.unlink()
        leaf.symlink_to(outside / '.s.PGSQL.5432')
        self.assert_refused()

    def test_query_delimiters_are_rejected_for_both_paths(self):
        for character in '&=?#':
            for argument in ('socket', 'key'):
                with self.subTest(character=character, argument=argument):
                    path = self.root / (argument + character + 'host=outside')
                    if argument == 'socket':
                        path.mkdir()
                    else:
                        path.write_text('synthetic-key')
                    self.assert_refused(**{argument: '/work/' + path.name})

    def test_socket_query_value_is_encoded_once(self):
        socket = self.root / 'socket + percent%25'
        socket.mkdir()
        self.bind_socket(socket)
        result = self.run_bridge(socket='/work/' + socket.name)
        self.assertEqual(result.returncode, 0)
        invocation = json.loads(self.record.read_text())
        url = urlsplit(invocation['JEETA_DATABASE_URL'])
        self.assertEqual(parse_qs(url.query), {'host': [str(socket)]})
        self.assertEqual((url.username, url.path), ('recovery_app', '/jeeta'))

    def test_host_tools_invocation_uses_the_same_confinement(self):
        outside = self.base / 'outside'
        outside.mkdir()
        self.bind_socket(outside)
        env = dict(os.environ, JEETA_TEST_ROOT=str(self.root))
        result = subprocess.run([sys.executable, str(BRIDGE), '--invoke', str(self.binary),
            'recovery-verify', str(outside), str(self.key)], env=env, capture_output=True, timeout=8)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.record.exists())
        result = subprocess.run([sys.executable, str(BRIDGE), '--invoke', str(self.binary),
            'recovery-verify', str(self.socket), str(self.key)], env=env, capture_output=True, timeout=8)
        self.assertEqual(result.returncode, 0)
        self.assertTrue(self.record.exists())

    def test_response_temp_symlink_cannot_truncate_host_file(self):
        victim = self.base / 'host-file'
        victim.write_text('untouched')
        (self.root / 'binary-response.tmp').symlink_to(victim)
        result = self.run_bridge()
        self.assertEqual(victim.read_text(), 'untouched')
        self.assertNotEqual(result.returncode, 0)

    def test_response_is_private_and_replaces_symlink_without_following_it(self):
        victim = self.base / 'host-file'
        victim.write_text('untouched')
        (self.root / 'binary-response').symlink_to(victim)
        # Wait for replacement rather than merely existence of the symlink.
        (self.root / 'binary-request').write_text('recovery-verify\n/work/socket\n/work/key\n')
        result = subprocess.run([sys.executable, str(BRIDGE), str(self.root), str(self.binary),
            sys.executable, '-c',
            'import pathlib,time,sys; p=pathlib.Path(sys.argv[1]); deadline=time.monotonic()+4\n'
            'while p.is_symlink() and time.monotonic()<deadline: time.sleep(.01)\n',
            str(self.root / 'binary-response')], capture_output=True, timeout=8)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(victim.read_text(), 'untouched')
        response = self.root / 'binary-response'
        self.assertFalse(response.is_symlink())
        self.assertEqual(response.read_text(), '0\n')
        self.assertEqual(response.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
