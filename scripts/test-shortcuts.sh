#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p target
clang -fobjc-arc -fblocks tests/workspace_native.m -framework Foundation -framework AppKit -o target/workspace-native-tests
target/workspace-native-tests
