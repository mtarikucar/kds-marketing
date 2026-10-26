#!/usr/bin/env python3
"""Run the host binary against a networkless container's bind-mounted Unix socket.

Only fixed recovery commands are accepted. The child inherits a seccomp filter
which kills attempts to open any non-Unix socket (including provider traffic).
No keys, URLs, SQL diagnostics or raw binary output are relayed.
"""
import ctypes
import ctypes.util
import os
from pathlib import Path
import subprocess
import stat
import sys
import time
from urllib.parse import quote


def unix_only():
    lib = ctypes.CDLL(ctypes.util.find_library('seccomp') or 'libseccomp.so.2')
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    class Compare(ctypes.Structure):
        _fields_ = [('arg', ctypes.c_uint), ('op', ctypes.c_int),
                    ('a', ctypes.c_uint64), ('b', ctypes.c_uint64)]
    lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32,
                                         ctypes.c_int, ctypes.c_uint, ctypes.POINTER(Compare)]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = lib.seccomp_init(0x7fff0000)  # ALLOW, except socket(domain != AF_UNIX).
    if not ctx:
        os._exit(125)
    comparison = Compare(0, 1, 1, 0)  # SCMP_CMP_NE, AF_UNIX=1
    rc = lib.seccomp_rule_add_array(ctx, 0x80000000,
        lib.seccomp_syscall_resolve_name(b'socket'), 1, ctypes.byref(comparison))
    if rc != 0 or lib.seccomp_load(ctx) != 0:
        os._exit(125)
    lib.seccomp_release(ctx)


def invoke(binary, operation, socket, key):
    env = {'JEETA_DATABASE_URL': 'postgresql://recovery_app@localhost/jeeta?host=' + quote(str(socket), safe=''),
           'JEETA_MASTER_KEY_FILE': str(key),
           'JEETA_RECOVERY_WORKSPACE_ID': '00000000-0000-0000-0000-000000000001'}
    try:
        result = subprocess.run([binary, operation], env=env, cwd='/tmp',
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                preexec_fn=unix_only, timeout=20)
        return 0 if result.returncode == 0 and result.stdout == b'recovery: passed\n' else 1
    except (subprocess.SubprocessError, OSError):
        return 1


def no_symlinks(path):
    """Check every component, including parents of the trusted scratch root."""
    if not path.is_absolute():
        raise ValueError('absolute path required')
    for component in (*reversed(path.parents), path):
        if component.is_symlink():
            raise ValueError('symlink refused')
    return path.resolve(strict=True)


def confined(root, value, container=False):
    if container:
        if not value.startswith('/work/'):
            raise ValueError('outside scratch')
        relative = value.removeprefix('/work/')
        # Do not let an absolute remainder discard root. Also reject ambiguous
        # components before pathlib normalizes double slashes or dot components.
        if any(part in ('', '.', '..') for part in relative.split('/')):
            raise ValueError('ambiguous path')
        path = root / relative
    else:
        path = Path(value)
        if '..' in path.parts:
            raise ValueError('ambiguous path')
    resolved = no_symlinks(path)
    if not resolved.is_relative_to(root) or any(c in str(resolved) for c in '&=?#'):
        raise ValueError('outside scratch or query delimiter')
    return resolved


def checked_paths(root, socket, key, container=False):
    socket, key = (confined(root, p, container) for p in (socket, key))
    if not socket.is_dir() or not key.is_file():
        raise ValueError('wrong path type')
    # SQLx appends this fixed-port leaf to host=. Checking the directory alone
    # would still permit a symlink from its socket entry to a host service.
    leaf = confined(root, str(socket / '.s.PGSQL.5432'))
    if not leaf.is_socket():
        raise ValueError('not a PostgreSQL socket')
    return socket, key


def respond(root_fd, rc):
    # Never open an existing attacker-controlled inode. All operations stay
    # relative to the already opened scratch directory, even if its name moves.
    fd = os.open('binary-response.tmp', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=root_fd)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write((str(rc) + '\n').encode('ascii'))
            output.flush()
            os.fsync(output.fileno())
        os.replace('binary-response.tmp', 'binary-response', src_dir_fd=root_fd, dst_dir_fd=root_fd)
    finally:
        try:
            os.unlink('binary-response.tmp', dir_fd=root_fd)
        except FileNotFoundError:
            pass


def main():
    if sys.argv[1] == '--invoke':
        root = no_symlinks(Path(os.environ['JEETA_TEST_ROOT']))
        binary, operation, socket, key = sys.argv[2:]
        return invoke(binary, operation, *checked_paths(root, socket, key))

    root, binary = no_symlinks(Path(sys.argv[1])), sys.argv[2]
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    process = subprocess.Popen(sys.argv[3:])
    try:
        while process.poll() is None:
            try:
                fd = os.open('binary-request', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=root_fd)
            except FileNotFoundError:
                time.sleep(.02)
                continue
            with os.fdopen(fd, 'r') as request:
                metadata = os.fstat(request.fileno())
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 4096:
                    raise ValueError('invalid request')
                lines = request.read(4097).splitlines()
            rc = 1
            if len(lines) == 3 and lines[0] in ('recovery-verify', 'recovery-canary-up', 'recovery-canary-down'):
                try:
                    paths = checked_paths(root, *lines[1:], container=True)
                    rc = invoke(binary, lines[0], *paths)
                except (ValueError, OSError):
                    pass
            os.unlink('binary-request', dir_fd=root_fd)
            respond(root_fd, rc)
        return process.returncode
    finally:
        os.close(root_fd)
        if process.poll() is None:
            process.terminate()
            process.wait()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError):
        sys.exit(1)
