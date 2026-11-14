#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
version=2.9.6
checksum=52bf9e88cdd972fc0c81501377a880e90d47031bd8ca5462488f843e2609e192
sdk=target/sparkle-sdk
if [ -f "$sdk/.version" ] && [ "$(cat "$sdk/.version")" = "$version" ] && [ -x "$sdk/bin/generate_appcast" ]; then
    exit 0
fi
mkdir -p "$sdk"
archive="$sdk/Sparkle-$version.tar.xz"
if [ ! -f "$archive" ]; then
    curl -fsSL --retry 3 "https://github.com/sparkle-project/Sparkle/releases/download/$version/Sparkle-$version.tar.xz" -o "$archive.part"
    mv "$archive.part" "$archive"
fi
printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 -c -
# Replace the SDK instead of overlaying nibs and signed resources from another version.
rm -rf "$sdk/Sparkle.framework" "$sdk/bin"
tar -xf "$archive" -C "$sdk" Sparkle.framework bin LICENSE
printf '%s\n' "$version" > "$sdk/.version"
