#!/usr/bin/env python3
"""Package portable Rust sources and shared pages; no platform toolchain is needed."""
import argparse, hashlib, json, os, subprocess, tarfile, tempfile
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
PREFIXES = ('src/', 'editor/', 'tools/', 'assets/', 'shared/core/', 'shared/pages/')
FILES = {'Cargo.toml', 'Cargo.lock', 'build.rs', 'LICENSE', 'scripts/build-shared-pages.cjs', 'scripts/build-shared-source.py', 'tests/ocr-text.png', 'shared/README.md'}
def sources():
    names = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], cwd=ROOT, text=True).splitlines()
    return [name for name in sorted(set(names)) if (name.startswith(PREFIXES) or name in FILES) and (ROOT/name).is_file() and 'target' not in Path(name).parts]
def source_digest(names):
    digest = hashlib.sha256()
    for name in names:
        digest.update(name.encode()+b'\0'+(ROOT/name).read_bytes())
    return digest.hexdigest()
def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--version', default='development'); parser.add_argument('--out', type=Path, default=ROOT/'dist/shared'); args = parser.parse_args()
    names = sources(); source_sha = source_digest(names)
    args.out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='cnote-shared-') as temp:
        pages = Path(temp)/'pages'
        subprocess.run(['node', 'scripts/build-shared-pages.cjs'], cwd=ROOT, env={**os.environ, 'CNOTE_SHARED_ASSETS':str(pages)}, check=True)
        archive = args.out/'cnote-shared.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            for name in names: tar.add(ROOT/name, arcname=name)
            tar.add(pages, arcname='pages')
        if source_digest(names) != source_sha or sources() != names: raise RuntimeError('Shared sources changed during packaging; rerun')
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    metadata = dict(protocol=1, version=args.version, commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(), dirty=bool(subprocess.check_output(['git','status','--porcelain'],cwd=ROOT,text=True).strip()), sourceSha256=source_sha, sha256=digest, features=['notes','trello','onedrive'])
    (args.out/'shared.json').write_text(json.dumps(metadata,indent=2)+'\n')
    (args.out/'cnote-shared.tar.gz.sha256').write_text(digest+'  cnote-shared.tar.gz\n')
    print(archive)
if __name__ == '__main__': main()
