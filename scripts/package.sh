#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
sh scripts/prepare-sparkle.sh
profile="${1:-release}"
version=$(python3 scripts/bundle-info.py --version "${2:-}")
if [ "$profile" = "release" ]; then
    cargo build --release --locked
elif [ "$profile" = "debug" ]; then
    cargo build --locked
else
    echo "Usage: scripts/package.sh [release|debug] [version]" >&2
    exit 1
fi
bundle="dist/CNote.app"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
# Keep this developer build out of Spotlight; the installed app is the searchable copy.
printf '' > "$(dirname "$bundle")/.metadata_never_index"
cp "target/$profile/cnote" "$bundle/Contents/MacOS/CNote.new"
mv -f "$bundle/Contents/MacOS/CNote.new" "$bundle/Contents/MacOS/CNote"
iconset="target/AppIcon.iconset"
mkdir -p "$iconset"
for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
    set -- $spec
    sips -z "$1" "$1" assets/note.png --out "$iconset/$2.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$bundle/Contents/Resources/AppIcon.icns"
arch=$(lipo -archs "$bundle/Contents/MacOS/CNote")
python3 scripts/bundle-info.py --version "$version" --arch "$arch" --output "$bundle/Contents/Info.plist"
mkdir -p "$bundle/Contents/Frameworks"
ditto target/sparkle-sdk/Sparkle.framework "$bundle/Contents/Frameworks/Sparkle.framework"
cp target/sparkle-sdk/LICENSE "$bundle/Contents/Resources/Sparkle-LICENSE.txt"
cp LICENSE THIRD_PARTY_NOTICES.md assets/Bootstrap-Icons-LICENSE.txt "$bundle/Contents/Resources/"
cp tools/vendor/LICENSES.txt "$bundle/Contents/Resources/Offline-Tools-LICENSES.txt"
codesign --force --deep --sign - "$bundle"
codesign --verify --deep --strict "$bundle"
echo "Built $bundle ($version)"
