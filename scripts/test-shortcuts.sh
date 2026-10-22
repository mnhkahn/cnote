#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p target
clang -fobjc-arc -fblocks tests/workspace_native.m -framework Foundation -framework AppKit -framework WebKit -o target/workspace-native-tests
if [ "${CNOTE_NATIVE_UI_TESTS:-}" = "1" ]; then
    node -e 'require("fs").writeFileSync("target/workspace-native.html", "<script>window.ipc={postMessage(){}};</script>"+require("./tests/editor-fixture.cjs")())'
fi
target/workspace-native-tests
