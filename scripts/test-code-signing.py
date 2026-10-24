#!/usr/bin/env python3
"""Prove two different signed executables share one legacy-Keychain ACL."""
import importlib.util
import pathlib
import secrets
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('signing', ROOT / 'scripts/code-signing.py')
signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signing)

directory = signing.signing_directory()
identity = signing.verify_pin(directory)
with tempfile.TemporaryDirectory(prefix='cnote-keychain-upgrade-test-') as folder:
    folder = pathlib.Path(folder)
    keychain = folder / 'fixture.keychain-db'
    password = secrets.token_hex(32)
    original_search = signing.shlex.split(signing.run(['security', 'list-keychains', '-d', 'user']).decode())
    try:
        signing.run(['security', 'create-keychain', '-p', password, keychain])
        signing.run(['security', 'unlock-keychain', '-p', password, keychain])
        executable = folder / 'cnote-fixture'
        requirements = []
        hashes = []
        for version, operation in [(1, 'write'), (2, 'read')]:
            signing.run(['clang', '-Wno-deprecated-declarations', f'-DVERSION={version}',
                         ROOT / 'tests/signing_keychain.c', '-framework', 'Security',
                         '-framework', 'CoreFoundation', '-o', executable])
            signing.sign_file(directory, executable, identity, identifier='com.cyeam.cnote')
            hashes.append(signing.hashlib.sha256(executable.read_bytes()).hexdigest())
            result = subprocess.run(['codesign', '-d', '-r-', str(executable)], capture_output=True, text=True, check=True)
            requirements.append(next(line for line in (result.stdout + result.stderr).splitlines() if line.startswith('designated =>')))
            print(signing.run([executable, keychain, operation]).decode().strip())
        assert hashes[0] != hashes[1], 'Fixture must actually change across versions'
        assert requirements[0] == requirements[1], 'Designated requirements must stay fixed across versions'
        # Confirm verification rejects an executable modified after signing.
        with executable.open('ab') as stream:
            stream.write(b'tampered')
        assert subprocess.run(['codesign', '--verify', str(executable)], capture_output=True).returncode != 0
        print('Different builds keep the same certificate-bound requirement; modified signed code is rejected.')
    finally:
        if keychain.exists():
            signing.run(['security', 'delete-keychain', keychain])
        signing.run(['security', 'list-keychains', '-d', 'user', '-s', *original_search])
