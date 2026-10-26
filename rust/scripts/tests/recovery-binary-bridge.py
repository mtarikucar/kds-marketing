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
import sys
import time


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
    env = {'JEETA_DATABASE_URL': 'postgresql://recovery_app@localhost/jeeta?host=' + str(socket),
           'JEETA_MASTER_KEY_FILE': str(key),
           'JEETA_RECOVERY_WORKSPACE_ID': '00000000-0000-0000-0000-000000000001'}
    try:
        result = subprocess.run([binary, operation], env=env, cwd='/tmp',
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                preexec_fn=unix_only, timeout=20)
        return 0 if result.returncode == 0 and result.stdout == b'recovery: passed\n' else 1
    except (subprocess.SubprocessError, OSError):
        return 1


if sys.argv[1] == '--invoke':
    sys.exit(invoke(*sys.argv[2:]))

root, binary = Path(sys.argv[1]), sys.argv[2]
process = subprocess.Popen(sys.argv[3:])
request = root / 'binary-request'
try:
    while process.poll() is None:
        if request.exists():
            lines = request.read_text().splitlines()
            rc = 1
            if len(lines) == 3 and lines[0] in ('recovery-verify', 'recovery-canary-up', 'recovery-canary-down'):
                paths = [root / p.removeprefix('/work/') for p in lines[1:]]
                if all(p.startswith('/work/') and '..' not in Path(p).parts for p in lines[1:]):
                    rc = invoke(binary, lines[0], *paths)
            request.unlink()
            temp = root / 'binary-response.tmp'
            temp.write_text(str(rc) + '\n')
            temp.rename(root / 'binary-response')
        time.sleep(.02)
    sys.exit(process.returncode)
finally:
    if process.poll() is None:
        process.terminate()
        process.wait()
