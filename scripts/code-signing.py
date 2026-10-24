#!/usr/bin/env python3
"""Keep CNote's code-signing identity stable across local builds and releases.

The public certificate is pinned in Git. Private material lives outside the
checkout, and is uploaded only to the repository's encrypted Actions secrets.
"""
import argparse
import contextlib
import fcntl
import base64
import hashlib
import os
import pathlib
import secrets
import shlex
import shutil
import ssl
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
PUBLIC_CERT = ROOT / 'assets/code-signing-cert.pem'
DEFAULT_DIR = pathlib.Path.home() / 'Library/Application Support/CNote/code-signing'


def signing_directory():
    default = pathlib.Path(os.environ['RUNNER_TEMP']) / 'cnote-code-signing' if os.environ.get('GITHUB_ACTIONS') == 'true' else DEFAULT_DIR
    return pathlib.Path(os.environ.get('CNOTE_SIGNING_DIR', default))


def run(args, *, data=None):
    # Never print commands: security's CLI requires passwords in some arguments.
    result = subprocess.run([str(arg) for arg in args], input=data, capture_output=True)
    if result.returncode:
        raise RuntimeError(f'{pathlib.Path(args[0]).name} {args[1]} failed (exit {result.returncode}); private arguments and output suppressed')
    return result.stdout


def write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)


def certificate_der(path):
    text = path.read_text()
    start = text.index('-----BEGIN CERTIFICATE-----')
    end = text.index('-----END CERTIFICATE-----', start) + len('-----END CERTIFICATE-----')
    return ssl.PEM_cert_to_DER_cert(text[start:end])


def fingerprint(path, algorithm='sha1'):
    return hashlib.new(algorithm, certificate_der(path)).hexdigest().upper()


def verify_pin(directory):
    if not PUBLIC_CERT.exists():
        raise RuntimeError('No pinned signing certificate. Run python3 scripts/code-signing.py configure once.')
    if certificate_der(directory / 'certificate.pem') != certificate_der(PUBLIC_CERT):
        raise RuntimeError('Signing identity differs from the pinned certificate; refusing to rotate identity.')
    for name in ('identity.p12', 'password', 'identity.keychain-db'):
        if not (directory / name).is_file():
            raise RuntimeError('Fixed signing identity is incomplete. Restore its private backup; do not generate a replacement.')
    return fingerprint(PUBLIC_CERT)


def pkcs12_compat():
    # OpenSSL 3 disables the algorithms needed by macOS PKCS#12 imports.
    # LibreSSL already enables these algorithms and has no -legacy option.
    version = run(['openssl', 'version']).decode().split()
    return ['-legacy'] if version[0] == 'OpenSSL' and int(version[1].split('.')[0]) >= 3 else []


@contextlib.contextmanager
def signing_lock(directory):
    # Two local package commands must not lock each other's keychain or race
    # when temporarily adding it to the user's keychain search list.
    descriptor = os.open(directory / 'sign.lock', os.O_RDWR | os.O_CREAT, 0o600)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, 'a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def import_keychain(directory, ci=False):
    with signing_lock(directory):
        _import_keychain(directory, ci)


def _import_keychain(directory, ci=False):
    password = (directory / 'password').read_text()
    keychain = directory / 'identity.keychain-db'
    original_search = shlex.split(run(['security', 'list-keychains', '-d', 'user']).decode())
    try:
        if not keychain.exists():
            run(['security', 'create-keychain', '-p', password, keychain])
        run(['security', 'unlock-keychain', '-p', password, keychain])
        run(['security', 'set-keychain-settings', '-lut', '21600', keychain])
        identity = fingerprint(directory / 'certificate.pem').encode()
        identities = run(['security', 'find-identity', '-p', 'codesigning', keychain])
        if identity not in identities:
            run(['security', 'import', directory / 'identity.p12', '-k', keychain,
                 '-P', password, '-T', '/usr/bin/codesign'])
            run(['security', 'set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', password, keychain])
        valid = run(['security', 'find-identity', '-v', '-p', 'codesigning', keychain])
        if identity not in valid:
            # Limit trust to code signing on the BUILD machine, never TLS.
            command = ['security', 'add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-k', keychain, directory / 'certificate.pem']
            if ci:
                command = ['sudo', 'security', 'add-trusted-cert', '-d', *command[2:]]
            run(command)
    finally:
        run(['security', 'list-keychains', '-d', 'user', '-s', *original_search])
        if keychain.exists():
            run(['security', 'lock-keychain', keychain])


