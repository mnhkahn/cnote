#!/bin/bash
# Run once to provision this repository's Actions secret from the macOS Keychain.
# Export inside a private temporary directory; remove it even when a command fails.
set -euo pipefail
cd "$(dirname "$0")/.."
sh scripts/prepare-sparkle.sh
repository="${CNOTE_UPDATE_REPOSITORY:-mnhkahn/cnote}"
actual=$(target/sparkle-sdk/bin/generate_keys --account com.cyeam.cnote -p)
expected=$(cat assets/update-public-key.txt)
if [ "$actual" != "$expected" ]; then
    echo 'The Keychain signing key does not match assets/update-public-key.txt.' >&2
    exit 1
fi
key_dir=$(mktemp -d "${TMPDIR:-/tmp}/cnote-signing.XXXXXX")
chmod 700 "$key_dir"
trap 'rm -rf "$key_dir"' EXIT HUP INT TERM
target/sparkle-sdk/bin/generate_keys --account com.cyeam.cnote -x "$key_dir/key" >/dev/null
python3 -c 'import sys,base64,pathlib; s=pathlib.Path(sys.argv[1]).read_text().strip(); assert len(base64.b64decode(s,validate=True)) in (32,64,96), "Invalid signing key"' "$key_dir/key"
gh secret set SPARKLE_PRIVATE_KEY --repo "$repository" < "$key_dir/key"
echo 'Configured the Sparkle private key in GitHub Actions.'