def configure(directory, upload=False):
    directory.parent.mkdir(parents=True, exist_ok=True)
    if not directory.exists():
        if PUBLIC_CERT.exists():
            raise RuntimeError('A certificate is already pinned. Restore the original identity instead of creating a new one.')
        directory.mkdir(mode=0o700)
        with tempfile.TemporaryDirectory(prefix='create-', dir=directory) as temporary:
            temporary = pathlib.Path(temporary)
            write_private(directory / 'password', secrets.token_hex(32).encode())
            run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-nodes',
                 '-keyout', temporary / 'key.pem', '-out', directory / 'certificate.pem',
                 '-days', '3650', '-subj', '/CN=CNote Local Code Signing/O=CNote/',
                 '-addext', 'keyUsage=critical,digitalSignature,keyCertSign,cRLSign',
                 '-addext', 'extendedKeyUsage=critical,codeSigning',
                 '-addext', 'basicConstraints=critical,CA:TRUE'])
            # macOS security import needs the legacy PKCS#12 encryption format.
            # A random 256-bit password protects this exported backup.
            run(['openssl', 'pkcs12', '-export', *pkcs12_compat(), '-inkey', temporary / 'key.pem',
                 '-in', directory / 'certificate.pem', '-out', directory / 'identity.p12',
                 '-passout', f'file:{directory / "password"}'])
            (directory / 'identity.p12').chmod(0o600)
    directory.chmod(0o700)
    if PUBLIC_CERT.exists() and certificate_der(directory / 'certificate.pem') != certificate_der(PUBLIC_CERT):
        raise RuntimeError('Local certificate differs from the pinned certificate.')
    import_keychain(directory)
    # Validate the identity before publishing its public certificate.
    with tempfile.TemporaryDirectory(prefix='cnote-signing-check-') as temporary:
        probe = pathlib.Path(temporary) / 'probe'
        shutil.copyfile('/usr/bin/true', probe)
        sign_file(directory, probe, fingerprint(directory / 'certificate.pem'), identifier='com.cyeam.cnote')
    if not PUBLIC_CERT.exists():
        PUBLIC_CERT.write_bytes((directory / 'certificate.pem').read_bytes())
    verify_pin(directory)
    if upload:
        repository = os.environ.get('CNOTE_UPDATE_REPOSITORY', 'mnhkahn/cnote')
        run(['gh', 'secret', 'set', 'CNOTE_SIGNING_P12', '--repo', repository],
            data=base64.b64encode((directory / 'identity.p12').read_bytes()))
        run(['gh', 'secret', 'set', 'CNOTE_SIGNING_PASSWORD', '--repo', repository],
            data=(directory / 'password').read_bytes())
        print('Configured the fixed identity in GitHub Actions secrets.')
    print(f'Fixed certificate SHA-256: {fingerprint(PUBLIC_CERT, "sha256")}')


def import_ci(directory):
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise RuntimeError('import-ci is restricted to disposable GitHub Actions runners.')
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    p12 = base64.b64decode(os.environ['CNOTE_SIGNING_P12'], validate=True)
    password = os.environ['CNOTE_SIGNING_PASSWORD'].encode()
    if not p12 or not password:
        raise RuntimeError('Missing fixed signing identity secrets.')
    write_private(directory / 'password', password)
    write_private(directory / 'identity.p12', p12)
    output = run(['openssl', 'pkcs12', *pkcs12_compat(), '-in', directory / 'identity.p12', '-clcerts', '-nokeys',
                  '-passin', f'file:{directory / "password"}'])
    (directory / 'certificate.pem').write_bytes(output)
    if certificate_der(directory / 'certificate.pem') != certificate_der(PUBLIC_CERT):
        raise RuntimeError('Actions secret differs from the pinned signing certificate.')
    import_keychain(directory, ci=True)
    verify_pin(directory)
    print('Imported and verified the fixed signing identity.')


def sign_file(directory, path, identity, identifier=None):
    with signing_lock(directory):
        _sign_file(directory, path, identity, identifier)


def _sign_file(directory, path, identity, identifier=None):
    keychain = directory / 'identity.keychain-db'
    password = (directory / 'password').read_text()
    original_search = shlex.split(run(['security', 'list-keychains', '-d', 'user']).decode())
    run(['security', 'unlock-keychain', '-p', password, keychain])
    try:
        # codesign also consults the search list even with --keychain supplied.
        run(['security', 'list-keychains', '-d', 'user', '-s', *original_search, keychain])
        args = ['codesign', '--force', '--sign', identity, '--keychain', keychain, '--timestamp=none']
        if identifier:
            args += ['--identifier', identifier]
        # Preserve Sparkle's vendor signatures; sign only the containing app.
        run([*args, path])
        run(['codesign', '--verify', '--deep', '--strict', path])
        if identifier:
            run(['codesign', '--verify', f'-R=identifier "{identifier}" and anchor = H"{identity}"', path])
    finally:
        run(['security', 'list-keychains', '-d', 'user', '-s', *original_search])
        run(['security', 'lock-keychain', keychain])


def cleanup_ci(directory):
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise RuntimeError('cleanup-ci is restricted to disposable GitHub Actions runners.')
    keychain = directory / 'identity.keychain-db'
    if keychain.exists():
        run(['security', 'delete-keychain', keychain])
    certificate = directory / 'certificate.pem'
    if certificate.exists():
        # Only remove admin trust if import-ci reached the trust operation.
        subprocess.run(['sudo', 'security', 'remove-trusted-cert', '-d', str(certificate)], capture_output=True)
    if directory.exists():
        shutil.rmtree(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['configure', 'check', 'sign', 'import-ci', 'cleanup-ci'])
    parser.add_argument('path', nargs='?', type=pathlib.Path)
    parser.add_argument('--upload', action='store_true')
    args = parser.parse_args()
    directory = signing_directory()
    os.umask(0o077)
    if args.command == 'configure':
        configure(directory, args.upload)
    elif args.command == 'import-ci':
        import_ci(directory)
    elif args.command == 'cleanup-ci':
        cleanup_ci(directory)
    elif os.environ.get('CNOTE_ALLOW_ADHOC') == '1':
        if args.command == 'sign':
            if not args.path:
                parser.error('sign requires an app path')
            run(['codesign', '--force', '--sign', '-', args.path])
            run(['codesign', '--verify', '--deep', '--strict', args.path])
        print('Development-only ad-hoc signing explicitly enabled; Keychain trust will not survive upgrades.')
    else:
        identity = verify_pin(directory)
        if args.command == 'sign':
            if not args.path:
                parser.error('sign requires an app path')
            sign_file(directory, args.path, identity, identifier='com.cyeam.cnote')
        print(f'Using fixed CNote identity: {identity}')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(f'Code signing: {error}', file=sys.stderr)
        sys.exit(1)
